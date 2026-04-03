import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import {
  MEASURE_UNITS,
  cleanUnit,
  roundImportedQty,
  parseQuantityToken,
  stripPriceAnnotations,
  stripHtml,
  stripHtmlToText,
  decodeEntities,
  asCleanLine,
  parseIngredientString,
} from './ingredientParserShared.js';
import {
  normalizeDifficultyLabel,
  estimateRecipeDifficulty,
  deriveRecipeDifficulty,
} from './recipeDifficultyShared.js';
import { parseImportedRecipeFromHtml } from './recipeParserShared.js';

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

const SALT_AND_PEPPER_PATTERN = /\bsalt\b\s*(?:and|&)\s*(?:freshly\s+ground\s+|ground\s+|cracked\s+|black\s+)?\bpepper\b|\b(?:freshly\s+ground\s+|ground\s+|cracked\s+|black\s+)?\bpepper\b\s*(?:and|&)\s*\bsalt\b/i;

function expandSeasoningLine(value) {
  const line = asCleanLine(value);
  if (!line) return [];
  if (!SALT_AND_PEPPER_PATTERN.test(line)) return [line];

  return [
    line.replace(SALT_AND_PEPPER_PATTERN, 'salt').trim(),
    line.replace(SALT_AND_PEPPER_PATTERN, 'black pepper').trim(),
  ].filter(Boolean);
}

function parseIngredientEntries(raw) {
  return expandSeasoningLine(raw)
    .map((line) => parseIngredientString(line))
    .filter(Boolean);
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


// Difficulty classification is now imported from shared module (see imports above)

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

  const parsed = {
    id: generateId(fallbackTitle),
    title: fallbackTitle,
    thumbnail: fallbackThumbnail,
    cookTime: 0,
    prepTime: 0,
    servings: 1,
    cuisine: 'Global',
    tags: ['Imported'],
    nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    ingredients: ingredientLines
      .flatMap((raw) => parseIngredientEntries(raw))
      .filter(Boolean),
    instructions,
  };

  const pageText = stripHtmlToText($('body').html() || $('body').text() || '');
  const inferredMeta = inferMissingRecipeMeta({
    prepTime: parsed.prepTime,
    cookTime: parsed.cookTime,
    servings: parsed.servings,
    instructions: parsed.instructions,
    pageText,
  });

  return {
    ...parsed,
    ...inferredMeta,
    difficulty: deriveRecipeDifficulty(parsed, [fallbackTitle]),
  };
}

function extractRecipeNotes($) {
  const noteSelectors = [
    '.wprm-recipe-notes-container',
    '.wprm-recipe-notes',
    '.tasty-recipes-notes',
    '.mv-create-notes',
    '.mv-recipe-notes',
    '[class*="recipe-notes"]',
    '[class*="recipe_notes"]',
    '[class*="recipe-tips"]',
  ];

  for (const selector of noteSelectors) {
    const el = $(selector).first();
    if (!el.length) continue;
    const text = stripHtmlToText($.html(el) || el.text() || '');
    if (text) return text;
  }

  const headingSection = getSectionHtmlByHeading($, 'Notes?|Recipe\\s*Notes?|Cook\'?s?\\s*Notes?|Tips?');
  const headingText = stripHtmlToText(headingSection || '');
  return headingText || '';
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

function estimateMinutesFromRange(a, b, unit) {
  const n1 = Number(a);
  const n2 = Number(b);
  if (!Number.isFinite(n1) || !Number.isFinite(n2)) return 0;
  const avg = (n1 + n2) / 2;
  return /hour|hr/i.test(String(unit || '')) ? Math.round(avg * 60) : Math.round(avg);
}

function extractMinutesFromText(text = '') {
  const source = String(text || '').toLowerCase();
  if (!source) return 0;

  let total = 0;

  const hourAndMinuteMatches = [...source.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?)\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(minutes?|mins?)/gi)];
  for (const m of hourAndMinuteMatches) {
    const h = Number(m[1]);
    const mins = Number(m[3]);
    if (Number.isFinite(h) && Number.isFinite(mins)) total += Math.round(h * 60 + mins);
  }

  const rangeSameUnitMatches = [...source.matchAll(/(\d+(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/gi)];
  for (const m of rangeSameUnitMatches) {
    total += estimateMinutesFromRange(m[1], m[2], m[3]);
  }

  const mixedRangeMatches = [...source.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/gi)];
  for (const m of mixedRangeMatches) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const aMin = /hour|hr/i.test(m[2]) ? a * 60 : a;
    const bMin = /hour|hr/i.test(m[4]) ? b * 60 : b;
    total += Math.round((aMin + bMin) / 2);
  }

  const reduced = source
    .replace(/(\d+(?:\.\d+)?)\s*(hours?|hrs?)\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(minutes?|mins?)/gi, ' ')
    .replace(/(\d+(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/gi, ' ')
    .replace(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/gi, ' ');

  const singleMatches = [...reduced.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/gi)];
  for (const m of singleMatches) {
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    total += /hour|hr/i.test(m[2]) ? Math.round(value * 60) : Math.round(value);
  }

  return total;
}

