import express from 'express';
import bodyParser from 'body-parser';
import rateLimit from 'express-rate-limit';
import { extractRecipeFromUrl } from './utils/extractRecipe.js';
import {
  isSocialVideoUrl,
  extractCaptionFromVideoUrl,
  parseCaptionWithLLM,
  extractRecipeFromAudio,
} from './utils/extractVideoRecipe.js';
import { validateRecipeUrl } from './utils/urlValidator.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 45000);
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_IMPORT_TIMEOUT_MS || 120000);

// ── CORS ───────────────────────────────────────────────────────────────────
// Mobile clients (iOS/Android) do not send an Origin header, so traditional
// CORS restrictions don't apply. We still set these headers so browser-based
// callers (e.g. future web app) receive explicit policy.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Import-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(bodyParser.json({ limit: '20mb' }));

// ── Authentication ─────────────────────────────────────────────────────────
// Requires a pre-shared secret sent by the mobile app as X-Import-Secret.
// Set IMPORT_SECRET in Railway env vars. When unset (local dev), auth is skipped.
const IMPORT_SECRET = process.env.IMPORT_SECRET || '';

function requireAuth(req, res, next) {
  if (!IMPORT_SECRET) return next(); // Dev mode: no secret configured
  const provided = req.headers['x-import-secret'];
  if (!provided || provided !== IMPORT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Rate limiting ──────────────────────────────────────────────────────────
const standardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const videoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ── POST /import — existing web recipe import (unchanged) ──────────────────
app.post('/import', requireAuth, standardLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    validateRecipeUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const recipe = await extractRecipeFromUrl(url, {
      signal: controller.signal,
      timeoutMs: Math.max(15000, REQUEST_TIMEOUT_MS - 3000),
    });

    return res.json(recipe);
  } catch (error) {
    console.error('❌ Error extracting recipe:', error.message);

    const message = String(error?.message || '');
    const code = String(error?.code || '');

    if (/timeout|aborted|canceled/i.test(message) || code === 'ERR_CANCELED') {
      return res.status(504).json({ error: 'Importer timed out while fetching/parsing recipe' });
    }

    return res.status(500).json({ error: 'Failed to extract recipe' });
  } finally {
    clearTimeout(timeoutId);
  }
});

