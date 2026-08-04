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

// ─── GET /api/team/:slug ──────────────────────────────────────────────────
// Get team members for a business
router.get('/:slug', async (req, res) => {
  try {
    const { data, error } = await db
      .from('entity_team_members')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .order('sort_order, name');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ team: data || [], total: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/team/:slug ─────────────────────────────────────────────────
// Add a team member (admin only)
router.post('/:slug', ownerRequired, async (req, res) => {
  try {
    const { name, title, bio, photo_url, specialty, certifications, years_experience, sort_order } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }

    const { data, error } = await db
      .from('entity_team_members')
      .insert({
        entity_slug: req.entitySlug,
        name: name.trim(),
        title: title?.trim() || null,
        bio: bio?.trim() || null,
        photo_url: photo_url || null,
        specialty: specialty?.trim() || null,
        certifications: certifications || [],
        years_experience: years_experience || null,
        sort_order: sort_order || 0
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ ok: true, member: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/team/:slug/:id ──────────────────────────────────────────────
// Edit a team member
router.put('/:slug/:id', ownerRequired, async (req, res) => {
  try {
    const { name, title, bio, photo_url, specialty, certifications, years_experience, sort_order } = req.body;

    const { data, error } = await db
      .from('entity_team_members')
      .update({
        ...(name && { name: name.trim() }),
        ...(title !== undefined && { title: title?.trim() || null }),
        ...(bio !== undefined && { bio: bio?.trim() || null }),
        ...(photo_url !== undefined && { photo_url }),
        ...(specialty !== undefined && { specialty: specialty?.trim() || null }),
        ...(certifications && { certifications }),
        ...(years_experience !== undefined && { years_experience }),
        ...(sort_order !== undefined && { sort_order })
      })
      .eq('id', req.params.id)
      .eq('entity_slug', req.entitySlug)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, member: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/team/:slug/:id ────────────────────────────────────────────
// Delete a team member
router.delete('/:slug/:id', ownerRequired, async (req, res) => {
  try {
    const { error } = await db
      .from('entity_team_members')
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
