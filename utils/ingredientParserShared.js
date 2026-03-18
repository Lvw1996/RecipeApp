// Shared ingredient parsing utilities used by both recipe-app and recipe-app-importer

export const MEASURE_UNITS = [
  'tablespoons', 'tablespoon', 'tbsp',
  'teaspoons', 'teaspoon', 'tsp',
  'cups', 'cup', 'c',
  'fluid ounces', 'fluid ounce', 'fl oz',
  'pints', 'pint',
  'quarts', 'quart',
  'gallons', 'gallon',
  'milliliters', 'millilitres', 'milliliter', 'millilitre', 'ml',
  'mils', 'mil',
  'liters', 'litres', 'liter', 'litre', 'l',
  'kgs',
  'kilos', 'kilo',
  'kilograms', 'kilogram', 'kg',
  'grammes', 'gramme',
  'grams', 'gram', 'g',
  'pounds', 'pound', 'lbs', 'lb',
  'ounces', 'ounce', 'oz',
  'cloves', 'clove',
  'sticks', 'stick',
  'slices', 'slice',
  'sprigs', 'sprig',
  'bunches', 'bunch',
  'cans', 'can',
  'cubes', 'cube',
  'pinches', 'pinch',
  'sheets', 'sheet',
  'pieces', 'piece', 'pcs',
];

export const UNIT_ALIASES = {
  tablespoons: 'tbsp', tablespoon: 'tbsp',
  teaspoons: 'tsp', teaspoon: 'tsp',
  cups: 'cup',
  c: 'cup',
  'fluid ounces': 'fl oz', 'fluid ounce': 'fl oz',
  pints: 'pint', quarts: 'quart', gallons: 'gallon',
  milliliters: 'ml', millilitres: 'ml', milliliter: 'ml', millilitre: 'ml',
  mils: 'ml', mil: 'ml',
  liters: 'l', litres: 'l', liter: 'l', litre: 'l',
  kgs: 'kg',
  kilos: 'kg', kilo: 'kg',
  kilograms: 'kg', kilogram: 'kg',
  grammes: 'g', gramme: 'g',
  grams: 'g', gram: 'g',
  pounds: 'lb', pound: 'lb', lbs: 'lb',
  ounces: 'oz', ounce: 'oz',
  cloves: 'clove', sticks: 'stick', stick: 'stick', slices: 'slice', sprigs: 'sprig',
  bunches: 'bunch', cans: 'can', cubes: 'cube', cube: 'cube', pinches: 'pinch',
  sheets: 'sheet',
  pieces: 'pcs', piece: 'pcs',
};

export const PREP_NOTE_REGEX =
  /\b(?:finely|roughly|thinly|coarsely|freshly|lightly|gently|well|loosely)\b|\b(?:minced|chopped|diced|sliced|grated|crushed|peeled|trimmed|softened|melted|divided|roasted|toasted|ground|beaten|shredded|cut|halved|quartered|rinsed|drained|cooked|uncooked|thawed|heated|cooled|whipped|julienned|blanched|deveined|mashed|crumbled|warmed|separated)\b|^(?:to taste|for serving|for drizzling|as needed|room temp|at room temperature|optional|optional garnish|for garnish|garnish)/i;

export const PRICE_FRAGMENT_REGEX = /(?:^|\s)[£$€]\s?\d+(?:[.,]\d{1,2})?(?:\s|$)/g;

