const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { validateEntityType, validateAlsoAppearsOn, VALID_ENTITY_TYPES, VALID_PAGES, SUBTYPES } = require('../utils/entity-types');
const { processBusiness, processBulkUpload } = require('../utils/upload-processor');

let db;
function getDb() {
  if (!db) {
    db = createClient(
      process.env.GCR_SUPABASE_URL,
      process.env.GCR_SUPABASE_SERVICE_KEY
    );
  }
  return db;
}

const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-change-in-production';

// ─── AUTH ─────────────────────────────────────────────────────────────────────
// Accepts: API key (ADMIN_SECRET), JWT token, or service key
function authRequired(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
    || req.headers['x-admin-key'];

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  // Check if it's an API key
  const validKeys = [
    process.env.GCR_SUPABASE_SERVICE_KEY,
    process.env.ADMIN_SECRET,
  ].filter(Boolean);

  if (validKeys.includes(token)) {
    next();
    return;
  }

  // Check if it's a JWT token
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
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

// ─── LOGIN ────────────────────────────────────────────────────────────────────
// POST /api/admin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Look up admin by email
    const { data: admin, error } = await getDb()
      .from('admin_users')
      .select('id, email, password_hash, role')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !admin) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Compare password
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token (valid for 7 days)
    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      admin: { id: admin.id, email: admin.email, role: admin.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── ENTITY CRUD ──────────────────────────────────────────────────────────────

// GET /api/admin/gcr/entities
router.get('/gcr/entities', async (req, res) => {
  let query = getDb()
    .from('entity')
    .select('id, slug, name, entity_type, entity_subtype, also_appears_on, city, is_active, featured, hero_image_url, rating')
    .order('name');

  if (req.query.type) query = query.eq('entity_type', req.query.type);
  if (req.query.uncategorized === 'true') query = query.is('entity_type', null);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/admin/gcr/entity-types — returns valid types, pages, subtypes
router.get('/gcr/entity-types', authRequired, (req, res) => {
  res.json({ types: VALID_ENTITY_TYPES, pages: VALID_PAGES, subtypes: SUBTYPES });
});

// POST /api/admin/gcr/upload — universal single-business upload
// Accepts full payload: { entity, tags, hours, photos, events, specials,
//   menu_items, drink_items, happy_hour_items, tour_options, amenities,
//   room_types, packages, highlights, policies, faq, ... any custom keys }
router.post('/gcr/upload', authRequired, async (req, res) => {
  const result = await processBusiness(getDb(), req.body);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

// POST /api/admin/gcr/upload/bulk — upload array of businesses at once
router.post('/gcr/upload/bulk', authRequired, async (req, res) => {
  const { businesses } = req.body;
  if (!Array.isArray(businesses) || !businesses.length) {
    return res.status(400).json({ error: 'businesses array required' });
  }
  const results = await processBulkUpload(getDb(), businesses);
  const status = results.failed.length > 0 && results.success.length === 0 ? 500 : 201;
  res.status(status).json(results);
});

// POST /api/admin/gcr/entities — create new entity
router.post('/gcr/entities', authRequired, async (req, res) => {
  const { entity, tags, hours } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'slug and name required' });

  const typeCheck = validateEntityType(entity.entity_type);
  if (!typeCheck.valid) return res.status(400).json({ error: typeCheck.error });

  const pagesCheck = validateAlsoAppearsOn(entity.also_appears_on);
  if (!pagesCheck.valid) return res.status(400).json({ error: pagesCheck.error });

  const { data: created, error } = await getDb().from('entity').insert({ ...entity, is_active: true }).select('id, slug').single();
  if (error) return res.status(500).json({ error: error.message });

  const slug = created.slug;
  const ops = [];

  if (tags?.length) ops.push(getDb().from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null }))));
  if (hours?.length) ops.push(getDb().from('entity_hours').insert(hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed }))));

  if (ops.length) await Promise.all(ops);
  invalidateCache(res, slug);
  res.status(201).json(created);
});

// GET /api/admin/gcr/entities/:slug
router.get('/gcr/entities/:slug', async (req, res) => {
  const slug = req.params.slug;
  const [entRes, hoursRes, photosRes, tagsRes] = await Promise.all([
    getDb().from('entity').select('*').eq('slug', slug).single(),
    getDb().from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    getDb().from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order'),
    getDb().from('entity_tags').select('*').eq('entity_slug', slug),
  ]);
  if (!entRes.data) return res.status(404).json({ error: 'Not found' });
  res.json({ entity: entRes.data, hours: hoursRes.data || [], photos: photosRes.data || [], tags: tagsRes.data || [] });
});

