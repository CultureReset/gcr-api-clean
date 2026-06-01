const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

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
    const { data: admin, error } = await db
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
  const { data, error } = await db.from('entity').select('id, slug, name, entity_subtype, city, is_active, featured, hero_image_url, rating').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/admin/gcr/entities — create new entity
router.post('/gcr/entities', authRequired, async (req, res) => {
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
router.get('/gcr/entities/:slug', async (req, res) => {
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
router.put('/gcr/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { entity } = req.body;
  const { error } = await db.from('entity').update({ ...entity, updated_at: new Date().toISOString() }).eq('slug', slug);
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
router.delete('/gcr/entities/:slug', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { error } = await db.from('entity').delete().eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

// ─── HOURS ────────────────────────────────────────────────────────────────────

router.put('/gcr/entities/:slug/hours', authRequired, async (req, res) => {
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

router.post('/gcr/entities/:slug/menu-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('menu_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/menu-sections/:id', authRequired, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('menu_sections').update({ section_name, sort_order }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/menu-sections/:id', authRequired, async (req, res) => {
  const { error } = await db.from('menu_sections').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/gcr/entities/:slug/menu-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, section_id, tags, image_url, image_path } = req.body;
  const { data, error } = await db.from('menu_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, tags: tags || null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/menu-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url, image_path } = req.body;
  const { data, error } = await db.from('menu_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, tags: tags || null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/menu-items/:id', authRequired, async (req, res) => {
  const { error } = await db.from('menu_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── DRINK SECTIONS + ITEMS ───────────────────────────────────────────────────

router.post('/gcr/entities/:slug/drink-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('drink_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.post('/gcr/entities/:slug/drink-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, section_id, image_url, image_path } = req.body;
  const { data, error } = await db.from('drink_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/drink-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, image_url, image_path } = req.body;
  const { data, error } = await db.from('drink_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/drink-items/:id', authRequired, async (req, res) => {
  const { error } = await db.from('drink_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── HAPPY HOUR ───────────────────────────────────────────────────────────────

router.put('/gcr/entities/:slug/happy-hour', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { hh_days, hh_start, hh_end, hh_description } = req.body;
  const { error } = await db.from('entity').update({ hh_days, hh_start, hh_end, hh_description, updated_at: new Date().toISOString() }).eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.json({ success: true });
});

router.post('/gcr/entities/:slug/hh-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('happy_hour_sections').insert({ entity_slug: slug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.post('/gcr/entities/:slug/hh-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { item_name, description, price, original_price, section_id, image_url, image_path } = req.body;
  const { data, error } = await db.from('happy_hour_items').insert({ entity_slug: slug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, image_path: image_path || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/hh-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, original_price, image_url, image_path } = req.body;
  const { data, error } = await db.from('happy_hour_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, image_path: image_path || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/hh-items/:id', authRequired, async (req, res) => {
  const { error } = await db.from('happy_hour_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────

router.post('/gcr/events', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_events').insert({ ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/gcr/events/:id', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_events').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/events/:id', authRequired, async (req, res) => {
  const { error } = await db.from('entity_events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SPECIALS ─────────────────────────────────────────────────────────────────

router.post('/gcr/specials', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_specials').insert({ ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/gcr/specials/:id', authRequired, async (req, res) => {
  const { data, error } = await db.from('entity_specials').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/specials/:id', authRequired, async (req, res) => {
  const { error } = await db.from('entity_specials').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── PHOTOS ───────────────────────────────────────────────────────────────────

router.post('/gcr/entities/:slug/photos', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { url, image_path, is_cover, sort_order, caption } = req.body;
  const { data, error } = await db.from('entity_photos').insert({ entity_slug: slug, url, image_path: image_path || null, is_cover: !!is_cover, sort_order: sort_order || 0, caption: caption || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.delete('/gcr/photos/:id', authRequired, async (req, res) => {
  const { error } = await db.from('entity_photos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── BULK IMPORT ──────────────────────────────────────────────────────────────

router.post('/gcr/import-entity', authRequired, async (req, res) => {
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

router.post('/gcr/import-menu', authRequired, async (req, res) => {
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

router.post('/gcr/import-drinks', authRequired, async (req, res) => {
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

router.post('/gcr/import-happyhour', authRequired, async (req, res) => {
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

router.post('/gcr/import-events', authRequired, async (req, res) => {
  const { entity_slug, events } = req.body;
  if (!entity_slug || !events?.length) return res.status(400).json({ error: 'entity_slug and events required' });
  const rows = events.map(e => ({ entity_slug, entity_name: e.entity_name || null, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, cover_charge: e.cover_charge || null, is_active: true, image_url: e.image_url || null }));
  const { error } = await db.from('entity_events').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

router.post('/gcr/import-specials', authRequired, async (req, res) => {
  const { entity_slug, specials } = req.body;
  if (!entity_slug || !specials?.length) return res.status(400).json({ error: 'entity_slug and specials required' });
  const rows = specials.map(s => ({ entity_slug, entity_name: s.entity_name || null, special_name: s.special_name || s.name, description: s.description || null, discount_type: s.discount_type || null, discount_value: s.discount_value || null, discount_text: s.discount_text || null, days: s.days || null, day_of_week: s.day_of_week || null, start_time: s.start_time || null, end_time: s.end_time || null, is_active: true, image_url: s.image_url || null }));
  const { error } = await db.from('entity_specials').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

router.post('/gcr/import-photos', authRequired, async (req, res) => {
  const { entity_slug, photos } = req.body;
  if (!entity_slug || !photos?.length) return res.status(400).json({ error: 'entity_slug and photos required' });
  const rows = photos.map((p, i) => ({ entity_slug, url: p.url, image_path: p.image_path || null, is_cover: !!p.is_cover, sort_order: p.sort_order ?? i, caption: p.caption || null }));
  const { error } = await db.from('entity_photos').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: rows.length });
});

// import-master — import everything for one entity at once
router.post('/gcr/import-master', authRequired, async (req, res) => {
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

// ─── TRIP SWIPE: TOURISTS ─────────────────────────────────────────────────────

// GET /api/admin/tourists — list all tourists with summary stats
router.get('/tourists', authRequired, async (req, res) => {
  try {
    const { data: profiles, error } = await db.from('tourist_profiles')
      .select('user_id, email, name, phone, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch summary stats for each tourist
    const tourists = await Promise.all((profiles || []).map(async (p) => {
      const [saves, swipes, itinerary] = await Promise.all([
        db.from('tourist_saves').select('id', { count: 'exact', head: true }).eq('user_id', p.user_id),
        db.from('tourist_swipe_events').select('id', { count: 'exact', head: true }).eq('user_id', p.user_id),
        db.from('tourist_itineraries').select('*').eq('user_id', p.user_id).maybeSingle()
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
      db.from('tourist_profiles').select('*').eq('user_id', uid).maybeSingle(),
      db.from('tourist_saves').select('*').eq('user_id', uid).order('saved_at', { ascending: false }),
      db.from('tourist_itineraries').select('*').eq('user_id', uid).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('tourist_swipe_events').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(100)
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
    const { data: prefs, error } = await db.from('user_preference_scores')
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
      db.from('tourist_saves').delete().eq('user_id', uid),
      db.from('tourist_swipe_events').delete().eq('user_id', uid),
      db.from('tourist_itineraries').delete().eq('user_id', uid),
      db.from('user_preference_scores').delete().eq('tourist_id', uid),
      db.from('tourist_profiles').delete().eq('user_id', uid)
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

    const { data: events, error } = await db.from('tourist_swipe_events')
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
    const { data: sponsored, error } = await db.from('tripswipe_sponsored')
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

    const { data, error } = await db.from('tripswipe_sponsored').insert({
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
    const { data, error } = await db.from('tripswipe_sponsored')
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
    const { error } = await db.from('tripswipe_sponsored').delete().eq('id', req.params.id);
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
    const { data: cards, error } = await db.from('tripswipe_promo_cards')
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

    const { data, error } = await db.from('tripswipe_promo_cards').insert({
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
    const { data, error } = await db.from('tripswipe_promo_cards')
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
    const { error } = await db.from('tripswipe_promo_cards').delete().eq('id', req.params.id);
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
    const { data: settings, error } = await db.from('tripswipe_business_settings')
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
    const { data: setting, error } = await db.from('tripswipe_business_settings')
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
    const { data: existing } = await db.from('tripswipe_business_settings')
      .select('id')
      .eq('entity_slug', slug)
      .maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await db.from('tripswipe_business_settings')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('entity_slug', slug)
        .select('*')
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await db.from('tripswipe_business_settings').insert({
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
      db.from('tourist_profiles').select('id', { count: 'exact', head: true }).gte('created_at', since),
      db.from('tourist_saves').select('id', { count: 'exact', head: true }).gte('created_at', since),
      db.from('tourist_swipe_events').select('id', { count: 'exact', head: true }).gte('created_at', since),
      db.from('tourist_itineraries').select('id', { count: 'exact', head: true }).gte('created_at', since)
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

module.exports = router;
