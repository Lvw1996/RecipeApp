import axios from 'axios';
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Unit tables for ingredient parsing
// ---------------------------------------------------------------------------
const MEASURE_UNITS = [
  'tablespoons','tablespoon','tbsp',
  'teaspoons','teaspoon','tsp',
  'cups','cup',
  'fluid ounces','fluid ounce','fl oz',
  'pints','pint',
  'quarts','quart',
  'gallons','gallon',
  'milliliters','millilitres','milliliter','millilitre','ml',
  'liters','litres','liter','litre','l',
  'kilograms','kilogram','kg',
  'grams','gram','g',
  'pounds','pound','lbs','lb',
  'ounces','ounce','oz',
  'cloves','clove',
  'slices','slice',
  'sprigs','sprig',
  'bunches','bunch',
  'cans','can',
  'pinches','pinch',
  'pieces','piece','pcs',
];

const UNIT_ALIASES = {
  tablespoons: 'tbsp', tablespoon: 'tbsp',
  teaspoons: 'tsp', teaspoon: 'tsp',
  cups: 'cup',
  'fluid ounces': 'fl oz', 'fluid ounce': 'fl oz',
  pints: 'pint', quarts: 'quart', gallons: 'gallon',
  milliliters: 'ml', millilitres: 'ml', milliliter: 'ml', millilitre: 'ml',
  liters: 'l', litres: 'l', liter: 'l', litre: 'l',
  kilograms: 'kg', kilogram: 'kg',
  grams: 'g', gram: 'g',
  pounds: 'lb', pound: 'lb', lbs: 'lb',
  ounces: 'oz', ounce: 'oz',
  cloves: 'clove', slices: 'slice', sprigs: 'sprig',
  bunches: 'bunch', cans: 'can', pinches: 'pinch',
  pieces: 'pcs', piece: 'pcs',
};

const PREP_NOTE_REGEX =
  /\b(?:finely|roughly|thinly|coarsely|freshly|lightly|gently|well|loosely)\b|\b(?:minced|chopped|diced|sliced|grated|crushed|peeled|trimmed|softened|melted|divided|roasted|toasted|ground|beaten|shredded|cut|halved|quartered|rinsed|drained|cooked|thawed|heated|cooled|whipped|julienned|blanched|deveined|mashed|crumbled|warmed)\b|^(?:to taste|for serving|as needed|room temp|at room temperature)/i;

