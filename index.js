import express from 'express';
import bodyParser from 'body-parser';
import { extractRecipeFromUrl } from './utils/extractRecipe.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post('/import', async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const recipe = await extractRecipeFromUrl(url);
    return res.json(recipe);
  } catch (error) {
    console.error('❌ Error extracting recipe:', error.message);
    return res.status(500).json({ error: 'Failed to extract recipe' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
