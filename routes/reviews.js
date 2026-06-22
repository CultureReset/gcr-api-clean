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

// ─── GET /api/reviews/:slug ───────────────────────────────────────────────
// Get paginated approved reviews for a business
router.get('/:slug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { data: reviews, error } = await db
      .from('entity_reviews')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });

    // Get total count
    const { count } = await db
      .from('entity_reviews')
      .select('*', { count: 'exact' })
      .eq('entity_slug', req.params.slug)
      .eq('approved', true);

    res.json({
      reviews: reviews || [],
      pagination: { page, limit, total: count }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/reviews/:slug/stats ─────────────────────────────────────────
// Get review statistics (rating breakdown)
router.get('/:slug/stats', async (req, res) => {
  try {
    const { data: reviews, error } = await db
      .from('entity_reviews')
      .select('rating')
      .eq('entity_slug', req.params.slug)
      .eq('approved', true);

    if (error) return res.status(500).json({ error: error.message });

    const stats = {
      total: reviews?.length || 0,
      average: 0,
      distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
    };

    if (reviews && reviews.length > 0) {
      const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
      stats.average = (sum / reviews.length).toFixed(1);
      reviews.forEach(r => {
        stats.distribution[r.rating]++;
      });
    }

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/reviews/:slug ──────────────────────────────────────────────
// Submit a new review
router.post('/:slug', async (req, res) => {
  try {
    const { reviewer_name, reviewer_email, rating, title, body } = req.body;

    if (!reviewer_name || !reviewer_email || !rating || !title || !body) {
      return res.status(400).json({ error: 'Missing required fields: reviewer_name, reviewer_email, rating, title, body' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const { data, error } = await db
      .from('entity_reviews')
      .insert({
        entity_slug: req.params.slug,
        reviewer_name: reviewer_name.trim(),
        reviewer_email: reviewer_email.trim(),
        rating: parseInt(rating),
        title: title.trim(),
        body: body.trim(),
        approved: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, review: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/reviews/:slug/:id ────────────────────────────────────────────
// Edit a review (user can edit own within 24hrs)
router.put('/:slug/:id', async (req, res) => {
  try {
    const { reviewer_email, title, body, rating } = req.body;

    if (!reviewer_email) {
      return res.status(400).json({ error: 'reviewer_email required' });
    }

    // Get the review
    const { data: review, error: getError } = await db
      .from('entity_reviews')
      .select('*')
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .single();

    if (getError || !review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Check if email matches and within 24hrs
    if (review.reviewer_email !== reviewer_email) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const createdAt = new Date(review.created_at);
    const now = new Date();
    const hoursOld = (now - createdAt) / (1000 * 60 * 60);
    if (hoursOld > 24) {
      return res.status(403).json({ error: 'Can only edit reviews within 24 hours' });
    }

    // Update review
    const { data, error } = await db
      .from('entity_reviews')
      .update({
        title: title?.trim() || review.title,
        body: body?.trim() || review.body,
        rating: rating || review.rating,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, review: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/reviews/:slug/:id ────────────────────────────────────────
// Delete a review
router.delete('/:slug/:id', async (req, res) => {
  try {
    const { reviewer_email } = req.body;

    if (!reviewer_email) {
      return res.status(400).json({ error: 'reviewer_email required' });
    }

    // Get the review
    const { data: review, error: getError } = await db
      .from('entity_reviews')
      .select('*')
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .single();

    if (getError || !review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Check if email matches
    if (review.reviewer_email !== reviewer_email) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { error } = await db
      .from('entity_reviews')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
