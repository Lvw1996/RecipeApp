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

    // Upstream site rejected the server's request (e.g. Cloudflare bot protection
    // on Railway's datacenter IPs). Return 422 so the app knows this is an upstream
    // block rather than a server crash, and can fall back to the on-device parser.
    const upstreamStatus = error?.response?.status;
    if (upstreamStatus === 403 || upstreamStatus === 401 || upstreamStatus === 429) {
      console.warn(`⚠️  Upstream site blocked the request (HTTP ${upstreamStatus}) — app will fall back to built-in parser`);
      return res.status(422).json({ error: `Upstream site blocked the request (HTTP ${upstreamStatus})` });
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
    if (!recipe.author && uploader) recipe.author = uploader;

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
      "name": "string — generic pantry ingredient name in English (see rules below)",
      "quantity": number — purchased quantity: grams when sold by weight, millilitres when sold by volume, whole number count otherwise,
      "unit": "string — g | ml | pcs",
      "barcode": "string | null — EAN/UPC barcode number if printed on the receipt, else null"
    }
  ]
}

════════════════════════════════════════
QUANTITY RULES
════════════════════════════════════════
Receipts often show weight-sold items as:  <weight> x <price-per-kg>
e.g.  "0.984 x 14,99"  means 0.984 kg was purchased.

- If sold by weight (kg on receipt): multiply kg × 1000 → output grams (g)
    0.984 kg  →  quantity: 984,  unit: "g"
    1.2 kg    →  quantity: 1200, unit: "g"
- If sold by volume (L on receipt): multiply L × 1000 → output millilitres (ml)
    1 L       →  quantity: 1000, unit: "ml"
    0.5 L     →  quantity: 500,  unit: "ml"
- If the pack already states grams/ml on its label (e.g. "500G", "P0500G"), use that number directly.
- If sold by count (eggs, bread loaf, etc.): output the count as a whole number, unit: "pcs"
    "6 x 0.86"  (6 items)  →  quantity: 6,  unit: "pcs"
- When a line shows "N x price" and N is clearly a count multiplier (integer, small number), use N as the count.

════════════════════════════════════════
NAME RULES
════════════════════════════════════════
Reduce every product name to its simplest generic pantry ingredient name in English lowercase.

1. STRIP store/brand prefixes and suffixes.
   Common prefixes that mean nothing: C, E, G, M, B (single-letter category codes)
   Australian: WW, Woolworths, Coles, Aldi, IGA, Macro, Homebrand, Select, Essentials,
               Devondale, Sanitarium, Uncle Tobys, San Remo, Leggo's, Praise, Continental,
               Schwartz, MasterFoods
   European:   PD, PDOCE (Pingo Doce), CONT (Continente), LIDL, ALDI, MERC (Mercadona),
               CARR (Carrefour), ICA, REWE, EDEKA, TESCO, SAINSBURY, WAITROSE, M&S, ASDA,
               SPAR, CONAD, ESSELUNGA, DIA, EROSKI, AH (Albert Heijn), JUMBO, DELHAIZE,
               COLRUYT, PICARD, LECLERC, INTERMARCHE, CASINO, MONOPRIX, FRANPRIX

2. STRIP size/weight/volume codes embedded in the name:
   "500G", "1KG", "P0500G", "PO400G", "1L", "12UN", "6X", "200ML", "1KG", "350G" etc.

3. STRIP receipt abbreviation codes that are NOT part of the ingredient:
   ATP, TC, PK, SAC (= bag/sack), SLT (= salted), C/QUI, S/OS, GL, FAT (= sliced), FORM,
   UHT, M/G (= full fat), MET, TUN, SOLO, COSTA, POSTA (= steak/portion when used as a code)

4. TRANSLATE foreign-language ingredient words to English:
   Portuguese → English:
     FRANGO → chicken | FRANGO PEITO → chicken breast | FRANGO PERNIL → chicken leg
     VITELO / VITELLO → veal | VITELO PA E ACEM → veal shoulder | LOMBO → loin
     SALMAO / SALMÃO → salmon | ATUM → tuna | BACALHAU → cod | PESCADA → hake
     CEBOLA → onion | TOMATE → tomato | POLPA TOMATE → tomato passata
     ARROZ → rice | ARROZ BASMATI → basmati rice
     PAO / PÃO → bread | PAO FORMA → sandwich bread | PAO HAMBURGUER → burger bun
     LEITE → milk | MANTEIGA → butter | OVO / OVOS → egg | QUEIJO → cheese
     CENOURA → carrot | BATATA → potato | ALHO → garlic | COUVE → cabbage
     ESPINAFRES → spinach | ERVILHAS → peas | FEIJAO → beans | LENTILHAS → lentils
     FIAMBRE → ham | PRESUNTO → prosciutto/cured ham | LINGUICA → chorizo sausage
     AZEITE → olive oil | OLEO → oil | VINAGRE → vinegar | SAL → salt
     ACUCAR → sugar | FARINHA → flour | OVOS → eggs | NATAS → cream
     IOGURTE → yogurt | MANTEIGA → butter | REQUEIJAO → ricotta
     LEGUMES → vegetables | MISTURA → mixed | CONGELADOS → frozen
     OREGAO / OREGAOS → oregano | COMINHOS → cumin | PIMENTA → pepper
   Spanish: POLLO → chicken | TERNERA → veal/beef | LECHE → milk | HUEVOS → eggs
            TOMATE → tomato | ACEITE → oil | HARINA → flour | ARROZ → rice
   French: POULET → chicken | LAIT → milk | OEUFS → eggs | BEURRE → butter
           FARINE → flour | POMME DE TERRE → potato | TOMATE → tomato
   German: HÄHNCHEN → chicken | MILCH → milk | EIER → eggs | BUTTER → butter
           MEHL → flour | KARTOFFEL → potato | KAROTTE → carrot
   Italian: POLLO → chicken | LATTE → milk | UOVA → eggs | BURRO → butter