function inferTimesFromInstructions(instructions = []) {
  const lines = Array.isArray(instructions) ? instructions : [];
  let prep = 0;
  let cook = 0;

  for (const line of lines) {
    const text = String(line || '').trim();
    if (!text) continue;
    const minutes = extractMinutesFromText(text);
    if (minutes <= 0) continue;

    const lower = text.toLowerCase();
    const cookLike = /\b(?:bake|roast|simmer|boil|cook|fry|saute|sauté|grill|broil|preheat|heat|oven|stovetop|stove)\b/.test(lower);
    if (cookLike) cook += minutes;
    else prep += minutes;
  }

  return {
    prepTime: Math.max(0, Math.round(prep)),
    cookTime: Math.max(0, Math.round(cook)),
  };
}

function extractServingsFromText(text = '') {
  const source = String(text || '').toLowerCase();
  if (!source) return 0;

  const servesMatch = source.match(/\bserv(?:e|es|ings?)\b\s*[:\-]?\s*(\d+)(?:\s*(?:to|-|–|—)\s*(\d+))?/i);
  if (servesMatch) {
    const a = Number(servesMatch[1]);
    const b = servesMatch[2] ? Number(servesMatch[2]) : 0;
    if (Number.isFinite(a) && a > 0) {
      if (Number.isFinite(b) && b > 0) return Math.round((a + b) / 2);
      return Math.round(a);
    }
  }

  const makesMatch = source.match(/\b(?:makes?|yield|yields?)\b\s*[:\-]?\s*(\d+)(?:\s*(?:to|-|–|—)\s*(\d+))?/i);
  if (makesMatch) {
    const a = Number(makesMatch[1]);
    const b = makesMatch[2] ? Number(makesMatch[2]) : 0;
    if (Number.isFinite(a) && a > 0) {
      if (Number.isFinite(b) && b > 0) return Math.round((a + b) / 2);
      return Math.round(a);
    }
  }

  return 0;
}

