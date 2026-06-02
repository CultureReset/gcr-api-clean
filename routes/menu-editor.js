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
  const adminToken = req.headers['x-admin-token'];
  const menuToken = req.headers['x-menu-token'] || req.query.token;

  // Admin bypass — if admin token is present, allow access
  if (adminToken) {
    req.entitySlug = slug;
    return next();
  }

  // Otherwise require PIN token
  if (!menuToken) return res.status(401).json({ error: 'Token required' });

  // Fetch entity and verify token matches slug+pin combo
  const { data: entity } = await db.from('entity').select('slug, menu_pin').eq('slug', slug).single();
  if (!entity) return res.status(404).json({ error: 'Not found' });
  if (!entity.menu_pin) return res.status(403).json({ error: 'Menu editing not enabled for this business' });

  const expected = makeToken(slug, entity.menu_pin);
  if (menuToken !== expected) return res.status(401).json({ error: 'Invalid token' });

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
  res.json({ success: true, token, slug: entity.slug, name: entity.name, hero_image_url: entity.hero_image_url });
});

// ─── GET /api/menu-editor/:slug/data ──────────────────────────────────────────
// Load all menu data for the editor
router.get('/:slug/data', pinAuth, async (req, res) => {
  const slug = req.entitySlug;

  // Try extended select (includes rotating_sections + theme if columns exist)
  let entity;
  const { data: entityFull, error: entitySelErr } = await db.from('entity')
    .select('id, slug, name, description, hero_image_url, phone, website_url, hh_days, hh_start, hh_end, hh_description, gallery_sections, rotating_sections, theme')
    .eq('slug', slug).single();
  if (entitySelErr && (entitySelErr.code === '42703' || (entitySelErr.message || '').includes('does not exist'))) {
    const { data } = await db.from('entity').select('id, slug, name, description, hero_image_url, phone, website_url, hh_days, hh_start, hh_end, hh_description, gallery_sections').eq('slug', slug).single();
    entity = data;
  } else {
    entity = entityFull;
  }
  if (!entity) return res.status(404).json({ error: 'Not found' });

  const [menuSections, drinkSections, hhSections, specials, events, hours, sides, dailyFeatures, photos] = await Promise.all([
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_sides').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_daily_features').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order'),
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
    sides: sides.data || [],
    daily_features: dailyFeatures.data || [],
    entity_photos: photos.data || [],
    gallery_sections: entity?.gallery_sections || [],
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
  'hero':       null,
  'gallery':    null,
};

router.post('/:slug/upload', pinAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file' });

  const slug = req.entitySlug;
  const type = req.body.type || 'menu-item';
  const itemId = req.body.item_id || null;
  const label = req.body.label || '';

  let folder;
  if (type === 'hero' || type === 'gallery') {
    folder = `entities/${slug}/gallery`;
  } else {
    folder = `${type}s/${itemId || slug}`;
  }

  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const storagePath = `${folder}/${Date.now()}.${ext}`;
  const bucket = (type === 'hero' || type === 'gallery') ? 'entity-photos' : 'menu-items';

  const { error: upErr } = await db.storage.from(bucket).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (upErr) return res.status(500).json({ error: upErr.message });

  const { data: { publicUrl } } = db.storage.from(bucket).getPublicUrl(storagePath);

  if (type === 'gallery') {
    const { data: existing } = await db.from('entity_photos').select('sort_order').eq('entity_slug', slug).order('sort_order', { ascending: false }).limit(1).single();
    const nextOrder = existing ? (existing.sort_order + 1) : 0;
    await db.from('entity_photos').insert({ entity_slug: slug, url: publicUrl, image_path: storagePath, is_cover: nextOrder === 0, sort_order: nextOrder, caption: label || null });
  } else if (type === 'hero') {
    await db.from('entity').update({ hero_image_url: publicUrl, hero_image_path: storagePath }).eq('slug', slug);
  } else {
    const table = TABLE_MAP[type];
    if (table && itemId) {
      await db.from(table).update({ image_url: publicUrl, image_path: storagePath }).eq('id', itemId).eq('entity_slug', slug);
    }
  }

  res.json({ success: true, url: publicUrl, path: storagePath });
});

// ─── BULK SAVE ────────────────────────────────────────────────────────────────
// POST /api/menu-editor/:slug/save
// Receives full dashboard payload and saves to DB
// Handles base64 image uploads to Supabase Storage

async function uploadBase64Image(slug, itemId, itemType, base64Str) {
  if (!base64Str || !base64Str.startsWith('data:')) return null;

  try {
    const matches = base64Str.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return null;

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = mimeType.split('/')[1] || 'jpg';
    const folder = itemType === 'hero' ? `entities/${slug}` : `${itemType}s/${itemId || slug}`;
    const storagePath = `${folder}/${Date.now()}.${ext}`;
    const bucket = (itemType === 'hero' || itemType === 'gallery') ? 'entity-photos' : 'menu-items';

    const { error: upErr } = await db.storage.from(bucket).upload(storagePath, buffer, { contentType: mimeType, upsert: true });
    if (upErr) {
      console.error('Image upload error:', upErr);
      return null;
    }

    const { data: { publicUrl } } = db.storage.from(bucket).getPublicUrl(storagePath);
    return { url: publicUrl, path: storagePath };
  } catch (err) {
    console.error('Base64 upload error:', err);
    return null;
  }
}

router.post('/:slug/save', pinAuth, async (req, res) => {
  const slug = req.entitySlug;
  const { business, gallery = [], gallery_sections = [], sides = [], dailyFeatures = [], areas = [], happyHour = [], rotatingSections = [], theme = {} } = req.body;

  if (!business || !business.name) return res.status(400).json({ error: 'Business name required' });

  try {
    // 1. Update entity (business info)
    const updateData = {
      name: business.name,
      subtitle: business.tagline || null,
      description: business.about || null,
      phone: business.phone || null,
      website_url: business.website || null,
      address_line_1: business.address || null,
      updated_at: new Date().toISOString(),
    };

    if (gallery_sections && gallery_sections.length > 0) {
      updateData.gallery_sections = gallery_sections;
    }

    // Try to save rotating_sections + theme (requires column to exist)
    const extendedData = { ...updateData };
    if (rotatingSections && rotatingSections.length > 0) extendedData.rotating_sections = rotatingSections;
    if (theme && Object.keys(theme).length > 0) extendedData.theme = theme;

    const { error: entityErr } = await db.from('entity').update(extendedData).eq('slug', slug);
    if (entityErr && (entityErr.code === '42703' || (entityErr.message || '').includes('does not exist'))) {
      // Columns not yet added — fall back to basic update
      const { error: e2 } = await db.from('entity').update(updateData).eq('slug', slug);
      if (e2) return res.status(500).json({ error: 'Entity update failed: ' + e2.message });
    } else if (entityErr) {
      return res.status(500).json({ error: 'Entity update failed: ' + entityErr.message });
    }

    // 2. Handle gallery images
    if (gallery.length > 0) {
      await db.from('entity_photos').delete().eq('entity_slug', slug);
      for (let i = 0; i < gallery.length; i++) {
        const img = gallery[i];
        let imageUrl = img.url;

        // Upload base64 if present
        if (img.url && img.url.startsWith('data:')) {
          const uploaded = await uploadBase64Image(slug, null, 'hero', img.url);
          if (uploaded) imageUrl = uploaded.url;
        }

        await db.from('entity_photos').insert({
          entity_slug: slug,
          url: imageUrl,
          is_cover: i === 0,
          sort_order: i,
          caption: img.label || null,
        });
      }
    }

    // 3. Process areas (sections, items, hours, etc.)
    const dayMap = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };

    for (const area of areas) {
      // 3a. Hours
      if (area.hours) {
        await db.from('entity_hours').delete().eq('entity_slug', slug);
        for (const [day, times] of Object.entries(area.hours)) {
          await db.from('entity_hours').insert({
            entity_slug: slug,
            day_of_week: dayMap[day.toLowerCase()] ?? 0,
            opens_at: times?.open || null,
            closes_at: times?.close || null,
            is_closed: times?.closed ?? false,
          });
        }
      }

      // 3b. Menu sections & items
      if (area.menu_sections && area.menu_sections.length > 0) {
        console.log(`Saving ${area.menu_sections.length} menu sections`);
        await db.from('menu_sections').delete().eq('entity_slug', slug);

        for (let i = 0; i < area.menu_sections.length; i++) {
          const sec = area.menu_sections[i];
          const sectionName = sec.name || sec.section_name;
          console.log(`Section ${i}: name="${sectionName}", hasItems=${sec.items?.length || 0}`);
          const { data: inserted } = await db.from('menu_sections').insert({
            entity_slug: slug,
            section_name: sectionName,
            sort_order: i,
          }).select().single();

          if (inserted && sec.items) {
            for (let j = 0; j < sec.items.length; j++) {
              const item = sec.items[j];
              const itemName = item.name || item.item_name;
              let imageUrl = item.image_url || item.image_path || (item.images && item.images[0]?.url);

              if (imageUrl && imageUrl.startsWith('data:')) {
                const uploaded = await uploadBase64Image(slug, inserted.id, 'menu-item', imageUrl);
                if (uploaded) imageUrl = uploaded.url;
              }

              await db.from('menu_items').insert({
                entity_slug: slug,
                section_id: inserted.id,
                item_name: itemName,
                description: item.description || null,
                price: item.price ? parseFloat(item.price) : null,
                image_url: imageUrl || null,
              });
            }
          }
        }
      }

      // 3c. Drink sections & items
      if (area.drink_sections && area.drink_sections.length > 0) {
        await db.from('drink_sections').delete().eq('entity_slug', slug);

        for (let i = 0; i < area.drink_sections.length; i++) {
          const sec = area.drink_sections[i];
          const sectionName = sec.name || sec.section_name;
          const { data: inserted } = await db.from('drink_sections').insert({
            entity_slug: slug,
            section_name: sectionName,
            sort_order: i,
          }).select().single();

          if (inserted && sec.items) {
            for (const item of sec.items) {
              const itemName = item.name || item.item_name;
              let imageUrl = item.image_url || item.image_path || (item.images && item.images[0]?.url);

              if (imageUrl && imageUrl.startsWith('data:')) {
                const uploaded = await uploadBase64Image(slug, inserted.id, 'drink-item', imageUrl);
                if (uploaded) imageUrl = uploaded.url;
              }

              await db.from('drink_items').insert({
                entity_slug: slug,
                section_id: inserted.id,
                item_name: itemName,
                description: item.description || null,
                price: item.price ? parseFloat(item.price) : null,
                image_url: imageUrl || null,
              });
            }
          }
        }
      }

      // 3d. Specials
      if (area.specials && area.specials.length > 0) {
        await db.from('entity_specials').delete().eq('entity_slug', slug);

        for (const spec of area.specials) {
          let imageUrl = spec.image_url || (spec.images && spec.images[0]?.url);

          if (imageUrl && imageUrl.startsWith('data:')) {
            const uploaded = await uploadBase64Image(slug, spec.id, 'special', imageUrl);
            if (uploaded) imageUrl = uploaded.url;
          }

          await db.from('entity_specials').insert({
            entity_slug: slug,
            special_name: spec.name,
            description: spec.description || null,
            discount_text: spec.discount_text || null,
            is_active: spec.active ?? true,
            image_url: imageUrl || null,
          });
        }
      }

      // 3e. Events
      if (area.events && area.events.length > 0) {
        await db.from('entity_events').delete().eq('entity_slug', slug);

        for (const evt of area.events) {
          let imageUrl = evt.image_url || (evt.images && evt.images[0]?.url);

          if (imageUrl && imageUrl.startsWith('data:')) {
            const uploaded = await uploadBase64Image(slug, evt.id, 'event', imageUrl);
            if (uploaded) imageUrl = uploaded.url;
          }

          await db.from('entity_events').insert({
            entity_slug: slug,
            event_name: evt.name,
            description: evt.description || null,
            event_date: evt.date || null,
            start_time: evt.time || null,
            is_active: evt.active ?? true,
            image_url: imageUrl || null,
          });
        }
      }
    }

    // 4. Sides + Add-ons (save all, not just first)
    if (sides && sides.length > 0) {
      await db.from('entity_sides').delete().eq('entity_slug', slug);
      for (let i = 0; i < sides.length; i++) {
        const side = sides[i];
        let imageUrl = side.image_url || (side.images && side.images[0]?.url);
        if (imageUrl && imageUrl.startsWith('data:')) {
          const uploaded = await uploadBase64Image(slug, null, 'side', imageUrl);
          if (uploaded) imageUrl = uploaded.url;
        }
        const sideData = {
          entity_slug: slug,
          side_name: side.name || null,
          description: side.description || null,
          price: side.price ? parseFloat(side.price) : null,
          image_url: imageUrl || null,
          is_active: side.active ?? true,
          sort_order: i,
        };
        // Try with item_type (requires ALTER TABLE if column missing)
        const { error: sideErr } = await db.from('entity_sides').insert({ ...sideData, item_type: side.type || 'side' });
        if (sideErr && (sideErr.code === '42703' || (sideErr.message || '').includes('does not exist'))) {
          await db.from('entity_sides').insert(sideData);
        } else if (sideErr) {
          console.error('Side insert error:', sideErr.message);
        }
      }
    }

    // 5. Daily Features
    if (dailyFeatures && dailyFeatures.length > 0) {
      await db.from('entity_daily_features').delete().eq('entity_slug', slug);
      const feature = dailyFeatures[0]; // Store single daily feature
      let imageUrl = feature.image_url || (feature.images && feature.images[0]?.url);

      if (imageUrl && imageUrl.startsWith('data:')) {
        const uploaded = await uploadBase64Image(slug, null, 'daily-feature', imageUrl);
        if (uploaded) imageUrl = uploaded.url;
      }

      await db.from('entity_daily_features').insert({
        entity_slug: slug,
        feature_name: feature.name || null,
        description: feature.description || null,
        price: feature.price ? parseFloat(feature.price) : null,
        image_url: imageUrl || null,
        is_active: feature.active ?? true,
      });
    }

    // 6. Happy Hour sections & items
    if (happyHour && happyHour.length > 0) {
      await db.from('happy_hour_sections').delete().eq('entity_slug', slug);

      for (let i = 0; i < happyHour.length; i++) {
        const sec = happyHour[i];
        const sectionName = sec.name || sec.section_name;
        const { data: inserted } = await db.from('happy_hour_sections').insert({
          entity_slug: slug,
          section_name: sectionName,
          sort_order: i,
        }).select().single();

        if (inserted && sec.items) {
          for (const item of sec.items) {
            const itemName = item.name || item.item_name;
            let imageUrl = item.image_url || item.image_path || (item.images && item.images[0]?.url);

            if (imageUrl && imageUrl.startsWith('data:')) {
              const uploaded = await uploadBase64Image(slug, inserted.id, 'hh-item', imageUrl);
              if (uploaded) imageUrl = uploaded.url;
            }

            await db.from('happy_hour_items').insert({
              entity_slug: slug,
              section_id: inserted.id,
              item_name: itemName,
              description: item.description || null,
              price: item.price ? parseFloat(item.price) : null,
              image_url: imageUrl || null,
            });
          }
        }
      }
    }

    res.json({ success: true, message: 'Menu saved successfully' });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

// ─── QR MENU (public read — no PIN) ──────────────────────────────────────────
// GET /api/menu-editor/:slug/qr-menu
// Used by QR code scan → display the full menu publicly

router.get('/:slug/qr-menu', async (req, res) => {
  const slug = req.params.slug;

  const { data: entity } = await db.from('entity').select('*').eq('slug', slug).eq('is_active', true).single();
  if (!entity) return res.status(404).json({ error: 'Not found' });

  const [menuSections, drinkSections, hhSections, specials, events, hours, sides, dailyFeatures] = await Promise.all([
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_sides').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_daily_features').select('*').eq('entity_slug', slug).eq('is_active', true),
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
    sides: sides.data || [],
    daily_features: dailyFeatures.data || [],
  });
});

module.exports = router;
