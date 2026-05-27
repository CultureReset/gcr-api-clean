const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// ─── AUTH ─────────────────────────────────────────────────────────────────────
// Accepts either the GCR service key OR the ADMIN_SECRET env var — no OAuth needed
function authRequired(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
    || req.headers['x-admin-key'];
  const valid = [
    process.env.GCR_SUPABASE_SERVICE_KEY,
    process.env.ADMIN_SECRET,
  ].filter(Boolean);
  if (!token || !valid.includes(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── CACHE INVALIDATION ───────────────────────────────────────────────────────
// Clears cache by setting headers that tell CDN/clients to revalidate
// This is called after every PATCH/POST/DELETE to ensure fresh data
function invalidateCache(res, entitySlug = null) {
  // Set headers to bust cache immediately - tells Vercel CDN and browsers to not cache
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Cache-Invalidated': new Date().toISOString(),
    'X-Invalidated-Slug': entitySlug || 'all-entities'
  });
}

// ─── ENTITY CRUD ──────────────────────────────────────────────────────────────

// GET /api/admin/gcr/entities
router.get('/entities', async (req, res) => {
  const { data, error } = await db.from('entity').select('id, slug, name, entity_subtype, city, is_active, featured, hero_image_url, rating').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/admin/gcr/entities — create new entity
router.post('/entities', authRequired, async (req, res) => {
  const { entity, tags, hours } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'slug and name required' });

  const { data: created, error } = await db.from('entity').insert({ ...entity, is_active: true }).select('id, slug').single();
  if (error) return res.status(500).json({ error: error.message });

  const slug = created.slug;
  const ops = [];

  if (tags?.length) ops.push(db.from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null }))));
  if (hours?.length) ops.push(db.from('entity_hours').insert(hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed }))));

  if (ops.length) await Promise.all(ops);
  invalidateCache(res, slug);
  res.status(201).json(created);
});

// GET /api/admin/gcr/entities/:slug
router.get('/entities/:slug', async (req, res) => {
  const slug = req.params.slug;
  const [entRes, hoursRes, photosRes, tagsRes] = await Promise.all([
    db.from('entity').select('*').eq('slug', slug).single(),
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_tags').select('*').eq('entity_slug', slug),
  ]);
  if (!entRes.data) return res.status(404).json({ error: 'Not found' });
  res.json({ entity: entRes.data, hours: hoursRes.data || [], photos: photosRes.data || [], tags: tagsRes.data || [] });
});

