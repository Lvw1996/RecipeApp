// utils/extractVideoRecipe.js
//
// Extracts recipe data from social video URLs (TikTok, Instagram, YouTube).
//
// Extraction strategy (two-pass: caption → audio fallback):
//   Pass 1 — Caption text:
//     Instagram: HTML page scrape (og:title) first → yt-dlp --dump-json fallback.
//     TikTok:    HTML scrape (og:description) first → yt-dlp --dump-json fallback.
//     YouTube:   yt-dlp --dump-json directly.
//     Caption is sent to Gemini 2.0 Flash to parse into structured recipe JSON.
//
//   Pass 2 — Audio transcription (triggered when caption yields no recipe):
//     yt-dlp downloads the audio stream to a temp file (no ffmpeg conversion needed).
//     The file is uploaded to Gemini Files API and Gemini extracts the recipe
//     directly from the audio — handles creators who speak the recipe aloud
//     rather than writing it in the post caption.
//
// The returned shape matches extractRecipe.js so the existing /import response
// handling on the app side works unchanged.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Supported social domains
// ---------------------------------------------------------------------------

const SOCIAL_DOMAINS = [
  'tiktok.com',
  'vm.tiktok.com',
  'www.tiktok.com',
  'instagram.com',
  'www.instagram.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
];

export function isSocialVideoUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Thumbnail fetch helper — downloads a thumbnail URL and returns a data URI.
// TikTok CDN URLs are IP-signed: the mobile app cannot load them directly
// because the signature was issued for the server's egress IP. Embedding the
// image as a base64 data URI at import time solves this permanently.
// ---------------------------------------------------------------------------

const MAX_THUMBNAIL_BYTES = 400_000; // ~300 KB raw keeps base64 under 400 KB — safe for Firestore

async function fetchThumbnailAsDataUrl(url) {
  if (!url) {
    console.log('[Thumbnail] No URL provided — skipping');
    return '';
  }
  console.log('[Thumbnail] Fetching:', url.slice(0, 120));
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    console.log('[Thumbnail] HTTP status:', res.status, res.statusText);
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();
    const buffer = await res.arrayBuffer();
    console.log('[Thumbnail] Fetched bytes:', buffer.byteLength, 'mime:', mimeType);
    if (buffer.byteLength > MAX_THUMBNAIL_BYTES) {
      console.warn('[Thumbnail] Skipping oversized image:', buffer.byteLength, 'bytes');
      return '';
    }
    const base64 = Buffer.from(buffer).toString('base64');
    console.log('[Thumbnail] base64 length:', base64.length);
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.error('[Thumbnail] Fetch error:', err.message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Instagram HTML caption extraction (primary path for Instagram URLs)
//
// For public Instagram posts the og:description meta tag contains the full
// caption text without needing authentication.  This is faster than yt-dlp
// and avoids Instagram's API login requirements.
// ---------------------------------------------------------------------------

const IG_FETCH_TIMEOUT_MS = 12000;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function extractOgMeta(html, property) {
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']|` +
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1] || m[2] || '') : '';
}

async function extractCaptionFromInstagramPage(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), IG_FETCH_TIMEOUT_MS);
  let html;
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } finally {
    clearTimeout(tid);
  }

  // Instagram puts the FULL post caption in og:title formatted as:
  //   "Author Name on Instagram: "Full caption text…""
  // og:description is a truncated version prefixed with like/comment counts
  // so og:title is always preferred as the caption source.
  const ogTitle = extractOgMeta(html, 'og:title');
  const ogDesc = extractOgMeta(html, 'og:description');

  let caption = '';

  if (ogTitle) {
    // Strip "Author on Instagram: " or "Author on Instagram Reels: " prefix + surrounding quotes
    caption = ogTitle
      .replace(/^.+?\bon\s+instagram(?:\s+reels)?:\s*/i, '')
      .replace(/^["""«]/, '')
      .replace(/["""»]$/, '')
      .trim();
  }

  // Fall back to og:description if og:title didn't yield anything useful
  if (!caption && ogDesc) {
    caption = ogDesc
      .replace(/^[^:]+:\s*["""«]?/, '')
      .replace(/["""»]?\s*$/, '')
      .trim();
  }

  if (!caption) throw new Error('No usable caption found in Instagram page HTML');

  const rawThumbnail = extractOgMeta(html, 'og:image');
  const thumbnail = await fetchThumbnailAsDataUrl(rawThumbnail);

  // Derive a clean title from the first non-empty line of the caption
  const firstLine = caption.split('\n').find(l => l.trim()) ?? '';
  const title = firstLine.slice(0, 100).trim();

  return { caption, title, thumbnail, uploader: '' };
}

