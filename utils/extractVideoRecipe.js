// utils/extractVideoRecipe.js
//
// Extracts recipe data from social video URLs (TikTok, Instagram) by:
//   1. Using yt-dlp to extract the video caption / description
//   2. Sending the caption to GPT-4o mini to parse it into structured recipe JSON
//
// The returned recipe shape matches what extractRecipe.js produces so the
// existing /import response handling on the app side works unchanged.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';

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
// yt-dlp caption extraction
// ---------------------------------------------------------------------------

const YTDLP_TIMEOUT_MS = 30000;

/**
 * Uses yt-dlp to fetch video metadata (no download) and returns the caption
 * text, thumbnail URL, title, and uploader name.
 *
 * @param {string} videoUrl
 * @returns {Promise<{ caption: string, title: string, thumbnail: string, uploader: string }>}
 */
export async function extractCaptionFromVideoUrl(videoUrl) {
  let stdout;
  try {
    const result = await execFileAsync(
      'yt-dlp',
      [
        '--dump-json',
        '--no-download',
        '--no-playlist',
        // Use a realistic browser UA to reduce bot detection
        '--user-agent',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        videoUrl,
      ],
      { timeout: YTDLP_TIMEOUT_MS }
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

  // yt-dlp stores the caption / post body in the "description" field.
  const caption = String(data.description || data.title || '').trim();
  const title = String(data.title || '').trim();
  const thumbnail = String(data.thumbnail || '').trim();
  const uploader = String(data.uploader || data.channel || '').trim();

  return { caption, title, thumbnail, uploader };
}

// ---------------------------------------------------------------------------
// GPT-4o mini recipe parser
// ---------------------------------------------------------------------------

const openai = new OpenAI(); // uses OPENAI_API_KEY env var automatically

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
 * Sends caption text to GPT-4o mini and returns a parsed recipe or null.
 *
 * @param {string} captionText
 * @returns {Promise<object | null>} ImportedRecipe-shaped object, or null if no recipe found
 */
export async function parseCaptionWithLLM(captionText) {
  if (!captionText || captionText.trim().length < 10) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set.');
  }

  let responseText;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: captionText.slice(0, 8000) }, // cap at 8k chars
      ],
    });
    responseText = completion.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error('[VideoImport] OpenAI API error:', err?.message);
    throw new Error('OpenAI API call failed: ' + (err?.message || 'unknown error'));
  }

  let parsed;
  try {
    // Strip any accidental markdown code fences the model might add
    const clean = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    parsed = JSON.parse(clean);
  } catch {
    console.error('[VideoImport] LLM returned non-JSON:', responseText.slice(0, 200));
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