// PUT /api/admin/gcr/entities/:slug — update core entity fields
router.put('/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { entity } = req.body;
  const { error } = await db.from('entity').update({ ...entity, updated_at: new Date().toISOString() }).eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// PATCH /api/admin/gcr/entities/:slug — bulk update everything at once
router.patch('/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { entity, hours, happyHour, menuSections, menuItems, drinkSections, drinkItems, hhSections, hhItems, events, specials, tags, photos } = req.body;
  const errors = [];

  // 1. Core entity
  if (entity) {
    const { error } = await db.from('entity').update({ ...entity, updated_at: new Date().toISOString() }).eq('slug', slug);
    if (error) errors.push('entity: ' + error.message);
  }

  // 2. Happy hour schedule on entity
  if (happyHour) {
    const { error } = await db.from('entity').update({
      hh_days: happyHour.days || null,
      hh_start: happyHour.start || null,
      hh_end: happyHour.end || null,
      hh_description: happyHour.description || null,
      updated_at: new Date().toISOString()
    }).eq('slug', slug);
    if (error) errors.push('happyHour: ' + error.message);
  }

  // 3. Hours (upsert by day_of_week)
  if (hours?.length) {
    for (const h of hours) {
      const { error } = await db.from('entity_hours').upsert(
        { entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed },
        { onConflict: 'entity_slug,day_of_week' }
      );
      if (error) errors.push('hours ' + h.day_of_week + ': ' + error.message);
    }
  }

  // 4. Menu sections
  if (menuSections?.length) {
    const rows = menuSections.map((s, i) => ({ entity_slug: slug, section_name: s.section_name || s.name, sort_order: s.sort_order ?? i }));
    const { error } = await db.from('menu_sections').insert(rows);
    if (error) errors.push('menu_sections: ' + error.message);
  }

  // 5. Menu items
  if (menuItems?.length) {
    const rows = menuItems.map(i => ({ entity_slug: slug, section_id: i.section_id || null, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, tags: i.tags || null, image_url: i.image_url || null }));
    const { error } = await db.from('menu_items').insert(rows);
    if (error) errors.push('menu_items: ' + error.message);
  }

  // 6. Drink sections
  if (drinkSections?.length) {
    const rows = drinkSections.map((s, i) => ({ entity_slug: slug, section_name: s.section_name || s.name, sort_order: s.sort_order ?? i }));
    const { error } = await db.from('drink_sections').insert(rows);
    if (error) errors.push('drink_sections: ' + error.message);
  }

  // 7. Drink items
  if (drinkItems?.length) {
    const rows = drinkItems.map(i => ({ entity_slug: slug, section_id: i.section_id || null, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null }));
    const { error } = await db.from('drink_items').insert(rows);
    if (error) errors.push('drink_items: ' + error.message);
  }

  // 8. HH sections
  if (hhSections?.length) {
    const rows = hhSections.map((s, i) => ({ entity_slug: slug, section_name: s.section_name || s.name, sort_order: s.sort_order ?? i }));
    const { error } = await db.from('happy_hour_sections').insert(rows);
    if (error) errors.push('hh_sections: ' + error.message);
  }

  // 9. HH items
  if (hhItems?.length) {
    const rows = hhItems.map(i => ({ entity_slug: slug, section_id: i.section_id || null, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, original_price: i.original_price || null, image_url: i.image_url || null }));
    const { error } = await db.from('happy_hour_items').insert(rows);
    if (error) errors.push('hh_items: ' + error.message);
  }

  // 10. Events
  if (events?.length) {
    const rows = events.map(e => ({ entity_slug: slug, entity_name: e.entity_name || null, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, cover_charge: e.cover_charge || null, is_active: true, image_url: e.image_url || null }));
    const { error } = await db.from('entity_events').insert(rows);
    if (error) errors.push('events: ' + error.message);
  }

  // 11. Specials
  if (specials?.length) {
    const rows = specials.map(s => ({ entity_slug: slug, entity_name: s.entity_name || null, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, start_time: s.start_time || null, end_time: s.end_time || null, is_active: true, image_url: s.image_url || null }));
    const { error } = await db.from('entity_specials').insert(rows);
    if (error) errors.push('specials: ' + error.message);
  }

  // 12. Tags (replace all)
  if (tags?.length) {
    await db.from('entity_tags').delete().eq('entity_slug', slug);
    const rows = tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null }));
    const { error } = await db.from('entity_tags').insert(rows);
    if (error) errors.push('tags: ' + error.message);
  }

  // 13. Photos
  if (photos?.length) {
    const rows = photos.map((p, i) => ({ entity_slug: slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }));
    const { error } = await db.from('entity_photos').insert(rows);
    if (error) errors.push('photos: ' + error.message);
  }

  if (errors.length) return res.status(207).json({ success: false, errors });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// DELETE /api/admin/gcr/entities/:slug
router.delete('/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { error } = await db.from('entity').delete().eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// ─── HOURS ────────────────────────────────────────────────────────────────────

router.put('/entities/:slug/hours', authRequired, async (req, res) => {
  const { hours } = req.body;
  const slug = req.params.slug;
  await db.from('entity_hours').delete().eq('entity_slug', slug);
  const rows = hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed }));
  const { error } = await db.from('entity_hours').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// ─── MENU SECTIONS + ITEMS ────────────────────────────────────────────────────

