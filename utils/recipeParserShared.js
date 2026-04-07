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
  const rangeMatch = value.match(/(\d+(?:\.\d+)?)\s*(?:to|[-\u2013\u2014])\s*(\d+(?:\.\d+)?)/i);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    if (a > 0 && b > 0) return Math.max(1, Math.round((a + b) / 2));
  }
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
  // Allow inline tags (anchors, spans, etc.) before/after the heading text,
  // e.g. <h2><a name="ingredients"></a>Ingredients</h2> or
  //      <h2><span class="label">Ingredients</span></h2>.
  const regex = new RegExp(
    `<(h1|h2|h3|h4)[^>]*>\\s*(?:<[^>]+>\\s*)*(?:${headingPattern})\\s*(?:<[^>]+>\\s*)*<\\/\\1>([\\s\\S]*?)(?=<(?:h1|h2|h3|h4)[^>]*>|$)`,
    'i'
  );
  const match = String(html || '').match(regex);
  return match ? match[2] : '';
};

/**
 * Scans <a href> links inside <li> elements in sectionHtml.
 * Returns a Map<anchorTextLowercase, absoluteUrl> for links pointing to the
 * same hostname as baseUrl. Used to detect ingredient lines that link to
 * sub-recipes on the same site.
 */
const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

const extractIngredientLinkMap = (sectionHtml, baseUrl) => {
  const linkMap = new Map();
  if (!sectionHtml || !baseUrl) return linkMap;

  let baseDomain;
  try {
    baseDomain = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return linkMap;
  }

  // Matches href with quoted value (href="url" or href='url') OR unquoted (href=url)
  const ANCHOR_RE = /<a\s[^>]*href\s*=\s*(?:(["'])([^"']+)\1|([^\s>"']+))[^>]*>([\s\S]*?)<\/a>/i;

  // Path-prefix blocklist: these are food encyclopaedia / editorial / collection
  // pages that recipe sites commonly link from ingredient text (e.g. BBC Good Food
  // links "red onion" to /glossary/red-onion). We only want same-domain links
  // that point to actual recipe pages, not ingredient guides or category pages.
  // Also blocks WordPress taxonomy/archive paths: /category/, /tag/, /author/,
  // and pagination paths: /page/ (e.g. /page/2/).
  const NON_RECIPE_PATH_RE = /^\/(?:glossary|ingredients?|ingredient-substitutes?|substitutes?|guide|guides|how-to|howto|technique|techniques|tips?|learn|about|collections?|search|topics?|seasonal|new|recipes\/collection|category|tag|tags|author|authors|page|archive|archives)\//i;

  // Slug-segment blocklist: catches how-to/what-is patterns embedded anywhere in
  // the URL path (e.g. "/how-to-cook-rice/", "/what-is-garlic/", "/guide-to-ghee/").
  // The prefix check above only catches directory-style paths like "/how-to/rice".
  const GUIDE_SLUG_RE = /(?:^|\/)(?:how-to-|what-is-|all-about-|guide-to-)[\w]/i;

  // Slug-suffix blocklist: collection / aggregation pages whose final path
  // segment ends with these patterns are clearly not single recipe pages.
  // e.g. BBC Good Food /recipes/cheese-recipe-ideas, /recipes/chicken-recipes
  const COLLECTION_SLUG_RE = /-(?:ideas?|recipes|recipe-ideas?|collection)(?:\/|$)/i;

  const processAnchor = (rawHref, anchorHtml) => {
    try {
      const resolved = new URL(rawHref, baseUrl);
      const linkDomain = resolved.hostname.toLowerCase().replace(/^www\./, '');
      if (linkDomain !== baseDomain) return;
      // Skip links to non-recipe paths (glossary, ingredient guides, category pages,
      // etc.). Only links that could plausibly point to a real recipe page are kept.
      if (NON_RECIPE_PATH_RE.test(resolved.pathname)) return;
      // Skip how-to guides and ingredient glossary pages whose slug contains
      // recognisable guide-style prefixes (e.g. /how-to-cook-rice/, /what-is-garlic/).
      if (GUIDE_SLUG_RE.test(resolved.pathname)) return;
      // Skip collection / aggregation pages identified by a slug suffix
      // (e.g. /recipes/cheese-recipe-ideas, /recipes/easy-chicken-recipes).
      if (COLLECTION_SLUG_RE.test(resolved.pathname)) return;
      resolved.hash = '';
      TRACKING_PARAMS.forEach((k) => resolved.searchParams.delete(k));
      if (resolved.pathname.length > 1) resolved.pathname = resolved.pathname.replace(/\/+$/, '');
      const anchorText = asCleanLine(decodeEntities(anchorHtml));
      if (anchorText) linkMap.set(anchorText.toLowerCase(), resolved.toString());
    } catch {
      // skip invalid hrefs
    }
  };

  // Primary scan: <a> tags inside <li> elements (standard ingredient lists)
  for (const liMatch of String(sectionHtml).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const liHtml = liMatch[1];
    const aMatch = liHtml.match(ANCHOR_RE);
    if (!aMatch) continue;
    processAnchor(aMatch[2] || aMatch[3], aMatch[4]);
  }

  // Fallback scan: any <a> tag anywhere in the section (handles recipe plugins
  // that wrap ingredient text in <span>/<div> rather than bare <li>;
  // e.g. WP Recipe Maker cards where the link is on a <span>).
  if (linkMap.size === 0) {
    for (const aMatch of String(sectionHtml).matchAll(new RegExp(ANCHOR_RE.source, 'gi'))) {
      processAnchor(aMatch[2] || aMatch[3], aMatch[4]);
    }
  }

  return linkMap;
};