export const UNICODE_FRACTIONS = {
  '1/4': 1 / 4,
  '1/2': 1 / 2,
  '3/4': 3 / 4,
  '1/7': 1 / 7,
  '1/9': 1 / 9,
  '1/10': 1 / 10,
  '1/3': 1 / 3,
  '2/3': 2 / 3,
  '1/5': 1 / 5,
  '2/5': 2 / 5,
  '3/5': 3 / 5,
  '4/5': 4 / 5,
  '1/6': 1 / 6,
  '5/6': 5 / 6,
  '1/8': 1 / 8,
  '3/8': 3 / 8,
  '5/8': 5 / 8,
  '7/8': 7 / 8,
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

export const UNICODE_FRACTION_REGEX = '[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]';

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MEASURE_UNITS_PATTERN = MEASURE_UNITS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((unit) => escapeRegExp(unit))
  .join('|');
const LEADING_QTY_UNIT_REGEX = new RegExp(
  `^((?:[0-9]+\\s+[0-9]+\\/[0-9]+)|(?:[0-9]+\\/[0-9]+)|(?:[0-9]*\\.?[0-9]+))\\s*(?:x\\s*)?(?:${MEASURE_UNITS_PATTERN})\\b\\.?\\s*`,
  'i'
);

function stripLeadingMeasurementFragments(value) {
  let next = String(value || '').trim();

  for (let i = 0; i < 4; i += 1) {
    const previous = next;
    next = next
      .replace(/^[)\]\[]+\s*/, '')
      .replace(/^\/\s*/, '')
      .replace(/^\(\s*(?:\d+(?:\.\d+)?)\s*[-\s]?(?:oz|ounce|ounces|g|kg|ml|l|lb|lbs|pounds?)\s*\)?\s*/i, '')
      .replace(/^(?:\d+(?:\.\d+)?)\s*[-\s]?(?:oz|ounce|ounces|g|kg|ml|l|lb|lbs|pounds?)\)\s*/i, '')
      .replace(/^(?:oz|ounce|ounces|g|kg|ml|l|lb|lbs|pounds?)\)\s*/i, '')
      .replace(/^to\s+\d+\s+/i, '')
      .replace(LEADING_QTY_UNIT_REGEX, '')
      .trim();

    if (next === previous) break;
  }

  return next;
}

