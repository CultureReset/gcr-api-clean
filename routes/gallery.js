const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// Cache-control for GET requests
router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  next();
});

// ─── GET /api/gallery/:slug ───────────────────────────────────────────────
// Get all gallery photos (paginated, optional category filter)
router.get('/:slug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const category = req.query.category;

    let query = db
      .from('entity_gallery')
      .select('*', { count: 'exact' })
      .eq('entity_slug', req.params.slug)
      .order('is_featured', { ascending: false })
      .order('sort_order');

    if (category) {
      query = query.eq('category', category);
    }

    const { data: photos, count, error } = await query.range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({
      photos: photos || [],
      pagination: { page, limit, total: count }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gallery/:slug/categories ───────────────────────────────────
// Get distinct categories for a business
router.get('/:slug/categories', async (req, res) => {
  try {
    const { data, error } = await db
      .from('entity_gallery')
      .select('category')
      .eq('entity_slug', req.params.slug)
      .distinct();

    if (error) return res.status(500).json({ error: error.message });
    const categories = [...new Set((data || []).map(d => d.category))];
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/gallery/:slug ──────────────────────────────────────────────
// Upload/add a gallery photo (admin)
router.post('/:slug', async (req, res) => {
  try {
    const { photo_url, caption, category, is_featured, sort_order } = req.body;

    if (!photo_url) {
      return res.status(400).json({ error: 'photo_url required' });
    }

    const { data, error } = await db
      .from('entity_gallery')
      .insert({
        entity_slug: req.params.slug,
        photo_url: photo_url.trim(),
        caption: caption?.trim() || null,
        category: category || 'general',
        is_featured: is_featured || false,
        sort_order: sort_order || 0
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, photo: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/gallery/:slug/:id ────────────────────────────────────────────
// Update gallery photo metadata
router.put('/:slug/:id', async (req, res) => {
  try {
    const { caption, category, is_featured, sort_order } = req.body;

    const { data, error } = await db
      .from('entity_gallery')
      .update({
        ...(caption !== undefined && { caption: caption?.trim() || null }),
        ...(category && { category }),
        ...(is_featured !== undefined && { is_featured }),
        ...(sort_order !== undefined && { sort_order })
      })
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, photo: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/gallery/:slug/:id ────────────────────────────────────────
// Delete a gallery photo
router.delete('/:slug/:id', async (req, res) => {
  try {
    const { error } = await db
      .from('entity_gallery')
      .delete()
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