/**
 * Detects WP Recipe Maker (WPRM) ingredient group structure in the page HTML
 * and returns the groups with their ingredient texts, in document order.
 * WPRM typically omits ingredient group names from the JSON-LD recipeIngredient
 * flat array — they only appear in the HTML as elements with class
 * "wprm-recipe-ingredient-group-name".
 * Returns null when no WPRM groups are found; only activates with ≥ 2 named groups.
 */
const tryExtractWprmIngredientGroups = (html) => {
  const str = String(html || '');
  if (!str.includes('wprm-recipe-ingredient-group')) return null;

  // Helper: extract WPRM <li> ingredient texts from an HTML chunk.
  const extractLiTexts = (chunk) => {
    const texts = [];
    const liRe = /<li[^>]*class="[^"]*wprm-recipe-ingredient[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(chunk)) !== null) {
      const t = asCleanLine(decodeEntities(String(m[1]).replace(/<[^>]+>/g, ' '))).trim();
      if (t) texts.push(t);
    }
    return texts;
  };

  // Split by group-name h4 headings. A capturing group in split() interleaves
  // the result as [before, heading0, content0, heading1, content1, ...].
  // Matches both wprm-recipe-ingredient-group-name and wprm-recipe-ingredient-groupe-name.
  const parts = str.split(/(<h4[^>]*wprm-recipe-ingredient-group[^>]*>[\s\S]*?<\/h4>)/i);
  // parts[0] = html before first heading; may contain an unnamed first ingredient group
  // parts[1] = full <h4> tag for group 1
  // parts[2] = html between group 1 and group 2 heading (contains group 1's <li>s)
  // parts[3] = full <h4> tag for group 2  …etc.

  const groups = [];

  // Collect any WPRM ingredients that precede the first named section heading.
  // e.g. spendwithpennies.com "Easy Homemade Lasagna" has an unnamed "For the
  // Lasagna" group (noodles, mozzarella, parmesan) before the named "Tomato
  // Sauce" and "Cheese Mixture" sections.
  const preGroupTexts = extractLiTexts(parts[0] || '');
  if (preGroupTexts.length > 0) {
    groups.push({ groupName: '', ingredientTexts: preGroupTexts });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const headingHtml = parts[i];
    const contentHtml = parts[i + 1] || '';

    const nameMatch = /<h4[^>]*>([\s\S]*?)<\/h4>/i.exec(headingHtml);
    if (!nameMatch) continue;
    const name = asCleanLine(decodeEntities(String(nameMatch[1]).replace(/<[^>]+>/g, ' ')))
      .replace(/:+\s*$/, '').trim();
    if (!name) continue;

    const ingredientTexts = extractLiTexts(contentHtml);
    groups.push({ groupName: name, ingredientTexts });
  }

  return groups.length >= 2 ? groups : null;
};

// Akis Petretzikis and similar custom sites use:
//   <div class="acc-wrapper">
//     <div class="acc-title">For the burger patties</div>
//     <div class="acc-body">
//       <div class="details-wrapper"><span class="text-grey">500 g</span> ground pork</div>
//       ...
//     </div>
//   </div>
// Split at each acc-title div; extract text from details-wrapper divs after it.
const tryExtractAccTitleGroups = (html) => {
  const str = String(html || '');
  if (!str.includes('acc-title')) return null;

  // A capturing group in split() interleaves: [before, title0, content0, title1, content1, ...]
  const parts = str.split(/(<div[^>]*class="[^"]*acc-title[^"]*"[^>]*>[\s\S]*?<\/div>)/i);

  const groups = [];
  for (let i = 1; i < parts.length; i += 2) {
    const titleHtml = parts[i];
    const contentHtml = parts[i + 1] || '';

    const nameMatch = /<div[^>]*>([\s\S]*?)<\/div>/i.exec(titleHtml);
    if (!nameMatch) continue;
    const name = asCleanLine(decodeEntities(String(nameMatch[1]).replace(/<[^>]+>/g, ' '))).trim();
    if (!name) continue;

    // Each ingredient is a details-wrapper div: qty in <span class="text-grey">, name as trailing text
    const ingredientTexts = [];
    const detailsRe = /<div[^>]*class="[^"]*details-wrapper[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let m;
    while ((m = detailsRe.exec(contentHtml)) !== null) {
      const liText = asCleanLine(decodeEntities(String(m[1]).replace(/<[^>]+>/g, ' '))).trim();
      if (liText) ingredientTexts.push(liText);
    }

    if (ingredientTexts.length > 0) groups.push({ groupName: name, ingredientTexts });
  }

  return groups.length >= 2 ? groups : null;
};

