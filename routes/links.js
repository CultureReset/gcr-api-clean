const express = require('express');
const axios = require('axios');

const router = express.Router();

// GET /api/links/menu?slug=...
// Loads GCR entity data for CyberCheck Links pages
router.get('/menu', async (req, res) => {
  try {
    const { slug } = req.query;

    if (!slug) {
      return res.status(400).json({ error: 'slug parameter required' });
    }

    // Call GCR entity endpoint
    const gcrUrl = `https://cybercheck-api-database.vercel.app/api/gcr/entity/${encodeURIComponent(slug)}`;
    const response = await axios.get(gcrUrl);

    // Return the GCR data
    res.json(response.data);
  } catch (err) {
    console.error('Links menu error:', err.message);
    res.status(500).json({ error: 'Failed to load menu data' });
  }
});

module.exports = router;
