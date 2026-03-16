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
  /\b(?:finely|roughly|thinly|coarsely|freshly|lightly|gently|well|loosely)\b|\b(?:minced|chopped|diced|sliced|grated|crushed|peeled|trimmed|softened|melted|divided|roasted|toasted|ground|beaten|shredded|cut|halved|quartered|rinsed|drained|cooked|uncooked|thawed|heated|cooled|whipped|julienned|blanched|deveined|mashed|crumbled|warmed|separated)\b|^(?:to taste|for serving|for drizzling|as needed|room temp|at room temperature|optional|optional garnish|for garnish|garnish)/i;

const UNICODE_FRACTIONS = {
  '¼': 1 / 4,
  '½': 1 / 2,
  '¾': 3 / 4,
  '⅐': 1 / 7,
  '⅑': 1 / 9,
  '⅒': 1 / 10,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅕': 1 / 5,
  '⅖': 2 / 5,
  '⅗': 3 / 5,
  '⅘': 4 / 5,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 1 / 8,
  '⅜': 3 / 8,
  '⅝': 5 / 8,
  '⅞': 7 / 8,
};

const UNICODE_FRACTION_REGEX = '[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]';

function parseQuantityToken(token) {
  const q = String(token || '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/⁄/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return 1;

  const mixedM = q.match(/^([0-9]+)\s+([0-9]+)\/([0-9]+)$/);
  const fracM = q.match(/^([0-9]+)\/([0-9]+)$/);
  const unicodeMixedM = q.match(new RegExp(`^([0-9]+)\\s*(${UNICODE_FRACTION_REGEX})$`));
  const unicodeOnlyM = q.match(new RegExp(`^(${UNICODE_FRACTION_REGEX})$`));

  if (mixedM) return parseInt(mixedM[1], 10) + parseInt(mixedM[2], 10) / parseInt(mixedM[3], 10);
  if (fracM) return parseInt(fracM[1], 10) / parseInt(fracM[2], 10);
  if (unicodeMixedM) {
    const whole = parseInt(unicodeMixedM[1], 10) || 0;
    const fraction = UNICODE_FRACTIONS[unicodeMixedM[2]] || 0;
    return whole + fraction || 1;
  }
  if (unicodeOnlyM) return UNICODE_FRACTIONS[unicodeOnlyM[1]] || 1;

  return parseFloat(q) || 1;
}

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

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function asCleanLine(value) {
  return stripHtml(decodeEntities(String(value || ''))).replace(/^[\s•\-–—●▪▫◦▢■□►▶▸]+/, '').trim();
}

/**
 * Splits a raw ingredient string into { name, quantity, unit, prepNote }.
 * e.g. "4 garlic cloves, finely minced"
 *   → { name:"garlic cloves", quantity:4, unit:"", prepNote:"finely minced" }
 * e.g. "750g / 1 1/2 lb lamb mince (first choice), or beef ((Note 1))"
 *   → { name:"lamb mince", quantity:750, unit:"g" }
 */
function parseIngredientString(raw) {
  let text = stripHtml(raw).replace(/^[\s•\-–—●▪▫◦▢■□►▶▸]+/, '').trim();
  if (!text) return null;

  // Normalize range prefixes (e.g. "2 – 3 tbsp") to a single leading quantity.
  text = text.replace(/^(\d+(?:\.\d+)?(?:\s+[0-9]+\/[0-9]+)?)\s*[–—-]\s*\d+(?:\.\d+)?(?:\s+[0-9]+\/[0-9]+)?\b\s*/i, '$1 ');

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
  const qtyMatch = text.match(new RegExp(`^((?:[0-9]+\\s+[0-9]+\/[0-9]+)|(?:[0-9]+\\s*${UNICODE_FRACTION_REGEX})|(?:[0-9]+\/[0-9]+)|(?:${UNICODE_FRACTION_REGEX})|(?:[0-9]*\.?[0-9]+))\\s*`));
  let quantity = 1;
  if (qtyMatch) {
    quantity = parseQuantityToken(qtyMatch[1]);
  }
  let remainder = qtyMatch ? text.slice(qtyMatch[0].length).trim() : text;

  // --- Parse unit ---
  const unitPattern = new RegExp(`^(${MEASURE_UNITS.join('|')})\\b\\.?\\s*`, 'i');
  const unitMatch = remainder.match(unitPattern);
  let unit = unitMatch ? cleanUnit(unitMatch[1]) : '';
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

  // Extract trailing prep phrase without comma: "cilantro roughly chopped"
  const trailingPrepMatch = remainder.match(/\b((?:finely|roughly|thinly|coarsely|freshly|lightly|gently)\s+(?:minced|chopped|diced|sliced|grated|crushed|julienned|shredded)|(?:minced|chopped|diced|sliced|grated|crushed|julienned|shredded))\s*$/i);
  if (trailingPrepMatch) {
    const prepSuffix = trailingPrepMatch[1].trim();
    if (prepSuffix) {
      if (!prepNote) prepNote = prepSuffix;
      remainder = remainder.slice(0, trailingPrepMatch.index).trim();
    }
  }

  // Handle count units that appear after the ingredient name, e.g. "4 garlic cloves".
  if (!unit && qtyMatch) {
    const trailingCountUnitMatch = remainder.match(/^(.*?)(?:\s+)(cloves?|slices?|sprigs?|pinches?|pieces?|pcs)\.?\s*$/i);
    if (trailingCountUnitMatch) {
      remainder = trailingCountUnitMatch[1].trim();
      unit = cleanUnit(trailingCountUnitMatch[2]);
    }
  }

  // --- Final name clean ---
  const name = remainder
    .replace(/\bcoriander\s*\/\s*cilantro\b/gi, 'cilantro')
    .replace(/\bcilantro\s*\/\s*coriander\b/gi, 'cilantro')
    .replace(/^of\s+/i, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\b(?:to taste|for serving|as needed|optional|optional garnish|for garnish|garnish)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || text.split(/[,(]/)[0].replace(/^of\s+/i, '').trim(); // safe fallback

  if (!name) return null;
  if (/^\d+(?:\.\d+)?$/.test(name)) return null;

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

function getSectionHtmlByHeading($, headingPattern) {
  const headingRegex = new RegExp(`^(?:${headingPattern})$`, 'i');
  const heading = $('h1,h2,h3,h4')
    .filter((_, el) => headingRegex.test($(el).text().trim()))
    .first();

  if (!heading.length) return '';

  let sectionHtml = '';
  let current = heading.next();
  while (current.length) {
    if (/^h[1-4]$/i.test(current[0]?.tagName || '')) break;
    sectionHtml += $.html(current);
    current = current.next();
  }

  return sectionHtml;
}

function extractListItems(sectionHtml) {
  if (!sectionHtml) return [];

  const listItems = [...sectionHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => asCleanLine(m[1]))
    .filter(Boolean);

  if (listItems.length > 0) return listItems;

  const plain = asCleanLine(sectionHtml.replace(/<[^>]+>/g, ' '));
  if (!plain) return [];

  const numbered = [...plain.matchAll(/(?:^|\s)(\d+)[.)]\s*([\s\S]*?)(?=(?:\s\d+[.)]\s)|$)/g)]
    .map((m) => asCleanLine(m[2]))
    .filter(Boolean);

  return numbered;
}

function extractTextLines(sectionHtml) {
  if (!sectionHtml) return [];

  const withBreaks = sectionHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h4|h5|h6)>/gi, '\n');

  const plain = decodeEntities(withBreaks).replace(/<[^>]+>/g, ' ');

  return plain
    .split(/\n+/)
    .map((line) => asCleanLine(line))
    .filter(Boolean);
}