// ---------------------------------------------------------------------------
// yt-dlp caption extraction (primary path for TikTok / YouTube)
// ---------------------------------------------------------------------------

const YTDLP_TIMEOUT_MS = 30000;

async function extractCaptionViaYtDlp(videoUrl) {
  let stdout;
  try {
    const result = await execFileAsync(
      'yt-dlp',
      [
        '--dump-json',
        '--no-download',
        '--no-playlist',
        '--user-agent', MOBILE_UA,
        videoUrl,
      ],
      { timeout: YTDLP_TIMEOUT_MS },
    );
    stdout = result.stdout;
  } catch (err) {
    const msg = String(err?.message || err?.stderr || '');
    console.error('[VideoImport] yt-dlp failed:', msg.slice(0, 300));
    throw new Error('yt-dlp could not fetch this video. It may be private or geo-restricted.');
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp returned unparseable output.');
  }

  const caption = String(data.description || data.title || '').trim();
  const title = String(data.title || '').trim();
  const thumbnail = String(data.thumbnail || '').trim();
  const uploader = String(data.uploader || data.channel || '').trim();

  return { caption, title, thumbnail, uploader };
}

// ---------------------------------------------------------------------------
// Public entry point — routes to the best extraction method per platform
// ---------------------------------------------------------------------------

function isInstagramUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'instagram.com' || host === 'www.instagram.com';
  } catch {
    return false;
  }
}

function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'tiktok.com' || host === 'www.tiktok.com' || host === 'vm.tiktok.com';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TikTok HTML caption extraction (primary path — avoids yt-dlp bot blocks)
//
// TikTok embeds the full post caption in a "desc" JSON field inside the
// page HTML.  We extract it with a simple regex — no auth needed for public
// videos.  Short URLs (vm.tiktok.com) are followed transparently.
// ---------------------------------------------------------------------------

async function extractCaptionFromTikTokPage(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), IG_FETCH_TIMEOUT_MS);
  let html;
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': MOBILE_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } finally {
    clearTimeout(tid);
  }

  // TikTok embeds post data in inline JSON as "desc":"<caption text>"
  // The caption contains \uXXXX escapes so JSON.parse handles unicode correctly.
  const descMatch = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!descMatch) throw new Error('No "desc" field found in TikTok page HTML');

  // JSON-unescape the captured string (handles \u0026, \u002F, emoji escapes, etc.)
  let caption;
  try {
    caption = JSON.parse('"' + descMatch[1] + '"');
  } catch {
    caption = descMatch[1]; // use raw if unescape fails
  }
  caption = caption.trim();
  if (!caption) throw new Error('TikTok "desc" field was empty');

  // TikTok CDN URLs are IP-signed — fetch and embed as a data URI so the
  // mobile app can load it regardless of egress IP.
  // Try multiple strategies in order of reliability:
  //   1. og:image meta tag
  //   2. "originCover" in embedded JSON (highest quality, no watermark)
  //   3. "cover" in embedded JSON
  //   4. <link rel="preload" as="image"> tag
  let rawThumbnail = '';

  const ogImage = extractOgMeta(html, 'og:image');
  if (ogImage) {
    rawThumbnail = ogImage;
    console.log('[Thumbnail] Source: og:image');
  }

  if (!rawThumbnail) {
    const originCoverMatch = html.match(/"originCover"\s*:\s*"(https?:[^"]+)"/);
    if (originCoverMatch) {
      rawThumbnail = JSON.parse('"' + originCoverMatch[1] + '"');
      console.log('[Thumbnail] Source: originCover JSON');
    }
  }

  if (!rawThumbnail) {
    // "cover" is common but also matches unrelated fields — anchor to video object
    const coverMatch = html.match(/"video"\s*:\s*\{[^}]{0,300}"cover"\s*:\s*"(https?:[^"]+)"/)
      ?? html.match(/"cover"\s*:\s*"(https?:\/\/[^"]+\.(?:jpeg|jpg|png|webp)[^"]*)"/i);
    if (coverMatch) {
      rawThumbnail = JSON.parse('"' + coverMatch[1] + '"');
      console.log('[Thumbnail] Source: cover JSON');
    }
  }

  if (!rawThumbnail) {
    const preloadMatch = html.match(/<link[^>]+rel="preload"[^>]+as="image"[^>]+href="([^"]+)"/i)
      ?? html.match(/<link[^>]+href="([^"]+)"[^>]+rel="preload"[^>]+as="image"/i);
    if (preloadMatch) {
      rawThumbnail = preloadMatch[1];
      console.log('[Thumbnail] Source: preload link');
    }
  }

  if (!rawThumbnail) {
    console.log('[Thumbnail] No thumbnail URL found in TikTok page — tried og:image, originCover, cover, preload link');
  }

  const thumbnail = await fetchThumbnailAsDataUrl(rawThumbnail);

  const firstLine = caption.split('\n').find(l => l.trim()) ?? '';
  const title = firstLine.slice(0, 100).trim();

  return { caption, title, thumbnail, uploader: '' };
}