// Next.js sites (e.g. Akis Petretzikis) embed page data in a <script> block as
// JSON with structure: {"ingredient_sections":[{"title":"For the burger patties",
// "ingredients":[{"quantity":"500","unit":"g","title":"ground pork","info":"neck"},...]},...]
// Parse that blob directly to get grouped ingredients with quantities.
const tryExtractNextDataGroups = (html) => {
  const str = String(html || '');
  if (!str.includes('ingredient_sections')) return null;

  // Find the script block that contains ingredient_sections
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(str)) !== null) {
    if (!sm[1].includes('ingredient_sections')) continue;

    // Extract the ingredient_sections array using bracket counting
    const keyIdx = sm[1].indexOf('"ingredient_sections"');
    if (keyIdx < 0) continue;
    const arrStart = sm[1].indexOf('[', keyIdx);
    if (arrStart < 0) continue;
    let depth = 0, arrEnd = -1;
    for (let ci = arrStart; ci < sm[1].length; ci++) {
      if (sm[1][ci] === '[') depth++;
      else if (sm[1][ci] === ']') { depth--; if (depth === 0) { arrEnd = ci; break; } }
    }
    if (arrEnd < 0) continue;

    let sections;
    try { sections = JSON.parse(sm[1].slice(arrStart, arrEnd + 1)); } catch { continue; }
    if (!Array.isArray(sections) || sections.length < 2) continue;

    const groups = [];
    for (const sec of sections) {
      const groupName = asCleanLine(String(sec.title || '')).trim();
      // Allow unnamed/empty-title sections (e.g. the main ingredient group that
      // precedes the named brine/sauce sections on the Akis Petretzikis site).
      if (!Array.isArray(sec.ingredients)) continue;

      const ingredientTexts = [];
      for (const ing of sec.ingredients) {
        const qty = String(ing.quantity || '').trim();
        const unit = String(ing.unit || '').trim();
        const title = asCleanLine(String(ing.title || '')).trim();
        const info = asCleanLine(String(ing.info || '')).trim();
        if (!title) continue;
        // Build "500 g ground pork, neck" style string
        const parts = [qty, unit, title, info ? ', ' + info : ''].filter(Boolean);
        ingredientTexts.push(parts.join(' ').replace(/\s{2,}/g, ' ').trim());
      }

      if (ingredientTexts.length > 0) groups.push({ groupName, ingredientTexts });
    }

    return groups.length >= 2 ? groups : null;
  }

  return null;
};

// Companion to tryExtractNextDataGroups: parses the "method" array from the
// same Next.js blob — [{"section":"For the burger patties","steps":[{"step":"..."}]}]
// Returns a flat instruction array using the __section__:Name prefix convention.
const tryExtractNextDataInstructions = (html) => {
  const str = String(html || '');
  if (!str.includes('"method"')) return null;

  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(str)) !== null) {
    if (!sm[1].includes('"section"') || !sm[1].includes('"steps"')) continue;

    const keyIdx = sm[1].indexOf('"method"');
    if (keyIdx < 0) continue;
    const arrStart = sm[1].indexOf('[', keyIdx);
    if (arrStart < 0) continue;
    let depth = 0, arrEnd = -1;
    for (let ci = arrStart; ci < sm[1].length; ci++) {
      if (sm[1][ci] === '[') depth++;
      else if (sm[1][ci] === ']') { depth--; if (depth === 0) { arrEnd = ci; break; } }
    }
    if (arrEnd < 0) continue;

    let method;
    try { method = JSON.parse(sm[1].slice(arrStart, arrEnd + 1)); } catch { continue; }
    if (!Array.isArray(method) || method.length === 0) continue;

    const lines = [];
    for (const sec of method) {
      const sectionName = asCleanLine(String(sec.section || '')).trim();
      if (sectionName) lines.push(`__section__:${sectionName}`);
      if (Array.isArray(sec.steps)) {
        for (const s of sec.steps) {
          const step = asCleanLine(decodeEntities(String(s.step || '').replace(/<[^>]+>/g, ' '))).trim();
          if (step) lines.push(step);
        }
      }
    }

    return lines.length > 0 ? lines : null;
  }

  return null;
};

// Companion to tryExtractNextDataInstructions: scans the same Next.js "method"
// blob and returns a link map (anchorText → url) for any same-domain <a href>
// links found inside step HTML. Needed because the step text is stored as raw
// HTML in the JSON blob (links are present) but the instruction extractor strips
// tags before storing the plain-text steps, so the links are otherwise lost.
// Example: Akis Petretzikis step 4 links "Poultry Brine" to a sub-recipe URL.
const tryExtractNextDataMethodLinks = (html, baseUrl) => {
  const str = String(html || '');
  if (!str.includes('"method"') || !baseUrl) return null;

  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(str)) !== null) {
    if (!sm[1].includes('"section"') || !sm[1].includes('"steps"')) continue;

    const keyIdx = sm[1].indexOf('"method"');
    if (keyIdx < 0) continue;
    const arrStart = sm[1].indexOf('[', keyIdx);
    if (arrStart < 0) continue;
    let depth = 0, arrEnd = -1;
    for (let ci = arrStart; ci < sm[1].length; ci++) {
      if (sm[1][ci] === '[') depth++;
      else if (sm[1][ci] === ']') { depth--; if (depth === 0) { arrEnd = ci; break; } }
    }
    if (arrEnd < 0) continue;

    let method;
    try { method = JSON.parse(sm[1].slice(arrStart, arrEnd + 1)); } catch { continue; }
    if (!Array.isArray(method) || method.length === 0) continue;

    // Concatenate all raw step HTML (before tag-stripping) so extractIngredientLinkMap
    // can find <a href> links in the fallback (non-<li>) scan path.
    const allStepHtml = method
      .flatMap((sec) => Array.isArray(sec.steps) ? sec.steps.map((s) => String(s.step || '')) : [])
      .join('\n');

    const map = extractIngredientLinkMap(allStepHtml, baseUrl);
    if (map.size > 0) return map;
  }

  return null;
};

