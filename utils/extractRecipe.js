import axios from 'axios';
import * as cheerio from 'cheerio';

export async function extractRecipeFromUrl(url) {
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    }
  });

  const $ = cheerio.load(html);

  const jsonLdScripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html())
    .get();

  const recipeJson = jsonLdScripts
    .map(script => {
      try {
        const parsed = JSON.parse(script);
        if (Array.isArray(parsed)) return parsed.find(p => p['@type'] === 'Recipe');
        if (parsed['@type'] === 'Recipe') return parsed;
        if (parsed['@graph']) return parsed['@graph'].find(p => p['@type'] === 'Recipe');
        return null;
      } catch {
        return null;
      }
    })
    .find(r => r);

  if (!recipeJson) throw new Error('No structured recipe found');
  console.log('💡 Parsed JSON-LD scripts:', jsonLdScripts);
  console.log('✅ Recipe JSON found:', recipeJson);

  return {
    id: generateId(recipeJson.name),
    title: recipeJson.name,
    thumbnail: recipeJson.image?.[0] || recipeJson.image || '',
    cookTime: parseDuration(recipeJson.cookTime),
    prepTime: parseDuration(recipeJson.prepTime),
    servings: parseInt(recipeJson.recipeYield) || 1,
    difficulty: 'unknown',
    cuisine: recipeJson.recipeCuisine || 'Unknown',
    tags: recipeJson.keywords?.split(',').map(t => t.trim()) || [],
    nutrition: {
      calories: extractNutrition(recipeJson, 'calories'),
      protein: extractNutrition(recipeJson, 'proteinContent'),
      carbs: extractNutrition(recipeJson, 'carbohydrateContent'),
      fat: extractNutrition(recipeJson, 'fatContent'),
    },
    ingredients: (recipeJson.recipeIngredient || []).map(item => ({
      name: item,
      quantity: 1,
      unit: '',
    })),
    instructions: extractInstructions(recipeJson)
  };
}

function extractInstructions(json) {
  if (typeof json.recipeInstructions === 'string') return [json.recipeInstructions];
  if (Array.isArray(json.recipeInstructions)) {
    return json.recipeInstructions.map(instr =>
      typeof instr === 'string' ? instr : instr.text || ''
    );
  }
  return [];
}

function extractNutrition(json, field) {
  return json.nutrition?.[field]
    ? parseInt(json.nutrition[field].replace(/[^\d]/g, '')) || 0
    : 0;
}

function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const hours = parseInt(match?.[1] || '0');
  const mins = parseInt(match?.[2] || '0');
  return hours * 60 + mins;
}

function generateId(title) {
  return title.toLowerCase().replace(/\s+/g, '_') + '_' + Math.floor(Math.random() * 10000);
}