export function stripPriceAnnotations(value) {
  return String(value || '').replace(PRICE_FRAGMENT_REGEX, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanUnit(raw) {
  const lower = String(raw || '').toLowerCase().trim();
  const aliased = UNIT_ALIASES[lower] || lower;
  return aliased === 'pcs' ? '' : aliased;
}

export function roundImportedQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n >= 100) return Math.round(n);
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

export function parseQuantityToken(token) {
  const q = String(token || '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/⁄/g, '/')
    .replace(/(\d),(\d)/g, '$1.$2')
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

export function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripHtmlToText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function asCleanLine(value) {
  return stripHtml(decodeEntities(String(value || '')))
    .replace(/^[\s\u2022\-\u2013\u2014\u25CF\u25AA\u25AB\u25E6\u25A2\u25A0\u25A1\u25BA\u25B6\u25B8]+/, '')
    .trim();
}

export function parseIngredientString(raw) {
  let text = stripHtml(raw)
    .replace(/^[\s\u2022\-\u2013\u2014\u25CF\u25AA\u25AB\u25E6\u25A2\u25A0\u25A1\u25BA\u25B6\u25B8]+/, '')
    .replace(/(\d),(\d)/g, '$1.$2')
    .trim();
  if (!text) return null;

  let quantityMin = null;
  let quantityMax = null;
  let quantityDisplay = '';

  const rangeMatch = text.match(new RegExp(
    `^((?:[0-9]+\\s+[0-9]+\\/[0-9]+)|(?:[0-9]+\\s*${UNICODE_FRACTION_REGEX})|(?:[0-9]+\\/[0-9]+)|(?:${UNICODE_FRACTION_REGEX})|(?:[0-9]*\\.?[0-9]+))\\s*(?:to|or|[–—-])\\s*((?:[0-9]+\\s+[0-9]+\\/[0-9]+)|(?:[0-9]+\\s*${UNICODE_FRACTION_REGEX})|(?:[0-9]+\\/[0-9]+)|(?:${UNICODE_FRACTION_REGEX})|(?:[0-9]*\\.?[0-9]+))\\b\\s*`,
    'i'
  ));
  if (rangeMatch) {
    const lowerToken = rangeMatch[1].trim();
    const upperToken = rangeMatch[2].trim();
    quantityMin = roundImportedQty(parseQuantityToken(lowerToken));
    quantityMax = roundImportedQty(parseQuantityToken(upperToken));
    quantityDisplay = `${lowerToken} to ${upperToken}`;
    text = text.replace(rangeMatch[0], `${upperToken} `);
  }

  text = text
    .replace(/\(\(note[^)]*\)\)/gi, '')
    .replace(/\(note[^)]*\)/gi, '')
    .replace(/\(see\s+notes?[^)]*\)/gi, '')
    .replace(/\(,?\s*optional[^)]*\)/gi, '')
    .replace(/\(first\s+choice[^)]*\)/gi, '')
    .replace(/\(second\s+choice[^)]*\)/gi, '')
    .replace(/\(\s*,?\s*or\s+[^)]+\)/gi, '')
    .replace(/\(\s*[0-9]+(?:\.[0-9]+)?\s*[-\s]?(?:oz|ounce|ounces|g|kg|ml|l|lb|lbs|pounds?)\s*\)/gi, '')
    .replace(/\([0-9.]+\s*(?:kg|g|lbs?|oz|ml|l|cups?|tbsp|tsp)\)/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const compactCanPrefixMatch = text.match(
    /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*(g|kg|ml|l|oz|lb|lbs)\.?\s+cans?\b\.?\s*(?:of\s+)?/i
  );
  if (compactCanPrefixMatch) {
    const packCount = Number(compactCanPrefixMatch[1]);
    const packSize = Number(compactCanPrefixMatch[2]);
    if (Number.isFinite(packCount) && Number.isFinite(packSize) && packCount > 0 && packSize > 0) {
      const totalQty = packCount * packSize;
      const rest = text.slice(compactCanPrefixMatch[0].length).trim();
      text = `${totalQty} ${cleanUnit(compactCanPrefixMatch[3])}${rest ? ` ${rest}` : ''}`.trim();
    }
  }

  const qtyMatch = text.match(new RegExp(
    `^((?:[0-9]+\\s+[0-9]+\\/[0-9]+)|(?:[0-9]+\\s*${UNICODE_FRACTION_REGEX})|(?:[0-9]+\\/[0-9]+)|(?:${UNICODE_FRACTION_REGEX})|(?:[0-9]*\\.?[0-9]+))\\s*`
  ));
  let quantity = 1;
  if (qtyMatch) quantity = parseQuantityToken(qtyMatch[1]);
  let remainder = qtyMatch ? text.slice(qtyMatch[0].length).trim() : text;

  let packSizeNote = '';
  let inferredUnitFromPack = '';
  let altQuantity = null;
  let altUnit = '';
  const packSizeMatch = remainder.match(/^x\s*([0-9]+(?:\.[0-9]+)?)\s*(g|kg|ml|l|oz|lb|lbs)\b\.?\s*/i);
  if (packSizeMatch) {
    packSizeNote = `${packSizeMatch[1]} ${cleanUnit(packSizeMatch[2])} each`;
    remainder = remainder.slice(packSizeMatch[0].length).trim();
  }

  const compactPackMatch = remainder.match(
    /^(\d+(?:\.[0-9]+)?)\s*(g|kg|ml|l|oz|lb|lbs)\.?\s+cans?\b\.?\s*(?:of\s+)?/i
  );
  if (compactPackMatch) {
    const packAmount = Number(compactPackMatch[1]);
    if (Number.isFinite(packAmount) && packAmount > 0) {
      quantity *= packAmount;
      inferredUnitFromPack = cleanUnit(compactPackMatch[2]);
    }
    remainder = remainder.slice(compactPackMatch[0].length).trim();
  }

  const unitPattern = new RegExp(`^(${MEASURE_UNITS.join('|')})\\b\\.?\\s*`, 'i');
  const unitMatch = remainder.match(unitPattern);
  let unit = inferredUnitFromPack || (unitMatch ? cleanUnit(unitMatch[1]) : '');
  if (unitMatch) remainder = remainder.slice(unitMatch[0].length).trim();

  // Parse parenthetical quantity+unit prefixes, e.g. "(1 stick) unsalted butter"
  // or the secondary amount in "8 tbsp (1 stick) unsalted butter".
  const leadingParenQtyUnitMatch = remainder.match(new RegExp(
    `^\\(\\s*((?:[0-9]+\\s+[0-9]+\\/[0-9]+)|(?:[0-9]+\\s*${UNICODE_FRACTION_REGEX})|(?:[0-9]+\\/[0-9]+)|(?:${UNICODE_FRACTION_REGEX})|(?:[0-9]*\\.?[0-9]+))\\s*(sticks?|stick|g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp|grams?|kilograms?|kilos?|pounds?)\\s*\\)\\s*`,
    'i'
  ));
  if (leadingParenQtyUnitMatch) {
    const parsedQty = roundImportedQty(parseQuantityToken(leadingParenQtyUnitMatch[1]));
    const parsedUnit = cleanUnit(leadingParenQtyUnitMatch[2]);

    if (!unit) {
      quantity = parsedQty;
      unit = parsedUnit;
    } else if (altQuantity == null) {
      altQuantity = parsedQty;
      altUnit = parsedUnit;
    }

    remainder = remainder.slice(leadingParenQtyUnitMatch[0].length).trim();
  }

  if (unit) {
    const altMatch = remainder.match(new RegExp(
      `^\\/\\s*((?:[0-9]+\\s+[0-9]+\\/[0-9]+)|(?:[0-9]+\\s*${UNICODE_FRACTION_REGEX})|(?:[0-9]+\\/[0-9]+)|(?:${UNICODE_FRACTION_REGEX})|(?:[0-9]*\\.?[0-9]+))\\s*(g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp|grams?|kilograms?|kilos?|pounds?)\\b`,
      'i'
    ));
    if (altMatch) {
      altQuantity = roundImportedQty(parseQuantityToken(altMatch[1]));
      altUnit = cleanUnit(altMatch[2]);
    }

    remainder = remainder
      .replace(/^\/\s*[\d\s/\\.]+\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp)\b\s*/i, '')
      .replace(/^or\s*[\d\s/\\.]+\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp|grams?|kilograms?|kilos?|pounds?)\b\s*/i, '')
      .replace(/^[\d\s/\\.]+\s*(?:g|kg|ml|l|oz|lb|lbs|cup|cups|tbsp|tsp|grams?|kilograms?|kilos?|pounds?)\b\s*/i, '')
      .replace(/^of\s+/i, '')
      .trim();
  }

  // Some imports include a second amount chunk after separators,
  // e.g. "1 cup /240 milliliters hot coffee".
  remainder = stripLeadingMeasurementFragments(remainder);

  remainder = remainder.replace(/\(\s*$/, '').replace(/^\s*\)+/, '').trim();

  let prepNote = '';
  const parenMatch = remainder.match(/\s*\(+\s*,?\s*([^()]+?)\s*\)+\s*$/);
  if (parenMatch) {
    const inner = parenMatch[1].replace(/^,\s*/, '').trim();
    if (!/^(?:note\s*\d*|see\s+notes?|optional)/i.test(inner) && inner.length > 0) {
      prepNote = inner;
      remainder = remainder.slice(0, parenMatch.index).trim();
    }
  }

  if (!prepNote) {
    const danglingOpenMatch = remainder.match(/^(.*?)\s+\(+\s*([^()]+?)\s*$/);
    if (danglingOpenMatch) {
      const inner = danglingOpenMatch[2].replace(/^,\s*/, '').trim();
      if (!/^(?:note\s*\d*|see\s+notes?|optional)/i.test(inner) && inner.length > 0) {
        prepNote = inner;
        remainder = danglingOpenMatch[1].trim();
      }
    }
  }

  const commaMatch = remainder.match(/,\s*(.+)$/);
  if (commaMatch) {
    const suffix = commaMatch[1].trim();
    if (PREP_NOTE_REGEX.test(suffix)) {
      if (!prepNote) prepNote = suffix;
      remainder = remainder.slice(0, commaMatch.index).trim();
    }
  }

  const trailingPrepMatch = remainder.match(
    /\b((?:finely|roughly|thinly|coarsely|freshly|lightly|gently)\s+(?:minced|chopped|diced|sliced|grated|crushed|julienned|shredded)|(?:minced|chopped|diced|sliced|grated|crushed|julienned|shredded))\s*$/i
  );
  if (trailingPrepMatch) {
    if (!prepNote) prepNote = trailingPrepMatch[1].trim();
    remainder = remainder.slice(0, trailingPrepMatch.index).trim();
  }

  const trailingPrefMatch = remainder.match(/\b((?:of\s+)?more to your liking|if needed|as needed)\s*$/i);
  if (trailingPrefMatch) {
    const suffix = trailingPrefMatch[1].replace(/^of\s+/i, '').trim();
    prepNote = prepNote ? `${prepNote}; ${suffix}` : suffix;
    remainder = remainder.slice(0, trailingPrefMatch.index).trim();
  }

  remainder = remainder.replace(/\)+\s*$/, '').trim();

  if (!unit && qtyMatch) {
    const trailingCountMatch = remainder.match(
      /^(.*?)(?:\s+)(cloves?|slices?|sprigs?|pinches?|pieces?|pcs|cubes?|sheets?)\b\.?\s*(.*)$/i
    );
    if (trailingCountMatch) {
      remainder = trailingCountMatch[1].trim();
      unit = cleanUnit(trailingCountMatch[2]);
      const ctx = String(trailingCountMatch[3] || '').trim();
      if (ctx && !prepNote) prepNote = ctx;
    }
  }

  if (packSizeNote) prepNote = prepNote ? `${prepNote}; ${packSizeNote}` : packSizeNote;

  const rawName = remainder
    .replace(/^to\s+\d+\s+/i, '')
    .replace(/^[).,:;\-\/\\]+\s*/, '')
    .replace(/^(?:and|or)\s+/i, '')
    .replace(/\bcoriander\s*\/\s*cilantro\b/gi, 'cilantro')
    .replace(/\bcilantro\s*\/\s*coriander\b/gi, 'cilantro')
    .replace(/\beschalots?\s*\/\s*french\s+onions?(?:\s*\(\s*us\s*:\s*onions?\s*\))?/gi, 'onion')
    .replace(/\bsour[-\s]?cream\s+greek\s+yogurt\b/gi, 'sour cream or greek yogurt')
    .replace(/\bgreek\s+yogurt\s+sour[-\s]?cream\b/gi, 'greek yogurt or sour cream')
    .replace(/\bfresh\s+herbs?\s+of\s+choice\b/gi, 'fresh herbs of choice')
    .replace(/\(\s*us\s*:\s*[^)]+\)/gi, '')
    .replace(/\(+\s*us\s*:\s*[^)]*$/i, '')
    .replace(/^of\s+/i, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*\+\s*[\d\s\u00BC-\u00BE\u2150-\u215E\/]+\s*(?:cups?|tbsp?|tbs|tsp|ml|g|oz|lbs?)\s+for\b[^,]*/gi, '')
    .replace(/\bfor\s+boiling\b.*$/i, '')
    .replace(/\bfor\s+(?:frying|sauteing|sautéing)\b.*$/i, '')
    .replace(/\(\s*(?:and|or)\s*$/i, '')
    .replace(/\([^)]*$/i, '')
    .replace(/\s+(?:and|or)\s*$/i, '')
    .replace(/\bbell\s+pepper\s+bell\s+pepper\b/gi, 'bell pepper')
    .replace(/\b(?:to taste|for serving|as needed|optional|optional garnish|for garnish|garnish)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || text.split(/[,(]/)[0].replace(/^of\s+/i, '').trim();

  if (!rawName) return null;
  if (/^\d+(?:\.\d+)?$/.test(rawName)) return null;

  const name = stripPriceAnnotations(rawName)
    .replace(/\bfor\s+boiling\b.*$/i, '')
    .replace(/\bfor\s+(?:frying|sauteing|sautéing)\b.*$/i, '')
    .replace(/^salted\s+water$/i, 'water')
    .replace(/[\s,;:]+$/g, '')
    .trim();

  // Filter out punctuation-only fragments to avoid empty match keys downstream.
  if (!/[a-z]/i.test(name)) return null;

  const selectedQuantity = quantityMax != null ? quantityMax : roundImportedQty(quantity);

  return {
    name: name || rawName,
    quantity: selectedQuantity,
    unit,
    ...(quantityMin != null ? { quantityMin } : {}),
    ...(quantityMax != null ? { quantityMax } : {}),
    ...(quantityDisplay ? { quantityDisplay } : {}),
    ...(altQuantity != null ? { altQuantity } : {}),
    ...(altUnit ? { altUnit } : {}),
    ...(prepNote ? { prepNote: stripPriceAnnotations(prepNote) } : {}),
  };
}