// PUT /api/admin/gcr/entities/:slug — update core entity fields
router.put('/gcr/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { entity } = req.body;

  if (entity.entity_type !== undefined) {
    const typeCheck = validateEntityType(entity.entity_type);
    if (!typeCheck.valid) return res.status(400).json({ error: typeCheck.error });
  }
  if (entity.also_appears_on !== undefined) {
    const pagesCheck = validateAlsoAppearsOn(entity.also_appears_on);
    if (!pagesCheck.valid) return res.status(400).json({ error: pagesCheck.error });
  }

  const { error } = await getDb().from('entity').update({ ...entity, updated_at: new Date().toISOString() }).eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// PATCH /api/admin/gcr/entities/:slug — bulk update everything at once
router.patch('/gcr/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { entity, hours, happyHour, menuSections, menuItems, drinkSections, drinkItems, hhSections, hhItems, events, specials, tags, photos } = req.body;
  const errors = [];

  // 1. Core entity
  if (entity) {
    const { error } = await getDb().from('entity').update({ ...entity, updated_at: new Date().toISOString() }).eq('slug', slug);
    if (error) errors.push('entity: ' + error.message);
  }

  // 2. Happy hour schedule on entity
  if (happyHour) {
    const { error } = await getDb().from('entity').update({
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
      const { error } = await getDb().from('entity_hours').upsert(
        { entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed },
        { onConflict: 'entity_slug,day_of_week' }
      );
      if (error) errors.push('hours ' + h.day_of_week + ': ' + error.message);
    }
  }

  // 4. Menu sections
  if (menuSections?.length) {
    const rows = menuSections.map((s, i) => ({ entity_slug: slug, section_name: s.section_name || s.name, sort_order: s.sort_order ?? i }));
    const { error } = await getDb().from('menu_sections').insert(rows);
    if (error) errors.push('menu_sections: ' + error.message);
  }

  // 5. Menu items
  if (menuItems?.length) {
    const rows = menuItems.map(i => ({ entity_slug: slug, section_id: i.section_id || null, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, tags: i.tags || null, image_url: i.image_url || null }));
    const { error } = await getDb().from('menu_items').insert(rows);
    if (error) errors.push('menu_items: ' + error.message);
  }

  // 6. Drink sections
  if (drinkSections?.length) {
    const rows = drinkSections.map((s, i) => ({ entity_slug: slug, section_name: s.section_name || s.name, sort_order: s.sort_order ?? i }));
    const { error } = await getDb().from('drink_sections').insert(rows);
    if (error) errors.push('drink_sections: ' + error.message);
  }

  // 7. Drink items
  if (drinkItems?.length) {
    const rows = drinkItems.map(i => ({ entity_slug: slug, section_id: i.section_id || null, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null }));
    const { error } = await getDb().from('drink_items').insert(rows);
    if (error) errors.push('drink_items: ' + error.message);
  }

  // 8. HH sections
  if (hhSections?.length) {
    const rows = hhSections.map((s, i) => ({ entity_slug: slug, section_name: s.section_name || s.name, sort_order: s.sort_order ?? i }));
    const { error } = await getDb().from('happy_hour_sections').insert(rows);
    if (error) errors.push('hh_sections: ' + error.message);
  }

  // 9. HH items
  if (hhItems?.length) {
    const rows = hhItems.map(i => ({ entity_slug: slug, section_id: i.section_id || null, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, original_price: i.original_price || null, image_url: i.image_url || null }));
    const { error } = await getDb().from('happy_hour_items').insert(rows);
    if (error) errors.push('hh_items: ' + error.message);
  }

  // 10. Events
  if (events?.length) {
    const rows = events.map(e => ({ entity_slug: slug, entity_name: e.entity_name || null, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, cover_charge: e.cover_charge || null, is_active: true, image_url: e.image_url || null }));
    const { error } = await getDb().from('entity_events').insert(rows);
    if (error) errors.push('events: ' + error.message);
  }

  // 11. Specials
  if (specials?.length) {
    const rows = specials.map(s => ({ entity_slug: slug, entity_name: s.entity_name || null, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, start_time: s.start_time || null, end_time: s.end_time || null, is_active: true, image_url: s.image_url || null }));
    const { error } = await getDb().from('entity_specials').insert(rows);
    if (error) errors.push('specials: ' + error.message);
  }

  // 12. Tags (replace all)
  if (tags?.length) {
    await getDb().from('entity_tags').delete().eq('entity_slug', slug);
    const rows = tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null }));
    const { error } = await getDb().from('entity_tags').insert(rows);
    if (error) errors.push('tags: ' + error.message);
  }

  // 13. Photos
  if (photos?.length) {
    const rows = photos.map((p, i) => ({ entity_slug: slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }));
    const { error } = await getDb().from('entity_photos').insert(rows);
    if (error) errors.push('photos: ' + error.message);
  }

  if (errors.length) return res.status(207).json({ success: false, errors });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// DELETE /api/admin/gcr/entities/:slug
router.delete('/gcr/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { error } = await getDb().from('entity').delete().eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// ─── HOURS ────────────────────────────────────────────────────────────────────

router.put('/gcr/entities/:slug/hours', authRequired, async (req, res) => {
  const { hours } = req.body;
  const slug = req.params.slug;
  await getDb().from('entity_hours').delete().eq('entity_slug', slug);
  const rows = hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed }));
  const { error } = await getDb().from('entity_hours').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// ─── MENU SECTIONS + ITEMS ────────────────────────────────────────────────────

