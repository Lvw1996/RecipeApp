import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
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

function normalizeDifficultyLabel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';

  if (/\b(very\s+easy|super\s+easy)\b/.test(text)) return 'Easy';
  if (/\b(very\s+hard|super\s+hard)\b/.test(text)) return 'Hard';
  if (/\b(easy|simple|quick|beginner|starter|basic)\b/.test(text)) return 'Easy';
  if (/\b(hard|difficult|advanced|challenging|expert|complex)\b/.test(text)) return 'Hard';
  if (/\b(medium|moderate|intermediate)\b/.test(text)) return 'Medium';

  return '';
}

function estimateDifficulty(recipe) {
  const ingredientsCount = Array.isArray(recipe?.ingredients) ? recipe.ingredients.length : 0;
  const instructionsCount = Array.isArray(recipe?.instructions) ? recipe.instructions.length : 0;
  const totalMinutes = (Number(recipe?.prepTime) || 0) + (Number(recipe?.cookTime) || 0);
  const instructionText = (Array.isArray(recipe?.instructions) ? recipe.instructions : [])
    .map((step) => String(step || ''))
    .join(' ')
    .toLowerCase();

  const hardTechniqueHits = [
    /\bproof\b/,
    /\btemper\b/,
    /\bemulsif(?:y|ied|ication)\b/,
    /\bdeglaze\b/,
    /\breduction\b/,
    /\bcarameliz(?:e|ed|ation)\b/,
    /\bfillet\b/,
    /\bbutcher\b/,
    /\bconfit\b/,
  ].reduce((acc, pattern) => acc + (pattern.test(instructionText) ? 1 : 0), 0);

  if (totalMinutes > 0 && totalMinutes <= 35 && ingredientsCount <= 9 && instructionsCount <= 5 && hardTechniqueHits === 0) {
    return 'Easy';
  }

  if ((totalMinutes >= 150 && instructionsCount >= 8) || hardTechniqueHits >= 3) {
    return 'Hard';
  }

  let score = 0;
  if (totalMinutes >= 120) score += 3;
  else if (totalMinutes >= 75) score += 2;
  else if (totalMinutes >= 45) score += 1;

  if (ingredientsCount >= 16) score += 3;
  else if (ingredientsCount >= 12) score += 2;
  else if (ingredientsCount >= 9) score += 1;

  if (instructionsCount >= 11) score += 3;
  else if (instructionsCount >= 8) score += 2;
  else if (instructionsCount >= 6) score += 1;

  if (hardTechniqueHits >= 2) score += 3;
  else if (hardTechniqueHits === 1) score += 1;

  if (score >= 7) return 'Hard';
  if (score >= 3) return 'Medium';
  return 'Easy';
}

function deriveDifficulty(candidate, extras = []) {
  const sources = [candidate?.difficulty, ...extras];
  for (const source of sources) {
    const normalized = normalizeDifficultyLabel(source);
    if (normalized) return normalized;
  }
  return estimateDifficulty(candidate);
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
      .map((raw) => parseIngredientString(raw))
      .filter(Boolean),
    instructions,
  };

  return {
    ...parsed,
    difficulty: deriveDifficulty(parsed, [fallbackTitle]),
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
          quantity: roundImportedQty(parseQuantityToken(amount || '1')),
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
      difficulty: deriveDifficulty(parsed, [
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

  const isTlsChainError = (error) => {
    const msg = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '').toLowerCase();
    return (
      code === 'unable_to_verify_leaf_signature' ||
      code === 'self_signed_cert_in_chain' ||
      msg.includes('unable to verify the first certificate') ||
      msg.includes('unable to verify leaf signature') ||
      msg.includes('self signed certificate in certificate chain')
    );
  };

  let html = '';
  try {
    const response = await axios.get(url, requestConfig);
    html = response.data;
  } catch (error) {
    // Some sites have incomplete TLS chains that fail Node validation but still serve valid HTML.
    // Retry once with relaxed TLS only for known certificate-chain failures.
    if (isTlsChainError(error) && !signal?.aborted) {
      const insecureConfig = {
        ...requestConfig,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      };
      const insecureResponse = await axios.get(url, insecureConfig);
      html = insecureResponse.data;
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
      ingredients: htmlIngredients.length > ingredients.length ? htmlIngredients : ingredients,
      instructions: htmlInstructions.length > jsonInstructions.length ? htmlInstructions : jsonInstructions,
      ...(htmlNotes || jsonNotes ? { notes: htmlNotes || jsonNotes } : {}),
    };

    return {
      ...parsed,
      difficulty: deriveDifficulty(parsed, [
        recipeNode?.difficulty,
        recipeNode?.recipeCategory,
        recipeNode?.description,
        recipeNode?.keywords,
        fallbackTitle,
      ]),
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
    difficulty: 'Easy',
    cuisine: 'Global',
    tags: ['Imported'],
    nutrition: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    ingredients: fallbackIngredients
      .map(raw => parseIngredientString(raw))
      .filter(Boolean),
    instructions: fallbackInstructions,
    ...(htmlNotes ? { notes: htmlNotes } : {}),
  };

  selectorFallbackRecipe.difficulty = deriveDifficulty(selectorFallbackRecipe, [fallbackTitle, htmlNotes]);

  if ((htmlSectionRecipe.ingredients || []).length > (selectorFallbackRecipe.ingredients || []).length) {
    return htmlSectionRecipe;
  }

  return selectorFallbackRecipe;
}