function cleanUnit(raw) {
  const lower = String(raw || '').toLowerCase().trim();
  return UNIT_ALIASES[lower] || lower;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a raw ingredient string into { name, quantity, unit, prepNote }.
 * e.g. "4 garlic cloves, finely minced"
 *   → { name:"garlic cloves", quantity:4, unit:"", prepNote:"finely minced" }
 * e.g. "750g / 1 1/2 lb lamb mince (first choice), or beef ((Note 1))"
 *   → { name:"lamb mince", quantity:750, unit:"g" }
 */
function parseIngredientString(raw) {
  let text = stripHtml(raw).replace(/^[\s•\-–]+/, '').trim();
  if (!text) return null;

  // --- Pre-clean: strip editorial notes before parsing so they don't confuse qty/unit ---
  text = text
    .replace(/\(\(note[^)]*\)\)/gi, '')          // ((Note N)) double-paren — strip both
    .replace(/\(note[^)]*\)/gi, '')               // (Note N) single-paren
    .replace(/\(see\s+notes?[^)]*\)/gi, '')       // (see note 3)
    .replace(/\(,?\s*optional[^)]*\)/gi, '')      // (optional) or (, optional...)
    .replace(/\(first\s+choice[^)]*\)/gi, '')
    .replace(/\(second\s+choice[^)]*\)/gi, '')
    .replace(/,\s*or\s+[^,(]+/gi, '')             // ", or beef"
    .replace(/\(\s*\)/g, '')                      // empty () left over from stripping
    .replace(/\s+/g, ' ')
    .trim();

  // --- Parse quantity: handles "1 1/2", "1/2", "2.5", integers ---
  const qtyMatch = text.match(/^((?:\d+\s+\d\/\d|\d+\/\d|\d*\.?\d+))\s*/);
  let quantity = 1;
  if (qtyMatch) {
    const q = qtyMatch[1].trim();
    const mixedM = q.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    const fracM = q.match(/^(\d+)\/(\d+)$/);
    if (mixedM) quantity = parseInt(mixedM[1]) + parseInt(mixedM[2]) / parseInt(mixedM[3]);
    else if (fracM) quantity = parseInt(fracM[1]) / parseInt(fracM[2]);
    else quantity = parseFloat(q) || 1;
  }
  let remainder = qtyMatch ? text.slice(qtyMatch[0].length).trim() : text;

  // --- Parse unit ---
  const unitPattern = new RegExp(`^(${MEASURE_UNITS.join('|')})\\b\\.?\\s*`, 'i');
  const unitMatch = remainder.match(unitPattern);
  const unit = unitMatch ? cleanUnit(unitMatch[1]) : '';
  if (unitMatch) remainder = remainder.slice(unitMatch[0].length).trim();

  // Strip "/ N unit alternate" dual-unit notation (RecipeTin Eats style: "750g / 1 1/2 lb …")
  if (unit) {
    remainder = remainder
      .replace(/^\/\s*[\d\s\/\.]+\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp)\b\s*/i, '')
      .trim();
  }

  // Strip dangling open/close parens left after pre-clean
  remainder = remainder.replace(/\(\s*$/, '').replace(/^\s*\)/, '').trim();

  // --- Extract prep note from trailing parenthetical: "(finely minced)" or "(, skin on...)" ---
  let prepNote = '';
  const parenMatch = remainder.match(/\s*\(\s*,?\s*([^)]+?)\s*\)\s*$/);
  if (parenMatch) {
    const inner = parenMatch[1].replace(/^,\s*/, '').trim();
    if (!/^(?:note\s*\d*|see\s+notes?|optional)/i.test(inner) && inner.length > 0) {
      prepNote = inner;
      remainder = remainder.slice(0, parenMatch.index).trim();
    }
  }

  // --- Extract prep note from comma suffix: ", finely minced" ---
  const commaMatch = remainder.match(/,\s*(.+)$/);
  if (commaMatch) {
    const suffix = commaMatch[1].trim();
    if (PREP_NOTE_REGEX.test(suffix)) {
      if (!prepNote) prepNote = suffix;
      remainder = remainder.slice(0, commaMatch.index).trim();
    }
  }

  // --- Final name clean ---
  const name = remainder
    .replace(/\s+-\s+.*$/, '')
    .replace(/\b(?:to taste|for serving|as needed)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || text.split(/[,(]/)[0].trim(); // safe fallback

  if (!name) return null;

  return {
    name,
    quantity,
    unit,
    ...(prepNote ? { prepNote } : {}),
  };
}

// ---------------------------------------------------------------------------
// JSON-LD helpers
// ---------------------------------------------------------------------------

/** Recursively find a Recipe node anywhere in a parsed JSON-LD blob. */
function findRecipeNode(value) {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecipeNode(entry);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some(t => String(t).toLowerCase() === 'recipe')) return value;

    if (Array.isArray(value['@graph'])) {
      const inGraph = findRecipeNode(value['@graph']);
      if (inGraph) return inGraph;
    }

    // Go one level deeper into child objects/arrays (catches wrapped schemas)
    for (const key of Object.keys(value)) {
      if (key === '@context') continue;
      const child = value[key];
      if (child && typeof child === 'object') {
        const found = findRecipeNode(child);
        if (found) return found;
      }
    }
  }

  return null;
}

function extractInstructions(json) {
  const raw = json.recipeInstructions;
  if (!raw) return [];

  if (typeof raw === 'string') {
    return raw.split(/\r?\n+/).map(s => stripHtml(s).trim()).filter(Boolean);
  }

  if (Array.isArray(raw)) {
    const steps = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        steps.push(stripHtml(item).trim());
      } else if (typeof item === 'object') {
        const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        // HowToSection contains itemListElement with HowToStep entries
        if (types.some(t => String(t).toLowerCase() === 'howtosection')) {
          const subSteps = Array.isArray(item.itemListElement) ? item.itemListElement : [];
          for (const sub of subSteps) {
            const text = stripHtml(sub.text || sub.name || '').trim();
            if (text) steps.push(text);
          }
        } else {
          const text = stripHtml(item.text || item.name || '').trim();
          if (text) steps.push(text);
        }
      }
    }
    return steps.filter(Boolean);
  }

  return [];
}