// ── POST /import-video — TikTok / Instagram caption-based recipe import ────
//
// Flow:
//   1. Caption extraction: HTML scrape (Instagram/TikTok) or yt-dlp --dump-json
//   2. Gemini parses caption text → structured recipe JSON
//   3. Audio fallback (if caption yields no recipe): yt-dlp downloads audio,
//      uploaded to Gemini Files API, Gemini extracts recipe from spoken content.
//      This handles creators who speak the recipe aloud in the video.
//
// Responses:
//   200 { ...recipe }               — recipe found and parsed
//   200 { error: 'no_recipe', caption: string }  — yt-dlp worked but LLM found no recipe
//   200 { error: 'no_caption', caption: '' }     — yt-dlp found no usable caption
//   400                             — missing / non-social URL
//   504                             — timeout
//   500                             — unexpected error
app.post('/import-video', requireAuth, videoLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (!isSocialVideoUrl(url)) {
    return res.status(400).json({ error: 'URL is not a supported social video URL (TikTok or Instagram)' });
  }

  const timedOut = { value: false };
  const timeoutId = setTimeout(() => {
    timedOut.value = true;
  }, VIDEO_TIMEOUT_MS);

  try {
    // Step 1: extract caption via yt-dlp
    let captionData;
    try {
      captionData = await extractCaptionFromVideoUrl(url);
    } catch (err) {
      console.error('[VideoImport] yt-dlp error:', err.message);
      return res.status(500).json({ error: err.message });
    }

    if (timedOut.value) {
      return res.status(504).json({ error: 'Video import timed out during caption extraction' });
    }

    const { caption, title, thumbnail, uploader } = captionData;

    // Step 2: parse caption text with Gemini
    let recipe = null;
    if (caption) {
      try {
        recipe = await parseCaptionWithLLM(caption);
      } catch (err) {
        console.error('[VideoImport] LLM error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (timedOut.value) {
        return res.status(504).json({ error: 'Video import timed out during recipe parsing' });
      }
    } else {
      console.log('[VideoImport] No caption found for:', url);
    }

    // Step 3: Audio fallback — triggered when caption was empty or contained no recipe.
    // Downloads the audio track and lets Gemini extract the recipe from spoken content.
    if (!recipe) {
      const reason = caption ? 'caption had no recipe' : 'no caption';
      console.log(`[VideoImport] ${reason} — attempting audio transcription fallback for:`, url);
      try {
        recipe = await extractRecipeFromAudio(url, thumbnail);
      } catch (audioErr) {
        console.warn('[VideoImport] Audio fallback failed:', audioErr.message);
      }
      if (timedOut.value) {
        return res.status(504).json({ error: 'Video import timed out during audio extraction' });
      }
    }

    if (!recipe) {
      // Both caption and audio paths found nothing — return the caption so the
      // user can edit it manually in the app.
      console.log('[VideoImport] No recipe found via caption or audio for:', url);
      return res.json({ error: caption ? 'no_recipe' : 'no_caption', caption: caption || '' });
    }

    // Merge in metadata yt-dlp provided but the LLM didn't fill
    recipe.thumbnail = recipe.thumbnail || thumbnail;
    recipe.title = recipe.title || title || `Recipe by ${uploader}`;
    recipe.importUrl = url;

    const thumbType = recipe.thumbnail?.startsWith('data:') ? `base64(${recipe.thumbnail.length} chars)` : (recipe.thumbnail ? `url(${recipe.thumbnail.slice(0, 80)})` : 'NONE');
    console.log('[VideoImport] ✅ Recipe parsed:', recipe.title, '| ingredients:', recipe.ingredients?.length, '| thumbnail:', thumbType);
    return res.json(recipe);

  } catch (err) {
    console.error('[VideoImport] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Failed to import video recipe' });
  } finally {
    clearTimeout(timeoutId);
  }
});

// ── POST /parse-caption — parse raw caption text into a recipe ─────────────
//
// Used by the app's fallback caption editor: user has edited the raw caption
// and taps "Parse Recipe", which hits this endpoint.
//
// Responses:
//   200 { ...recipe }               — recipe found
//   200 { error: 'no_recipe' }      — LLM found no recipe in the text
//   400                             — missing text
//   500                             — API error
app.post('/parse-caption', requireAuth, videoLimiter, async (req, res) => {
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  try {
    const recipe = await parseCaptionWithLLM(text);

    if (!recipe) {
      return res.json({ error: 'no_recipe' });
    }

    console.log('[ParseCaption] ✅ Recipe parsed:', recipe.title, '| ingredients:', recipe.ingredients?.length);
    return res.json(recipe);
  } catch (err) {
    console.error('[ParseCaption] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to parse caption' });
  }
});