router.post('/entities/:slug/menu-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('menu_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/menu-sections/:id', authRequired, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('menu_sections').update({ section_name, sort_order }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/menu-sections/:id', authRequired, async (req, res) => {
  const { error } = await db.from('menu_sections').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/entities/:slug/menu-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, section_id, tags, image_url, image_path } = req.body;
  const { data, error } = await db.from('menu_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, tags: tags || null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/menu-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url, image_path } = req.body;
  const { data, error } = await db.from('menu_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, tags: tags || null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/menu-items/:id', authRequired, async (req, res) => {
  const { error } = await db.from('menu_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── DRINK SECTIONS + ITEMS ───────────────────────────────────────────────────

router.post('/entities/:slug/drink-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('drink_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.post('/entities/:slug/drink-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, section_id, image_url, image_path } = req.body;
  const { data, error } = await db.from('drink_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/drink-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, image_url, image_path } = req.body;
  const { data, error } = await db.from('drink_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/drink-items/:id', authRequired, async (req, res) => {
  const { error } = await db.from('drink_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── HAPPY HOUR ───────────────────────────────────────────────────────────────

router.put('/entities/:slug/happy-hour', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { hh_days, hh_start, hh_end, hh_description } = req.body;
  const { error } = await db.from('entity').update({ hh_days, hh_start, hh_end, hh_description, updated_at: new Date().toISOString() }).eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

router.post('/entities/:slug/hh-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('happy_hour_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.post('/entities/:slug/hh-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, original_price, section_id, image_url, image_path } = req.body;
  const { data, error } = await db.from('happy_hour_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/hh-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, original_price, image_url, image_path } = req.body;
  const { data, error } = await db.from('happy_hour_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/hh-items/:id', authRequired, async (req, res) => {
  const { error } = await db.from('happy_hour_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────

router.post('/events', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_events').insert({ ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/events/:id', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_events').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/events/:id', authRequired, async (req, res) => {
  const { error } = await db.from('entity_events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SPECIALS ─────────────────────────────────────────────────────────────────

router.post('/specials', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_specials').insert({ ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/specials/:id', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_specials').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/specials/:id', authRequired, async (req, res) => {
  const { error } = await db.from('entity_specials').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── PHOTOS ───────────────────────────────────────────────────────────────────

router.post('/entities/:slug/photos', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { url, image_path, is_cover, sort_order, caption } = req.body;
  const { data, error } = await db.from('entity_photos').insert({ entity_slug: slug, url, image_path: image_path || null, is_cover: !!is_cover, sort_order: sort_order || 0, caption: caption || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.delete('/photos/:id', authRequired, async (req, res) => {
  const { error } = await db.from('entity_photos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── BULK IMPORT ──────────────────────────────────────────────────────────────

router.post('/import-entity', authRequired, async (req, res) => {
  const { entity, hours, tags, photos } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'slug and name required' });

  const { error } = await db.from('entity').upsert({ ...entity, is_active: entity.is_active !== false }, { onConflict: 'slug' });
  if (error) return res.status(500).json({ error: error.message });

  const slug = entity.slug;
  const ops = [];
  if (hours?.length) {
    await db.from('entity_hours').delete().eq('entity_slug', slug);
    ops.push(db.from('entity_hours').insert(hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed }))));
  }
  if (tags?.length) {
    await db.from('entity_tags').delete().eq('entity_slug', slug);
    ops.push(db.from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null }))));
  }
  if (photos?.length) ops.push(db.from('entity_photos').insert(photos.map((p, i) => ({ entity_slug: slug, url: p.url, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }))));
  if (ops.length) await Promise.all(ops);
  res.json({ success: true, slug });
});

router.post('/import-menu', authRequired, async (req, res) => {
  const { entity_slug, sections } = req.body;
  if (!entity_slug || !sections?.length) return res.status(400).json({ error: 'entity_slug and sections required' });

  await db.from('menu_items').delete().eq('entity_slug', entity_slug);
  await db.from('menu_sections').delete().eq('entity_slug', entity_slug);

  for (const sec of sections) {
    const { data: secData, error: secErr } = await db.from('menu_sections').insert({ entity_slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
    if (secErr) continue;
    if (sec.items?.length) {
      await db.from('menu_items').insert(sec.items.map(i => ({ entity_slug, section_id: secData.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, tags: i.tags || null, image_url: i.image_url || null })));
    }
  }
  res.json({ success: true });
});

router.post('/import-drinks', authRequired, async (req, res) => {
  const { entity_slug, sections } = req.body;
  if (!entity_slug || !sections?.length) return res.status(400).json({ error: 'entity_slug and sections required' });

  await db.from('drink_items').delete().eq('entity_slug', entity_slug);
  await db.from('drink_sections').delete().eq('entity_slug', entity_slug);

  for (const sec of sections) {
    const { data: secData, error: secErr } = await db.from('drink_sections').insert({ entity_slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
    if (secErr) continue;
    if (sec.items?.length) {
      await db.from('drink_items').insert(sec.items.map(i => ({ entity_slug, section_id: secData.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null })));
    }
  }
  res.json({ success: true });
});

router.post('/import-happyhour', authRequired, async (req, res) => {
  const { entity_slug, hh_days, hh_start, hh_end, hh_description, sections } = req.body;
  if (!entity_slug) return res.status(400).json({ error: 'entity_slug required' });

  await db.from('entity').update({ hh_days, hh_start, hh_end, hh_description }).eq('slug', entity_slug);
  await db.from('happy_hour_items').delete().eq('entity_slug', entity_slug);
  await db.from('happy_hour_sections').delete().eq('entity_slug', entity_slug);

  for (const sec of (sections || [])) {
    const { data: secData, error: secErr } = await db.from('happy_hour_sections').insert({ entity_slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
    if (secErr) continue;
    if (sec.items?.length) {
      await db.from('happy_hour_items').insert(sec.items.map(i => ({ entity_slug, section_id: secData.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, original_price: i.original_price != null ? parseFloat(i.original_price) : null, image_url: i.image_url || null })));
    }
  }
  res.json({ success: true });
});

router.post('/import-events', authRequired, async (req, res) => {
  const { entity_slug, events } = req.body;
  if (!entity_slug || !events?.length) return res.status(400).json({ error: 'entity_slug and events required' });
  const rows = events.map(e => ({ entity_slug, entity_name: e.entity_name || null, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, cover_charge: e.cover_charge || null, is_active: true, image_url: e.image_url || null }));
  const { error } = await db.from('entity_events').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

router.post('/import-specials', authRequired, async (req, res) => {
  const { entity_slug, specials } = req.body;
  if (!entity_slug || !specials?.length) return res.status(400).json({ error: 'entity_slug and specials required' });
  const rows = specials.map(s => ({ entity_slug, entity_name: s.entity_name || null, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, start_time: s.start_time || null, end_time: s.end_time || null, is_active: true, image_url: s.image_url || null }));
  const { error } = await db.from('entity_specials').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

router.post('/import-photos', authRequired, async (req, res) => {
  const { entity_slug, photos } = req.body;
  if (!entity_slug || !photos?.length) return res.status(400).json({ error: 'entity_slug and photos required' });
  const rows = photos.map((p, i) => ({ entity_slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }));
  const { error } = await db.from('entity_photos').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

// import-master — import everything for one entity at once
router.post('/import-master', authRequired, async (req, res) => {
  const { entity, hours, tags, photos, menu, drinks, happyHour, events, specials } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'entity.slug and entity.name required' });

  const slug = entity.slug;
  const results = {};

  // Upsert entity
  const { error: entErr } = await db.from('entity').upsert({ ...entity, is_active: entity.is_active !== false }, { onConflict: 'slug' });
  if (entErr) return res.status(500).json({ error: 'entity: ' + entErr.message });
  results.entity = 'ok';

  // Hours
  if (hours?.length) {
    await db.from('entity_hours').delete().eq('entity_slug', slug);
    await db.from('entity_hours').insert(hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed })));
    results.hours = hours.length;
  }

  // Tags
  if (tags?.length) {
    await db.from('entity_tags').delete().eq('entity_slug', slug);
    await db.from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null })));
    results.tags = tags.length;
  }

  // Photos
  if (photos?.length) {
    await db.from('entity_photos').insert(photos.map((p, i) => ({ entity_slug: slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null })));
    results.photos = photos.length;
  }

  // Menu
  if (menu?.length) {
    await db.from('menu_items').delete().eq('entity_slug', slug);
    await db.from('menu_sections').delete().eq('entity_slug', slug);
    for (const sec of menu) {
      const { data: s } = await db.from('menu_sections').insert({ entity_slug: slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
      if (s && sec.items?.length) await db.from('menu_items').insert(sec.items.map(i => ({ entity_slug: slug, section_id: s.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null })));
    }
    results.menu = 'ok';
  }

  // Drinks
  if (drinks?.length) {
    await db.from('drink_items').delete().eq('entity_slug', slug);
    await db.from('drink_sections').delete().eq('entity_slug', slug);
    for (const sec of drinks) {
      const { data: s } = await db.from('drink_sections').insert({ entity_slug: slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
      if (s && sec.items?.length) await db.from('drink_items').insert(sec.items.map(i => ({ entity_slug: slug, section_id: s.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null })));
    }
    results.drinks = 'ok';
  }

  // Happy Hour
  if (happyHour) {
    await db.from('entity').update({ hh_days: happyHour.hh_days, hh_start: happyHour.hh_start, hh_end: happyHour.hh_end, hh_description: happyHour.hh_description }).eq('slug', slug);
    if (happyHour.sections?.length) {
      await db.from('happy_hour_items').delete().eq('entity_slug', slug);
      await db.from('happy_hour_sections').delete().eq('entity_slug', slug);
      for (const sec of happyHour.sections) {
        const { data: s } = await db.from('happy_hour_sections').insert({ entity_slug: slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
        if (s && sec.items?.length) await db.from('happy_hour_items').insert(sec.items.map(i => ({ entity_slug: slug, section_id: s.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, original_price: i.original_price != null ? parseFloat(i.original_price) : null })));
      }
    }
    results.happyHour = 'ok';
  }

  // Events
  if (events?.length) {
    await db.from('entity_events').insert(events.map(e => ({ entity_slug: slug, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, is_active: true, image_url: e.image_url || null })));
    results.events = events.length;
  }

  // Specials
  if (specials?.length) {
    await db.from('entity_specials').insert(specials.map(s => ({ entity_slug: slug, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, is_active: true, image_url: s.image_url || null })));
    results.specials = specials.length;
  }

  res.json({ success: true, slug, results });
});

module.exports = router;