function extractNutrition(json, field) {
  return json.nutrition?.[field]
    ? parseInt(String(json.nutrition[field]).replace(/[^\d]/g, '')) || 0
    : 0;
}

function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const match = String(durationStr).match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  const hours = parseInt(match?.[1] || '0');
  const mins = parseInt(match?.[2] || '0');
  return hours * 60 + mins;
}

function extractServings(value) {
  if (!value) return 1;
  if (Array.isArray(value)) value = value[0];
  const m = String(value).match(/\d+/);
  return m ? parseInt(m[0]) || 1 : 1;
}

function extractThumbnail(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === 'string' ? first : first?.url || '';
  }
  return image.url || '';
}

function generateId(title) {
  return String(title || 'recipe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function extractRecipeFromUrl(url) {
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    },
  });

  const $ = cheerio.load(html);

  // --- 1. Try JSON-LD structured data ---
  const jsonLdScripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html())
    .get();

  let recipeNode = null;
  for (const script of jsonLdScripts) {
    try {
      const parsed = JSON.parse(script);
      recipeNode = findRecipeNode(parsed);
      if (recipeNode) break;
    } catch {
      // malformed script block, skip
    }
  }

  if (recipeNode) {
    console.log('✅ Recipe JSON-LD found');

    const rawIngredients = Array.isArray(recipeNode.recipeIngredient)
      ? recipeNode.recipeIngredient
      : [];

    const ingredients = rawIngredients
      .map(item => parseIngredientString(String(item)))
      .filter(Boolean)
      .filter((item, idx, arr) =>
        idx === arr.findIndex(x => x.name.toLowerCase() === item.name.toLowerCase())
      );

    return {
      id: generateId(recipeNode.name),
      title: stripHtml(recipeNode.name) || 'Imported Recipe',
      thumbnail: extractThumbnail(recipeNode.image),
      cookTime: parseDuration(recipeNode.cookTime),
      prepTime: parseDuration(recipeNode.prepTime),
      servings: extractServings(recipeNode.recipeYield),
      difficulty: 'Medium',
      cuisine: stripHtml(recipeNode.recipeCuisine) || 'Global',
      tags: typeof recipeNode.keywords === 'string'
        ? recipeNode.keywords.split(',').map(t => t.trim()).filter(Boolean)
        : Array.isArray(recipeNode.keywords) ? recipeNode.keywords : ['Imported'],
      nutrition: {
        calories: extractNutrition(recipeNode, 'calories'),
        protein: extractNutrition(recipeNode, 'proteinContent'),
        carbs: extractNutrition(recipeNode, 'carbohydrateContent'),
        fat: extractNutrition(recipeNode, 'fatContent'),
      },
      ingredients,
      instructions: extractInstructions(recipeNode),
    };
  }

  // --- 2. Fallback: scrape HTML directly ---
  console.log('⚠️ No JSON-LD found, falling back to HTML scrape');

  const fallbackTitle =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    'Untitled Recipe';

  const fallbackThumbnail = $('meta[property="og:image"]').attr('content') || '';

  // Target class-named ingredient containers; avoid pulling in navigation/ads.
  const ingredientEls = $('[class*="ingredient"] li, [class*="wprm-recipe-ingredient"]');
  const fallbackIngredients = ingredientEls.length
    ? ingredientEls.map((_, el) => $(el).text().trim()).get().filter(Boolean)
    : $('ul li').map((_, el) => $(el).text().trim()).get()
        .filter(t => /\d/.test(t) || /\b(cup|tsp|tbsp|g|kg|ml|oz|lb|clove|pinch)\b/i.test(t));

  const instructionEls = $('[class*="instruction"] li, [class*="wprm-recipe-instruction"], [class*="step"] li');
  const fallbackInstructions = instructionEls.length
    ? instructionEls.map((_, el) => $(el).text().trim()).get().filter(Boolean)
    : $('ol li').map((_, el) => $(el).text().trim()).get().filter(t => t.length > 20);

  return {
    id: generateId(fallbackTitle),
    title: fallbackTitle,
    thumbnail: fallbackThumbnail,
    cookTime: 0,
    prepTime: 0,
    servings: 1,
    difficulty: 'Medium',
    cuisine: 'Global',
    tags: ['Imported'],
    nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    ingredients: fallbackIngredients
      .map(raw => parseIngredientString(raw))
      .filter(Boolean),
    instructions: fallbackInstructions,
  };
}
