const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
  const { data, error } = await getDb().from('entity').select('id, slug, name, entity_subtype, city, is_active, featured, hero_image_url, rating').order('name').limit(5000);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/admin/gcr/entities — create new entity
router.post('/gcr/entities', authRequired, async (req, res) => {
  const { entity, tags, hours } = req.body;
  if (!entity?.slug || !entity?.name) return res.status(400).json({ error: 'slug and name required' });

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

// POST /api/admin/gcr/events/backfill-types — infer and set event_type on all null events
router.post('/gcr/events/backfill-types', authRequired, async (req, res) => {
  const { data: events, error } = await getDb().from('entity_events').select('id,event_name,description').is('event_type', null);
  if (error) return res.status(500).json({ error: error.message });

  function infer(name, desc) {
    const s = ((name || '') + ' ' + (desc || '')).toLowerCase();
    if (s.includes('karaoke')) return 'karaoke';
    if (s.includes('trivia')) return 'trivia';
    if (s.includes('bingo')) return 'bingo';
    if (s.includes('open mic') || s.includes('open jam')) return 'open_mic';
    if (s.includes('drag')) return 'drag_show';
    if (s.includes('comedy')) return 'comedy';
    if (s.includes('dj ') || s.includes(' dj') || s.startsWith('dj')) return 'dj';
    if (s.includes('happy hour')) return 'happy_hour';
    if (s.includes('brunch')) return 'brunch_event';
    if (s.includes('wine') && s.includes('tast')) return 'wine_tasting';
    if (s.includes('beer') && s.includes('tast')) return 'beer_tasting';
    if (s.includes('kids') || s.includes('children') || s.includes('family')) return 'kids_event';
    if (s.includes('festival')) return 'festival';
    if (s.includes('tournament') || s.includes('competition')) return 'tournament';
    if (s.includes('fundrais') || s.includes('charity')) return 'fundraiser';
    if (s.includes('art show') || s.includes('art exhibit')) return 'art_show';
    if (s.includes('market') || s.includes('pop-up') || s.includes('popup')) return 'market';
    return 'live_music';
  }

  let updated = 0, errors = 0;
  for (const ev of events) {
    const type = infer(ev.event_name, ev.description);
    const { error: upErr } = await getDb().from('entity_events').update({ event_type: type }).eq('id', ev.id);
    if (upErr) errors++; else updated++;
  }
  res.json({ total: events.length, updated, errors });
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

// ─── TRIP SWIPE: TOURISTS ─────────────────────────────────────────────────────

// GET /api/admin/tourists — list all tourists with summary stats
router.get('/tourists', authRequired, async (req, res) => {
  try {
    const { data: profiles, error } = await getDb().from('tourist_profiles')
      .select('user_id, email, name, phone, destination, arrival, departure, setup_complete, sms_opt_in, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const tourists = await Promise.all((profiles || []).map(async (p) => {
      const [saves, swipes, itinerary] = await Promise.all([
        getDb().from('tourist_saves').select('id', { count: 'exact', head: true }).eq('user_id', p.user_id),
        getDb().from('tourist_swipe_events').select('id', { count: 'exact', head: true }).eq('user_id', p.user_id),
        getDb().from('tourist_itineraries').select('id').eq('user_id', p.user_id).limit(1).maybeSingle()
      ]);

      return {
        user_id: p.user_id,
        email: p.email,
        name: p.name,
        phone: p.phone,
        destination: p.destination,
        arrival: p.arrival,
        departure: p.departure,
        setup_complete: p.setup_complete,
        sms_opt_in: p.sms_opt_in,
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
    const [profile, saves, itinerary, swipesRight, swipesLeft, swipesSuper, seen] = await Promise.all([
      getDb().from('tourist_profiles').select('*').eq('user_id', uid).maybeSingle(),
      getDb().from('tourist_saves').select('*').eq('user_id', uid).order('saved_at', { ascending: false }),
      getDb().from('tourist_itineraries').select('*').eq('user_id', uid).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      getDb().from('tourist_swipe_events').select('entity_slug, category, swiped_at').eq('user_id', uid).eq('direction', 'right').order('swiped_at', { ascending: false }),
      getDb().from('tourist_swipe_events').select('entity_slug, category, swiped_at').eq('user_id', uid).eq('direction', 'left').order('swiped_at', { ascending: false }),
      getDb().from('tourist_swipe_events').select('entity_slug, category, swiped_at').eq('user_id', uid).eq('direction', 'super').order('swiped_at', { ascending: false }),
      getDb().from('tourist_seen').select('entity_slug, seen_at').eq('user_id', uid).order('seen_at', { ascending: false }),
    ]);

    const rightData  = swipesRight.data  || [];
    const leftData   = swipesLeft.data   || [];
    const superData  = swipesSuper.data  || [];
    const savesData  = saves.data        || [];
    const seenData   = seen.data         || [];

    res.json({
      profile:       profile.data   || null,
      itinerary:     itinerary.data || null,
      saves:         savesData,
      swiped_right:  rightData,
      swiped_left:   leftData,
      super_liked:   superData,
      seen:          seenData,
      summary: {
        saves_count:       savesData.length,
        swiped_right_count: rightData.length,
        swiped_left_count:  leftData.length,
        super_liked_count:  superData.length,
        seen_count:         seenData.length,
        like_rate: rightData.length + leftData.length > 0
          ? Math.round((rightData.length / (rightData.length + leftData.length)) * 100) + '%'
          : '—',
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/tourists/:user_id/preferences — get processed preference data
router.get('/tourists/:user_id/preferences', authRequired, async (req, res) => {
  try {
    const uid = req.params.user_id;

    const [{ data: prefs }, { data: swipeStats }, { data: saves }, { data: swipedRight }] = await Promise.all([
      getDb().from('user_preference_scores').select('tag, score').eq('tourist_id', uid).order('score', { ascending: false }),
      getDb().from('tourist_swipe_events').select('direction').eq('user_id', uid),
      getDb().from('tourist_saves').select('entity_slug, business_name, category, hero_image_url, is_super_like, saved_at').eq('user_id', uid).order('saved_at', { ascending: false }),
      getDb().from('tourist_swipe_events').select('entity_slug, category, swiped_at').eq('user_id', uid).eq('direction', 'right').order('swiped_at', { ascending: false }),
    ]);

    const scores = prefs || [];
    const loves = scores.filter(p => p.score >= 20);
    const likes = scores.filter(p => p.score >= 1 && p.score < 20);
    const dislikes = scores.filter(p => p.score < 0);

    const swipeArr = swipeStats || [];
    const swipe_counts = {
      like:  swipeArr.filter(s => s.direction === 'right').length,
      nope:  swipeArr.filter(s => s.direction === 'left').length,
      super: swipeArr.filter(s => s.direction === 'super').length,
    };

    res.json({
      loves, likes, dislikes,
      top_tags: scores.slice(0, 10).map(p => p.tag),
      total_tags: scores.length,
      swipe_counts,
      saves: saves || [],
      swiped_right: swipedRight || [],
    });
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

// GET /api/admin/tripswipe/sponsored — list sponsored businesses (public read so Trip Swipe can load without auth)
router.get('/tripswipe/sponsored', async (req, res) => {
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

// GET /api/admin/tripswipe/promo-cards — list promo cards (public read so Trip Swipe can load without auth)
router.get('/tripswipe/promo-cards', async (req, res) => {
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

// GET /api/admin/tripswipe/settings — get Trip Swipe business settings (public read so Trip Swipe can load without auth)
router.get('/tripswipe/settings', async (req, res) => {
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

// GET /api/admin/tripswipe/settings/:slug — get Trip Swipe setting for one business (public read)
router.get('/tripswipe/settings/:slug', async (req, res) => {
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

// POST /api/admin/gcr/upload-image — upload image file to Supabase storage
router.post('/gcr/upload-image', authRequired, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const { entity_slug, is_cover } = req.body;
  const ext = req.file.originalname.split('.').pop() || 'jpg';
  const fileName = `${entity_slug || 'general'}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error: upErr } = await getDb().storage.from('entity-media').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (upErr) return res.status(500).json({ error: upErr.message });
  const { data: { publicUrl } } = getDb().storage.from('entity-media').getPublicUrl(fileName);
  if (entity_slug) {
    const { data: existing } = await getDb().from('entity_photos').select('id').eq('entity_slug', entity_slug).order('sort_order', { ascending: false }).limit(1);
    const nextOrder = existing?.length ? (existing[0].sort_order || 0) + 1 : 0;
    await getDb().from('entity_photos').insert({ entity_slug, url: publicUrl, image_path: fileName, is_cover: is_cover === 'true', sort_order: nextOrder });
  }
  res.json({ url: publicUrl, path: fileName });
});

// ─── ARTISTS ─────────────────────────────────────────────────────────────────

// GET /api/admin/artists — list all artists
router.get('/artists', authRequired, async (req, res) => {
  const { search } = req.query;
  let q = getDb().from('artists').select('*').order('name', { ascending: true });
  if (search) q = q.ilike('name', `%${search}%`);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ artists: data || [] });
});

// GET /api/admin/artists/:id — single artist
router.get('/artists/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('artists').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Artist not found' });
  res.json(data);
});

// PUT /api/admin/artists/:id — update artist fields
router.put('/artists/:id', authRequired, async (req, res) => {
  const allowed = ['name', 'bio', 'genre', 'hometown', 'image_url', 'website_url', 'spotify_url', 'social_instagram', 'social_facebook', 'social_tiktok'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();
  const { data, error } = await getDb().from('artists').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/admin/artists/:id/photo — upload artist photo
router.post('/artists/:id/photo', authRequired, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const ext = req.file.originalname.split('.').pop() || 'jpg';
  const fileName = `artists/${req.params.id}-${Date.now()}.${ext}`;
  const { error: upErr } = await getDb().storage.from('entity-media').upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (upErr) return res.status(500).json({ error: upErr.message });
  const { data: { publicUrl } } = getDb().storage.from('entity-media').getPublicUrl(fileName);
  await getDb().from('artists').update({ image_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ url: publicUrl });
});

// ─── SMS BLAST (manual, admin-triggered) ─────────────────────────────────────

// POST /api/admin/sms-blast — send custom SMS to tourists filtered by:
//   in_town_only: true/false  — only tourists whose visit dates include today
//   tags: []                  — preference tags they love/like
//   min_score: number         — minimum preference score (default 0)
//   match_type: 'any'|'all'   — OR vs AND for tag matching
//   swiped_right: []          — entity slugs they swiped right on
//   saved: []                 — entity slugs they saved / super-liked
//   category: string          — category they've engaged with (restaurant, activity, etc.)
router.post('/sms-blast', authRequired, async (req, res) => {
  const {
    message,
    in_town_only = true,
    tags = [],
    min_score = 0,
    match_type = 'any',
    swiped_right = [],
    saved = [],
    category = null,
  } = req.body || {};

  if (!message) return res.status(400).json({ error: 'message required' });

  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const from   = process.env.TWILIO_PHONE_NUMBER || '+12513135464';
  const today  = new Date().toISOString().slice(0, 10);
  const db     = getDb();

  try {
    // Step 1 — start with all opted-in tourists who have a phone
    let baseQuery = db
      .from('tourist_profiles')
      .select('id, phone, name, arrival, departure')
      .eq('sms_opt_in', true)
      .not('phone', 'is', null);

    if (in_town_only) {
      baseQuery = baseQuery.lte('arrival', today).gte('departure', today);
    }

    const { data: allTourists, error: baseErr } = await baseQuery;
    if (baseErr) throw baseErr;
    if (!allTourists?.length) return res.json({ sent: 0, total: 0, message: 'No tourists match base filters' });

    let eligible = new Set(allTourists.map(t => t.id));

    // Step 2 — filter by preference tags
    if (tags.length > 0) {
      const { data: scores } = await db
        .from('user_preference_scores')
        .select('tourist_id, tag, score')
        .in('tag', tags.map(t => t.toLowerCase().trim()))
        .gte('score', min_score);

      if (scores?.length) {
        const byTourist = {};
        scores.forEach(s => {
          if (!byTourist[s.tourist_id]) byTourist[s.tourist_id] = new Set();
          byTourist[s.tourist_id].add(s.tag.toLowerCase().trim());
        });

        const tagSet = new Set(tags.map(t => t.toLowerCase().trim()));
        eligible = new Set([...eligible].filter(id => {
          const matched = byTourist[id] || new Set();
          if (match_type === 'all') return [...tagSet].every(t => matched.has(t));
          return [...tagSet].some(t => matched.has(t));
        }));
      } else {
        eligible = new Set(); // no matches
      }
    }

    // Step 3 — filter by swiped right on specific businesses
    if (swiped_right.length > 0) {
      const { data: swipes } = await db
        .from('tourist_swipe_events')
        .select('tourist_id, entity_slug')
        .in('entity_slug', swiped_right)
        .eq('direction', 'right');

      const swipers = new Set((swipes || []).map(s => s.tourist_id));
      eligible = new Set([...eligible].filter(id => swipers.has(id)));
    }

    // Step 4 — filter by saved businesses
    if (saved.length > 0) {
      const { data: saves } = await db
        .from('tourist_saves')
        .select('user_id, entity_slug')
        .in('entity_slug', saved);

      const savers = new Set((saves || []).map(s => s.user_id));
      eligible = new Set([...eligible].filter(id => savers.has(id)));
    }

    // Step 5 — filter by category engagement (swiped right OR saved in this category)
    if (category) {
      const [{ data: catSwipes }, { data: catSaves }] = await Promise.all([
        db.from('tourist_swipe_events').select('tourist_id').eq('category', category).eq('direction', 'right'),
        db.from('tourist_saves').select('user_id').eq('category', category),
      ]);
      const catEngaged = new Set([
        ...(catSwipes || []).map(s => s.tourist_id),
        ...(catSaves || []).map(s => s.user_id),
      ]);
      eligible = new Set([...eligible].filter(id => catEngaged.has(id)));
    }

    if (!eligible.size) return res.json({ sent: 0, total: 0, message: 'No tourists match all filters' });

    // Step 6 — get phones for eligible tourist IDs
    const eligibleTourists = allTourists.filter(t => eligible.has(t.id));

    // Step 7 — send via Twilio with small delay between messages
    let sent = 0;
    const errors = [];
    for (const t of eligibleTourists) {
      try {
        await client.messages.create({ from, to: t.phone, body: message });
        sent++;
        await new Promise(r => setTimeout(r, 80));
      } catch (e) {
        errors.push({ phone: t.phone, error: e.message });
      }
    }

    // Log the blast
    await db.from('sms_blast_log').insert({
      message,
      filters: { in_town_only, tags, min_score, match_type, swiped_right, saved, category },
      total_eligible: eligibleTourists.length,
      sent,
      sent_at: new Date().toISOString(),
      sent_by: req.adminEmail || 'admin',
    }).catch(() => {});

    res.json({ sent, total: eligibleTourists.length, errors: errors.length ? errors : undefined });

  } catch (e) {
    console.error('sms-blast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/sms-blasts — blast history
router.get('/sms-blasts', authRequired, async (req, res) => {
  try {
    const { data, error } = await getDb()
      .from('sms_blast_log')
      .select('*')
      .order('sent_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ blasts: data || [] });
  } catch (e) {
    res.status(500).json({ blasts: [] });
  }
});

// POST /api/admin/sms-blast/preview — count recipients without sending
router.post('/sms-blast/preview', authRequired, async (req, res) => {
  const {
    in_town_only = true,
    tags = [],
    min_score = 0,
    match_type = 'any',
    swiped_right = [],
    saved = [],
    category = null,
  } = req.body || {};

  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();

  try {
    let baseQuery = db
      .from('tourist_profiles')
      .select('id')
      .eq('sms_opt_in', true)
      .not('phone', 'is', null);

    if (in_town_only) baseQuery = baseQuery.lte('arrival', today).gte('departure', today);

    const { data: allTourists } = await baseQuery;
    if (!allTourists?.length) return res.json({ count: 0 });

    let eligible = new Set(allTourists.map(t => t.id));

    if (tags.length > 0) {
      const { data: scores } = await db
        .from('user_preference_scores')
        .select('tourist_id, tag, score')
        .in('tag', tags.map(t => t.toLowerCase().trim()))
        .gte('score', min_score);
      if (scores?.length) {
        const byTourist = {};
        scores.forEach(s => { if (!byTourist[s.tourist_id]) byTourist[s.tourist_id] = new Set(); byTourist[s.tourist_id].add(s.tag); });
        const tagSet = new Set(tags.map(t => t.toLowerCase().trim()));
        eligible = new Set([...eligible].filter(id => {
          const m = byTourist[id] || new Set();
          return match_type === 'all' ? [...tagSet].every(t => m.has(t)) : [...tagSet].some(t => m.has(t));
        }));
      } else eligible = new Set();
    }

    if (swiped_right.length > 0) {
      const { data: swipes } = await db.from('tourist_swipe_events').select('tourist_id').in('entity_slug', swiped_right).eq('direction', 'right');
      const s = new Set((swipes || []).map(s => s.tourist_id));
      eligible = new Set([...eligible].filter(id => s.has(id)));
    }

    if (saved.length > 0) {
      const { data: saves } = await db.from('tourist_saves').select('user_id').in('entity_slug', saved);
      const s = new Set((saves || []).map(s => s.user_id));
      eligible = new Set([...eligible].filter(id => s.has(id)));
    }

    if (category) {
      const [{ data: cs }, { data: cv }] = await Promise.all([
        db.from('tourist_swipe_events').select('tourist_id').eq('category', category).eq('direction', 'right'),
        db.from('tourist_saves').select('user_id').eq('category', category),
      ]);
      const ce = new Set([...(cs||[]).map(s=>s.tourist_id), ...(cv||[]).map(s=>s.user_id)]);
      eligible = new Set([...eligible].filter(id => ce.has(id)));
    }

    res.json({ count: eligible.size });
  } catch (e) {
    res.status(500).json({ count: 0, error: e.message });
  }
});

// ─── Trip Swipe hero button config (public) ───────────────────────────────────
router.get('/trip-swipe-button', async (req, res) => {
  res.json({ type: 'iframe', label: '🌊 Start Swiping', url: process.env.TRIP_SWIPE_URL || 'https://gcr-trip-swipe.vercel.app' });
});

// ─── Business claim leads ─────────────────────────────────────────────────────
router.get('/gcr/claims', authRequired, async (req, res) => {
  try {
    const { data, error } = await db.from('business_claims').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/gcr/claims/:id', authRequired, async (req, res) => {
  try {
    const { status, notes } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    const { error } = await db.from('business_claims').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Leads ────────────────────────────────────────────────────────────────────
router.get('/sales-leads', authRequired, async (req, res) => {
  try {
    const { source, status } = req.query;
    let query = db.from('leads').select('*').order('created_at', { ascending: false });
    if (source) query = query.eq('source', source);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/sales-leads/:id', authRequired, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    const { error } = await db.from('leads').update(updates).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
