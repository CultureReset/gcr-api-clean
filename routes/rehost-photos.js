// ─── Rehost every externally-hosted photo into permanent storage ───────────
// Any entity/entity_photos row whose url points somewhere other than our own
// Supabase Storage bucket is depending on a third party staying online and
// serving that exact path forever: Google Places Photo API links (both the
// legacy maps.googleapis.com/.../photo?key=... form and the newer
// places.googleapis.com/v1/.../media form — the latter's photo tokens are
// short-lived by design and may already be dead by the time this runs),
// other CDNs (Wix, Squarespace, TripShock, DigitalOcean Spaces...), and
// individual business websites. None of those are ours to guarantee.
//
// This downloads the actual image bytes right now (while each URL still
// works) and re-uploads them into our own entity-photos storage bucket, then
// repoints the DB row at that permanent copy. Safe to call repeatedly: once
// a row is migrated its url points at our own storage domain, so it's
// naturally excluded from the next run's query — no separate "done" flag.
// Rows whose source has already gone dead (expired Google token, business
// site down, etc.) are reported as failures and simply left as-is; nothing
// can rescue a copy that's already unreachable.
//
// Protected by a dedicated token (not the general admin JWT system) so it's
// simple to reason about. Set REHOST_ADMIN_TOKEN in the Vercel project env
// vars, then call:
//   curl -X POST https://<api host>/api/gcr/admin/rehost-external-photos \
//     -H "x-rehost-token: <the token>" -H "Content-Type: application/json" \
//     -d '{"limit": 40}'
// Repeat until "remaining" in the response reaches 0. Scope right now is
// large (roughly 32,000 rows platform-wide) — this processes rows
// concurrently within each call to get through that in a reasonable number
// of requests, but at that volume expect to call this many times.

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

const OUR_STORAGE_HOST = 'mkepugvdlktfsossumox.supabase.co';
const BUCKET = 'entity-photos';
const CONCURRENCY = 8;

function requireToken(req, res, next) {
  const configured = process.env.REHOST_ADMIN_TOKEN;
  if (!configured) return res.status(503).json({ error: 'REHOST_ADMIN_TOKEN is not set in this environment — refusing to run rather than allow an unprotected endpoint.' });
  if (req.get('x-rehost-token') !== configured) return res.status(401).json({ error: 'Invalid or missing x-rehost-token header.' });
  next();
}

async function rehostOne(slug, sourceUrl, filenameHint) {
  // Some sites reject requests with no browser-like User-Agent (hotlink protection).
  const resp = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GulfCoastRadarBot/1.0; +https://gcr-unified.vercel.app)' } });
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status}`);
  const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!contentType.startsWith('image/')) throw new Error(`not an image (content-type: ${contentType})`);
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : contentType.includes('gif') ? 'gif' : 'jpg';
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0) throw new Error('empty response body');
  const storagePath = `${slug}/${filenameHint}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await db.storage.from(BUCKET).upload(storagePath, buffer, { contentType, upsert: true });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const { data: { publicUrl } } = db.storage.from(BUCKET).getPublicUrl(storagePath);
  return publicUrl;
}

async function runPool(items, worker) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
  return results;
}

// GET /api/gcr/admin/rehost-external-photos/status — how much work is left, no auth needed for a read-only count
router.get('/rehost-external-photos/status', async (req, res) => {
  const notOurs = `%${OUR_STORAGE_HOST}%`;
  const [heroRes, photoRes] = await Promise.all([
    db.from('entity').select('slug', { count: 'exact', head: true }).not('hero_image_url', 'is', null).not('hero_image_url', 'like', notOurs),
    db.from('entity_photos').select('id', { count: 'exact', head: true }).not('url', 'is', null).not('url', 'like', notOurs),
  ]);
  res.json({
    hero_image_url_remaining: heroRes.count || 0,
    entity_photos_remaining: photoRes.count || 0,
  });
});

// POST /api/gcr/admin/rehost-external-photos — process up to `limit` rows this call, concurrently
router.post('/rehost-external-photos', requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit, 10) || 40, 150);
  const notOurs = `%${OUR_STORAGE_HOST}%`;
  const results = { hero_migrated: [], hero_failed: [], photo_migrated: [], photo_failed: [] };

  // Hero images first — one per business, highest visible impact
  const { data: heroes } = await db.from('entity').select('slug, hero_image_url').not('hero_image_url', 'is', null).not('hero_image_url', 'like', notOurs).limit(limit);
  await runPool(heroes || [], async (e) => {
    try {
      const publicUrl = await rehostOne(e.slug, e.hero_image_url, 'hero');
      const { error } = await db.from('entity').update({ hero_image_url: publicUrl }).eq('slug', e.slug);
      if (error) throw new Error(error.message);
      results.hero_migrated.push(e.slug);
    } catch (err) {
      results.hero_failed.push({ slug: e.slug, error: err.message });
    }
  });

  // Then gallery photos, same remaining budget for this call
  const remainingBudget = limit - results.hero_migrated.length - results.hero_failed.length;
  if (remainingBudget > 0) {
    const { data: photos } = await db.from('entity_photos').select('id, entity_slug, url').not('url', 'is', null).not('url', 'like', notOurs).limit(remainingBudget);
    await runPool(photos || [], async (p) => {
      try {
        const publicUrl = await rehostOne(p.entity_slug, p.url, 'photo');
        const { error } = await db.from('entity_photos').update({ url: publicUrl }).eq('id', p.id);
        if (error) throw new Error(error.message);
        results.photo_migrated.push(p.entity_slug);
      } catch (err) {
        results.photo_failed.push({ slug: p.entity_slug, error: err.message });
      }
    });
  }

  const [heroRes, photoRes] = await Promise.all([
    db.from('entity').select('slug', { count: 'exact', head: true }).not('hero_image_url', 'is', null).not('hero_image_url', 'like', notOurs),
    db.from('entity_photos').select('id', { count: 'exact', head: true }).not('url', 'is', null).not('url', 'like', notOurs),
  ]);

  res.json({
    hero_migrated_count: results.hero_migrated.length,
    hero_failed_count: results.hero_failed.length,
    photo_migrated_count: results.photo_migrated.length,
    photo_failed_count: results.photo_failed.length,
    hero_failed: results.hero_failed,
    photo_failed: results.photo_failed,
    remaining: (heroRes.count || 0) + (photoRes.count || 0),
    note: 'Call again with the same limit to continue until remaining is 0. Failures are usually a source that already went dead (expired Google token, site down) — nothing to retry there.',
  });
});

module.exports = router;
