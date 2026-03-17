// Shared recipe difficulty classification logic used by both recipe-app and recipe-app-importer

const HARD_TECHNIQUE_PATTERNS = [
  /(?<!-)\bproof\b/,           // dough proofing; exclude 'oven-proof', 'waterproof'
  /\btemper\b/,
  /\bemulsif(?:y|ied|ication)\b/,
  /\bdeglaze\b/,
  /\breduction\b/,
  /\bcarameliz(?:e|ed|ation)\b/,
  /\bfillet(?:ing|ed)\b/,     // filleting technique; exclude 'the fillet' (noun)
  /\bbutcher\b/,
  /\bconfit\b/,
];

export function normalizeDifficultyLabel(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';

  if (/\b(very\s+easy|super\s+easy)\b/.test(text)) return 'Easy';
  if (/\b(very\s+hard|super\s+hard)\b/.test(text)) return 'Hard';
  if (/\b(easy|simple|quick|beginner|starter|basic)\b/.test(text)) return 'Easy';
  if (/\b(hard|difficult|advanced|challenging|expert|complex)\b/.test(text)) return 'Hard';
  if (/\b(medium|moderate|intermediate)\b/.test(text)) return 'Medium';

  return '';
}

function instructionLinesFromValue(value) {
  if (Array.isArray(value)) return value.map((line) => String(line || '')).filter(Boolean);
  return String(value || '')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function countHardTechniqueHits(instructionLines = []) {
  const text = instructionLines.join(' ').toLowerCase();
  return HARD_TECHNIQUE_PATTERNS.reduce(
    (acc, pattern) => acc + (pattern.test(text) ? 1 : 0),
    0,
  );
}

export function estimateRecipeDifficulty(recipe = {}) {
  const ingredientsCount = Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0;
  const instructionLines = instructionLinesFromValue(recipe.instructions);
  const instructionsCount = instructionLines.length;
  const totalMinutes = (Number(recipe.prepTime) || 0) + (Number(recipe.cookTime) || 0);
  const hardTechniqueHits = countHardTechniqueHits(instructionLines);

  // Easy: up to 45 min, up to 8 steps, up to 14 ingredients, tolerating up to 1 hard-technique hit
  if (
    totalMinutes > 0 &&
    totalMinutes <= 45 &&
    ingredientsCount <= 14 &&
    instructionsCount <= 8 &&
    hardTechniqueHits <= 1
  ) {
    return 'Easy';
  }

  // Hard: either (150+ min AND 8+ steps) OR 3+ hard technique hits
  if ((totalMinutes >= 150 && instructionsCount >= 8) || hardTechniqueHits >= 3) {
    return 'Hard';
  }

  // Medium: scored case
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

export function deriveRecipeDifficulty(candidate = {}, extras = []) {
  const sources = [candidate?.difficulty, ...(Array.isArray(extras) ? extras : [])];
  for (const source of sources) {
    const normalized = normalizeDifficultyLabel(source);
    if (normalized) return normalized;
  }

  return estimateRecipeDifficulty(candidate);
}
