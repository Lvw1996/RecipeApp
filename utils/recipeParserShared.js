import {
  cleanUnit,
  roundImportedQty,
  stripPriceAnnotations,
  stripHtmlToText,
  decodeEntities,
  asCleanLine,
  parseIngredientString,
} from './ingredientParserShared.js';

const SALT_AND_PEPPER_PATTERN = /\bsalt\b\s*(?:and|&)\s*(?:freshly\s+ground\s+|ground\s+|cracked\s+|black\s+)?\bpepper\b|\b(?:freshly\s+ground\s+|ground\s+|cracked\s+|black\s+)?\bpepper\b\s*(?:and|&)\s*\bsalt\b/i;

const parseIsoDurationToMinutes = (value) => {
  if (typeof value !== 'string') return Number(value) || 0;
  const match = value.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!match) return Number(value) || 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  return hours * 60 + minutes;
};

const parseServings = (value) => {
  if (typeof value === 'number') return value > 0 ? Math.round(value) : 1;
  if (typeof value !== 'string') return 1;
  const firstNumber = value.match(/\d+(?:\.\d+)?/);
  return firstNumber ? Math.max(1, Math.round(Number(firstNumber[0]))) : 1;
};

const getMetaContent = (html, attr, key) => {
  const regex = new RegExp(`<meta[^>]*${attr}=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  const match = String(html || '').match(regex);
  return match ? asCleanLine(decodeEntities(match[1])) : '';
};

const getSectionHtmlByHeading = (html, headingPattern) => {
  const regex = new RegExp(
    `<(h1|h2|h3|h4)[^>]*>\\s*(?:${headingPattern})\\s*<\\/\\1>([\\s\\S]*?)(?=<(?:h1|h2|h3|h4)[^>]*>|$)`,
    'i'
  );
  const match = String(html || '').match(regex);
  return match ? match[2] : '';
};

const extractListItems = (sectionHtml) => {
  if (!sectionHtml) return [];

  const listItems = [...sectionHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => asCleanLine(decodeEntities(m[1])))
    .filter(Boolean);

  if (listItems.length > 0) return listItems;

  const plain = asCleanLine(decodeEntities(sectionHtml.replace(/<[^>]+>/g, ' ')));
  if (!plain) return [];

  return [...plain.matchAll(/(?:^|\s)(\d+)[.)]\s*([\s\S]*?)(?=(?:\s\d+[.)]\s)|$)/g)]
    .map((m) => asCleanLine(m[2]))
    .filter(Boolean);
};

const extractTextLines = (sectionHtml) => {
  if (!sectionHtml) return [];

  const withBreaks = sectionHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h4|h5|h6)>/gi, '\n');

  const plain = decodeEntities(withBreaks).replace(/<[^>]+>/g, ' ');

  return plain
    .split(/\n+/)
    .map((line) => asCleanLine(line))
    .filter(Boolean);
};

const isLikelyIngredientLine = (line) => {
  const cleaned = asCleanLine(line);
  if (!cleaned) return false;

  const lower = cleaned.toLowerCase();
  if (['us', 'metric', 'ingredients', 'method', 'instructions'].includes(lower)) return false;
  if (/^(for\s+the\b|you\'ll\s+need\b)/i.test(cleaned)) return false;

  if (/^\d/.test(cleaned)) return true;
  if (/\b(cup|tsp|tbsp|g|kg|ml|l|oz|lb|pinch|egg|butter|flour|sugar|milk|salt|pepper|vanilla)\b/i.test(lower)) return true;
  if (/^[a-z][a-z\s'\-]{2,30}$/i.test(cleaned) && cleaned.split(' ').length <= 4) return true;

  return false;
};

const cleanIngredientName = (value) => {
  let next = asCleanLine(value);

  next = next
    .replace(/\bsour[-\s]?cream\s+greek\s+yogurt\b/gi, 'sour cream or greek yogurt')
    .replace(/\bgreek\s+yogurt\s+sour[-\s]?cream\b/gi, 'greek yogurt or sour cream')
    .replace(/\bfresh\s+herbs?\s+of\s+choice\b/gi, 'fresh herbs of choice')
    .replace(/\bcliantro\b/gi, 'cilantro')
    .replace(/\b\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp)\s*\/\s*\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp)\b/gi, ' ')
    .replace(/\bus\s*\/\s*metric\b/gi, ' ')
    .replace(/\(\(?\s*~?\s*each\s+in\s+shell[^)]*\)?\)/gi, ' ')
    .replace(/\(\s*slivered\s+or\s+flaked\s+almonds?\s+also\s+great[^)]*\)/gi, ' ')
    .replace(/\(\s*regular\s+greek\s+or\s+greek-style[^)]*\)/gi, ' ')
    .replace(/\(\(?\s*[^)]*note\s*\d*[^)]*\)?\)/gi, ' ')
    .replace(/\bcoriander\s*\/\s*cilantro\b/gi, 'cilantro')
    .replace(/\bcilantro\s*\/\s*coriander\b/gi, 'cilantro')
    .replace(/\bplain\s+unsweetened\s+yogurt\b/gi, 'yogurt')
    .replace(/\blarge\s+eggs?\b/gi, 'egg')
    .replace(/\beggs?\s+in\s+shell\b/gi, 'egg')
    .replace(/\s+-\s+.*$/g, ' ')
    .replace(/,\s*(?:cut|sliced|diced|minced|chopped|crushed|grated|divided|softened|melted|to taste|plus more|for serving).*/i, '')
    .replace(/\bfor\s+boiling\b.*$/i, '')
    .replace(/\b(?:to taste|for serving|as needed|optional|optional garnish|for garnish|garnish)\b.*$/i, '')
    .replace(/\b(?:finely|roughly|thinly|coarsely|freshly|lightly|gently)\s+(?:minced|chopped|diced|sliced|grated|crushed|julienned|shredded)\b$/i, '')
    .replace(/\b(?:minced|chopped|diced|sliced|grated|crushed|julienned|shredded)\b$/i, '')
    .trim();

  return (next || asCleanLine(value)).replace(/\s+/g, ' ').trim();
};

const expandSeasoningLine = (value) => {
  const line = asCleanLine(value);
  if (!line) return [];
  if (!SALT_AND_PEPPER_PATTERN.test(line)) return [line];

  return [
    line.replace(SALT_AND_PEPPER_PATTERN, 'salt').trim(),
    line.replace(SALT_AND_PEPPER_PATTERN, 'black pepper').trim(),
  ].filter(Boolean);
};

const parseIngredientText = (line, canonicalizeName) => {
  const shared = parseIngredientString(String(line || ''));
  if (!shared) return null;

  let displayName = stripPriceAnnotations(cleanIngredientName(shared.name))
    .replace(/^to\s+\d+\s+/i, '')
    .replace(/[\s,;:]+$/g, '')
    .trim();

  let prepNote = String(shared.prepNote || '').trim();

  const flourVariantMatch = displayName.match(/^(flour)\s*,\s*(plain\s*\/\s*all-purpose|all-purpose|plain)$/i);
  if (flourVariantMatch) {
    displayName = flourVariantMatch[1].trim();
    const flourVariant = flourVariantMatch[2].trim();
    prepNote = prepNote ? `${prepNote}; ${flourVariant}` : flourVariant;
  }

  const canonicalName = canonicalizeName(displayName
    .replace(/^to\s+\d+\s+/i, '')
    .replace(/[\s,;:]+$/g, '')
    .trim());

  if (!displayName || !canonicalName || /^\d+(?:\.\d+)?$/.test(canonicalName)) return null;

  const quantityDisplay = String(shared.quantityDisplay || '').trim();

  return {
    name: displayName,
    canonicalName,
    quantity: shared.quantity,
    unit: shared.unit,
    ...(quantityDisplay ? { quantityDisplay } : {}),
    ...(Number.isFinite(shared.quantityMin) ? { quantityMin: Number(shared.quantityMin) } : {}),
    ...(Number.isFinite(shared.quantityMax) ? { quantityMax: Number(shared.quantityMax) } : {}),
    ...(Number.isFinite(shared.altQuantity) ? { altQuantity: Number(shared.altQuantity) } : {}),
    ...(String(shared.altUnit || '').trim() ? { altUnit: cleanUnit(String(shared.altUnit || '')) } : {}),
    ...(prepNote ? { prepNote } : {}),
  };
};

const ingredientsFromValue = (value, canonicalizeName) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => ingredientsFromValue(entry, canonicalizeName))
      .filter((item) => item.name)
      .filter(
        (item, index, self) =>
          index === self.findIndex((x) => (x.canonicalName || x.name).toLowerCase() === (item.canonicalName || item.name).toLowerCase())
      );
  }

  if (typeof value === 'string') {
    return expandSeasoningLine(value)
      .map((line) => parseIngredientText(line, canonicalizeName))
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    const anyValue = value;
    const rawName = asCleanLine(anyValue.name || anyValue.text || anyValue.ingredient || anyValue.item)
      .replace(/^(?:or|\/)\s*[\d\s\/\.]+\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp|grams?|kilograms?|kilos?|pounds?)\b\s*/i, '')
      .replace(/^of\s+/i, '')
      .trim();

    const parsedFromRaw = expandSeasoningLine(rawName)
      .map((line) => parseIngredientText(line, canonicalizeName))
      .filter(Boolean);

    if (parsedFromRaw.length > 0) {
      return parsedFromRaw.map((parsed) => ({
        name: parsed.name,
        canonicalName: parsed.canonicalName,
        quantity: roundImportedQty(Number(anyValue.quantity) || parsed.quantity || 1),
        unit: cleanUnit(String(anyValue.unit || parsed.unit || '')),
        ...(String(anyValue.quantityDisplay || parsed.quantityDisplay || '').trim()
          ? { quantityDisplay: String(anyValue.quantityDisplay || parsed.quantityDisplay || '').trim() }
          : {}),
        ...(Number.isFinite(Number(anyValue.quantityMin)) || Number.isFinite(parsed.quantityMin)
          ? { quantityMin: Number.isFinite(Number(anyValue.quantityMin)) ? Number(anyValue.quantityMin) : parsed.quantityMin }
          : {}),
        ...(Number.isFinite(Number(anyValue.quantityMax)) || Number.isFinite(parsed.quantityMax)
          ? { quantityMax: Number.isFinite(Number(anyValue.quantityMax)) ? Number(anyValue.quantityMax) : parsed.quantityMax }
          : {}),
        ...(Number.isFinite(Number(anyValue.altQuantity)) || Number.isFinite(parsed.altQuantity)
          ? { altQuantity: Number.isFinite(Number(anyValue.altQuantity)) ? Number(anyValue.altQuantity) : parsed.altQuantity }
          : {}),
        ...(cleanUnit(String(anyValue.altUnit || parsed.altUnit || ''))
          ? { altUnit: cleanUnit(String(anyValue.altUnit || parsed.altUnit || '')) }
          : {}),
        ...(anyValue.prepNote || parsed.prepNote ? { prepNote: anyValue.prepNote || parsed.prepNote } : {}),
      }));
    }

    if (!rawName) return [];

    return [
      {
        name: rawName,
        canonicalName: canonicalizeName(rawName),
        quantity: roundImportedQty(Number(anyValue.quantity) || 1),
        unit: cleanUnit(String(anyValue.unit || '')),
        ...(anyValue.prepNote ? { prepNote: anyValue.prepNote } : {}),
      },
    ];
  }

  return [];
};

const parseJsonSafely = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const findRecipeNode = (value) => {
  if (!value) return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecipeNode(entry);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const node = value;
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => String(t).toLowerCase() === 'recipe')) return node;

    if (Array.isArray(node['@graph'])) {
      const graphMatch = findRecipeNode(node['@graph']);
      if (graphMatch) return graphMatch;
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      const found = findRecipeNode(child);
      if (found) return found;
    }
  }

  return null;
};

const instructionLinesFromValue = (value) => {
  if (value == null) return [];

  if (typeof value === 'string') {
    return value
      .split(/\r?\n+|(?<=\.)\s+(?=[A-Z0-9])/)
      .map((line) => asCleanLine(line))
      .map((line) => line.replace(/^\d+[.):-]?\s*/, ''))
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => instructionLinesFromValue(entry));
  }

  if (typeof value === 'object') {
    const anyValue = value;
    if (typeof anyValue.text === 'string') return instructionLinesFromValue(anyValue.text);
    if (Array.isArray(anyValue.itemListElement)) return instructionLinesFromValue(anyValue.itemListElement);
    if (typeof anyValue.name === 'string') return instructionLinesFromValue(anyValue.name);
  }

  return [];
};

const extractMinutesFromText = (text = '') => {
  const source = String(text || '').toLowerCase();
  if (!source) return 0;

  let total = 0;
  const both = [...source.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?)\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(minutes?|mins?)/gi)];
  for (const m of both) total += Math.round(Number(m[1]) * 60 + Number(m[3]));

  const reduced = source.replace(/(\d+(?:\.\d+)?)\s*(hours?|hrs?)\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(minutes?|mins?)/gi, ' ');
  const singles = [...reduced.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/gi)];
  for (const m of singles) {
    const value = Number(m[1]);
    total += /hour|hr/i.test(m[2]) ? Math.round(value * 60) : Math.round(value);
  }
  return total;
};

const inferTimesFromInstructions = (instructions = []) => {
  let prep = 0;
  let cook = 0;
  for (const line of Array.isArray(instructions) ? instructions : []) {
    const text = String(line || '').trim();
    if (!text) continue;
    const minutes = extractMinutesFromText(text);
    if (minutes <= 0) continue;
    const cookLike = /\b(?:bake|roast|simmer|boil|cook|fry|saute|sauté|grill|broil|preheat|heat|oven|stovetop|stove)\b/.test(text.toLowerCase());
    if (cookLike) cook += minutes;
    else prep += minutes;
  }
  return { prepTime: Math.round(prep), cookTime: Math.round(cook) };
};

const extractServingsFromText = (text = '') => {
  const source = String(text || '').toLowerCase();
  const servesMatch = source.match(/\bserv(?:e|es|ings?)\b\s*[:\-]?\s*(\d+)(?:\s*(?:to|-|–|—)\s*(\d+))?/i);
  if (servesMatch) {
    const a = Number(servesMatch[1]);
    const b = Number(servesMatch[2] || 0);
    if (a > 0) return b > 0 ? Math.round((a + b) / 2) : Math.round(a);
  }
  const makesMatch = source.match(/\b(?:makes?|yield|yields?)\b\s*[:\-]?\s*(\d+)(?:\s*(?:to|-|–|—)\s*(\d+))?/i);
  if (makesMatch) {
    const a = Number(makesMatch[1]);
    const b = Number(makesMatch[2] || 0);
    if (a > 0) return b > 0 ? Math.round((a + b) / 2) : Math.round(a);
  }
  return 0;
};

const inferMissingRecipeMeta = ({ prepTime = 0, cookTime = 0, servings = 1, instructions = [], pageText = '' }) => {
  const inferredTimes = inferTimesFromInstructions(instructions);
  const inferredServings = extractServingsFromText(pageText);

  return {
    prepTime: prepTime > 0 ? prepTime : inferredTimes.prepTime,
    cookTime: cookTime > 0 ? cookTime : inferredTimes.cookTime,
    servings: servings > 1 ? servings : (inferredServings > 0 ? inferredServings : servings),
  };
};

export const parseImportedRecipeFromHtml = (html, options = {}) => {
  const canonicalizeName = typeof options.canonicalizeName === 'function'
    ? options.canonicalizeName
    : (value) => String(value || '').trim().toLowerCase();

  const text = String(html || '');
  if (!text.trim()) return null;

  const scriptMatches = [...text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let recipeNode = null;
  for (const match of scriptMatches) {
    const parsed = parseJsonSafely(String(match[1] || '').trim());
    if (!parsed) continue;
    recipeNode = findRecipeNode(parsed);
    if (recipeNode) break;
  }

  const titleFromHtml =
    getMetaContent(text, 'property', 'og:title') ||
    asCleanLine(decodeEntities((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));

  const thumbnailFromHtml =
    getMetaContent(text, 'property', 'og:image') ||
    getMetaContent(text, 'name', 'twitter:image');

  const methodSection = getSectionHtmlByHeading(text, 'Method|Instructions?');
  const ingredientsSection = getSectionHtmlByHeading(text, 'Ingredients?');
  const notesSection = getSectionHtmlByHeading(text, 'Notes?|Recipe\\s*Notes?|Cook\'?s?\\s*Notes?|Tips?');

  let instructions = recipeNode
    ? instructionLinesFromValue(recipeNode.recipeInstructions)
    : extractListItems(methodSection);

  const methodLines = extractTextLines(methodSection);
  if (instructions.length === 0 && methodLines.length > 0) {
    instructions = methodLines
      .map((line) => line.replace(/^\d+[.)-]?\s*/, '').trim())
      .filter(Boolean)
      .filter((line, index, arr) => arr.indexOf(line) === index);
  }

  let ingredientLines = extractListItems(ingredientsSection);
  const ingredientTextLines = extractTextLines(ingredientsSection).filter(isLikelyIngredientLine);
  if (ingredientLines.length === 0) ingredientLines = ingredientTextLines;

  const ingredients = recipeNode
    ? ingredientsFromValue(recipeNode.recipeIngredient, canonicalizeName)
    : ingredientLines.flatMap((line) => ingredientsFromValue(line, canonicalizeName));

  const servesMatch = decodeEntities(text).match(/Serves\s*(\d+(?:\s*[-–]\s*\d+)?)/i);
  const notes = stripHtmlToText(notesSection || '') || stripHtmlToText(String(recipeNode?.recipeNotes || recipeNode?.notes || recipeNode?.description || ''));

  const prepMinutes = recipeNode
    ? parseIsoDurationToMinutes(recipeNode.prepTime) || Number(recipeNode.prepTimeMinutes) || 0
    : 0;
  const cookMinutes = recipeNode
    ? parseIsoDurationToMinutes(recipeNode.cookTime) || Number(recipeNode.cookTimeMinutes) || 0
    : 0;

  const parsedRecipe = {
    title: asCleanLine(recipeNode?.name) || titleFromHtml || 'Imported Recipe',
    thumbnail:
      typeof recipeNode?.image === 'string'
        ? recipeNode.image
        : Array.isArray(recipeNode?.image)
        ? String(recipeNode.image[0]?.url || recipeNode.image[0] || '')
        : String(recipeNode?.image?.url || thumbnailFromHtml || ''),
    prepTime: prepMinutes,
    cookTime: cookMinutes,
    servings: parseServings(recipeNode?.recipeYield || servesMatch?.[1] || ''),
    ingredients,
    instructions,
    ...(notes ? { notes } : {}),
    tags: ['Imported'],
    cuisine: asCleanLine(recipeNode?.recipeCuisine) || 'Global',
    difficulty: 'Easy',
  };

  const pageText = stripHtmlToText(text || '');
  const inferred = inferMissingRecipeMeta({
    prepTime: parsedRecipe.prepTime,
    cookTime: parsedRecipe.cookTime,
    servings: parsedRecipe.servings,
    instructions: parsedRecipe.instructions,
    pageText,
  });

  return {
    ...parsedRecipe,
    ...inferred,
  };
};

export const parseImportedRecipeFromUrl = async (url, options = {}) => {
  const pageUrl = String(url || '').trim();
  if (!pageUrl) return null;

  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl(pageUrl);
    const html = await response.text();
    return parseImportedRecipeFromHtml(html, options);
  } catch {
    return null;
  }
};
