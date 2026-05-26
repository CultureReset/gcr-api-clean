// Menu Editor — PIN-protected, accessible via URL link
// URL: /menu-editor.html?slug=restaurant-slug
// Auth: POST /api/menu-editor/:slug/auth with { pin }

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// ─── PIN AUTH ─────────────────────────────────────────────────────────────────
// Verify PIN against entity.menu_pin
// Returns session token (just the slug + pin hash for simplicity)

function makeToken(slug, pin) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(`${slug}:${pin}:${process.env.GCR_SUPABASE_SERVICE_KEY}`).digest('hex').slice(0, 32);
}

async function pinAuth(req, res, next) {
  const slug = req.params.slug;
  const token = req.headers['x-menu-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token required' });

  // Fetch entity and verify token matches slug+pin combo
  const { data: entity } = await db.from('entity').select('slug, menu_pin').eq('slug', slug).single();
  if (!entity) return res.status(404).json({ error: 'Not found' });
  if (!entity.menu_pin) return res.status(403).json({ error: 'Menu editing not enabled for this business' });

  const expected = makeToken(slug, entity.menu_pin);
  if (token !== expected) return res.status(401).json({ error: 'Invalid token' });

  req.entitySlug = slug;
  next();
}

// ─── POST /api/menu-editor/:slug/auth ─────────────────────────────────────────
// Body: { pin }
// Returns: { token, slug, name }
router.post('/:slug/auth', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  const { data: entity } = await db.from('entity').select('slug, name, menu_pin, hero_image_url').eq('slug', req.params.slug).single();
  if (!entity) return res.status(404).json({ error: 'Business not found' });
  if (!entity.menu_pin) return res.status(403).json({ error: 'Menu editing not enabled' });
  if (String(entity.menu_pin) !== String(pin)) return res.status(401).json({ error: 'Incorrect PIN' });

  const token = makeToken(entity.slug, entity.menu_pin);
  res.json({ token, slug: entity.slug, name: entity.name, hero_image_url: entity.hero_image_url });
});

// ─── GET /api/menu-editor/:slug/data ──────────────────────────────────────────
// Load all menu data for the editor
router.get('/:slug/data', pinAuth, async (req, res) => {
  const slug = req.entitySlug;

  const { data: entity } = await db.from('entity').select('id, slug, name, description, hero_image_url, phone, website_url, hh_days, hh_start, hh_end, hh_description').eq('slug', slug).single();
  if (!entity) return res.status(404).json({ error: 'Not found' });

  const [menuSections, drinkSections, hhSections, specials, events, hours] = await Promise.all([
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
  ]);

  const sectionIds = [
    ...(menuSections.data || []).map(s => s.id),
    ...(drinkSections.data || []).map(s => s.id),
    ...(hhSections.data || []).map(s => s.id),
  ];

  const [menuItems, drinkItems, hhItems] = await Promise.all([
    (menuSections.data || []).length ? db.from('menu_items').select('*').in('section_id', (menuSections.data || []).map(s => s.id)).order('id') : { data: [] },
    (drinkSections.data || []).length ? db.from('drink_items').select('*').in('section_id', (drinkSections.data || []).map(s => s.id)).order('id') : { data: [] },
    (hhSections.data || []).length ? db.from('happy_hour_items').select('*').in('section_id', (hhSections.data || []).map(s => s.id)).order('id') : { data: [] },
  ]);

  res.json({
    entity,
    hours: hours.data || [],
    menu_sections: (menuSections.data || []).map(s => ({ ...s, items: (menuItems.data || []).filter(i => i.section_id === s.id) })),
    drink_sections: (drinkSections.data || []).map(s => ({ ...s, items: (drinkItems.data || []).filter(i => i.section_id === s.id) })),
    happy_hour_sections: (hhSections.data || []).map(s => ({ ...s, items: (hhItems.data || []).filter(i => i.section_id === s.id) })),
    specials: specials.data || [],
    events: events.data || [],
  });
});

// ─── MENU SECTIONS ────────────────────────────────────────────────────────────