// Sites like gordonramsay.com use <p><strong>Header:</strong></p> between
// <ul class="recipe-division"> blocks in their ingredients section.
// Takes the scoped ingredientsSection HTML (not full page).
const tryExtractStrongHeaderGroups = (sectionHtml) => {
  const str = String(sectionHtml || '');
  if (!str.includes('recipe-division')) return null;

  const groups = [];
  const ulRe = /<ul[^>]*class="[^"]*recipe-division[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
  let lastEnd = 0;
  let m;
  ulRe.lastIndex = 0;
  while ((m = ulRe.exec(str)) !== null) {
    const chunkBefore = str.slice(lastEnd, m.index);
    let groupName = null;

    // Pattern 1: <p><strong>Header:</strong></p>  (AMP pages)
    const strongMatch = chunkBefore.match(/<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/i);
    if (strongMatch) {
      const raw = asCleanLine(decodeEntities(strongMatch[1]));
      if (!/^serves\b/i.test(raw)) groupName = raw;
    }

    // Pattern 2: <p class="recipe-division"><span>Header:</span></p>  (non-AMP pages)
    if (!groupName) {
      const pDivRe = /<p[^>]*class="[^"]*recipe-division[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
      let pM, lastNonBlank = null;
      pDivRe.lastIndex = 0;
      while ((pM = pDivRe.exec(chunkBefore)) !== null) {
        const inner = asCleanLine(decodeEntities(pM[1].replace(/<[^>]+>/g, ' ')));
        if (inner && !/^serves\b/i.test(inner)) lastNonBlank = inner;
      }
      if (lastNonBlank) groupName = lastNonBlank;
    }
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    const ingredientTexts = [];
    let liM;
    liRe.lastIndex = 0;
    const ulContent = m[1];
    while ((liM = liRe.exec(ulContent)) !== null) {
      const t = asCleanLine(decodeEntities(liM[1]));
      if (t) ingredientTexts.push(t);
    }
    if (ingredientTexts.length > 0) groups.push({ groupName, ingredientTexts });
    lastEnd = m.index + m[0].length;
  }

  // Only activate when at least one group has a real named header
  if (groups.length === 0 || groups.every((g) => !g.groupName)) return null;
  return groups;
};

// Some sites (e.g. gordonramsay.com) append sub-sections like "SPECIAL EQUIPMENT"
// and "RECIPE NOTES" after the main <ol> steps, inside the same method container,
// using <p class="recipe-division"> labels + <ul class="recipe-division"> lists.
// Split these out so they go to notes instead of instructions.
const splitGrMethodSubSections = (sectionHtml) => {
  const str = String(sectionHtml || '');
  if (!str.includes('recipe-division')) return { trimmedMethod: str, bonusNotes: [] };

  // Find end of the main <ol> block (the actual numbered steps)
  const olEnd = str.indexOf('</ol>');
  if (olEnd < 0) return { trimmedMethod: str, bonusNotes: [] };

  // After </ol>, look for the first <p class="recipe-division"> with non-blank text
  const afterOl = str.slice(olEnd + 5);
  const pDivRe = /<p[^>]*class="[^"]*recipe-division[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let cutOffset = -1;
  let pm;
  pDivRe.lastIndex = 0;
  while ((pm = pDivRe.exec(afterOl)) !== null) {
    const inner = asCleanLine(decodeEntities(pm[1].replace(/<[^>]+>/g, ' ')));
    if (inner) { cutOffset = pm.index; break; }
  }
  if (cutOffset < 0) return { trimmedMethod: str, bonusNotes: [] };

  const trimmedMethod = str.slice(0, olEnd + 5 + cutOffset);
  const remainder = str.slice(olEnd + 5 + cutOffset);

  // Collect <li> text from all <ul class="recipe-division"> blocks in remainder,
  // prefixed with their section header label.
  const bonusNotes = [];
  const ulRe = /<ul[^>]*class="[^"]*recipe-division[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
  let um;
  ulRe.lastIndex = 0;
  // To match each ul with its preceding header, walk remainder linearly
  let searchFrom = 0;
  const pHeaderRe = /<p[^>]*class="[^"]*recipe-division[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  // Collect all <p class="recipe-division"> headers and <ul class="recipe-division"> blocks
  // in document order.
  const tokens = [];
  let tp;
  pHeaderRe.lastIndex = 0;
  while ((tp = pHeaderRe.exec(remainder)) !== null) {
    const label = asCleanLine(decodeEntities(tp[1].replace(/<[^>]+>/g, ' ')));
    if (label) tokens.push({ type: 'header', pos: tp.index, label });
  }
  ulRe.lastIndex = 0;
  while ((um = ulRe.exec(remainder)) !== null) {
    tokens.push({ type: 'ul', pos: um.index, html: um[1] });
  }
  tokens.sort((a, b) => a.pos - b.pos);
  let pendingHeader = null;
  for (const tok of tokens) {
    if (tok.type === 'header') {
      pendingHeader = tok.label;
    } else {
      if (pendingHeader) { bonusNotes.push(pendingHeader); pendingHeader = null; }
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let lm;
      liRe.lastIndex = 0;
      while ((lm = liRe.exec(tok.html)) !== null) {
        const t = asCleanLine(decodeEntities(lm[1].replace(/<[^>]+>/g, ' ')));
        if (t) bonusNotes.push(t);
      }
    }
  }
  return { trimmedMethod, bonusNotes };
};