/**
 * Extracts caption + metadata from a social video URL.
 * - Instagram: HTML scrape (og:title) first → yt-dlp fallback
 * - TikTok:    HTML scrape (og:description) first → yt-dlp fallback
 * - YouTube:   yt-dlp directly
 *
 * @param {string} videoUrl
 * @returns {Promise<{ caption: string, title: string, thumbnail: string, uploader: string }>}
 */
export async function extractCaptionFromVideoUrl(videoUrl) {
  if (isInstagramUrl(videoUrl)) {
    try {
      const result = await extractCaptionFromInstagramPage(videoUrl);
      if (result.caption) {
        console.log('[VideoImport] Instagram caption retrieved via HTML scrape');
        return result;
      }
    } catch (err) {
      console.warn('[VideoImport] Instagram HTML scrape failed, trying yt-dlp:', err.message);
    }
    return extractCaptionViaYtDlp(videoUrl);
  }

  if (isTikTokUrl(videoUrl)) {
    try {
      const result = await extractCaptionFromTikTokPage(videoUrl);
      if (result.caption) {
        console.log('[VideoImport] TikTok caption retrieved via HTML scrape');
        return result;
      }
    } catch (err) {
      console.warn('[VideoImport] TikTok HTML scrape failed, trying yt-dlp:', err.message);
    }
    return extractCaptionViaYtDlp(videoUrl);
  }

  // YouTube, etc.
  return extractCaptionViaYtDlp(videoUrl);
}

// ---------------------------------------------------------------------------
// Gemini 2.0 Flash recipe parser
// ---------------------------------------------------------------------------

// Clients are created lazily so the server can start without crashing when
// GEMINI_API_KEY has not been set yet.
let _genai = null;
function getGenAI() {
  if (!_genai) _genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genai;
}

let _fileManager = null;
function getFileManager() {
  if (!_fileManager) _fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
  return _fileManager;
}

const SYSTEM_PROMPT = `You are a recipe extraction assistant. The user will give you the caption or description text from a social media cooking video (TikTok or Instagram). Your job is to extract a structured recipe from that text if one exists.

Output ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "found": true | false,
  "title": "string — recipe name",
  "servings": number | null,
  "prepTime": number | null,   // minutes
  "cookTime": number | null,   // minutes
  "cuisine": "string | null",
  "tags": ["string"],
  "ingredients": [
    {
      "name": "string — ingredient name only, no quantity",
      "quantity": number | null,
      "unit": "string — e.g. g, ml, cup, tbsp, tsp, oz, lb, kg, pcs — or empty string",
      "prepNote": "string — e.g. diced, softened — or empty string"
    }
  ],
  "instructions": ["string — one step per element"],
  "notes": "string | null"
}

Rules:
- If no recipe is found in the text, return { "found": false } and nothing else.
- Quantities must be numbers (convert fractions: ½ → 0.5, ¼ → 0.25).
- Split compound ingredients onto separate lines ("salt and pepper" → two items).
- Keep ingredient names clean — no quantities in the name field.
- Instructions should be separate steps. If the text has no clear steps, infer logical steps from the ingredient list.
- Output English regardless of the input language.`;

// ---------------------------------------------------------------------------
// Audio transcription fallback — Gemini Files API
// ---------------------------------------------------------------------------

const YTDLP_AUDIO_TIMEOUT_MS = 90_000; // 90s — download can be slow on cold starts