5. KEEP descriptors that distinguish meaningful pantry variants:
   "chicken breast" not just "chicken" | "salmon steak" vs "salmon fillet"
   "full cream milk" | "basmati rice" | "cherry tomato" | "greek yogurt"
   "baby spinach" | "veal shoulder" | "chicken thigh"

6. SIMPLIFY where a generic name is more useful than an overly specific one:
   "extra virgin olive oil" → "olive oil"
   "panko breadcrumbs" → "breadcrumb"
   "diced canned tomatoes" → "canned tomato"

════════════════════════════════════════
EXAMPLES
════════════════════════════════════════
Receipt line (any language)             → name | qty | unit
─────────────────────────────────────────────────────────────
"WW Full Cream Milk 2L"                → "full cream milk"       | 2000 | ml
"Coles Chicken Breast 500g"            → "chicken breast"        |  500 | g
"Macro Org Free Range Eggs 12pk"       → "egg"                   |   12 | pcs
"San Remo Penne 500g"                  → "penne"                 |  500 | g
"Devondale Butter Unsalted 250g"       → "butter"                |  250 | g
"WW Baby Spinach 120g"                 → "baby spinach"          |  120 | g
"Coles Greek Yoghurt 1kg"              → "greek yogurt"          | 1000 | g
"MasterFoods Garlic Powder 55g"        → "garlic powder"         |   55 | g
"Coles Diced Tomatoes 400g"            → "canned tomato"         |  400 | g
"Continental Chicken Stock 1L"         → "chicken stock"         | 1000 | ml
"C L UHT M/G PDOCE 1L"               → "full cream milk"       | 1000 | ml
"C SALMAO POSTA KG  0.984 x 14,99"   → "salmon"                |  984 | g
"C FRANGO PERKIN ATP PD  0.705x4,99" → "chicken"               |  705 | g
"C FRANGO PEITO TC  2.402 x 7,49"    → "chicken breast"        | 2402 | g
"C VITELO PA E ACEM  0.612 x 13,99"  → "veal shoulder"         |  612 | g
"C ATUM GL COSTA 1G"                  → "tuna"                  |    1 | pcs
"G POLPA TOMATE PD 500G"              → "tomato passata"        |  500 | g
"C ARROZ BASMATI PD"                  → "basmati rice"          |    1 | pcs
"G PAO FORMA PD 600G"                 → "sandwich bread"        |  600 | g
"C CEBOLA SAC 1KG PD"                 → "onion"                 | 1000 | g
"C DV L SOLO PD 12UN"                 → "egg"                   |   12 | pcs
"C QJ FAT PO 200G"                    → "cheese"                |  200 | g
"C LEG SLT C/QUI P0350G"              → "vegetables"            |  350 | g
"C MIST VEG SLT PD400G"               → "mixed vegetables"      |  400 | g
"E TEM MAN OREG PO 300G"              → "oregano"               |  300 | g
"C L UHT M/G PDOCE 1L  6 x 0,86"     → "full cream milk"       | 6000 | ml
"C HAN ANENO PD"                      → "pineapple"             |    1 | pcs
"Lurpak Butter 500g"                  → "butter"                |  500 | g
"Coca Cola Zero 1.25L"                → "coke zero"             | 1250 | ml
"WW Frozen Peas 1kg"                  → "frozen peas"           | 1000 | g

════════════════════════════════════════
DUPLICATE ITEMS — CRITICAL
════════════════════════════════════════
If the same ingredient appears as multiple SEPARATE LINE ITEMS on the receipt
(e.g. four packs of veal each with a different weight scanned individually),
output EACH as a SEPARATE object in the "items" array.
Do NOT combine, deduplicate, or sum them up.
Each physical purchase line = one entry.

Example: three veal packs on receipt → three separate items:
  { "name": "veal shoulder", "quantity": 612, "unit": "g" }
  { "name": "veal shoulder", "quantity": 616, "unit": "g" }
  { "name": "veal shoulder", "quantity": 618, "unit": "g" }

════════════════════════════════════════
IGNORE (do not include in output)
════════════════════════════════════════
- Store name, date, time, cashier, terminal, loyalty card info
- Total, subtotal, tax (IVA/GST/VAT), change, payment method lines
- Discount / savings / "Poupança" lines
- Non-food items: detergent, cleaning products, batteries, clothing, cosmetics
  (e.g. "E SOC LAVAGEM" = laundry detergent → exclude)
- Delivery fees, bag charges, loyalty point balances

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
