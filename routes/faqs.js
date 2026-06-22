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

// ─── GET /api/faqs/:slug ──────────────────────────────────────────────────
// Get FAQs for a business (optional category filter)
router.get('/:slug', async (req, res) => {
  try {
    const category = req.query.category;

    let query = db
      .from('entity_faqs')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .order('sort_order');

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    res.json({ faqs: data || [], total: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/faqs/:slug ─────────────────────────────────────────────────
// Add an FAQ (admin)
router.post('/:slug', async (req, res) => {
  try {
    const { question, answer, category, sort_order } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: 'question and answer required' });
    }

    const { data, error } = await db
      .from('entity_faqs')
      .insert({
        entity_slug: req.params.slug,
        question: question.trim(),
        answer: answer.trim(),
        category: category || 'general',
        sort_order: sort_order || 0
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, faq: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/faqs/:slug/:id ───────────────────────────────────────────────
// Edit an FAQ
router.put('/:slug/:id', async (req, res) => {
  try {
    const { question, answer, category, sort_order } = req.body;

    const { data, error } = await db
      .from('entity_faqs')
      .update({
        ...(question && { question: question.trim() }),
        ...(answer && { answer: answer.trim() }),
        ...(category && { category }),
        ...(sort_order !== undefined && { sort_order })
      })
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, faq: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/faqs/:slug/:id ────────────────────────────────────────────
// Delete an FAQ
router.delete('/:slug/:id', async (req, res) => {
  try {
    const { error } = await db
      .from('entity_faqs')
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
