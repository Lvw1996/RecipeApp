import express from 'express';
import bodyParser from 'body-parser';
import { extractRecipeFromUrl } from './utils/extractRecipe.js';

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS || 30000);

app.use(bodyParser.json());

app.post('/import', async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const recipe = await extractRecipeFromUrl(url, { signal: controller.signal });

    return res.json(recipe);
  } catch (error) {
    console.error('❌ Error extracting recipe:', error.message);

    const message = String(error?.message || '');
    const code = String(error?.code || '');

    if (/timeout|aborted|canceled/i.test(message) || code === 'ERR_CANCELED') {
      return res.status(504).json({ error: 'Importer timed out while fetching/parsing recipe' });
    }

    return res.status(500).json({ error: 'Failed to extract recipe' });
  } finally {
    clearTimeout(timeoutId);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