// Extracts nutrition from a Schema.org JSON-LD NutritionInformation node.
// Returns { calories, protein, carbs, fat } or null if no usable data found.
const extractNutritionFromLd = (node) => {
  if (!node?.nutrition) return null;
  const n = node.nutrition;
  // parseFloat handles '24.5g' → 24.5 correctly; parseInt with [^\d] stripping
  // would turn '24.5g' → '245' which is wrong.
  const parseNum = (v) => Math.round(parseFloat(String(v || '').trim()) || 0);
  const calories = parseNum(n.calories);
  const protein  = parseNum(n.proteinContent);
  const carbs    = parseNum(n.carbohydrateContent);
  const fat      = parseNum(n.fatContent);
  if (calories + protein + carbs + fat === 0) return null;
  // servingSize is free-text e.g. "1 serving", "100g", "1 slice (85g)"
  const servingSize = String(n.servingSize || '').trim() || null;
  return { calories, protein, carbs, fat, ...(servingSize ? { servingSize } : {}) };
};

// Extracts nutrition from a __NEXT_DATA__ blob (e.g. Akis Petretzikis).
// Handles "nutritions" arrays: [{ title: "Calories per portion", value: "385 kcal" }, ...]
const tryExtractNextDataNutrition = (html) => {
  const str = String(html || '');
  if (!str.includes('"nutritions"')) return null;
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(str)) !== null) {
    const content = sm[1];
    const keyIdx = content.indexOf('"nutritions"');
    if (keyIdx < 0) continue;
    const arrStart = content.indexOf('[', keyIdx);
    if (arrStart < 0) continue;
    let depth = 0;
    let arrEnd = -1;
    for (let i = arrStart; i < content.length; i++) {
      if (content[i] === '[') depth++;
      else if (content[i] === ']') {
        depth--;
        if (depth === 0) { arrEnd = i; break; }
      }
    }
    if (arrEnd < 0) continue;
    let nutritions;
    try { nutritions = JSON.parse(content.slice(arrStart, arrEnd + 1)); } catch { continue; }
    if (!Array.isArray(nutritions) || nutritions.length === 0) continue;
    const result = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    for (const item of nutritions) {
      const title = String(item.title || item.name || '').toLowerCase();
      const value = Math.round(parseFloat(String(item.value || item.amount || '').trim()) || 0);
      if (!value) continue;
      if (/calor/.test(title))               result.calories = value;
      else if (/protein/.test(title))        result.protein  = value;
      else if (/carb/.test(title))           result.carbs    = value;
      else if (/\bfat\b|lipid/.test(title))  result.fat      = value;
    }
    if (result.calories + result.protein + result.carbs + result.fat > 0) return result;
  }
  return null;
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
    // Strip editorial suffixes like ", a thicker sliced bread is always nice!" that
    // contain exclamation marks (author commentary, not ingredient info).
    .replace(/,\s*[^,]*[!][^,]*$/g, '')
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

  // Split "N unit GENERIC including A, B, C and/or D" → one item per listed ingredient.
  // e.g. "3 sprigs fresh herbs including parsley, rosemary, thyme and/or sage"
  //   → ["3 sprigs parsley", "3 sprigs rosemary", "3 sprigs thyme", "3 sprigs sage"]
  const includingIdx = line.search(/\bincluding\b/i);
  if (includingIdx > 0) {
    const beforeIncluding = line.slice(0, includingIdx).trim();
    const afterIncluding = line.slice(includingIdx).replace(/^including\s*/i, '').trim();
    if (afterIncluding) {
      const prefixParsed = parseIngredientString(beforeIncluding);
      const qtyPart = prefixParsed
        ? [String(prefixParsed.quantityDisplay || (prefixParsed.quantity != null ? prefixParsed.quantity : '') || ''), String(prefixParsed.unit || '')].filter((s) => s !== '').join(' ')
        : '';
      const items = afterIncluding
        .replace(/\band\/or\b/gi, ',')
        .replace(/\s+and\b|\s+or\b/gi, ',')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && /^[a-zA-Z]/.test(s));
      if (items.length >= 2) {
        return items.map((item) => (qtyPart ? `${qtyPart} ${item}` : item));
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

/**
 * Returns true when a string in a recipeIngredient array is a section-group
 * label rather than an actual ingredient (e.g. "For the noodles:",
 * "RAGU BOLOGNESE:", "To garnish:").  Detection rule: ends with ":" and does
 * not start with a digit or fraction — real measured ingredients never start
 * with a colon-suffix alone.
 */
const isIngredientSectionHeader = (str) => {
  const s = asCleanLine(String(str || '')).trim();
  if (!s) return false;
  // Starts with a number or unicode fraction → it's a quantity, not a header
  if (/^[\d\u00BC-\u00BE\u2150-\u215E]/.test(s)) return false;
  // Ends with colon (e.g. "RAGU BOLOGNESE:", "For the noodles:", "Chicken:")
  if (s.endsWith(':')) return true;
  // Common section-label prefixes WITHOUT trailing colon, seen on some sites:
  // "For the burger patties", "For the fries", "To serve", "To garnish", etc.
  // Only match when the string is short (≤6 words) and contains no digits.
  if (!/\d/.test(s) && s.split(/\s+/).length <= 6) {
    if (/^for (?:the|a)\b/i.test(s)) return true;
    if (/^to (?:serve|garnish|assemble|finish|plate|complete)\b/i.test(s)) return true;
  }
  return false;
};

const ingredientsFromValue = (value, canonicalizeName) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => ingredientsFromValue(entry, canonicalizeName))
      .filter((item) => item.name)
      .filter(
        (item, index, self) =>
          index === self.findIndex((x) =>
            // Section headers are only deduped against other section headers —
            // never against real ingredients that happen to share the same name
            // (e.g. a "Chicken:" group label vs. a "chicken" ingredient).
            Boolean(x.sectionHeader) === Boolean(item.sectionHeader) &&
            (x.canonicalName || x.name).toLowerCase() === (item.canonicalName || item.name).toLowerCase()
          )
      );
  }

  if (typeof value === 'string') {
    // Section-group labels (e.g. "For the noodles:", "RAGU BOLOGNESE:") appear
    // as plain strings in the recipeIngredient array on many recipe sites.
    // Emit them as display-only rows so the UI can render a group divider.
    if (isIngredientSectionHeader(value)) {
      const label = asCleanLine(value).replace(/:+\s*$/, '').trim();
      return label ? [{ name: label, sectionHeader: true }] : [];
    }
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
    const type = String(anyValue['@type'] || '').toLowerCase();

    // HowToSection (e.g. RecipeTin Eats): emit a section marker before the
    // steps so the UI can render a group heading ("RAGU", "CHEESE SAUCE").
    if (type === 'howtosection' && Array.isArray(anyValue.itemListElement)) {
      const sectionName = asCleanLine(String(anyValue.name || '')).trim();
      const steps = anyValue.itemListElement.flatMap((entry) => instructionLinesFromValue(entry));
      return sectionName ? [`__section__:${sectionName}`, ...steps] : steps;
    }

    // HowToStep with both name and text (e.g. Mediterranean Dish):
    // prepend the step name so "Make the sponge: In the bowl..." is preserved.
    if (typeof anyValue.text === 'string') {
      const stepName = asCleanLine(String(anyValue.name || '')).trim();
      const stepText = instructionLinesFromValue(anyValue.text);
      if (stepName && stepText.length > 0 && !stepText[0].startsWith(stepName)) {
        stepText[0] = `${stepName}: ${stepText[0]}`;
      }
      return stepText;
    }

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

  const thumbnailFromHtml = (() => {
    const fromMeta =
      getMetaContent(text, 'property', 'og:image') ||
      getMetaContent(text, 'property', 'og:image:url') ||
      getMetaContent(text, 'name', 'og:image') ||
      getMetaContent(text, 'name', 'og:image:url') ||
      getMetaContent(text, 'name', 'twitter:image');
    if (fromMeta) return fromMeta;
    // Fallback: find an <img> whose alt text overlaps the recipe title
    // (catches sites like Drupal gov sites that have no og:image meta tag).
    const THUMB_PLACEHOLDER_RE = /placeholder|spinner|loading|blank|nophoto|spacer|pixel|1x1/i;
    const titleWords = String(titleFromHtml || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const imgTagRe = /<img\b([^>]+)>/gi;
    let m;
    while ((m = imgTagRe.exec(text)) !== null) {
      const attrs = m[1];
      const srcM = attrs.match(/(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i);
      if (!srcM || THUMB_PLACEHOLDER_RE.test(srcM[1])) continue;
      const altM = attrs.match(/alt=["']([^"']*)["']/i);
      const alt = String(altM ? altM[1] : '').toLowerCase();
      if (titleWords.length && titleWords.some(w => alt.includes(w))) return srcM[1];
    }
    return '';
  })();

  const methodSection = getSectionHtmlByHeading(text, 'Method|Execution\\s+Method|(?:Cooking\\s+)?Instructions?|Directions?');
  const { trimmedMethod, bonusNotes: methodBonusNotes } = splitGrMethodSubSections(methodSection);
  const ingredientsSection = getSectionHtmlByHeading(text, 'Ingredients?');
  const notesSection = getSectionHtmlByHeading(text, 'Notes?|Recipe\\s*Notes?|Cook\'?s?\\s*Notes?|Tips?');

  let instructions = recipeNode?.recipeInstructions
    ? instructionLinesFromValue(recipeNode.recipeInstructions)
    : extractListItems(trimmedMethod);

  const methodLines = extractTextLines(trimmedMethod);
  if (instructions.length === 0 && methodLines.length > 0) {
    instructions = methodLines
      .map((line) => line.replace(/^\d+[.)-]?\s*/, '').trim())
      .filter(Boolean)
      .filter((line) => line.split(/\s+/).length > 2)  // strip nav-only words like "Back", "Next"
      .filter((line, index, arr) => arr.indexOf(line) === index);
  }

  // Next.js sites (e.g. Akis Petretzikis) embed sectioned instructions in a
  // "method" array in the page blob. Override if the blob has richer data.
  const nextDataInstructions = tryExtractNextDataInstructions(text);
  if (nextDataInstructions) instructions = nextDataInstructions;

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

  // Also detect when JSON-LD is significantly under-counting ingredients vs the
  // HTML ingredient section. Some WPRM sites only include the sub-recipe reference
  // in JSON-LD and omit the remaining ingredients (e.g. Ambitious Kitchen's
  // Spicy Chicken Melts: JSON-LD has 1 item, visible card has 3).
  // When ingredientsSection is empty (heading not found, e.g. WPRM custom containers),
  // count ingredient-like <li> items from the full page using a qty+unit filter so we
  // don't count unrelated navigation or list items.
  const _qtyUnitReCount = /^\d[\d\s/\-]*\s+(?:tsp|tbsp?|tablespoons?|teaspoons?|cups?|ml|g(?!\w)|kg|oz|lbs?|pounds?|pinch|handful|bunch|cloves?|slices?|batch)\b/i;
  const htmlLiCount = ingredientsSection
    ? (ingredientsSection.match(/<li\b/gi) || []).length
    : [...text.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => asCleanLine(decodeEntities(m[1])))
        .filter((s) => s && _qtyUnitReCount.test(s))
        .length;
  // Treat as under-counted when JSON-LD has ≤ 50% of the visible HTML items
  // and the HTML has at least 2 more than the JSON-LD array.
  const ldUnderCounted =
    rawLdIngArr.length > 0 &&
    htmlLiCount > rawLdIngArr.length &&
    htmlLiCount >= rawLdIngArr.length + 2 &&
    htmlLiCount / rawLdIngArr.length >= 2;

  const htmlLiIngredients = (ldQuantityPoor || ldUnderCounted)
    ? (() => {
        const qtyUnitRe = _qtyUnitReCount;
        const scanHtml = ldUnderCounted ? (ingredientsSection || text) : text;
        const lines = [...scanHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
          .map((m) => asCleanLine(decodeEntities(m[1])))
          .filter((s) => s && qtyUnitRe.test(s));
        return lines.length > 0 && lines.length >= rawLdIngArr.length * 0.8 ? lines : null;
      })()
    : null;

  // When JSON-LD has bare names (no quantities), or has no recipeIngredient at
  // all, but the HTML ingredients section has <li> items, prefer those directly.
  // The unit-regex scan above is too strict for formats like "3kg" or "100g".
  const htmlSectionIngredients =
    (ldQuantityPoor || rawLdIngArr.length === 0) &&
    ingredientLines.length > 0 &&
    (rawLdIngArr.length === 0 || ingredientLines.length >= rawLdIngArr.length * 0.5)
      ? ingredientLines
      : null;

  let ingredients = recipeNode
    ? ((htmlSectionIngredients || htmlLiIngredients)
        ? (htmlSectionIngredients || htmlLiIngredients).flatMap((line) => ingredientsFromValue(line, canonicalizeName))
        : ingredientsFromValue(recipeNode.recipeIngredient, canonicalizeName))
    : ingredientLines.flatMap((line) => ingredientsFromValue(line, canonicalizeName));

  // Some sites omit ingredient group names from JSON-LD — they only appear in HTML
  // or an embedded data blob. Try extractors in priority order.
  // Always pass full `text` (not `ingredientsSection`) since section extraction
  // stops at the first heading element, which is often the group heading itself.
  // Try Next.js blob before HTML acc-title: the embedded JSON has all sections
  // including unnamed ones (fixed above), while acc-title HTML may omit the
  // unnested main-ingredient block that precedes the first <acc-title> div.
  const htmlGroups = tryExtractWprmIngredientGroups(text)
    || tryExtractNextDataGroups(text)
    || tryExtractAccTitleGroups(text)
    || tryExtractStrongHeaderGroups(ingredientsSection);
  if (htmlGroups) {
    ingredients = htmlGroups.flatMap(({ groupName, ingredientTexts }) => [
      ...(groupName ? [{ name: groupName, sectionHeader: true }] : []),
      ...ingredientTexts
        .flatMap((line) => ingredientsFromValue(line, canonicalizeName))
        .filter((ing) => !ing.sectionHeader),
    ]);
  }

  // Attach subRecipeUrl to ingredients whose name matches a same-domain link
  // found in the HTML ingredient section (e.g. "Lemon Glaze" linking to
  // https://site.com/lemon-glaze-recipe/).
  // Fall back to full page HTML when the section heading extractor finds nothing
  // (e.g. Tasty Recipes / custom containers that don't use a standard h2 heading).
  const ingredientLinkMap = options.baseUrl
    ? extractIngredientLinkMap(ingredientsSection || text, options.baseUrl)
    : null;

  // Build a secondary map: anchor text → full ingredient name parsed from the
  // HTML <li>. JSON-LD recipeIngredient entries often omit "or X" alternatives
  // that appear in the visible HTML (e.g. JSON-LD says "ricotta cheese" but the
  // <li> reads "ricotta cheese or cottage cheese"). When we attach a subRecipeUrl
  // we use this map to restore the richer name so the picker fires correctly.
  const anchorFullNameMap = new Map();
  if (ingredientLinkMap && ingredientLinkMap.size > 0) {
    const liScanHtml = ingredientsSection || text;
    for (const liMatch of String(liScanHtml).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const liHtml = liMatch[1];
      const aTagMatch = liHtml.match(/<a[^>]+>([\s\S]*?)<\/a>/i);
      if (!aTagMatch) continue;
      const anchorKey = asCleanLine(decodeEntities(aTagMatch[1])).toLowerCase();
      if (!ingredientLinkMap.has(anchorKey)) continue;
      const fullLiText = asCleanLine(decodeEntities(liHtml));
      const parsed = parseIngredientText(fullLiText, (n) => n);
      // Only treat the full li text as an enriched name when it genuinely
      // contains alternatives (e.g. "ricotta cheese or cottage cheese").
      // Without the \bor\b guard, footnote suffixes like "pasta sauce* see note"
      // would produce a parsed.name of "pasta sauce* see note" (different from
      // the anchor key "pasta sauce") and corrupt the stored ingredient name.
      if (parsed && parsed.name.toLowerCase() !== anchorKey && /\bor\b/i.test(parsed.name)) {
        anchorFullNameMap.set(anchorKey, parsed.name);
      }
    }
  }

  const ingredientsWithLinks =
    ingredientLinkMap && ingredientLinkMap.size > 0
      ? ingredients.map((ing) => {
          const nameLower = (ing.name || '').toLowerCase();
          // Exact match first. Fall back to contains: ingredient name like
          // "batch Lemon Glaze" should still match anchor key "lemon glaze".
          // Require anchor >= 5 chars to avoid false positives on short words.
          let linked = ingredientLinkMap.get(nameLower);
          let matchedAnchor = linked ? nameLower : null;
          if (!linked) {
            for (const [anchor, url] of ingredientLinkMap) {
              if (anchor.length >= 5 && nameLower.includes(anchor)) {
                linked = url;
                matchedAnchor = anchor;
                break;
              }
            }
          }
          if (!linked) return ing;
          // If the HTML <li> had a richer name (e.g. "ricotta cheese or cottage
          // cheese") than what JSON-LD provided ("ricotta cheese"), use it so
          // the ingredient alternatives picker fires correctly.
          const enrichedName = matchedAnchor ? anchorFullNameMap.get(matchedAnchor) : null;
          // subRecipeAltName records which specific alternative (e.g. "ricotta cheese")
          // maps to the sub-recipe URL, so applyAlternativeChoices can preserve
          // linkedRecipeId/isSubRecipe when the user picks that option.
          return enrichedName
            ? { ...ing, name: enrichedName, subRecipeUrl: linked, subRecipeAltName: matchedAnchor }
            : { ...ing, subRecipeUrl: linked };
        })
      : ingredients;

  // Second-pass: for ingredients that got no subRecipeUrl from the ingredient
  // section, scan the method section HTML for same-domain <a href> links whose
  // anchor text ends with the ingredient name (e.g. "Poultry Brine" → "brine").
  // Using ends-with rather than contains avoids false positives on common words
  // like "chicken" that appear mid-phrase in unrelated recipe title links.
  // For Next.js sites (e.g. Akis Petretzikis) the method section heading may
  // not be found by getSectionHtmlByHeading because step content lives in the
  // embedded __NEXT_DATA__ blob — fall back to the blob link extractor.
  // Try the scraped method section HTML first; if it yields no links (common on
  // Next.js sites where step content lives in the __NEXT_DATA__ blob rather than
  // in rendered HTML elements), fall back to the blob link extractor.
  const methodLinkMap = (() => {
    if (!options.baseUrl) return null;
    if (trimmedMethod) {
      const m = extractIngredientLinkMap(trimmedMethod, options.baseUrl);
      if (m.size > 0) return m;
    }
    return tryExtractNextDataMethodLinks(text, options.baseUrl);
  })();
  const ingredientsFinal = methodLinkMap && methodLinkMap.size > 0
    ? ingredientsWithLinks.map((ing) => {
        if (ing.subRecipeUrl) return ing;
        const nameLower = (ing.name || '').toLowerCase();
        if (nameLower.length < 4) return ing;
        const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const endsWithRe = new RegExp(`\\b${escaped}$`);
        for (const [anchor, url] of methodLinkMap) {
          if (endsWithRe.test(anchor)) return { ...ing, subRecipeUrl: url };
        }
        return ing;
      })
    : ingredientsWithLinks;
  const linkedCount = ingredientsFinal.filter(i => i.subRecipeUrl).length;
  const servesMatch = decodeEntities(text).match(/Serves\s*(\d+(?:\s*[-–]\s*\d+)?)/i);
  const notes = (() => {
    const base = stripHtmlToText(notesSection || '') || stripHtmlToText(String(recipeNode?.recipeNotes || recipeNode?.notes || recipeNode?.description || ''));
    if (methodBonusNotes.length === 0) return base;
    const extra = methodBonusNotes.join('\n');
    return base ? base + '\n' + extra : extra;
  })();

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
    ingredients: ingredientsFinal,
    instructions,
    ...(notes ? { notes } : {}),
    tags: ['Imported'],
    cuisine: asCleanLine(recipeNode?.recipeCuisine) || 'Global',
    difficulty: 'Easy',
    nutrition: extractNutritionFromLd(recipeNode) || tryExtractNextDataNutrition(text) || null,
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
