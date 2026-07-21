// ─── Rehost fragile third-party photo URLs into permanent storage ──────────
// Google Places Photo API URLs (maps.googleapis.com/.../photo?...&key=...) are
// live API calls, not files — they depend on an API key staying valid and a
// photo_reference token that Google does not guarantee stays stable forever.
// This downloads the actual image bytes (while the URL still works) and
// re-uploads them into our own entity-photos storage bucket, then repoints
// the DB row at that permanent copy. Safe to call repeatedly: once a row is
// migrated its url no longer matches the Google pattern, so it's naturally
// skipped on the next run — no separate "done" flag needed.
//
// Protected by a dedicated token (not the general admin JWT system) so it's
// simple to reason about. Set REHOST_ADMIN_TOKEN in the Vercel project env
// vars, then call:
//   curl -X POST https://<api host>/api/gcr/admin/rehost-google-photos \
//     -H "x-rehost-token: <the token>" -H "Content-Type: application/json" \
//     -d '{"limit": 20}'
// Repeat until "remaining" in the response reaches 0.

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

const GOOGLE_PHOTO_PATTERN = '%maps.googleapis.com%';
const BUCKET = 'entity-photos';

function requireToken(req, res, next) {
  const configured = process.env.REHOST_ADMIN_TOKEN;
  if (!configured) return res.status(503).json({ error: 'REHOST_ADMIN_TOKEN is not set in this environment — refusing to run rather than allow an unprotected endpoint.' });
  if (req.get('x-rehost-token') !== configured) return res.status(401).json({ error: 'Invalid or missing x-rehost-token header.' });
  next();
}

async function rehostOne(slug, sourceUrl, filenameHint) {
  const resp = await fetch(sourceUrl);
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status}`);
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const buffer = Buffer.from(await resp.arrayBuffer());
  const storagePath = `${slug}/${filenameHint}-${Date.now()}.${ext}`;
  const { error: upErr } = await db.storage.from(BUCKET).upload(storagePath, buffer, { contentType, upsert: true });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const { data: { publicUrl } } = db.storage.from(BUCKET).getPublicUrl(storagePath);
  return publicUrl;
}

// GET /api/gcr/admin/rehost-google-photos/status — how much work is left, no auth needed for a read-only count
router.get('/rehost-google-photos/status', async (req, res) => {
  const [heroRes, photoRes] = await Promise.all([
    db.from('entity').select('slug', { count: 'exact', head: true }).like('hero_image_url', GOOGLE_PHOTO_PATTERN),
    db.from('entity_photos').select('id', { count: 'exact', head: true }).like('url', GOOGLE_PHOTO_PATTERN),
  ]);
  res.json({
    hero_image_url_remaining: heroRes.count || 0,
    entity_photos_remaining: photoRes.count || 0,
  });
});

// POST /api/gcr/admin/rehost-google-photos — process up to `limit` rows this call
router.post('/rehost-google-photos', requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit, 10) || 15, 50);
  const results = { hero_migrated: [], hero_failed: [], photo_migrated: [], photo_failed: [] };

  // Hero images first — one per business, highest visible impact
  const { data: heroes } = await db.from('entity').select('slug, hero_image_url').like('hero_image_url', GOOGLE_PHOTO_PATTERN).limit(limit);
  for (const e of heroes || []) {
    try {
      const publicUrl = await rehostOne(e.slug, e.hero_image_url, 'hero');
      const { error } = await db.from('entity').update({ hero_image_url: publicUrl }).eq('slug', e.slug);
      if (error) throw new Error(error.message);
      results.hero_migrated.push(e.slug);
    } catch (err) {
      results.hero_failed.push({ slug: e.slug, error: err.message });
    }
  }

  // Then gallery photos, same remaining budget for this call
  const remainingBudget = limit - results.hero_migrated.length - results.hero_failed.length;
  if (remainingBudget > 0) {
    const { data: photos } = await db.from('entity_photos').select('id, entity_slug, url').like('url', GOOGLE_PHOTO_PATTERN).limit(remainingBudget);
    for (const p of photos || []) {
      try {
        const publicUrl = await rehostOne(p.entity_slug, p.url, 'photo');
        const { error } = await db.from('entity_photos').update({ url: publicUrl }).eq('id', p.id);
        if (error) throw new Error(error.message);
        results.photo_migrated.push(p.entity_slug);
      } catch (err) {
        results.photo_failed.push({ slug: p.entity_slug, error: err.message });
      }
    }
  }

  const [heroRes, photoRes] = await Promise.all([
    db.from('entity').select('slug', { count: 'exact', head: true }).like('hero_image_url', GOOGLE_PHOTO_PATTERN),
    db.from('entity_photos').select('id', { count: 'exact', head: true }).like('url', GOOGLE_PHOTO_PATTERN),
  ]);

  res.json({
    ...results,
    remaining: (heroRes.count || 0) + (photoRes.count || 0),
    note: 'Call again with the same limit to continue until remaining is 0.',
  });
});

module.exports = router;