router.post('/:slug/menu-sections', pinAuth, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('menu_sections').insert({ entity_slug: req.entitySlug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:slug/menu-sections/:id', pinAuth, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('menu_sections').update({ section_name, sort_order }).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:slug/menu-sections/:id', pinAuth, async (req, res) => {
  await db.from('menu_items').delete().eq('section_id', req.params.id);
  const { error } = await db.from('menu_sections').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── MENU ITEMS ───────────────────────────────────────────────────────────────

router.post('/:slug/menu-items', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url } = req.body;
  const { data, error } = await db.from('menu_items').insert({ entity_slug: req.entitySlug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, tags: tags || null, image_url: image_url || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:slug/menu-items/:id', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url } = req.body;
  const { data, error } = await db.from('menu_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, tags: tags || null, image_url: image_url || null }).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:slug/menu-items/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('menu_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── DRINK SECTIONS + ITEMS ───────────────────────────────────────────────────

router.post('/:slug/drink-sections', pinAuth, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('drink_sections').insert({ entity_slug: req.entitySlug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/:slug/drink-sections/:id', pinAuth, async (req, res) => {
  await db.from('drink_items').delete().eq('section_id', req.params.id);
  const { error } = await db.from('drink_sections').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/:slug/drink-items', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, image_url } = req.body;
  const { data, error } = await db.from('drink_items').insert({ entity_slug: req.entitySlug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, image_url: image_url || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:slug/drink-items/:id', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, image_url } = req.body;
  const { data, error } = await db.from('drink_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, image_url: image_url || null }).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:slug/drink-items/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('drink_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── HAPPY HOUR ───────────────────────────────────────────────────────────────

router.put('/:slug/happy-hour', pinAuth, async (req, res) => {
  const { hh_days, hh_start, hh_end, hh_description } = req.body;
  const { error } = await db.from('entity').update({ hh_days, hh_start, hh_end, hh_description, updated_at: new Date().toISOString() }).eq('slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/:slug/hh-sections', pinAuth, async (req, res) => {
  const { section_name, sort_order } = req.body;
  const { data, error } = await db.from('happy_hour_sections').insert({ entity_slug: req.entitySlug, section_name, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/:slug/hh-sections/:id', pinAuth, async (req, res) => {
  await db.from('happy_hour_items').delete().eq('section_id', req.params.id);
  const { error } = await db.from('happy_hour_sections').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

router.post('/:slug/hh-items', pinAuth, async (req, res) => {
  const { item_name, description, price, original_price, section_id, image_url } = req.body;
  const { data, error } = await db.from('happy_hour_items').insert({ entity_slug: req.entitySlug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:slug/hh-items/:id', pinAuth, async (req, res) => {
  const { item_name, description, price, original_price, image_url } = req.body;
  const { data, error } = await db.from('happy_hour_items').update({ item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null }).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:slug/hh-items/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('happy_hour_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SPECIALS ─────────────────────────────────────────────────────────────────

router.post('/:slug/specials', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_specials').insert({ entity_slug: req.entitySlug, ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:slug/specials/:id', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_specials').update(req.body).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:slug/specials/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('entity_specials').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────

router.post('/:slug/events', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_events').insert({ entity_slug: req.entitySlug, ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:slug/events/:id', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_events').update(req.body).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:slug/events/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('entity_events').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────────────

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const TABLE_MAP = {
  'menu-item':  'menu_items',
  'drink-item': 'drink_items',
  'hh-item':    'happy_hour_items',
  'event':      'entity_events',
  'special':    'entity_specials',
  'hero':       null, // saved on entity itself
};

router.post('/:slug/upload', pinAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file' });

  const slug = req.entitySlug;
  const type = req.body.type || 'menu-item'; // menu-item | drink-item | hh-item | event | special | hero
  const itemId = req.body.item_id || null;
  const folder = type === 'hero' ? `entities/${slug}` : `${type}s/${itemId || slug}`;
  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const storagePath = `${folder}/${Date.now()}.${ext}`;

  const { error: upErr } = await db.storage.from('media').upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (upErr) return res.status(500).json({ error: upErr.message });

  const { data: { publicUrl } } = db.storage.from('media').getPublicUrl(storagePath);

  // Save url + path directly to the correct DB row
  const table = TABLE_MAP[type];
  if (table && itemId) {
    await db.from(table).update({ image_url: publicUrl, image_path: storagePath }).eq('id', itemId).eq('entity_slug', slug);
  } else if (type === 'hero') {
    await db.from('entity').update({ hero_image_url: publicUrl, hero_image_path: storagePath }).eq('slug', slug);
  }

  res.json({ success: true, url: publicUrl, path: storagePath });
});

// ─── QR MENU (public read — no PIN) ──────────────────────────────────────────
// GET /api/menu-editor/:slug/qr-menu
// Used by QR code scan → display the full menu publicly

router.get('/:slug/qr-menu', async (req, res) => {
  const slug = req.params.slug;

  const { data: entity } = await db.from('entity').select('slug, name, description, hero_image_url, phone, website_url, address_line_1, city, state, hh_days, hh_start, hh_end, hh_description').eq('slug', slug).eq('is_active', true).single();
  if (!entity) return res.status(404).json({ error: 'Not found' });

  const [menuSections, drinkSections, hhSections, specials, events, hours] = await Promise.all([
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
  ]);

  const [menuItems, drinkItems, hhItems] = await Promise.all([
    (menuSections.data || []).length ? db.from('menu_items').select('*').in('section_id', (menuSections.data || []).map(s => s.id)).order('id') : { data: [] },
    (drinkSections.data || []).length ? db.from('drink_items').select('*').in('section_id', (drinkSections.data || []).map(s => s.id)).order('id') : { data: [] },
    (hhSections.data || []).length ? db.from('happy_hour_items').select('*').in('section_id', (hhSections.data || []).map(s => s.id)).order('id') : { data: [] },
  ]);

  res.json({
    entity,
    hours: hours.data || [],
    menu_sections: (menuSections.data || []).map(s => ({ ...s, items: (menuItems.data || []).filter(i => i.section_id === s.id) })),
    drink_sections: (drinkSections.data || []).map(s => ({ ...s, items: (drinkItems.data || []).filter(i => i.section_id === s.id) })),
    happy_hour_sections: (hhSections.data || []).map(s => ({ ...s, items: (hhItems.data || []).filter(i => i.section_id === s.id) })),
    specials: specials.data || [],
    events: events.data || [],
  });
});

module.exports = router;
