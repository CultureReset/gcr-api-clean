const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const { ownerRequired } = require('../middleware/ownerAuth');

// Reads stay public — GCR Unified renders these on tourist-facing pages.
//
// Writes did not have a guard at all: the business was whatever slug appeared
// in the path, so anyone on the internet could POST to a stranger's listing.
// ownerRequired resolves the business from the session via entity_owners
// instead, and every write below uses req.entitySlug rather than the slug in
// the URL. The path keeps its :slug so existing links still work; it is simply
// no longer what decides whose data is written.

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// Cache-control for GET requests
router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  next();
});

// ─── GET /api/blog/:slug ──────────────────────────────────────────────────
// Get blog posts for a business (paginated, published only)
router.get('/:slug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const { data: posts, error, count } = await db
      .from('entity_blog_posts')
      .select('*', { count: 'exact' })
      .eq('entity_slug', req.params.slug)
      .not('published_at', 'is', null)
      .lte('published_at', new Date().toISOString())
      .order('published_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });

    res.json({
      posts: posts || [],
      pagination: { page, limit, total: count }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/blog/:slug/:postSlug ────────────────────────────────────────
// Get a single blog post
router.get('/:slug/:postSlug', async (req, res) => {
  try {
    const { data, error } = await db
      .from('entity_blog_posts')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .eq('slug', req.params.postSlug)
      .single();

    if (error) return res.status(404).json({ error: 'Post not found' });

    // Only return if published
    if (!data.published_at || new Date(data.published_at) > new Date()) {
      return res.status(404).json({ error: 'Post not available' });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/blog/:slug ────────────────────────────────────────────────
// Create a blog post (admin)
router.post('/:slug', ownerRequired, async (req, res) => {
  try {
    const { title, slug, content, excerpt, featured_image_url, published_at } = req.body;

    if (!title || !slug) {
      return res.status(400).json({ error: 'title and slug required' });
    }

    const { data, error } = await db
      .from('entity_blog_posts')
      .insert({
        entity_slug: req.entitySlug,
        title: title.trim(),
        slug: slug.trim(),
        content: content?.trim() || null,
        excerpt: excerpt?.trim() || null,
        featured_image_url: featured_image_url || null,
        published_at: published_at || null
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/blog/:slug/:id ───────────────────────────────────────────────
// Edit a blog post
router.put('/:slug/:id', ownerRequired, async (req, res) => {
  try {
    const { title, slug, content, excerpt, featured_image_url, published_at } = req.body;

    const { data, error } = await db
      .from('entity_blog_posts')
      .update({
        ...(title && { title: title.trim() }),
        ...(slug && { slug: slug.trim() }),
        ...(content !== undefined && { content: content?.trim() || null }),
        ...(excerpt !== undefined && { excerpt: excerpt?.trim() || null }),
        ...(featured_image_url !== undefined && { featured_image_url }),
        ...(published_at !== undefined && { published_at }),
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('entity_slug', req.entitySlug)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/blog/:slug/:id ────────────────────────────────────────────
// Delete a blog post
router.delete('/:slug/:id', ownerRequired, async (req, res) => {
  try {
    const { error } = await db
      .from('entity_blog_posts')
      .delete()
      .eq('id', req.params.id)
      .eq('entity_slug', req.entitySlug);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