function isLikelyIngredientLine(line) {
  const cleaned = asCleanLine(line);
  if (!cleaned) return false;

  const lower = cleaned.toLowerCase();
  if (['us', 'metric', 'ingredients', 'method', 'instructions'].includes(lower)) return false;
  if (/^(for\s+the\b|you\'ll\s+need\b)/i.test(cleaned)) return false;

  if (/^\d/.test(cleaned)) return true;
  if (/\b(cup|tsp|tbsp|g|kg|ml|l|oz|lb|pinch|egg|butter|flour|sugar|milk|salt|pepper|vanilla)\b/i.test(lower)) return true;
  if (/^[a-z][a-z\s'\-]{2,30}$/i.test(cleaned) && cleaned.split(' ').length <= 4) return true;

  return false;
}

function extractIngredientLinesFromSectionHtml(sectionHtml) {
  if (!sectionHtml) return [];

  const $$ = cheerio.load(`<section>${sectionHtml}</section>`);
  const preferredPane =
    $$('.tab-pane.show.active').first().length
      ? $$('.tab-pane.show.active').first()
      : $$('#metric').first().length
      ? $$('#metric').first()
      : $$('.tab-pane').first();

  if (preferredPane.length) {
    const paneLines = preferredPane
      .find('p, li')
      .map((_, el) => asCleanLine($$(el).text()))
      .get()
      .filter(Boolean)
      .filter(isLikelyIngredientLine);

    if (paneLines.length > 0) return paneLines;
  }

  let ingredientLines = extractListItems(sectionHtml);
  const ingredientTextLines = extractTextLines(sectionHtml).filter(isLikelyIngredientLine);
  if (ingredientLines.length === 0) {
    ingredientLines = ingredientTextLines;
  }

  return ingredientLines;
}

function parseRecipeFromHtmlSections($, fallbackTitle, fallbackThumbnail) {
  const methodSection = getSectionHtmlByHeading($, 'Method|Instructions?');
  const ingredientsSection = getSectionHtmlByHeading($, 'Ingredients?');

  let instructions = extractListItems(methodSection);
  const methodLines = extractTextLines(methodSection);
  if (instructions.length === 0 && methodLines.length > 0) {
    instructions = methodLines
      .map((line) => line.replace(/^\d+[.)-]?\s*/, '').trim())
      .filter(Boolean)
      .filter((line, index, arr) => arr.indexOf(line) === index);
  }

  const ingredientLines = extractIngredientLinesFromSectionHtml(ingredientsSection);

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
    ingredients: ingredientLines
      .map((raw) => parseIngredientString(raw))
      .filter(Boolean),
    instructions,
  };
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

// Placeholder filename patterns that indicate a lazy-loaded or low-quality stand-in
const PLACEHOLDER_PATTERN = /low[_-]?res|placeholder|template|blank|dummy|loading|spinner/i;

function extractBestThumbnail($, titleHint = '') {
  // 1. Standard OG / Twitter meta tags
  const og = $('meta[property="og:image"]').attr('content');
  if (og && !PLACEHOLDER_PATTERN.test(og)) return og;

  const tw = $('meta[name="twitter:image"]').attr('content');
  if (tw && !PLACEHOLDER_PATTERN.test(tw)) return tw;

  // 2. <link rel="image_src"> (older WP themes)
  const linkImg = $('link[rel="image_src"]').attr('href');
  if (linkImg && !PLACEHOLDER_PATTERN.test(linkImg)) return linkImg;

  // 3. First <img> inside common recipe/article content areas whose alt matches the title
  const titleWords = titleHint.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  let bestSrc = '';
  $('article img, .entry-content img, .post-content img, .recipe img, main img').each((_, el) => {
    if (bestSrc) return;
    const src = $( el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
    if (!src || PLACEHOLDER_PATTERN.test(src)) return;
    const alt = ($(el).attr('alt') || '').toLowerCase();
    if (titleWords.length && titleWords.some(w => alt.includes(w))) {
      bestSrc = src;
    }
  });
  if (bestSrc) return bestSrc;

  // 4. Any large-looking img (has explicit width >= 300 or is in an uploads path) that isn't a placeholder
  $('img').each((_, el) => {
    if (bestSrc) return;
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!src || PLACEHOLDER_PATTERN.test(src)) return;
    const w = parseInt($(el).attr('width') || '0');
    const isUpload = /\/uploads\/|\/images\/recipes?\//i.test(src);
    if (w >= 300 || isUpload) bestSrc = src;
  });

  return bestSrc;
}

function generateId(title) {
  return String(title || 'recipe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function getWprmRecipeIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const hash = decodeURIComponent(parsed.hash || '');
    const m = hash.match(/wprm-recipe-container-(\d+)/i);
    return m ? String(m[1]) : '';
  } catch {
    return '';
  }
}

async function extractRecipeFromWprmApi(url, options = {}) {
  const recipeId = getWprmRecipeIdFromUrl(url);
  if (!recipeId) return null;

  let apiUrl = '';
  try {
    const parsed = new URL(String(url || ''));
    apiUrl = `${parsed.origin}/wp-json/wp/v2/wprm_recipe/${recipeId}`;
  } catch {
    return null;
  }

  const timeoutMs = Number(options.timeoutMs) || 20000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onAbort = () => timeoutController.abort();
  if (options?.signal) options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: timeoutController.signal,
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const recipe = payload?.recipe || {};

    const ingredientGroups = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
    const ingredients = ingredientGroups
      .flatMap((group) => Array.isArray(group?.ingredients) ? group.ingredients : [])
      .map((item) => {
        const amount = String(item?.amount || '').trim();
        const unit = cleanUnit(String(item?.unit || ''));
        const name = stripHtml(item?.name || '').trim();
        const notes = stripHtml(item?.notes || '').trim();
        const asLine = `${amount}${amount ? ' ' : ''}${unit}${unit ? ' ' : ''}${name}${notes ? `, ${notes}` : ''}`.trim();

        const parsedIngredient = parseIngredientString(asLine);
        if (parsedIngredient) return parsedIngredient;

        if (!name) return null;
        return {
          name,
          quantity: parseQuantityToken(amount || '1'),
          unit,
          ...(notes ? { prepNote: notes } : {}),
        };
      })
      .filter(Boolean)
      .filter((item, idx, arr) => idx === arr.findIndex((x) => x.name.toLowerCase() === item.name.toLowerCase()));

    const instructionGroups = Array.isArray(recipe?.instructions) ? recipe.instructions : [];
    const instructions = instructionGroups
      .flatMap((group) => Array.isArray(group?.instructions) ? group.instructions : [])
      .map((step) => stripHtml(step?.text || ''))
      .filter(Boolean);

    const keywords = Array.isArray(recipe?.tags?.keyword)
      ? recipe.tags.keyword.map((k) => stripHtml(k?.name || '')).filter(Boolean)
      : ['Imported'];

    const cuisine = Array.isArray(recipe?.tags?.cuisine) && recipe.tags.cuisine[0]?.name
      ? stripHtml(recipe.tags.cuisine[0].name)
      : 'Global';

    const title = stripHtml(recipe?.name || payload?.title?.rendered || '') || 'Imported Recipe';
    if (!title) return null;

    return {
      id: String(recipe?.id || payload?.id || recipeId || generateId(title)),
      title,
      thumbnail: recipe?.image_url || '',
      cookTime: Number(recipe?.cook_time) || 0,
      prepTime: Number(recipe?.prep_time) || 0,
      servings: extractServings(recipe?.servings),
      difficulty: 'Medium',
      cuisine,
      tags: keywords.length ? keywords : ['Imported'],
      nutrition: {
        calories: Number(recipe?.nutrition?.calories) || 0,
        protein: Number(recipe?.nutrition?.protein) || 0,
        carbs: Number(recipe?.nutrition?.carbohydrates) || 0,
        fat: Number(recipe?.nutrition?.fat) || 0,
      },
      ingredients,
      instructions,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (options?.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function extractRecipeFromUrl(url, options = {}) {
  const { signal } = options;
  const requestTimeoutMs = Number(options.timeoutMs) || Number(process.env.UPSTREAM_TIMEOUT_MS || 35000);

  // For WPRM links with recipe id in hash, use the WP REST endpoint first.
  const wprmApiRecipe = await extractRecipeFromWprmApi(url, {
    signal,
    timeoutMs: Math.min(requestTimeoutMs, 20000),
  });
  if (wprmApiRecipe) {
    return wprmApiRecipe;
  }

  const requestConfig = {
    signal,
    timeout: requestTimeoutMs,
    maxRedirects: 8,
    maxContentLength: 15 * 1024 * 1024,
    maxBodyLength: 15 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    },
  };

  let html = '';
  try {
    const response = await axios.get(url, requestConfig);
    html = response.data;
  } catch (error) {
    // Retry once for transient upstream stalls or socket hiccups.
    const retryable =
      error?.code === 'ECONNABORTED' ||
      error?.code === 'ETIMEDOUT' ||
      error?.code === 'ECONNRESET' ||
      /timeout|socket|network/i.test(String(error?.message || ''));

    if (!retryable || signal?.aborted) {
      throw error;
    }

    const response = await axios.get(url, requestConfig);
    html = response.data;
  }

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

    const fallbackTitle = stripHtml(recipeNode.name) || 'Imported Recipe';
    const jsonLdThumbnail = extractThumbnail(recipeNode.image);
    const fallbackThumbnail = (jsonLdThumbnail && !PLACEHOLDER_PATTERN.test(jsonLdThumbnail))
      ? jsonLdThumbnail
      : extractBestThumbnail($, fallbackTitle);
    const htmlSectionRecipe = parseRecipeFromHtmlSections($, fallbackTitle, fallbackThumbnail);
    const htmlIngredients = Array.isArray(htmlSectionRecipe.ingredients) ? htmlSectionRecipe.ingredients : [];
    const htmlInstructions = Array.isArray(htmlSectionRecipe.instructions) ? htmlSectionRecipe.instructions : [];
    const jsonInstructions = extractInstructions(recipeNode);

    return {
      id: generateId(recipeNode.name),
      title: fallbackTitle,
      thumbnail: fallbackThumbnail,
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
      ingredients: htmlIngredients.length > ingredients.length ? htmlIngredients : ingredients,
      instructions: htmlInstructions.length > jsonInstructions.length ? htmlInstructions : jsonInstructions,
    };
  }

  // --- 2. Fallback: scrape HTML directly ---
  console.log('⚠️ No JSON-LD found, falling back to HTML scrape');

  const fallbackTitle =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    'Untitled Recipe';

  const fallbackThumbnail = extractBestThumbnail($, fallbackTitle);

  const htmlSectionRecipe = parseRecipeFromHtmlSections($, fallbackTitle, fallbackThumbnail);

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

  const selectorFallbackRecipe = {
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

  if ((htmlSectionRecipe.ingredients || []).length > (selectorFallbackRecipe.ingredients || []).length) {
    return htmlSectionRecipe;
  }

  return selectorFallbackRecipe;
}