router.post('/gcr/entities/:slug/menu-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await getDb().from('menu_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/menu-sections/:id', authRequired, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await getDb().from('menu_sections').update({ section_name, sort_order }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/menu-sections/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('menu_sections').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/gcr/entities/:slug/menu-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, section_id, tags, image_url, image_path } = req.body;
  const { data, error } = await getDb().from('menu_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, tags: tags || null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/menu-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url, image_path } = req.body;
  const { data, error } = await getDb().from('menu_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, tags: tags || null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/menu-items/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('menu_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── DRINK SECTIONS + ITEMS ───────────────────────────────────────────────────

router.post('/gcr/entities/:slug/drink-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await getDb().from('drink_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.post('/gcr/entities/:slug/drink-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, section_id, image_url, image_path } = req.body;
  const { data, error } = await getDb().from('drink_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/drink-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, image_url, image_path } = req.body;
  const { data, error } = await getDb().from('drink_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/drink-items/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('drink_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── HAPPY HOUR ───────────────────────────────────────────────────────────────

router.put('/gcr/entities/:slug/happy-hour', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { hh_days, hh_start, hh_end, hh_description } = req.body;
  const { error } = await getDb().from('entity').update({ hh_days, hh_start, hh_end, hh_description, updated_at: new Date().toISOString() }).eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

router.post('/gcr/entities/:slug/hh-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await getDb().from('happy_hour_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.post('/gcr/entities/:slug/hh-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, original_price, section_id, image_url, image_path } = req.body;
  const { data, error } = await getDb().from('happy_hour_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/hh-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, original_price, image_url, image_path } = req.body;
  const { data, error } = await getDb().from('happy_hour_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/hh-items/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('happy_hour_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────

router.post('/gcr/events', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_events').insert({ ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/gcr/events/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_events').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/events/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SPECIALS ─────────────────────────────────────────────────────────────────

router.post('/gcr/specials', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_specials').insert({ ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/gcr/specials/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_specials').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/specials/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_specials').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── PHOTOS ───────────────────────────────────────────────────────────────────

router.post('/gcr/entities/:slug/photos', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { url, image_path, is_cover, sort_order, caption } = req.body;
  const { data, error } = await getDb().from('entity_photos').insert({ entity_slug: slug, url, image_path: image_path || null, is_cover: !!is_cover, sort_order: sort_order || 0, caption: caption || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.delete('/gcr/photos/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_photos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── BULK IMPORT ──────────────────────────────────────────────────────────────

router.post('/gcr/import-entity', authRequired, async (req, res) => {
  const { entity, hours, tags, photos } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'slug and name required' });

  const { error } = await getDb().from('entity').upsert({ ...entity, is_active: entity.is_active !== false }, { onConflict: 'slug' });
  if (error) return res.status(500).json({ error: error.message });

  const slug = entity.slug;
  const ops = [];
  if (hours?.length) {
    await getDb().from('entity_hours').delete().eq('entity_slug', slug);
    ops.push(getDb().from('entity_hours').insert(hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed }))));
  }
  if (tags?.length) {
    await getDb().from('entity_tags').delete().eq('entity_slug', slug);
    ops.push(getDb().from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null }))));
  }
  if (photos?.length) ops.push(getDb().from('entity_photos').insert(photos.map((p, i) => ({ entity_slug: slug, url: p.url, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }))));
  if (ops.length) await Promise.all(ops);
  res.json({ success: true, slug });
});

router.post('/gcr/import-menu', authRequired, async (req, res) => {
  const { entity_slug, sections } = req.body;
  if (!entity_slug || !sections?.length) return res.status(400).json({ error: 'entity_slug and sections required' });

  await getDb().from('menu_items').delete().eq('entity_slug', entity_slug);
  await getDb().from('menu_sections').delete().eq('entity_slug', entity_slug);

  for (const sec of sections) {
    const { data: secData, error: secErr } = await getDb().from('menu_sections').insert({ entity_slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
    if (secErr) continue;
    if (sec.items?.length) {
      await getDb().from('menu_items').insert(sec.items.map(i => ({ entity_slug, section_id: secData.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, tags: i.tags || null, image_url: i.image_url || null })));
    }
  }
  res.json({ success: true });
});

router.post('/gcr/import-drinks', authRequired, async (req, res) => {
  const { entity_slug, sections } = req.body;
  if (!entity_slug || !sections?.length) return res.status(400).json({ error: 'entity_slug and sections required' });

  await getDb().from('drink_items').delete().eq('entity_slug', entity_slug);
  await getDb().from('drink_sections').delete().eq('entity_slug', entity_slug);

  for (const sec of sections) {
    const { data: secData, error: secErr } = await getDb().from('drink_sections').insert({ entity_slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
    if (secErr) continue;
    if (sec.items?.length) {
      await getDb().from('drink_items').insert(sec.items.map(i => ({ entity_slug, section_id: secData.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null })));
    }
  }
  res.json({ success: true });
});

router.post('/gcr/import-happyhour', authRequired, async (req, res) => {
  const { entity_slug, hh_days, hh_start, hh_end, hh_description, sections } = req.body;
  if (!entity_slug) return res.status(400).json({ error: 'entity_slug required' });

  await getDb().from('entity').update({ hh_days, hh_start, hh_end, hh_description }).eq('slug', entity_slug);
  await getDb().from('happy_hour_items').delete().eq('entity_slug', entity_slug);
  await getDb().from('happy_hour_sections').delete().eq('entity_slug', entity_slug);

  for (const sec of (sections || [])) {
    const { data: secData, error: secErr } = await getDb().from('happy_hour_sections').insert({ entity_slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
    if (secErr) continue;
    if (sec.items?.length) {
      await getDb().from('happy_hour_items').insert(sec.items.map(i => ({ entity_slug, section_id: secData.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, original_price: i.original_price != null ? parseFloat(i.original_price) : null, image_url: i.image_url || null })));
    }
  }
  res.json({ success: true });
});

router.post('/gcr/import-events', authRequired, async (req, res) => {
  const { entity_slug, events } = req.body;
  if (!entity_slug || !events?.length) return res.status(400).json({ error: 'entity_slug and events required' });
  const rows = events.map(e => ({ entity_slug, entity_name: e.entity_name || null, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, cover_charge: e.cover_charge || null, is_active: true, image_url: e.image_url || null }));
  const { error } = await getDb().from('entity_events').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

router.post('/gcr/import-specials', authRequired, async (req, res) => {
  const { entity_slug, specials } = req.body;
  if (!entity_slug || !specials?.length) return res.status(400).json({ error: 'entity_slug and specials required' });
  const rows = specials.map(s => ({ entity_slug, entity_name: s.entity_name || null, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, start_time: s.start_time || null, end_time: s.end_time || null, is_active: true, image_url: s.image_url || null }));
  const { error } = await getDb().from('entity_specials').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

router.post('/gcr/import-photos', authRequired, async (req, res) => {
  const { entity_slug, photos } = req.body;
  if (!entity_slug || !photos?.length) return res.status(400).json({ error: 'entity_slug and photos required' });
  const rows = photos.map((p, i) => ({ entity_slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }));
  const { error } = await getDb().from('entity_photos').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

// import-master — import everything for one entity at once
router.post('/gcr/import-master', authRequired, async (req, res) => {
  const { entity, hours, tags, photos, menu, drinks, happyHour, events, specials, sections } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'entity.slug and entity.name required' });

  const slug = entity.slug;
  const results = {};

  // Upsert entity
  const { error: entErr } = await getDb().from('entity').upsert({ ...entity, is_active: entity.is_active !== false }, { onConflict: 'slug' });
  if (entErr) return res.status(500).json({ error: 'entity: ' + entErr.message });
  results.entity = 'ok';

  // Hours
  if (hours?.length) {
    await getDb().from('entity_hours').delete().eq('entity_slug', slug);
    await getDb().from('entity_hours').insert(hours.map(h => ({ entity_slug: slug, day_of_week: h.day_of_week, opens_at: h.opens_at || null, closes_at: h.closes_at || null, is_closed: !!h.is_closed })));
    results.hours = hours.length;
  }

  // Tags
  if (tags?.length) {
    await getDb().from('entity_tags').delete().eq('entity_slug', slug);
    await getDb().from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, tag_name: t.tag_name || t, tag_category: t.tag_category || null })));
    results.tags = tags.length;
  }

  // Photos
  if (photos?.length) {
    await getDb().from('entity_photos').insert(photos.map((p, i) => ({ entity_slug: slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null })));
    results.photos = photos.length;
  }

  // Menu
  if (menu?.length) {
    await getDb().from('menu_items').delete().eq('entity_slug', slug);
    await getDb().from('menu_sections').delete().eq('entity_slug', slug);
    for (const sec of menu) {
      const { data: s } = await getDb().from('menu_sections').insert({ entity_slug: slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
      if (s && sec.items?.length) await getDb().from('menu_items').insert(sec.items.map(i => ({ entity_slug: slug, section_id: s.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null })));
    }
    results.menu = 'ok';
  }

  // Drinks
  if (drinks?.length) {
    await getDb().from('drink_items').delete().eq('entity_slug', slug);
    await getDb().from('drink_sections').delete().eq('entity_slug', slug);
    for (const sec of drinks) {
      const { data: s } = await getDb().from('drink_sections').insert({ entity_slug: slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
      if (s && sec.items?.length) await getDb().from('drink_items').insert(sec.items.map(i => ({ entity_slug: slug, section_id: s.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, image_url: i.image_url || null })));
    }
    results.drinks = 'ok';
  }

  // Happy Hour
  if (happyHour) {
    await getDb().from('entity').update({ hh_days: happyHour.hh_days, hh_start: happyHour.hh_start, hh_end: happyHour.hh_end, hh_description: happyHour.hh_description }).eq('slug', slug);
    if (happyHour.sections?.length) {
      await getDb().from('happy_hour_items').delete().eq('entity_slug', slug);
      await getDb().from('happy_hour_sections').delete().eq('entity_slug', slug);
      for (const sec of happyHour.sections) {
        const { data: s } = await getDb().from('happy_hour_sections').insert({ entity_slug: slug, section_name: sec.section_name || sec.name, sort_order: sec.sort_order || 0 }).select('id').single();
        if (s && sec.items?.length) await getDb().from('happy_hour_items').insert(sec.items.map(i => ({ entity_slug: slug, section_id: s.id, item_name: i.item_name || i.name, description: i.description || null, price: i.price != null ? parseFloat(i.price) : null, original_price: i.original_price != null ? parseFloat(i.original_price) : null })));
      }
    }
    results.happyHour = 'ok';
  }

  // Events
  if (events?.length) {
    await getDb().from('entity_events').insert(events.map(e => ({ entity_slug: slug, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, is_active: true, image_url: e.image_url || null })));
    results.events = events.length;
  }

  // Specials
  if (specials?.length) {
    await getDb().from('entity_specials').insert(specials.map(s => ({ entity_slug: slug, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, is_active: true, image_url: s.image_url || null })));
    results.specials = specials.length;
  }

  // Flexible sections (Things To Do, Services, Staying)
  if (sections?.length) {
    await getDb().from('entity_section_items').delete().eq('entity_slug', slug);
    await getDb().from('entity_sections').delete().eq('entity_slug', slug);
    for (const [i, sec] of sections.entries()) {
      const { data: s, error: secErr } = await getDb()
        .from('entity_sections')
        .insert({ entity_slug: slug, section_type: sec.section_type, section_name: sec.section_name || sec.name, sort_order: sec.sort_order ?? i })
        .select('id').single();
      if (secErr || !s) continue;
      if (sec.items?.length) {
        await getDb().from('entity_section_items').insert(sec.items.map((item, j) => ({
          entity_slug: slug,
          section_id: s.id,
          item_name: item.item_name || item.name,
          description: item.description || null,
          price_from: item.price_from != null ? parseFloat(item.price_from) : null,
          price_to: item.price_to != null ? parseFloat(item.price_to) : null,
          price_label: item.price_label || null,
          duration: item.duration || null,
          icon: item.icon || null,
          metadata: item.metadata || {},
          sort_order: item.sort_order ?? j,
        })));
      }
    }
    results.sections = sections.length;
  }

  res.json({ success: true, slug, results });
});

// ─── ENTITY SECTIONS (Things To Do / Services / Staying) ─────────────────────

// GET /api/admin/entities/:slug/sections
router.get('/entities/:slug/sections', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const { data: secs } = await getDb().from('entity_sections').select('*').eq('entity_slug', slug).order('sort_order');
    const ids = (secs || []).map(s => s.id);
    const { data: items } = ids.length
      ? await getDb().from('entity_section_items').select('*').in('section_id', ids).order('sort_order')
      : { data: [] };
    const sections = (secs || []).map(s => ({ ...s, items: (items || []).filter(i => i.section_id === s.id) }));
    res.json({ sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/entities/:slug/sections — replace all sections for entity
router.post('/entities/:slug/sections', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const { sections } = req.body;
    if (!Array.isArray(sections)) return res.status(400).json({ error: 'sections array required' });

    await getDb().from('entity_section_items').delete().eq('entity_slug', slug);
    await getDb().from('entity_sections').delete().eq('entity_slug', slug);

    for (const [i, sec] of sections.entries()) {
      const { data: s, error: secErr } = await getDb()
        .from('entity_sections')
        .insert({ entity_slug: slug, section_type: sec.section_type, section_name: sec.section_name || sec.name, sort_order: sec.sort_order ?? i })
        .select('id').single();
      if (secErr || !s) continue;
      if (sec.items?.length) {
        await getDb().from('entity_section_items').insert(sec.items.map((item, j) => ({
          entity_slug: slug, section_id: s.id,
          item_name: item.item_name || item.name,
          description: item.description || null,
          price_from: item.price_from != null ? parseFloat(item.price_from) : null,
          price_to: item.price_to != null ? parseFloat(item.price_to) : null,
          price_label: item.price_label || null,
          duration: item.duration || null,
          icon: item.icon || null,
          metadata: item.metadata || {},
          sort_order: item.sort_order ?? j,
        })));
      }
    }
    res.json({ success: true, slug, count: sections.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/entities/:slug/sections — clear all sections
router.delete('/entities/:slug/sections', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    await getDb().from('entity_section_items').delete().eq('entity_slug', slug);
    await getDb().from('entity_sections').delete().eq('entity_slug', slug);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/gcr/:slug/sections — add a single new section (no wipe)
// Use this when the user clicks "Add Section" in the dashboard
// Body: { section_type, section_name, items: [] }
// section_type can be anything — standard types or custom like "pool", "beach-access"
router.post('/gcr/:slug/sections', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const { section_type, section_name, items = [] } = req.body;
    if (!section_name) return res.status(400).json({ error: 'section_name required' });

    const db = getDb();

    // Get next sort_order
    const { data: last } = await db.from('entity_sections').select('sort_order').eq('entity_slug', slug).order('sort_order', { ascending: false }).limit(1).single();
    const sort_order = last ? (last.sort_order + 1) : 0;

    const { data: section, error: secErr } = await db
      .from('entity_sections')
      .insert({
        entity_slug: slug,
        section_type: section_type || `custom_${section_name.toLowerCase().replace(/\s+/g, '_')}`,
        section_name,
        sort_order,
      })
      .select().single();

    if (secErr) return res.status(500).json({ error: secErr.message });

    // Insert items if provided
    let insertedItems = [];
    if (items.length) {
      const { data, error: itemErr } = await db.from('entity_section_items').insert(
        items.map((item, i) => ({
          section_id: section.id,
          entity_slug: slug,
          item_name: item.item_name || item.name,
          description: item.description || null,
          price_from: item.price_from != null ? parseFloat(item.price_from) : null,
          price_to: item.price_to != null ? parseFloat(item.price_to) : null,
          price_label: item.price_label || null,
          duration: item.duration || null,
          icon: item.icon || null,
          metadata: item.metadata || {},
          sort_order: i,
        }))
      ).select();
      if (itemErr) return res.status(500).json({ error: itemErr.message });
      insertedItems = data || [];
    }

    res.status(201).json({ success: true, section: { ...section, items: insertedItems } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/gcr/sections/:id — rename a section or reorder it
router.patch('/gcr/sections/:id', authRequired, async (req, res) => {
  try {
    const { section_name, section_type, sort_order } = req.body;
    const updates = {};
    if (section_name !== undefined) updates.section_name = section_name;
    if (section_type !== undefined) updates.section_type = section_type;
    if (sort_order !== undefined) updates.sort_order = sort_order;

    const { error } = await getDb().from('entity_sections').update(updates).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/gcr/sections/:id — delete a single section + its items
router.delete('/gcr/sections/:id', authRequired, async (req, res) => {
  try {
    await getDb().from('entity_section_items').delete().eq('section_id', req.params.id);
    await getDb().from('entity_sections').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/gcr/sections/:section_id/items — add item to existing section
router.post('/gcr/sections/:section_id/items', authRequired, async (req, res) => {
  try {
    const { entity_slug, item_name, description, price_from, price_to, price_label, duration, icon, metadata } = req.body;
    if (!entity_slug || !item_name) return res.status(400).json({ error: 'entity_slug and item_name required' });

    const db = getDb();
    const { data: last } = await db.from('entity_section_items').select('sort_order').eq('section_id', req.params.section_id).order('sort_order', { ascending: false }).limit(1).single();
    const sort_order = last ? (last.sort_order + 1) : 0;

    const { data, error } = await db.from('entity_section_items').insert({
      section_id: req.params.section_id,
      entity_slug,
      item_name,
      description: description || null,
      price_from: price_from != null ? parseFloat(price_from) : null,
      price_to: price_to != null ? parseFloat(price_to) : null,
      price_label: price_label || null,
      duration: duration || null,
      icon: icon || null,
      metadata: metadata || {},
      sort_order,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/gcr/section-items/:id — edit a section item
router.patch('/gcr/section-items/:id', authRequired, async (req, res) => {
  try {
    const { item_name, description, price_from, price_to, price_label, duration, icon, metadata, sort_order } = req.body;
    const updates = {};
    if (item_name !== undefined) updates.item_name = item_name;
    if (description !== undefined) updates.description = description;
    if (price_from !== undefined) updates.price_from = price_from != null ? parseFloat(price_from) : null;
    if (price_to !== undefined) updates.price_to = price_to != null ? parseFloat(price_to) : null;
    if (price_label !== undefined) updates.price_label = price_label;
    if (duration !== undefined) updates.duration = duration;
    if (icon !== undefined) updates.icon = icon;
    if (metadata !== undefined) updates.metadata = metadata;
    if (sort_order !== undefined) updates.sort_order = sort_order;

    const { error } = await getDb().from('entity_section_items').update(updates).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/gcr/section-items/:id — delete a single section item
router.delete('/gcr/section-items/:id', authRequired, async (req, res) => {
  try {
    const { error } = await getDb().from('entity_section_items').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TRIP SWIPE: TOURISTS ─────────────────────────────────────────────────────

// GET /api/admin/tourists — list all tourists with summary stats
router.get('/tourists', authRequired, async (req, res) => {
  try {
    const { data: profiles, error } = await getDb().from('tourist_profiles')
      .select('user_id, email, name, phone, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch summary stats for each tourist
    const tourists = await Promise.all((profiles || []).map(async (p) => {
      const [saves, swipes, itinerary] = await Promise.all([
        getDb().from('tourist_saves').select('id', { count: 'exact', head: true }).eq('user_id', p.user_id),
        getDb().from('tourist_swipe_events').select('id', { count: 'exact', head: true }).eq('user_id', p.user_id),
        getDb().from('tourist_itineraries').select('*').eq('user_id', p.user_id).maybeSingle()
      ]);

      return {
        user_id: p.user_id,
        email: p.email,
        name: p.name || p.email.split('@')[0],
        phone: p.phone,
        saves_count: saves.count || 0,
        swipes_count: swipes.count || 0,
        itineraries_count: itinerary ? 1 : 0,
        created_at: p.created_at,
        updated_at: p.updated_at
      };
    }));

    res.json({ tourists });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/tourists/:user_id — get tourist detail with all data
router.get('/tourists/:user_id', authRequired, async (req, res) => {
  try {
    const uid = req.params.user_id;
    const [profile, saves, itinerary, swipes] = await Promise.all([
      getDb().from('tourist_profiles').select('*').eq('user_id', uid).maybeSingle(),
      getDb().from('tourist_saves').select('*').eq('user_id', uid).order('saved_at', { ascending: false }),
      getDb().from('tourist_itineraries').select('*').eq('user_id', uid).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      getDb().from('tourist_swipe_events').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(100)
    ]);

    res.json({
      profile: profile.data || null,
      saves: saves.data || [],
      itinerary: itinerary.data || null,
      recent_swipes: swipes.data || []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/tourists/:user_id/preferences — get tourist preference scores
router.get('/tourists/:user_id/preferences', authRequired, async (req, res) => {
  try {
    const uid = req.params.user_id;
    const { data: prefs, error } = await getDb().from('user_preference_scores')
      .select('*')
      .eq('tourist_id', uid)
      .order('score', { ascending: false });

    if (error) throw error;
    res.json({ preferences: prefs || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/tourists/:user_id — delete tourist and cascade all data
router.delete('/tourists/:user_id', authRequired, async (req, res) => {
  try {
    const uid = req.params.user_id;

    // Delete cascading records
    await Promise.all([
      getDb().from('tourist_saves').delete().eq('user_id', uid),
      getDb().from('tourist_swipe_events').delete().eq('user_id', uid),
      getDb().from('tourist_itineraries').delete().eq('user_id', uid),
      getDb().from('user_preference_scores').delete().eq('tourist_id', uid),
      getDb().from('tourist_profiles').delete().eq('user_id', uid)
    ]);

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TRIP SWIPE: ANALYTICS ───────────────────────────────────────────────────

// GET /api/admin/tripswipe-analytics — swipe activity stats
router.get('/tripswipe-analytics', authRequired, async (req, res) => {
  try {
    const period = req.query.period || 'week';
    const now = new Date();
    let since = new Date(now);

    if (period === 'today') since.setHours(0, 0, 0, 0);
    else if (period === 'week') since.setDate(now.getDate() - 7);
    else if (period === 'month') since.setMonth(now.getMonth() - 1);

    const { data: events, error } = await getDb().from('tourist_swipe_events')
      .select('*')
      .gte('created_at', since.toISOString());

    if (error) throw error;

    const events_arr = events || [];
    const likes = events_arr.filter(e => e.direction === 'like').length;
    const nopes = events_arr.filter(e => e.direction === 'nope').length;
    const total = events_arr.length;

    // Category breakdown
    const cats = {};
    events_arr.forEach(e => {
      const cat = e.category || 'unknown';
      cats[cat] = (cats[cat] || 0) + 1;
    });

    res.json({
      total_seen: total,
      total_likes: likes,
      total_nopes: nopes,
      like_rate: total > 0 ? Math.round((likes / total) * 100) : 0,
      categories: Object.entries(cats).map(([cat, count]) => ({ cat, count }))
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TRIP SWIPE: SPONSORED BUSINESSES ──────────────────────────────────────

// GET /api/admin/tripswipe/sponsored — list sponsored businesses
router.get('/tripswipe/sponsored', authRequired, async (req, res) => {
  try {
    const { data: sponsored, error } = await getDb().from('tripswipe_sponsored')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ sponsored: sponsored || [] });
  } catch(e) {
    res.status(500).json({ sponsored: [] });
  }
});

// POST /api/admin/tripswipe/sponsored — add sponsored business
router.post('/tripswipe/sponsored', authRequired, async (req, res) => {
  try {
    const { entity_slug, entity_id, business_name, images, description, cta_text, cta_url, start_date, end_date } = req.body;

    const { data, error } = await getDb().from('tripswipe_sponsored').insert({
      entity_slug,
      entity_id,
      business_name,
      images: images || [],
      description,
      cta_text,
      cta_url,
      start_date,
      end_date,
      is_active: true,
      created_at: new Date().toISOString()
    }).select('*').single();

    if (error) throw error;
    invalidateCache(res);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/tripswipe/sponsored/:id — update sponsored
router.put('/tripswipe/sponsored/:id', authRequired, async (req, res) => {
  try {
    const { data, error } = await getDb().from('tripswipe_sponsored')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    invalidateCache(res);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/tripswipe/sponsored/:id
router.delete('/tripswipe/sponsored/:id', authRequired, async (req, res) => {
  try {
    const { error } = await getDb().from('tripswipe_sponsored').delete().eq('id', req.params.id);
    if (error) throw error;
    invalidateCache(res);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TRIP SWIPE: PROMO CARDS (Tonight) ─────────────────────────────────────

// GET /api/admin/tripswipe/promo-cards — list promo cards
router.get('/tripswipe/promo-cards', authRequired, async (req, res) => {
  try {
    const { data: cards, error } = await getDb().from('tripswipe_promo_cards')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ cards: cards || [] });
  } catch(e) {
    res.status(500).json({ cards: [] });
  }
});

// POST /api/admin/tripswipe/promo-cards — add promo card
router.post('/tripswipe/promo-cards', authRequired, async (req, res) => {
  try {
    const { title, description, image_url, cta_text, cta_url, show_date, is_active } = req.body;

    const { data, error } = await getDb().from('tripswipe_promo_cards').insert({
      title,
      description,
      image_url,
      cta_text,
      cta_url,
      show_date,
      is_active: is_active !== false,
      created_at: new Date().toISOString()
    }).select('*').single();

    if (error) throw error;
    invalidateCache(res);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/tripswipe/promo-cards/:id — update promo card
router.put('/tripswipe/promo-cards/:id', authRequired, async (req, res) => {
  try {
    const { data, error } = await getDb().from('tripswipe_promo_cards')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    invalidateCache(res);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/tripswipe/promo-cards/:id
router.delete('/tripswipe/promo-cards/:id', authRequired, async (req, res) => {
  try {
    const { error } = await getDb().from('tripswipe_promo_cards').delete().eq('id', req.params.id);
    if (error) throw error;
    invalidateCache(res);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TRIP SWIPE: BUSINESS SETTINGS ────────────────────────────────────────

// GET /api/admin/tripswipe/settings — get Trip Swipe business settings
router.get('/tripswipe/settings', authRequired, async (req, res) => {
  try {
    const { data: settings, error } = await getDb().from('tripswipe_business_settings')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ settings: settings || [] });
  } catch(e) {
    res.status(500).json({ settings: [] });
  }
});

// GET /api/admin/tripswipe/settings/:slug — get Trip Swipe setting for one business
router.get('/tripswipe/settings/:slug', authRequired, async (req, res) => {
  try {
    const { data: setting, error } = await getDb().from('tripswipe_business_settings')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .maybeSingle();

    if (error) throw error;
    res.json(setting || { entity_slug: req.params.slug, enabled: true, show_on_tripswipe: true });
  } catch(e) {
    res.status(500).json({});
  }
});

// PUT /api/admin/tripswipe/settings/:slug — update Trip Swipe setting
router.put('/tripswipe/settings/:slug', authRequired, async (req, res) => {
  try {
    const slug = req.params.slug;

    // Try to update, if not found insert
    const { data: existing } = await getDb().from('tripswipe_business_settings')
      .select('id')
      .eq('entity_slug', slug)
      .maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await getDb().from('tripswipe_business_settings')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('entity_slug', slug)
        .select('*')
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await getDb().from('tripswipe_business_settings').insert({
        entity_slug: slug,
        ...req.body,
        created_at: new Date().toISOString()
      }).select('*').single();
      if (error) throw error;
      result = data;
    }

    invalidateCache(res, slug);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PLATFORM ANALYTICS ───────────────────────────────────────────────────

// GET /api/admin/platform-analytics — overall platform stats
router.get('/platform-analytics', authRequired, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [tourists, saves, swipes, itineraries] = await Promise.all([
      getDb().from('tourist_profiles').select('id', { count: 'exact', head: true }).gte('created_at', since),
      getDb().from('tourist_saves').select('id', { count: 'exact', head: true }).gte('created_at', since),
      getDb().from('tourist_swipe_events').select('id', { count: 'exact', head: true }).gte('created_at', since),
      getDb().from('tourist_itineraries').select('id', { count: 'exact', head: true }).gte('created_at', since)
    ]);

    res.json({
      period_days: days,
      total_tourists: tourists.count || 0,
      total_saves: saves.count || 0,
      total_swipes: swipes.count || 0,
      total_itineraries: itineraries.count || 0
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI ORGANIZER ─────────────────────────────────────────────────────────────
// POST /api/admin/ai-organize
// Parses raw text input (menu, specials, events, etc) into structured data
// Body: { raw_input, business_id?, business_name }
// Returns: { success, message, organized_data }

router.post('/ai-organize', authRequired, async (req, res) => {
  try {
    const { raw_input, business_id, business_name } = req.body;
    if (!raw_input || !raw_input.trim()) {
      return res.status(400).json({ error: 'raw_input required' });
    }

    // Call Claude to parse the raw input
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a restaurant menu data organizer. Parse the following raw text input and structure it into a JSON object with these sections:
- menu_sections: Array of {section_name, items: [{item_name, description?, price?}]}
- drink_sections: Array of {section_name, items: [{item_name, description?, price?}]}
- happy_hour_sections: Array of {section_name, items: [{item_name, description?, price?, original_price?}]}
- specials: Array of {name, description?, discount_text?}
- events: Array of {event_name, description?, event_date?, event_time?}

Extract ONLY what's in the text. Use null/empty arrays for missing sections.
Return ONLY valid JSON, no markdown.

RAW INPUT:
${raw_input}`;

    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0]?.type === 'text' ? message.content[0].text : '';
    let parsed = {};

    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse Claude response:', responseText);
      return res.status(400).json({ error: 'Failed to parse data: ' + e.message });
    }

    // If business_id provided, fetch existing data and merge
    let mergedData = {
      menu_sections: parsed.menu_sections || [],
      drink_sections: parsed.drink_sections || [],
      happy_hour_sections: parsed.happy_hour_sections || [],
      specials: parsed.specials || [],
      events: parsed.events || [],
    };

    if (business_id && business_id !== 'null' && business_id !== 'new') {
      const { data: entity } = await db.from('entity').select('slug').eq('id', business_id).single();
      if (entity) {
        const slug = entity.slug;

        // Fetch existing data
        const [menuSecs, drinkSecs, hhSecs, specs, evts] = await Promise.all([
          db.from('menu_sections').select('*, items:menu_items(*)').eq('entity_slug', slug).order('sort_order'),
          db.from('drink_sections').select('*, items:drink_items(*)').eq('entity_slug', slug).order('sort_order'),
          db.from('happy_hour_sections').select('*, items:happy_hour_items(*)').eq('entity_slug', slug).order('sort_order'),
          db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
          db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true),
        ]);

        // Merge: old data + new parsed data (new data takes precedence)
        mergedData.menu_sections = [
          ...(menuSecs.data || []).map(s => ({ section_name: s.section_name, items: s.items || [] })),
          ...(parsed.menu_sections || []).filter(p => !menuSecs.data?.some(s => s.section_name === p.section_name))
        ];
        mergedData.drink_sections = [
          ...(drinkSecs.data || []).map(s => ({ section_name: s.section_name, items: s.items || [] })),
          ...(parsed.drink_sections || []).filter(p => !drinkSecs.data?.some(s => s.section_name === p.section_name))
        ];
        mergedData.happy_hour_sections = [
          ...(hhSecs.data || []).map(s => ({ section_name: s.section_name, items: s.items || [] })),
          ...(parsed.happy_hour_sections || []).filter(p => !hhSecs.data?.some(s => s.section_name === p.section_name))
        ];
        mergedData.specials = [...(specs.data || []).map(s => ({ name: s.special_name, description: s.description, discount_text: s.discount_text })), ...(parsed.specials || [])];
        mergedData.events = [...(evts.data || []).map(e => ({ event_name: e.event_name, description: e.description, event_date: e.event_date })), ...(parsed.events || [])];
      }
    }

    res.json({
      success: true,
      message: `✅ Data organized! Found ${(mergedData.menu_sections || []).length} menu sections, ${(mergedData.drink_sections || []).length} drink sections, ${(mergedData.specials || []).length} specials, ${(mergedData.events || []).length} events.`,
      organized_data: mergedData,
    });
  } catch (err) {
    console.error('AI organize error:', err);
    res.status(500).json({ error: 'Failed to organize data: ' + err.message });
  }
});

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────────────
// Unified image upload for all business types + all image slots
// POST /api/admin/gcr/images/upload
//
// Form fields:
//   image       (file)    — the image file
//   slug        (text)    — entity slug
//   type        (text)    — hero | logo | gallery | menu-item | drink-item |
//                           hh-item | event | special | section-item
//   item_id     (text)    — required for menu-item, drink-item, hh-item, event, special, section-item
//   caption     (text)    — optional caption for gallery photos
//   set_hero    (text)    — "true" to also update hero_image_url when type=gallery
//
// Returns: { success: true, url: "https://...", path: "entities/slug/..." }
// The URL is saved to the DB automatically. Read it back from the DB to display it.

const multer = require('multer');
const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const IMAGE_TABLE_MAP = {
  // Restaurants / Coffee / Bakery / Dessert
  'menu-item':      { table: 'menu_items',             bucket: 'menu-items' },
  'drink-item':     { table: 'drink_items',            bucket: 'menu-items' },
  'hh-item':        { table: 'happy_hour_items',       bucket: 'menu-items' },
  'special':        { table: 'entity_specials',        bucket: 'entity-photos' },

  // All types — events, sections, section items
  'event':          { table: 'entity_events',          bucket: 'entity-photos' },
  'section-item':   { table: 'entity_section_items',   bucket: 'entity-photos' },

  // Things To Do — tour options, packages, fleet, etc. all use entity_section_items
  'tour-option':    { table: 'entity_section_items',   bucket: 'entity-photos' },
  'package':        { table: 'entity_section_items',   bucket: 'entity-photos' },
  'fleet-item':     { table: 'entity_section_items',   bucket: 'entity-photos' },

  // Staying — room types use entity_section_items
  'room-type':      { table: 'entity_section_items',   bucket: 'entity-photos' },

  // Services — service packages use entity_section_items
  'service-package':{ table: 'entity_section_items',   bucket: 'entity-photos' },

  // Artists (live music profiles)
  'artist':         { table: 'artists',                bucket: 'entity-photos' },
};

router.post('/gcr/images/upload', authRequired, _upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const { slug, type = 'gallery', item_id, caption, set_hero } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    const db = getDb();
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `${Date.now()}.${ext}`;

    // Determine storage path + bucket
    let storagePath, bucket;
    if (type === 'hero' || type === 'logo') {
      storagePath = `entities/${slug}/${type}.${ext}`;
      bucket = 'entity-photos';
    } else if (type === 'gallery') {
      storagePath = `entities/${slug}/gallery/${filename}`;
      bucket = 'entity-photos';
    } else if (IMAGE_TABLE_MAP[type]) {
      storagePath = `${type}s/${item_id || slug}/${filename}`;
      bucket = IMAGE_TABLE_MAP[type].bucket;
    } else {
      storagePath = `entities/${slug}/${type}/${filename}`;
      bucket = 'entity-photos';
    }

    // Upload file to Supabase Storage
    const { error: upErr } = await db.storage
      .from(bucket)
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (upErr) return res.status(500).json({ error: `Storage upload failed: ${upErr.message}` });

    // Get the public URL
    const { data: { publicUrl } } = db.storage.from(bucket).getPublicUrl(storagePath);

    // Save URL to the right DB table
    if (type === 'hero') {
      await db.from('entity').update({ hero_image_url: publicUrl, hero_image_path: storagePath }).eq('slug', slug);

    } else if (type === 'logo') {
      await db.from('entity').update({ logo_url: publicUrl, logo_image_path: storagePath }).eq('slug', slug);

    } else if (type === 'gallery') {
      const { data: last } = await db.from('entity_photos').select('sort_order').eq('entity_slug', slug).order('sort_order', { ascending: false }).limit(1).single();
      const nextOrder = last ? (last.sort_order + 1) : 0;
      await db.from('entity_photos').insert({
        entity_slug: slug,
        url: publicUrl,
        image_path: storagePath,
        is_cover: nextOrder === 0,
        sort_order: nextOrder,
        caption: caption || null,
      });
      // Optionally also set as hero
      if (set_hero === 'true' || nextOrder === 0) {
        await db.from('entity').update({ hero_image_url: publicUrl, hero_image_path: storagePath }).eq('slug', slug);
      }

    } else if (IMAGE_TABLE_MAP[type]) {
      if (!item_id) return res.status(400).json({ error: `item_id required for type "${type}"` });
      await db.from(IMAGE_TABLE_MAP[type].table)
        .update({ image_url: publicUrl, image_path: storagePath })
        .eq('id', item_id);
    }

    res.json({ success: true, url: publicUrl, path: storagePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/gcr/:slug/gallery/bulk — upload multiple images to gallery at once
// Send as multipart/form-data with field name "images" (multiple files)
router.post('/gcr/:slug/gallery/bulk', authRequired, _upload.array('images', 100), async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!req.files?.length) return res.status(400).json({ error: 'No images provided' });

    const db = getDb();

    // Get current highest sort_order
    const { data: last } = await db.from('entity_photos').select('sort_order').eq('entity_slug', slug).order('sort_order', { ascending: false }).limit(1).single();
    let nextOrder = last ? (last.sort_order + 1) : 0;

    const uploaded = [];
    const failed = [];

    for (const file of req.files) {
      try {
        const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
        const storagePath = `entities/${slug}/gallery/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        const { error: upErr } = await db.storage
          .from('entity-photos')
          .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });

        if (upErr) { failed.push({ name: file.originalname, error: upErr.message }); continue; }

        const { data: { publicUrl } } = db.storage.from('entity-photos').getPublicUrl(storagePath);

        const { data: photo } = await db.from('entity_photos').insert({
          entity_slug: slug,
          url: publicUrl,
          image_path: storagePath,
          is_cover: nextOrder === 0,
          sort_order: nextOrder,
          caption: file.originalname.replace(/\.[^/.]+$/, '') || null,
        }).select().single();

        // First image auto-sets as hero if none exists
        if (nextOrder === 0) {
          await db.from('entity').update({ hero_image_url: publicUrl, hero_image_path: storagePath }).eq('slug', slug);
        }

        uploaded.push(photo);
        nextOrder++;
      } catch (err) {
        failed.push({ name: file.originalname, error: err.message });
      }
    }

    res.status(201).json({ success: true, uploaded, failed, total: uploaded.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/gcr/images/assign — assign a gallery image to a specific item
// This is how you pick from the gallery to set as hero, logo, or attach to a menu item
// Body: { photo_id, slug, assign_to, item_id }
//   assign_to: "hero" | "logo" | "menu-item" | "drink-item" | "hh-item" |
//              "event" | "special" | "section-item"
//   item_id: required for menu-item, drink-item, etc.
router.post('/gcr/images/assign', authRequired, async (req, res) => {
  try {
    const { photo_id, slug, assign_to, item_id } = req.body;
    if (!photo_id || !slug || !assign_to) return res.status(400).json({ error: 'photo_id, slug, assign_to required' });

    const db = getDb();

    // Get the photo URL from gallery
    const { data: photo, error: photoErr } = await db.from('entity_photos').select('url, image_path').eq('id', photo_id).single();
    if (photoErr || !photo) return res.status(404).json({ error: 'Photo not found' });

    const { url, image_path } = photo;

    if (assign_to === 'hero') {
      await db.from('entity').update({ hero_image_url: url, hero_image_path: image_path }).eq('slug', slug);
      // Mark this photo as cover in gallery
      await db.from('entity_photos').update({ is_cover: false }).eq('entity_slug', slug);
      await db.from('entity_photos').update({ is_cover: true }).eq('id', photo_id);

    } else if (assign_to === 'logo') {
      await db.from('entity').update({ logo_url: url, logo_image_path: image_path }).eq('slug', slug);

    } else if (IMAGE_TABLE_MAP[assign_to]) {
      if (!item_id) return res.status(400).json({ error: `item_id required for assign_to="${assign_to}"` });
      const { table } = IMAGE_TABLE_MAP[assign_to];
      // artists table uses image_url, all others use image_url too — consistent
      await db.from(table).update({ image_url: url, image_path }).eq('id', item_id);

    } else {
      return res.status(400).json({
        error: `Unknown assign_to value: "${assign_to}"`,
        valid_values: ['hero', 'logo', ...Object.keys(IMAGE_TABLE_MAP)],
      });
    }

    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/gcr/images — remove an image from storage + DB
router.delete('/gcr/images', authRequired, async (req, res) => {
  try {
    const { slug, photo_id, path, bucket = 'entity-photos' } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });

    const db = getDb();

    // Remove from storage
    await db.storage.from(bucket).remove([path]);

    // Remove from entity_photos if it's a gallery photo
    if (photo_id) {
      await db.from('entity_photos').delete().eq('id', photo_id);
    }

    // If it was the hero, clear it
    if (slug && path.includes('/hero.')) {
      await db.from('entity').update({ hero_image_url: null, hero_image_path: null }).eq('slug', slug);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/gcr/:slug/photos — get all photos for a business
router.get('/gcr/:slug/photos', authRequired, async (req, res) => {
  try {
    const { data, error } = await getDb()
      .from('entity_photos')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/gcr/photos/:id — update sort order, caption, or is_cover
router.patch('/gcr/photos/:id', authRequired, async (req, res) => {
  try {
    const { sort_order, caption, is_cover } = req.body;
    const updates = {};
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (caption !== undefined) updates.caption = caption;
    if (is_cover !== undefined) updates.is_cover = is_cover;

    const { error } = await getDb().from('entity_photos').update(updates).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GOOGLE PLACES IMPORT ─────────────────────────────────────────────────────
const { googlePlaceToEntity, googlePlacesToEntities } = require('../utils/google-places-import');
const { processBulkUpload } = require('../utils/upload-processor');

// POST /api/admin/gcr/import/google-places
// Pass raw Google Places API response directly — converts + saves everything
// Body: { places: [...] }  OR  { place: {...} }  (single or array)
router.post('/gcr/import/google-places', authRequired, async (req, res) => {
  try {
    const { place, places } = req.body;
    const list = places || (place ? [place] : null);
    if (!list?.length) return res.status(400).json({ error: 'place or places array required' });

    // Convert Google data → GCR format
    const converted = googlePlacesToEntities(list);
    const failed_conversion = converted.filter(c => c.error);
    const valid = converted.filter(c => !c.error);

    if (!valid.length) {
      return res.status(400).json({ error: 'No valid places to import', details: failed_conversion });
    }

    // Flag any that couldn't be auto-categorized — still import them but mark for review
    const needs_review = valid.filter(c => !c.entity.entity_type);
    needs_review.forEach(c => { c.entity.is_active = false; }); // hide until manually categorized

    // Save to DB
    const results = await processBulkUpload(getDb(), valid);

    res.status(201).json({
      imported: results.success.length,
      failed_import: results.failed,
      failed_conversion,
      needs_review: needs_review.map(c => ({ slug: c.entity.slug, name: c.entity.name, google_type: c.entity.primary_type })),
      warnings: results.warnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/gcr/import/google-places/preview
// Same as above but returns converted data WITHOUT saving — lets you review before committing
router.post('/gcr/import/google-places/preview', authRequired, async (req, res) => {
  try {
    const { place, places } = req.body;
    const list = places || (place ? [place] : null);
    if (!list?.length) return res.status(400).json({ error: 'place or places array required' });

    const converted = googlePlacesToEntities(list);
    res.json({
      preview: converted,
      total: converted.length,
      categorized: converted.filter(c => c.entity?.entity_type).length,
      needs_review: converted.filter(c => !c.entity?.entity_type).length,
      errors: converted.filter(c => c.error).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