// Extension → MIME type for Gemini Files API
const AUDIO_MIME_MAP = {
  m4a:  'audio/mp4',
  mp4:  'video/mp4',
  webm: 'video/webm',
  opus: 'audio/ogg',
  ogg:  'audio/ogg',
  aac:  'audio/aac',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  flac: 'audio/flac',
};

const AUDIO_RECIPE_PROMPT = `You are a recipe extraction assistant. The audio you are given is from a cooking video — the host speaks the recipe aloud, listing ingredients and method steps.

Extract the recipe from the spoken content.

Output ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "found": true | false,
  "title": "string — recipe name",
  "servings": number | null,
  "prepTime": number | null,
  "cookTime": number | null,
  "cuisine": "string | null",
  "tags": ["string"],
  "ingredients": [
    {
      "name": "string — ingredient name only, no quantity",
      "quantity": number | null,
      "unit": "string — e.g. g, ml, cup, tbsp, tsp, oz, lb, kg, pcs — or empty string",
      "prepNote": "string — e.g. diced, softened — or empty string"
    }
  ],
  "instructions": ["string — one step per element"],
  "notes": "string | null"
}

Rules:
- If no recipe is present in the audio, return { "found": false } and nothing else.
- Quantities must be numbers (convert fractions: ½ → 0.5, ¼ → 0.25).
- Split compound ingredients onto separate lines ("salt and pepper" → two items).
- Keep ingredient names clean — no quantities in the name field.
- Instructions should be separate steps.
- Output English regardless of the input language.`;

/**
 * Downloads the audio from a social video URL using yt-dlp, uploads it to
 * the Gemini Files API, and asks Gemini to extract a structured recipe from
 * the spoken content.
 *
 * Used as a fallback when the post caption contains no recipe — i.e. the
 * creator speaks the recipe aloud in the video rather than writing it in
 * the post description.
 *
 * @param {string} videoUrl
 * @param {string} [fallbackThumbnail]  Thumbnail already obtained from the caption path
 * @returns {Promise<object | null>}  ImportedRecipe-shaped object, or null
 */