// ── POST /parse-receipt — Gemini vision receipt → pantry items ─────────────
//
// Receives a base64-encoded grocery receipt image, passes it to Gemini 2.0
// Flash vision, and returns a structured list of grocery items.
//
// Request body: { image: "<base64 string>", mimeType: "image/jpeg" | "image/png" }
// Response 200: { items: [{ name, quantity, unit, barcode? }] }
// Response 400: missing image
// Response 500: Gemini error
const RECEIPT_SYSTEM_PROMPT = `You are a grocery receipt parser. Analyse the receipt image and extract every purchased food or drink item.

Output ONLY valid JSON — no markdown, no explanation:
{
  "items": [
    {
      "name": "string — generic pantry ingredient name (see rules and examples below)",
      "quantity": number — numeric quantity (weight in grams if sold by weight, count otherwise),
      "unit": "string — g | ml | pcs",
      "barcode": "string | null — EAN/UPC barcode number if printed on the receipt, else null"
    }
  ]
}

Name rules — reduce every product to its simplest generic pantry ingredient name:
- Remove ALL brand/store prefixes: WW, Woolworths, Coles, Aldi, IGA, Macro, Homebrand, Select, Essentials, Devondale, Sanitarium, Uncle Tobys, San Remo, Leggo's, Praise, Continental, Schwartz, MasterFoods, etc.
- Remove pack size, weight, volume: "2L", "500g", "12pk", "6x", "1kg", "375ml" etc.
- Remove descriptors that specify the product variant ONLY IF a simpler catalog name exists:
    e.g. "Extra Virgin Olive Oil" → "olive oil"  |  "Full Cream Milk" → "full cream milk"  |  "Greek Style Yoghurt" → "greek yogurt"
- Keep descriptors that meaningfully distinguish items in a pantry:
    "baby spinach" NOT "spinach" when that's what was bought  |  "cherry tomato" vs "tomato"  |  "chicken breast" vs "chicken thigh"
- Remove trailing tax/weight codes: " D", " A", " C ea", " T", " *"
- Output English names regardless of receipt language
- Use lowercase names

Examples (receipt text → name output):
  "WW Full Cream Milk 2L"              → "full cream milk"
  "Coles Chicken Breast 500g"          → "chicken breast"
  "Macro Org Free Range Eggs 12pk"     → "egg"
  "EVOO Spray 200ml"                   → "cooking spray"
  "San Remo Penne 500g"               → "penne"
  "Devondale Butter Unsalted 250g"     → "butter"
  "WW Baby Spinach 120g"               → "baby spinach"
  "Coles Greek Yoghurt 1kg"            → "greek yogurt"
  "MasterFoods Garlic Powder 55g"      → "garlic powder"
  "Coles Diced Tomatoes 400g"          → "canned tomato"
  "WW Frozen Peas 1kg"                 → "frozen peas"
  "Coles Sour Cream 300ml"             → "sour cream"
  "Coca Cola Zero 1.25L"               → "coke zero"
  "Red Rock Deli Sea Salt Chips 165g"  → "chips"
  "Lurpak Butter 500g"                 → "butter"
  "Woolworths Select Pasta Sauce 500g" → "pasta sauce"
  "Continental Chicken Stock 1L"       → "chicken stock"
  "Coles Panko Breadcrumbs 200g"       → "breadcrumb"

Ignore (do not include in output):
- Store name, date, time, cashier, terminal, loyalty points, receipts numbers
- Total, subtotal, GST, VAT, tax, change, EFTPOS, card payment lines
- Non-food items: batteries, cleaning products, clothing, cosmetics
- Discount/savings lines

If the receipt is unreadable or contains no food items, return { "items": [] }`;


let _receiptGenAI = null;
function getReceiptGenAI() {
  if (!_receiptGenAI) _receiptGenAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _receiptGenAI;
}

app.post('/parse-receipt', requireAuth, standardLimiter, async (req, res) => {
  const { image, mimeType = 'image/jpeg' } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'No image provided' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server' });
  }

  try {
    const model = getReceiptGenAI().getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    });

    const result = await model.generateContent([
      { text: RECEIPT_SYSTEM_PROMPT },
      { inlineData: { mimeType, data: image } },
    ]);

    const responseText = result.response.text().trim();

    let parsed;
    try {
      const clean = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(clean);
    } catch {
      console.error('[ParseReceipt] Gemini returned non-JSON:', responseText.slice(0, 200));
      return res.status(500).json({ error: 'Gemini returned unparseable response' });
    }

    const items = (parsed?.items || []).filter(
      (i) => i?.name && String(i.name).trim().length > 1,
    );

    console.log('[ParseReceipt] ✅ Parsed', items.length, 'items');
    return res.json({ items });
  } catch (err) {
    console.error('[ParseReceipt] Error:', err?.message);
    return res.status(500).json({ error: err?.message || 'Failed to parse receipt' });
  }
});

