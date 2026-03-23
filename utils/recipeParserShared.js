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
// Matches "1 tsp each paprika and cumin", "each black pepper and cayenne pepper", etc.
const EACH_AND_PATTERN = /\beach\s+\w.*?\s+and\s+\w/i;

const parseIsoDurationToMinutes = (value) => {
  if (typeof value !== 'string') return Number(value) || 0;
  const match = value.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!match) return Number(value) || 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  return hours * 60 + minutes;
};

const parseServings = (value) => {
  if (Array.isArray(value)) return parseServings(value[0]);
  if (value && typeof value === 'object') return parseServings(value.value ?? value['@value'] ?? '');
  if (typeof value === 'number') return value > 0 ? Math.round(value) : 1;
  if (typeof value !== 'string') return 1;
  const firstNumber = value.match(/\d+(?:\.\d+)?/);
  return firstNumber ? Math.max(1, Math.round(Number(firstNumber[0]))) : 1;
};

const parseAttributes = (tag = '') => {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let m;
  while ((m = attrRe.exec(String(tag || ''))) !== null) {
    attrs[String(m[1] || '').toLowerCase()] = String(m[3] || '');
  }
  return attrs;
};

const getMetaContent = (html, attr, key) => {
  const targetAttr = String(attr || '').toLowerCase();
  const targetKey = String(key || '').toLowerCase();
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attrs = parseAttributes(tag);
    if (String(attrs[targetAttr] || '').toLowerCase() !== targetKey) continue;
    const content = String(attrs.content || '').trim();
    if (content) return asCleanLine(decodeEntities(content));
  }

  return '';
};

const imageUrlFromValue = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return String(value).trim();

  if (Array.isArray(value)) {
    for (const entry of value) {
      const next = imageUrlFromValue(entry);
      if (next) return next;
    }
    return '';
  }

  if (typeof value === 'object') {
    return (
      imageUrlFromValue(value.url) ||
      imageUrlFromValue(value.secure_url) ||
      imageUrlFromValue(value.contentUrl) ||
      imageUrlFromValue(value.thumbnailUrl) ||
      imageUrlFromValue(value.image) ||
      imageUrlFromValue(value['@id'])
    );
  }

  return '';
};

const normalizeImageUrl = (value, baseUrl = '') => {
  const raw = imageUrlFromValue(value);
  if (!raw) return '';

  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;

  if (baseUrl) {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return raw;
    }
  }

  return raw;
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
    // Convert leading word-form numbers to digits so the ingredient parser's
    // compact-can prefix regex (which needs digit tokens) can process them.
    // e.g. "two 28-ounce cans ..." → "2 28-ounce cans ..."
    .replace(/^(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+/i, (_, w) => ({ two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' }[w.toLowerCase()] + ' '))
    // Normalise hyphenated unit adjective "28-ounce" → "28 oz" so numeric can-size
    // patterns match correctly (regex expects digit[space]unit, not digit-ounce).
    .replace(/\b(\d+)-ounces?\b/gi, '$1 oz')
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
    .replace(/,\s*(?:flaked|cut|sliced|diced|minced|chopped|crushed|grated|divided|softened|melted|to taste|plus more|for serving).*/i, '')
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

  // Split "EACH X and Y" → two separate items sharing the same unit prefix.
  // e.g. "1 tsp each paprika and cumin" → ["1 tsp paprika", "1 tsp cumin"]
  if (EACH_AND_PATTERN.test(line)) {
    const eachIdx = line.search(/\beach\s+\w/i);
    const prefix = line.slice(0, eachIdx);
    const afterEach = line.slice(eachIdx).replace(/^each\s+/i, '');
    const andIdx = afterEach.indexOf(' and ');
    if (andIdx > 0) {
      const partA = afterEach.slice(0, andIdx).trim();
      const partB = afterEach.slice(andIdx + 5).trim();
      if (partA && partB) {
        return [prefix + partA, prefix + partB].filter(Boolean);
      }
    }
  }

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
    // Some sites embed raw control characters (e.g. bare \r or \n) inside JSON
    // string literals, making the JSON technically invalid. Walk through the string
    // and escape control characters only when they appear inside a string value,
    // preserving structural whitespace (spaces, tabs, newlines between tokens).
    try {
      let sanitized = '';
      let inString = false;
      let escaped = false;
      for (const ch of value) {
        if (escaped) {
          sanitized += ch;
          escaped = false;
        } else if (ch === '\\') {
          sanitized += ch;
          if (inString) escaped = true;
        } else if (ch === '"') {
          sanitized += ch;
          inString = !inString;
        } else if (inString && ch.charCodeAt(0) < 0x20) {
          if (ch === '\r') sanitized += '\\r';
          else if (ch === '\n') sanitized += '\\n';
          else if (ch === '\t') sanitized += '\\t';
          else sanitized += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        } else {
          sanitized += ch;
        }
      }
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
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
  const makesMatch = source.match(/\b(?:makes?|yield|yields?|portions?)\b\s*[:\-]?\s*(\d+)(?:\s*(?:to|-|–|—)\s*(\d+))?/i);
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
    getMetaContent(text, 'property', 'og:image:url') ||
    getMetaContent(text, 'name', 'og:image') ||
    getMetaContent(text, 'name', 'og:image:url') ||
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

  // Some sites (e.g. Woolworths SA) publish JSON-LD recipeIngredient as bare
  // names with no quantities/units.  When that's detected, fall back to the
  // richer <li> elements found in the page HTML which DO carry quantities.
  const rawLdIngArr = Array.isArray(recipeNode?.recipeIngredient)
    ? recipeNode.recipeIngredient
    : recipeNode?.recipeIngredient ? [String(recipeNode.recipeIngredient)] : [];
  const ldQuantityPoor =
    rawLdIngArr.length > 0 &&
    rawLdIngArr.filter((s) => /\d/.test(String(s || ''))).length / rawLdIngArr.length < 0.2;

  const htmlLiIngredients = ldQuantityPoor
    ? (() => {
        const qtyUnitRe = /^\d[\d\s/\-]*\s+(?:tsp|tbsp?|tablespoons?|teaspoons?|cups?|ml|g(?!\w)|kg|oz|lbs?|pounds?|pinch|handful|bunch|cloves?|slices?)\b/i;
        const lines = [...text.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
          .map((m) => asCleanLine(decodeEntities(m[1])))
          .filter((s) => s && qtyUnitRe.test(s));
        return lines.length > 0 && lines.length >= rawLdIngArr.length * 0.8 ? lines : null;
      })()
    : null;

  const ingredients = recipeNode
    ? (htmlLiIngredients
        ? htmlLiIngredients.flatMap((line) => ingredientsFromValue(line, canonicalizeName))
        : ingredientsFromValue(recipeNode.recipeIngredient, canonicalizeName))
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
    thumbnail: normalizeImageUrl(recipeNode?.image || thumbnailFromHtml || '', options.baseUrl || ''),
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
    // Treat any non-2xx response (404, 410, 500, etc.) as a failure — don't
    // parse error pages which can accidentally look like recipes.
    if (!response.ok) return null;
    const html = await response.text();
    return parseImportedRecipeFromHtml(html, { ...options, baseUrl: pageUrl });
  } catch {
    return null;
  }
};