export async function extractRecipeFromAudio(videoUrl, fallbackThumbnail = '') {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const tmpBase = join(tmpdir(), `recipe-audio-${Date.now()}`);
  let tmpPath = null;

  // ── Step 1: Download audio stream via yt-dlp ──────────────────────────────
  console.log('[AudioImport] Downloading audio from:', videoUrl.slice(0, 80));
  try {
    await execFileAsync(
      'yt-dlp',
      [
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '-o', `${tmpBase}.%(ext)s`,
        '--no-playlist',
        '--user-agent', MOBILE_UA,
        videoUrl,
      ],
      { timeout: YTDLP_AUDIO_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = String(err?.message || err?.stderr || '');
    console.error('[AudioImport] yt-dlp download failed:', msg.slice(0, 200));
    throw new Error('Audio download failed: ' + msg.slice(0, 120));
  }

  // Find the downloaded file — yt-dlp replaces %(ext)s with the actual extension
  for (const ext of Object.keys(AUDIO_MIME_MAP)) {
    const candidate = `${tmpBase}.${ext}`;
    try {
      await fs.access(candidate);
      tmpPath = candidate;
      break;
    } catch {
      // try next extension
    }
  }

  if (!tmpPath) {
    throw new Error('Audio download produced no output file — unknown extension.');
  }

  const { size } = await fs.stat(tmpPath);
  console.log('[AudioImport] Downloaded:', tmpPath.split(/[\/\\]/).pop(), `(${(size / 1024).toFixed(0)} KB)`);

  // ── Step 2: Upload to Gemini Files API ────────────────────────────────────
  const ext = tmpPath.split('.').pop()?.toLowerCase() ?? 'm4a';
  const mimeType = AUDIO_MIME_MAP[ext] ?? 'audio/mp4';

  let geminiFile;
  try {
    const uploadResult = await getFileManager().uploadFile(tmpPath, {
      mimeType,
      displayName: 'recipe-audio',
    });
    geminiFile = uploadResult.file;
    console.log('[AudioImport] Uploaded to Gemini Files API:', geminiFile.name, 'state:', geminiFile.state);

    // Wait for ACTIVE state (usually instant for short audio; video takes a few seconds)
    let attempts = 0;
    while (geminiFile.state === 'PROCESSING' && attempts < 15) {
      await new Promise(r => setTimeout(r, 2000));
      geminiFile = await getFileManager().getFile(geminiFile.name);
      attempts++;
    }
    if (geminiFile.state !== 'ACTIVE') {
      throw new Error(`Gemini file never became ACTIVE (state: ${geminiFile.state})`);
    }
  } finally {
    // Always delete local temp file regardless of upload success
    await fs.unlink(tmpPath).catch(() => {});
  }

  // ── Step 3: Ask Gemini to extract the recipe from the spoken audio ─────────
  let responseText;
  try {
    const model = getGenAI().getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });
    const result = await model.generateContent([
      { fileData: { fileUri: geminiFile.uri, mimeType: geminiFile.mimeType } },
      { text: AUDIO_RECIPE_PROMPT },
    ]);
    responseText = result.response.text().trim();
  } finally {
    // Delete the uploaded file from Gemini — it auto-expires in 48h but clean up immediately
    await getFileManager().deleteFile(geminiFile.name).catch(() => {});
  }

  // ── Step 4: Parse JSON response ────────────────────────────────────────────
  let parsed;
  try {
    const clean = responseText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('[AudioImport] LLM returned non-JSON:', responseText.slice(0, 300));
    return null;
  }

  if (!parsed?.found) {
    console.log('[AudioImport] No recipe found in audio.');
    return null;
  }

  console.log('[AudioImport] ✅ Recipe extracted from audio:', parsed.title, '| ingredients:', parsed.ingredients?.length);

  return {
    title: String(parsed.title || 'Imported Recipe').trim(),
    thumbnail: fallbackThumbnail || '',
    prepTime: Number(parsed.prepTime) || 0,
    cookTime: Number(parsed.cookTime) || 0,
    servings: Number(parsed.servings) || 1,
    cuisine: parsed.cuisine || '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [],
    ingredients: (parsed.ingredients || []).map(ing => ({
      name: String(ing.name || '').trim(),
      quantity: ing.quantity != null ? Number(ing.quantity) : 1,
      unit: String(ing.unit || '').trim(),
      prepNote: String(ing.prepNote || '').trim() || undefined,
    })).filter(ing => ing.name),
    instructions: (parsed.instructions || []).map(s => String(s).trim()).filter(Boolean),
    notes: parsed.notes ? String(parsed.notes).trim() : '',
    importUrl: '',  // filled in at route level
  };
}

/**
 * Sends caption text to Gemini 2.0 Flash and returns a parsed recipe or null.
 *
 * @param {string} captionText
 * @returns {Promise<object | null>} ImportedRecipe-shaped object, or null if no recipe found
 */
export async function parseCaptionWithLLM(captionText) {
  if (!captionText || captionText.trim().length < 10) return null;

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  let responseText;
  try {
    const model = getGenAI().getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });
    const result = await model.generateContent(
      SYSTEM_PROMPT + '\n\nCaption text:\n' + captionText.slice(0, 8000),
    );
    responseText = result.response.text().trim();
  } catch (err) {
    console.error('[VideoImport] Gemini API error:', err?.message);
    throw new Error('Gemini API call failed: ' + (err?.message || 'unknown error'));
  }

  let parsed;
  try {
    // Strip markdown code fences in case the model ignores responseMimeType
    const clean = responseText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('[VideoImport] LLM returned non-JSON:', responseText.slice(0, 300));
    return null;
  }

  if (!parsed?.found) return null;

  // Normalise into the same shape extractRecipe.js produces
  return {
    title: String(parsed.title || 'Imported Recipe').trim(),
    thumbnail: '',   // yt-dlp thumbnail is passed through separately at the route level
    prepTime: Number(parsed.prepTime) || 0,
    cookTime: Number(parsed.cookTime) || 0,
    servings: Number(parsed.servings) || 1,
    cuisine: parsed.cuisine || '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [],
    ingredients: (parsed.ingredients || []).map(ing => ({
      name: String(ing.name || '').trim(),
      quantity: ing.quantity != null ? Number(ing.quantity) : 1,
      unit: String(ing.unit || '').trim(),
      prepNote: String(ing.prepNote || '').trim() || undefined,
    })).filter(ing => ing.name),
    instructions: (parsed.instructions || []).map(s => String(s).trim()).filter(Boolean),
    notes: parsed.notes ? String(parsed.notes).trim() : '',
    importUrl: '',  // filled in at route level
  };
}