function inferMissingRecipeMeta({ prepTime = 0, cookTime = 0, servings = 1, instructions = [], pageText = '' }) {
  const inferredTimes = inferTimesFromInstructions(instructions);
  const inferredServings = extractServingsFromText(pageText);

  return {
    prepTime: prepTime > 0 ? prepTime : inferredTimes.prepTime,
    cookTime: cookTime > 0 ? cookTime : inferredTimes.cookTime,
    servings: servings > 1 ? servings : (inferredServings > 0 ? inferredServings : servings),
  };
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

function recipeCompletenessScore(candidate) {
  if (!candidate) return 0;
  const ingredientsCount = Array.isArray(candidate.ingredients) ? candidate.ingredients.length : 0;
  const instructionsCount = Array.isArray(candidate.instructions) ? candidate.instructions.length : 0;
  const hasTitle = candidate.title ? 1 : 0;
  return ingredientsCount * 2 + instructionsCount * 3 + hasTitle * 2;
}

function withImporterDefaults(candidate, fallback = {}) {
  if (!candidate) return null;
  const title = String(candidate.title || fallback.title || 'Imported Recipe').trim();
  const normalized = {
    id: String(candidate.id || generateId(title)),
    title,
    thumbnail: candidate.thumbnail || fallback.thumbnail || '',
    cookTime: Number(candidate.cookTime) || 0,
    prepTime: Number(candidate.prepTime) || 0,
    servings: Number(candidate.servings) || 1,
    cuisine: candidate.cuisine || 'Global',
    tags: Array.isArray(candidate.tags) && candidate.tags.length > 0 ? candidate.tags : ['Imported'],
    nutrition: {
      calories: Number(candidate?.nutrition?.calories) || 0,
      protein: Number(candidate?.nutrition?.protein) || 0,
      carbs: Number(candidate?.nutrition?.carbs) || 0,
      fat: Number(candidate?.nutrition?.fat) || 0,
    },
    ingredients: Array.isArray(candidate.ingredients) ? candidate.ingredients : [],
    instructions: Array.isArray(candidate.instructions) ? candidate.instructions : [],
    ...(String(candidate.notes || '').trim() ? { notes: String(candidate.notes).trim() } : {}),
  };

  normalized.difficulty = deriveRecipeDifficulty(normalized, Array.isArray(fallback.difficultyHints) ? fallback.difficultyHints : [title]);
  return normalized;
}

function chooseBestParsedRecipe(primary, secondary, fallback = {}) {
  const left = withImporterDefaults(primary, fallback);
  const right = withImporterDefaults(secondary, fallback);
  if (!left) return right;
  if (!right) return left;
  return recipeCompletenessScore(right) > recipeCompletenessScore(left) ? right : left;
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

        const parsedIngredients = parseIngredientEntries(asLine);
        if (parsedIngredients.length > 0) return parsedIngredients;

        if (!name) return null;
        return [{
          name,
          quantity: roundImportedQty(parseQuantityToken(amount || '1')),
          unit,
          ...(notes ? { prepNote: notes } : {}),
        }];
      })
      .flat()
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
    const recipeNotes = stripHtmlToText(recipe?.notes || payload?.content?.rendered || '');
    if (!title) return null;

    const parsed = {
      id: String(recipe?.id || payload?.id || recipeId || generateId(title)),
      title,
      thumbnail: recipe?.image_url || '',
      cookTime: Number(recipe?.cook_time) || 0,
      prepTime: Number(recipe?.prep_time) || 0,
      servings: extractServings(recipe?.servings),
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
      ...(recipeNotes ? { notes: recipeNotes } : {}),
    };

    return {
      ...parsed,
      difficulty: deriveRecipeDifficulty(parsed, [
        recipe?.difficulty,
        recipe?.difficulty_text,
        recipe?.summary,
        recipeNotes,
        title,
        keywords.join(' '),
      ]),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (options?.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// HTML byline extraction — used when JSON-LD lacks an author field
// ---------------------------------------------------------------------------
function extractHtmlAuthor($) {
  // 1. Common semantic selectors used by recipe sites and WordPress themes
  const selectorCandidates = [
    '[class*="author-name"]',
    '[class*="byline"] [class*="name"]',
    '[class*="byline"]',
    '[rel="author"]',
    '[itemprop="author"]',
    '[class*="recipe-author"]',
    '[class*="wprm-recipe-author"]',
    '.author',
  ];
  for (const sel of selectorCandidates) {
    const text = $(sel).first().text().trim();
    if (text && text.length < 80) {
      // Strip leading "by", "by:", "recipe by" prefix (case-insensitive)
      return text.replace(/^(recipe\s+by|by)\s*:?\s*/i, '').trim();
    }
  }

  // 2. Plain-text "By: Name" / "By Name" pattern anywhere in the page
  const pageText = $('body').text();
  const bylineMatch = pageText.match(/\bby\s*:\s*([A-Z][^\n\r,|]{2,50})/i);
  if (bylineMatch) {
    const candidate = bylineMatch[1].trim();
    // Reject if it looks like a sentence (contains a verb indicator or is very long)
    if (candidate.length < 60 && !/\b(and|or|is|are|was|the|a|an)\b/i.test(candidate)) {
      return candidate;
    }
  }

  return '';
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
    maxRedirects: 3,
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
    // SSL certificate chain errors (e.g. site renewed cert but didn't include the
    // intermediate CA). Retry once with relaxed verification so recipe content on
    // sites with an incomplete chain can still be imported. The connection is still
    // encrypted — we just can't fully verify the chain.
    const isSslChainError =
      error?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      error?.code === 'CERT_HAS_EXPIRED' ||
      error?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      error?.code === 'SELF_SIGNED_CERT_IN_CHAIN';

    if (isSslChainError && !signal?.aborted) {
      console.warn(`⚠️  SSL chain error for ${url} (${error.code}) — retrying with relaxed TLS verification`);
      const relaxedConfig = {
        ...requestConfig,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      };
      const response = await axios.get(url, relaxedConfig);
      html = response.data;
    } else {
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
  }

  const sharedParsed = parseImportedRecipeFromHtml(html, {
    canonicalizeName: (value) => String(value || '').trim().toLowerCase(),
    baseUrl: url,
  });

  // After choosing the best parsed recipe, re-apply subRecipeUrl values that
  // were detected in the HTML (same-domain <a href> links inside ingredient <li>
  // elements). sharedParsed is the only parse path that detects these links;
  // if jsonLdRecipe wins the chooseBestParsedRecipe comparison its ingredients
  // come from plain-text JSON-LD which has no link data, so we patch them here.
  const applySubRecipeLinks = (recipe) => {
    if (!recipe || !Array.isArray(recipe.ingredients) || !Array.isArray(sharedParsed?.ingredients)) {
      return recipe;
    }
    const urlByName = new Map(
      sharedParsed.ingredients
        .filter(i => i?.subRecipeUrl)
        .map(i => [String(i.name || '').toLowerCase(), i.subRecipeUrl])
    );
    if (!urlByName.size) return recipe;
    return {
      ...recipe,
      ingredients: recipe.ingredients.map(ing => {
      const nameLower = String(ing.name || '').toLowerCase();
      let linked = urlByName.get(nameLower);
      if (!linked) {
        for (const [key, url] of urlByName) {
          if (key.length >= 5 && (nameLower.includes(key) || key.includes(nameLower))) {
            linked = url;
            break;
          }
        }
      }
      return linked ? { ...ing, subRecipeUrl: linked } : ing;
      }),
    };
  };

  const $ = cheerio.load(html);
  const htmlNotes = extractRecipeNotes($);

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
      .flatMap(item => parseIngredientEntries(String(item)))
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
    const jsonNotes = stripHtmlToText(recipeNode.recipeNotes || recipeNode.notes || recipeNode.description || '');

    const parsed = {
      id: generateId(recipeNode.name),
      title: fallbackTitle,
      thumbnail: fallbackThumbnail,
      cookTime: parseDuration(recipeNode.cookTime),
      prepTime: parseDuration(recipeNode.prepTime),
      servings: extractServings(recipeNode.recipeYield),
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
      // Prefer HTML ingredients when counts are equal or HTML has more: the visible
      // HTML preserves "or" alternatives (e.g. "ricotta cheese or cottage cheese") that
      // JSON-LD recipeIngredient strings commonly truncate to just "ricotta cheese".
      // Only fall back to JSON-LD when HTML parsing produced fewer items (i.e. the
      // HTML scraper missed some ingredients that JSON-LD correctly captured).
      ingredients: htmlIngredients.length >= ingredients.length ? htmlIngredients : ingredients,
      instructions: jsonInstructions.length > 0 ? jsonInstructions : htmlInstructions,
      ...(htmlNotes || jsonNotes ? { notes: htmlNotes || jsonNotes } : {}),
    };

    const pageText = stripHtmlToText($('body').html() || $('body').text() || '');
    const inferredMeta = inferMissingRecipeMeta({
      prepTime: parsed.prepTime,
      cookTime: parsed.cookTime,
      servings: parsed.servings,
      instructions: parsed.instructions,
      pageText,
    });

    // Extract author — Schema.org `author` can be a string, {name:""}, or an array
    const rawAuthor = recipeNode.author;
    let extractedAuthor = '';
    if (typeof rawAuthor === 'string') {
      extractedAuthor = rawAuthor.trim();
    } else if (rawAuthor && typeof rawAuthor === 'object') {
      const first = Array.isArray(rawAuthor) ? rawAuthor[0] : rawAuthor;
      extractedAuthor = String(first?.name || first?.['@value'] || '').trim();
    }
    // Fall back to HTML byline when JSON-LD has no author
    if (!extractedAuthor) extractedAuthor = extractHtmlAuthor($);

    const jsonLdRecipe = {
      ...parsed,
      ...inferredMeta,
      ...(extractedAuthor ? { author: extractedAuthor } : {}),
      difficulty: deriveRecipeDifficulty(parsed, [
        recipeNode?.difficulty,
        recipeNode?.recipeCategory,
      ]),
    };

    return applySubRecipeLinks(chooseBestParsedRecipe(jsonLdRecipe, sharedParsed, {
      title: fallbackTitle,
      thumbnail: fallbackThumbnail,
      difficultyHints: [recipeNode?.difficulty, recipeNode?.recipeCategory, fallbackTitle],
    }));
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
    difficulty: 'Easy',
    cuisine: 'Global',
    tags: ['Imported'],
    nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    ingredients: fallbackIngredients
      .flatMap(raw => parseIngredientEntries(raw))
      .filter(Boolean),
    instructions: fallbackInstructions,
    ...(htmlNotes ? { notes: htmlNotes } : {}),
  };

  const pageText = stripHtmlToText($('body').html() || $('body').text() || '');
  Object.assign(selectorFallbackRecipe, inferMissingRecipeMeta({
    prepTime: selectorFallbackRecipe.prepTime,
    cookTime: selectorFallbackRecipe.cookTime,
    servings: selectorFallbackRecipe.servings,
    instructions: selectorFallbackRecipe.instructions,
    pageText,
  }));

  selectorFallbackRecipe.difficulty = deriveRecipeDifficulty(selectorFallbackRecipe, [fallbackTitle, htmlNotes]);

  const htmlAuthor = extractHtmlAuthor($);

  const selectedFallback = (htmlSectionRecipe.ingredients || []).length > (selectorFallbackRecipe.ingredients || []).length
    ? htmlSectionRecipe
    : selectorFallbackRecipe;

  return applySubRecipeLinks(chooseBestParsedRecipe(
    htmlAuthor ? { ...selectedFallback, author: htmlAuthor } : selectedFallback,
    sharedParsed,
    {
      title: fallbackTitle,
      thumbnail: fallbackThumbnail,
      difficultyHints: [fallbackTitle, htmlNotes],
    }
  ));
}
