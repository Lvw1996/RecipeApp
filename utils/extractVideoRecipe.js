// utils/extractVideoRecipe.js
//
// Extracts recipe data from social video URLs (TikTok, Instagram, YouTube).
//
// Caption extraction strategy (recipe is always in the caption, not the audio):
//   - Instagram: HTML page scrape (og:description) first — works on public posts
//                without authentication. Falls back to yt-dlp if the scrape fails.
//   - TikTok / YouTube: yt-dlp --dump-json (metadata only, no video download).
//
// Once the caption is obtained it is sent to Gemini 2.0 Flash to parse it into
// structured recipe JSON.  The returned shape matches extractRecipe.js so the
// existing /import response handling on the app side works unchanged.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

  const thumbnail = extractOgMeta(html, 'og:image');

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

  const thumbnail = extractOgMeta(html, 'og:image');
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

// Client is created lazily so the server can start without crashing when
// GEMINI_API_KEY has not been set yet.
let _genai = null;
function getGenAI() {
  if (!_genai) _genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genai;
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