// ── POST /parse-recipe-image — Gemini vision recipe → structured recipe ──────
//
// Receives a base64-encoded photo of a recipe (cookbook page, recipe card,
// handwritten note, etc.), passes it to Gemini 2.5 Flash vision, and returns
// a fully structured recipe ready for the app to preview and save.
//
// Request body: { image: "<base64 string>", mimeType: "image/jpeg" | "image/png" }
// Response 200: { found: true, title, servings, prepTime, cookTime, cuisine,
//                tags, ingredients, instructions, notes }
//           OR: { found: false }   — no recipe visible in image
// Response 400: missing image
// Response 500: Gemini error
const RECIPE_IMAGE_PROMPT = `You are a recipe extraction assistant. The image shows a recipe — it may be a cookbook page, recipe card, handwritten note, or magazine cut-out.

Extract the complete recipe from the image.

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
      "unit": "string — g, ml, cup, tbsp, tsp, oz, lb, kg, pcs — or empty string",
      "prepNote": "string — e.g. diced, softened — or empty string"
    }
  ],
  "instructions": ["string — one step per element"],
  "notes": "string | null"
}

Rules:
- If no recipe is visible in the image, return { "found": false } and nothing else.
- Quantities must be numbers. Convert fractions: \u00bd \u2192 0.5, \u00bc \u2192 0.25, \u2153 \u2192 0.333, \u2154 \u2192 0.667, \u00be \u2192 0.75.
- Split truly separate ingredients onto separate lines ("salt and pepper" \u2192 two items).
- Do NOT split "X or Y" alternatives — they are the SAME ingredient with a substitution option. Example: "1/3 cup butter or oil" \u2192 ONE item with name "butter", prepNote "or oil". Keep name as the primary/first option.
- Keep ingredient names clean — no quantities in the name field.
- prepTime and cookTime must be in minutes.
- Output English regardless of the language in the image.`;

app.post('/parse-recipe-image', requireAuth, standardLimiter, async (req, res) => {
  const { image, mimeType = 'image/jpeg' } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'No image provided' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server' });
  }

  try {
    const model = getReceiptGenAI().getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    });

    const result = await model.generateContent([
      { text: RECIPE_IMAGE_PROMPT },
      { inlineData: { mimeType, data: image } },
    ]);

    const responseText = result.response.text().trim();

    let parsed;
    try {
      const clean = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error('[ParseRecipeImage] Gemini returned non-JSON:', responseText.slice(0, 200));
      return res.status(500).json({ error: 'Gemini returned unparseable response' });
    }

    if (!parsed?.found) {
      console.log('[ParseRecipeImage] No recipe detected in image.');
      return res.json({ found: false });
    }

    // Sanitise / coerce the response so the app always receives a consistent shape
    const recipe = {
      found: true,
      title: String(parsed.title || 'Scanned Recipe').trim(),
      servings: Number(parsed.servings) || null,
      prepTime: Number(parsed.prepTime) || null,
      cookTime: Number(parsed.cookTime) || null,
      cuisine: parsed.cuisine ? String(parsed.cuisine).trim() : null,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [],
      ingredients: (parsed.ingredients || []).map(ing => ({
        name: String(ing.name || '').trim(),
        quantity: ing.quantity != null ? Number(ing.quantity) : null,
        unit: String(ing.unit || '').trim(),
        prepNote: String(ing.prepNote || '').trim() || undefined,
      })).filter(ing => ing.name),
      instructions: (parsed.instructions || []).map(s => String(s).trim()).filter(Boolean),
      notes: parsed.notes ? String(parsed.notes).trim() : null,
    };

    console.log('[ParseRecipeImage] \u2705 Parsed recipe:', recipe.title, '| ingredients:', recipe.ingredients.length, '| steps:', recipe.instructions.length);
    return res.json(recipe);
  } catch (err) {
    console.error('[ParseRecipeImage] Error:', err?.message);
    return res.status(500).json({ error: err?.message || 'Failed to parse recipe image' });
  }
});

// ── GET /health — quick liveness check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    node: process.version,
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV || 'development',
    firebaseConfigured: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    ts: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
