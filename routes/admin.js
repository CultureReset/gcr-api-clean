const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { findExistingEntity, possibleFuzzyDuplicate } = require('../lib/find-existing-entity');
const { analyzePhoto } = require('../lib/analyze-photo');
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

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET env var is required — refusing to mount /api/admin with an insecure default secret');
}
const JWT_SECRET = process.env.JWT_SECRET;

// Cache-control for GET requests (10 min for entity lists, helps with slow loads)
router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
  next();
});

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
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── CACHE INVALIDATION ───────────────────────────────────────────────────────
// Clears cache by setting headers that tell CDN/clients to revalidate
// This is called after every PATCH/POST/DELETE to ensure fresh data
// Look up entity UUID from slug — needed for tables that use entity_id FK
async function getEntityId(slug) {
  const { data } = await getDb().from('entity').select('id').eq('slug', slug).single();
  return data?.id || null;
}

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
// Supabase/PostgREST hard-caps any single query at 1000 rows, so we must
// page through with .range() to return the full set (~2,800 entities).
router.get('/gcr/entities', async (req, res) => {
  try {
    const db = getDb();
    // parent_slug:parent_entity_slug aliases the real column to the API's
    // established field name — the actual DB column is parent_entity_slug,
    // not parent_slug (a schema mismatch that silently broke every
    // parent/child hub feature; see PATCH handler below for the write side).
    const cols = 'id, slug, name, entity_subtype, city, is_active, featured, hero_image_url, rating, icon, parent_slug:parent_entity_slug';
    const search = req.query.search;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 1000) : null;

    if (search || limit) {
      // Targeted lookup — used by admin search boxes (e.g. Page Rails slot picker).
      // Single query, no full-table pagination.
      let query = db.from('entity').select(cols).order('name');
      if (search) query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
      query = query.limit(limit || 50);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ entities: data || [], total: data?.length || 0 });
    }

    // No search/limit — original behavior, fetch everything for the businesses list page
    const PAGE = 1000;
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await db.from('entity').select(cols).order('name').range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      all = all.concat(data || []);
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    res.json({ entities: all, total: all.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const { entity, hours, happyHour, menuSections, menuItems, drinkSections, drinkItems, hhSections, hhItems, events, specials, tags, photos, schedules } = req.body;
  const errors = [];

  // 1. Core entity
  if (entity) {
    // parent_slug (hub linkage) needs its own validation before the generic
    // passthrough update below — an unchecked write here could point an
    // entity at a slug that doesn't exist, or at itself. The request/response
    // field is parent_slug, but the real DB column is parent_entity_slug (a
    // schema mismatch that silently broke every parent/child hub feature) —
    // delete the request-shaped key and set the real column name so the
    // generic `.update({...entity})` below writes to the column that exists.
    if ('parent_slug' in entity) {
      const parentSlug = entity.parent_slug || null;
      delete entity.parent_slug;
      if (parentSlug === slug) {
        return res.status(400).json({ error: 'An entity cannot be its own parent' });
      }
      if (parentSlug) {
        const { data: parentRow } = await getDb().from('entity').select('slug').eq('slug', parentSlug).eq('is_active', true).maybeSingle();
        if (!parentRow) {
          return res.status(400).json({ error: `parent_slug "${parentSlug}" does not match an active entity` });
        }
      }
      entity.parent_entity_slug = parentSlug;
    }
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

  // 14. Activity schedules
  if (schedules?.length) {
    const rows = schedules.map((s, i) => ({
      entity_slug: slug,
      schedule_name: s.schedule_name || s.name || s.label,
      label: s.label || s.schedule_name || s.name,
      schedule_type: s.schedule_type || null,
      time_start: s.time_start || s.time || null,
      duration: s.duration || null,
      days_of_week: s.days_of_week || s.days || null,
      notes: s.notes || null,
      is_active: s.is_active !== false,
      sort_order: s.sort_order ?? i
    }));
    const { error } = await getDb().from('activity_schedules').insert(rows);
    if (error) errors.push('schedules: ' + error.message);
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

// ─── AVAILABILITY (manual today's-spots entry; live platform scraping is a
// separate, per-business follow-up — this is the foundation it plugs into) ──

// GET current + upcoming rows so the admin editor can show what's on file.
router.get('/gcr/entities/:slug/availability', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb()
    .from('business_availability')
    .select('*')
    .eq('entity_slug', slug)
    .gte('availability_date', new Date().toISOString().split('T')[0])
    .order('availability_date')
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ availability: data || [] });
});

// PUT upserts a single date's row (defaults to today) — this is the manual
// toggle-and-number flow; source_platform stays null for hand-entered rows
// so a later scraper can tell its own rows apart from manual ones.
router.put('/gcr/entities/:slug/availability', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const {
    availability_date, total_capacity, remaining_spots, status,
    visible_on_profile, source_platform, booking_type,
    last_minute_deal, last_minute_price, original_price,
  } = req.body;
  const date = availability_date || new Date().toISOString().split('T')[0];

  const row = {
    entity_slug: slug,
    availability_date: date,
    total_capacity: total_capacity ?? null,
    remaining_spots: remaining_spots ?? null,
    status: status || 'unknown',
    visible_on_profile: visible_on_profile !== false,
    source_platform: source_platform || null,
    booking_type: booking_type || null,
    last_minute_deal: last_minute_deal || null,
    last_minute_price: last_minute_price ?? null,
    original_price: original_price ?? null,
    last_updated: new Date().toISOString(),
  };

  const { data: existing } = await getDb().from('business_availability')
    .select('id').eq('entity_slug', slug).eq('availability_date', date).maybeSingle();

  const { error } = existing
    ? await getDb().from('business_availability').update(row).eq('id', existing.id)
    : await getDb().from('business_availability').insert(row);
  if (error) return res.status(500).json({ error: error.message });

  // Low-spots or an explicit last-minute price surfaces on the already-live
  // /deals page (deal_type='last_minute') automatically — no separate manual
  // deal submission needed. Upsert-by-slug+date so repeated PUTs (e.g. an
  // admin decrementing spots through the day) update one row instead of
  // spawning duplicates.
  const isLastMinute = row.visible_on_profile && (
    (row.remaining_spots != null && row.remaining_spots <= 5) || row.last_minute_deal
  );
  if (isLastMinute) {
    try {
      const { data: ent } = await getDb().from('entity')
        .select('name, entity_type, entity_subtype, hero_image_url, phone, booking_url').eq('slug', slug).maybeSingle();
      const headline = row.last_minute_deal || `${row.remaining_spots} spot${row.remaining_spots === 1 ? '' : 's'} left today`;
      const discount_pct = (row.original_price && row.last_minute_price)
        ? Math.round((1 - parseFloat(row.last_minute_price) / parseFloat(row.original_price)) * 100) : null;
      const dealRow = {
        entity_slug: slug, entity_name: ent?.name || null,
        entity_type: ent?.entity_type || null, entity_subtype: ent?.entity_subtype || null,
        posted_by: 'auto', deal_type: 'last_minute', headline,
        image_url: ent?.hero_image_url || null,
        original_price: row.original_price ?? null, deal_price: row.last_minute_price ?? null,
        discount_pct,
        valid_date: date, is_today_only: date === new Date().toISOString().split('T')[0],
        spots_total: row.total_capacity, spots_remaining: row.remaining_spots,
        claim_type: ent?.booking_url ? 'link' : 'phone', claim_url: ent?.booking_url || null, claim_phone: ent?.phone || null,
        is_active: true, promoted_feed: true, swipe_card: true, source: 'availability_sync',
      };
      const { data: existingDeal } = await getDb().from('gcr_deals')
        .select('id').eq('entity_slug', slug).eq('valid_date', date).eq('source', 'availability_sync').maybeSingle();
      if (existingDeal) await getDb().from('gcr_deals').update(dealRow).eq('id', existingDeal.id);
      else await getDb().from('gcr_deals').insert({ ...dealRow, created_at: new Date().toISOString() });
    } catch (e) { /* deal sync is a bonus surface, never block the availability write */ }
  } else {
    // Spots refilled back above the low-inventory threshold, or visibility
    // turned off — deactivate any deal this sync created so it stops
    // showing a stale "spots left" claim.
    await getDb().from('gcr_deals').update({ is_active: false })
      .eq('entity_slug', slug).eq('valid_date', date).eq('source', 'availability_sync');
  }

  invalidateCache(res, slug);
  res.json({ success: true });
});

// ─── MENU SECTIONS + ITEMS ────────────────────────────────────────────────────

router.post('/gcr/entities/:slug/menu-sections', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { section_name, sort_order, days_of_week, start_time, end_time, is_active, metadata } = req.body;
  const { data, error } = await getDb().from('menu_sections').insert({
    entity_slug: slug,
    section_name,
    sort_order: sort_order || 0,
    days_of_week: days_of_week || ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    start_time: start_time || null,
    end_time: end_time || null,
    is_active: is_active !== false,
    metadata: metadata || {}
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/menu-sections/:id', authRequired, async (req, res) => {
  const { section_name, sort_order, days_of_week, start_time, end_time, is_active, metadata } = req.body;
  const { data, error } = await getDb().from('menu_sections').update({
    section_name,
    sort_order,
    days_of_week,
    start_time: start_time || null,
    end_time: end_time || null,
    is_active,
    metadata
  }).eq('id', req.params.id).select().single();
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
  const { item_name, description, price, section_id, tags, image_url, image_path, is_available, is_featured, is_catch_of_day, is_on_tap, has_market_price, sort_order, metadata } = req.body;
  const { data, error } = await getDb().from('menu_items').insert({
    entity_slug: slug,
    section_id: section_id || null,
    item_name,
    description: description || null,
    price: price != null ? parseFloat(price) : null,
    tags: tags || null,
    image_url: image_url || null,
    image_path: image_path || null,
    is_available: is_available !== false,
    is_featured: is_featured || false,
    is_catch_of_day: is_catch_of_day || false,
    is_on_tap: is_on_tap || false,
    has_market_price: has_market_price || false,
    sort_order: sort_order || 0,
    metadata: metadata || {}
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/menu-items/:id', authRequired, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url, image_path, is_available, is_featured, is_catch_of_day, is_on_tap, has_market_price, sort_order, metadata } = req.body;
  const { data, error } = await getDb().from('menu_items').update({
    item_name,
    description: description || null,
    price: price != null ? parseFloat(price) : null,
    section_id: section_id || null,
    tags: tags || null,
    image_url: image_url || null,
    image_path: image_path || null,
    is_available,
    is_featured,
    is_catch_of_day,
    is_on_tap,
    has_market_price,
    sort_order,
    metadata
  }).eq('id', req.params.id).select().single();
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

// POST /api/admin/gcr/import-section-based — the default bulk-upload CSV format.
// Body: raw array of CSV rows (NOT pre-grouped), each row shaped:
//   { restaurant_name, city, state, address, phone, section_type, section, item_name, description, price, tags }
// section_type: profile | menu | special | event | tags | service | dietary
// Restaurants are matched by name (case-insensitive) + address; created if not found.
// Designed to be safe to re-run: menu items are upserted by (entity_slug, section_name, item_name)
// rather than wiping the whole menu every time, since CSV uploads happen repeatedly over time.
router.post('/gcr/import-section-based', authRequired, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Expected a non-empty array of CSV rows' });

  const db = getDb();
  const errors = [];
  let inserted = 0;
  const entityCache = new Map(); // "name|address" -> slug, avoids a lookup per row

  function slugify(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  async function resolveEntity(row) {
    const name = (row.restaurant_name || '').trim();
    const address = (row.address || '').trim();
    if (!name) throw new Error('restaurant_name is required');
    const cacheKey = name.toLowerCase() + '|' + address.toLowerCase();
    if (entityCache.has(cacheKey)) return entityCache.get(cacheKey);

    // Try to find an existing entity by name (case-insensitive) + address first
    const { data: matches } = await db.from('entity').select('slug, address_line_1').ilike('name', name);
    let match = (matches || []).find(m => !address || (m.address_line_1 || '').toLowerCase().trim() === address.toLowerCase());
    if (!match && matches?.length === 1 && !address) match = matches[0];

    // Name+address didn't find it (CSV rows often spell the name slightly
    // differently than however the business first got imported) — fall back
    // to an exact phone match before assuming this is a new business.
    if (!match && row.phone) {
      const phoneMatch = await findExistingEntity(db, { phone: row.phone });
      if (phoneMatch) match = { slug: phoneMatch.slug };
    }

    let slug;
    if (match) {
      slug = match.slug;
    } else {
      if (row.phone) {
        const fuzzy = await possibleFuzzyDuplicate(db, name);
        if (fuzzy) console.warn(`[csv-import] "${name}" has no name/address/phone match but is ${Math.round(fuzzy.similarity * 100)}% similar to existing "${fuzzy.slug}" — creating a new row anyway; review manually if this is really the same business.`);
      }
      // Create a new minimal entity so this row (and following rows for the same
      // restaurant) has somewhere to attach
      const baseSlug = slugify(name);
      let candidate = baseSlug, suffix = 2;
      while (true) {
        const { data: existing } = await db.from('entity').select('slug').eq('slug', candidate).maybeSingle();
        if (!existing) break;
        candidate = `${baseSlug}-${suffix++}`;
        if (suffix > 50) throw new Error('Could not generate a unique slug for ' + name);
      }
      slug = candidate;
      const { error: createErr } = await db.from('entity').insert({
        slug, name,
        city: row.city || null,
        state: row.state || null,
        address_line_1: address || null,
        phone: row.phone || null,
        entity_type: 'restaurant',
        entity_subtype: 'restaurant',
        is_active: true,
      });
      if (createErr) throw new Error('Could not create entity: ' + createErr.message);
    }
    entityCache.set(cacheKey, slug);
    return slug;
  }

  for (const row of rows) {
    try {
      const slug = await resolveEntity(row);
      const type = (row.section_type || 'menu').toLowerCase().trim();

      if (type === 'profile') {
        // Profile rows update entity-level fields rather than creating items
        const updates = {};
        if (row.item_name) updates.name = row.item_name; // item_name doubles as display name in profile rows
        if (row.description) updates.description = row.description;
        if (row.tags) updates.subtitle = row.tags;
        if (Object.keys(updates).length) {
          const { error } = await db.from('entity').update(updates).eq('slug', slug);
          if (error) throw error;
        }
        inserted++;
        continue;
      }

      if (type === 'menu' || type === 'dietary') {
        const sectionName = row.section || 'Menu';
        let { data: section } = await db.from('menu_sections').select('id').eq('entity_slug', slug).eq('section_name', sectionName).maybeSingle();
        if (!section) {
          const { data: created, error: secErr } = await db.from('menu_sections').insert({ entity_slug: slug, section_name: sectionName }).select('id').single();
          if (secErr) throw secErr;
          section = created;
        }
        // Upsert-by-name so re-running the same CSV doesn't duplicate items
        const { data: existingItem } = await db.from('menu_items').select('id').eq('section_id', section.id).eq('item_name', row.item_name).maybeSingle();
        const itemRow = {
          entity_slug: slug,
          section_id: section.id,
          item_name: row.item_name,
          description: row.description || null,
          price: row.price ? parseFloat(String(row.price).replace(/[^0-9.]/g, '')) || null : null,
        };
        if (existingItem) await db.from('menu_items').update(itemRow).eq('id', existingItem.id);
        else await db.from('menu_items').insert(itemRow);
        inserted++;
        continue;
      }

      if (type === 'special') {
        // Upsert-by-name so re-running the same CSV updates instead of duplicating
        const { data: existing } = await db.from('entity_specials').select('id').eq('entity_slug', slug).eq('special_name', row.item_name).maybeSingle();
        const specialRow = { entity_slug: slug, special_name: row.item_name, description: row.description || null, discount_text: row.price || null, is_active: true };
        if (existing) await db.from('entity_specials').update(specialRow).eq('id', existing.id);
        else await db.from('entity_specials').insert(specialRow);
        inserted++;
        continue;
      }

      if (type === 'event') {
        // Upsert-by-name so re-running the same CSV updates instead of duplicating
        const { data: existing } = await db.from('entity_events').select('id').eq('entity_slug', slug).eq('event_name', row.item_name).maybeSingle();
        const eventRow = { entity_slug: slug, event_name: row.item_name, description: row.description || null, is_active: true };
        if (existing) await db.from('entity_events').update(eventRow).eq('id', existing.id);
        else await db.from('entity_events').insert(eventRow);
        inserted++;
        continue;
      }

      if (type === 'service') {
        // No dedicated services table is wired up yet — store as a generic
        // entity_section so it's at least captured and visible, not dropped.
        let { data: section } = await db.from('entity_sections').select('id').eq('entity_slug', slug).eq('section_name', row.section || 'Services').maybeSingle();
        if (!section) {
          const { data: created, error: secErr } = await db.from('entity_sections').insert({ entity_slug: slug, section_type: 'offerings', section_name: row.section || 'Services' }).select('id').single();
          if (secErr) throw secErr;
          section = created;
        }
        await db.from('entity_section_items').insert({
          entity_slug: slug,
          section_id: section.id,
          item_name: row.item_name,
          description: row.description || null,
          price_label: row.price || null,
        });
        inserted++;
        continue;
      }

      if (type === 'tags') {
        const tagList = String(row.tags || row.item_name || '').split(',').map(t => t.trim()).filter(Boolean);
        for (const tag of tagList) {
          // Skip if this exact tag already exists for the entity — this is the
          // path that previously duplicated tags into the tens of thousands
          const { data: existing } = await db.from('entity_tags').select('id').eq('entity_slug', slug).eq('tag_name', tag).maybeSingle();
          if (!existing) await db.from('entity_tags').insert({ entity_slug: slug, tag_name: tag }).then(() => {}).catch(() => {});
        }
        inserted++;
        continue;
      }

      errors.push(`Unknown section_type "${row.section_type}" for ${row.restaurant_name}`);
    } catch (e) {
      errors.push(`${row.restaurant_name || 'row'}: ${e.message}`);
    }
  }

  res.json({
    success: true,
    restaurants: entityCache.size,
    inserted,
    errors,
  });
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
  const { entity, hours, tags, photos, menu, drinks, happyHour, events, specials, sections, pricing, whatsIncluded, requirements, faqs, schedules } = req.body;
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

  // Photos — replace, don't append, so re-uploading a business doesn't duplicate its gallery
  if (photos?.length) {
    await getDb().from('entity_photos').delete().eq('entity_slug', slug);
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

  // Events — replace, don't append (keeps every field: date, times, day, artist, recurring)
  if (events?.length) {
    await getDb().from('entity_events').delete().eq('entity_slug', slug);
    await getDb().from('entity_events').insert(events.map(e => ({ entity_slug: slug, event_name: e.event_name || e.name, description: e.description || null, event_date: e.event_date || null, start_time: e.start_time || null, end_time: e.end_time || null, day_of_week: e.day_of_week || null, recurring: !!e.recurring, artist_name: e.artist_name || null, is_active: true, image_url: e.image_url || null })));
    results.events = events.length;
  }

  // Specials — replace, don't append
  if (specials?.length) {
    await getDb().from('entity_specials').delete().eq('entity_slug', slug);
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

  // Pricing items
  if (pricing?.length) {
    const eid = await getEntityId(slug);
    if (eid) {
      await getDb().from('pricing_items').insert(pricing.map((p, i) => ({
        entity_id: eid,
        item_name: p.item_name || p.name,
        price: p.price != null ? parseFloat(p.price) : null,
        price_type: p.price_type || null,
        description: p.description || null,
        sort_order: p.sort_order ?? i,
      })));
      results.pricing = pricing.length;
    }
  }

  // What's included
  if (whatsIncluded?.length) {
    const eid = await getEntityId(slug);
    if (eid) {
      await getDb().from('whats_included').insert(whatsIncluded.map((w, i) => ({
        entity_id: eid,
        included_item: typeof w === 'string' ? w : (w.included_item || w.item),
        sort_order: i,
      })));
      results.whatsIncluded = whatsIncluded.length;
    }
  }

  // Requirements
  if (requirements?.length) {
    const eid = await getEntityId(slug);
    if (eid) {
      await getDb().from('requirements').insert(requirements.map((r, i) => ({
        entity_id: eid,
        requirement_text: typeof r === 'string' ? r : (r.requirement_text || r.text),
        sort_order: i,
      })));
      results.requirements = requirements.length;
    }
  }

  // FAQs
  if (faqs?.length) {
    const eid = await getEntityId(slug);
    if (eid) {
      await getDb().from('faqs').insert(faqs.map((f, i) => ({
        entity_id: eid,
        question: f.question,
        answer: f.answer,
        sort_order: f.sort_order ?? i,
      })));
      results.faqs = faqs.length;
    }
  }

  // Activity schedules
  if (schedules?.length) {
    const rows = schedules.map((s, i) => ({
      entity_slug: slug,
      schedule_name: s.schedule_name || s.name || s.label,
      label: s.label || s.schedule_name || s.name,
      schedule_type: s.schedule_type || null,
      time_start: s.time_start || s.time || null,
      duration: s.duration || null,
      days_of_week: s.days_of_week || s.days || null,
      notes: s.notes || null,
      is_active: s.is_active !== false,
      sort_order: s.sort_order ?? i
    }));
    const { error } = await getDb().from('activity_schedules').insert(rows);
    if (!error) results.schedules = schedules.length;
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
        .insert({ entity_slug: slug, section_type: sec.section_type, section_name: sec.section_name || sec.name, subtitle: sec.subtitle || null, image_url: sec.image_url || null, image_path: sec.image_path || null, sort_order: sec.sort_order ?? i })
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
          image_url: item.image_url || null,
          image_path: item.image_path || null,
          metadata: item.metadata || {},
          sort_order: item.sort_order ?? j,
        })));
      }
    }
    res.json({ success: true, slug, count: sections.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/gcr/sections/:id/image — set/clear one section's banner
// photo without re-saving the whole sections list (used by the "Upload
// Photo" button in the entity editor's Sections tab). Pass {image_url,
// image_path} to set, or {image_url:null} to remove.
router.patch('/gcr/sections/:id/image', authRequired, async (req, res) => {
  try {
    const { image_url, image_path } = req.body;
    const { error } = await getDb().from('entity_sections')
      .update({ image_url: image_url || null, image_path: image_path || null })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/gcr/section-items/:id/image — same, for one item within a section.
router.patch('/gcr/section-items/:id/image', authRequired, async (req, res) => {
  try {
    const { image_url, image_path } = req.body;
    const { error } = await getDb().from('entity_section_items')
      .update({ image_url: image_url || null, image_path: image_path || null })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
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
        getDb().from('tourist_swipe_events').select('id', { count: 'exact', head: true }).eq('tourist_id', p.user_id),
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
      getDb().from('tourist_swipe_events').select('entity_slug, category, created_at').eq('tourist_id', uid).eq('direction', 'like').order('created_at', { ascending: false }),
      getDb().from('tourist_swipe_events').select('entity_slug, category, created_at').eq('tourist_id', uid).eq('direction', 'nope').order('created_at', { ascending: false }),
      getDb().from('tourist_swipe_events').select('entity_slug, category, created_at').eq('tourist_id', uid).eq('direction', 'super').order('created_at', { ascending: false }),
      getDb().from('tourist_seen').select('entity_slug, seen_at:created_at').eq('tourist_id', uid).order('created_at', { ascending: false }),
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
      getDb().from('user_preference_scores').select('tag, score').eq('user_id', uid).order('score', { ascending: false }),
      getDb().from('tourist_swipe_events').select('direction').eq('tourist_id', uid),
      getDb().from('tourist_saves').select('entity_slug, business_name, category, hero_image_url, is_super_like, saved_at').eq('user_id', uid).order('saved_at', { ascending: false }),
      getDb().from('tourist_swipe_events').select('entity_slug, category, created_at').eq('tourist_id', uid).eq('direction', 'like').order('created_at', { ascending: false }),
    ]);

    const scores = prefs || [];
    const loves = scores.filter(p => p.score >= 20);
    const likes = scores.filter(p => p.score >= 1 && p.score < 20);
    const dislikes = scores.filter(p => p.score < 0);

    const swipeArr = swipeStats || [];
    const swipe_counts = {
      like:  swipeArr.filter(s => s.direction === 'like').length,
      nope:  swipeArr.filter(s => s.direction === 'nope').length,
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
      getDb().from('tourist_swipe_events').delete().eq('tourist_id', uid),
      getDb().from('tourist_itineraries').delete().eq('user_id', uid),
      getDb().from('user_preference_scores').delete().eq('user_id', uid),
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

// GET /api/admin/gcr/analytics — entity-level view counts, rolled up daily in gcr_page_views
router.get('/gcr/analytics', authRequired, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  const [todayRes, monthRes] = await Promise.all([
    getDb().from('gcr_page_views').select('entity_id, view_count').eq('view_date', today),
    getDb().from('gcr_page_views').select('entity_id, view_count').gte('view_date', monthStart),
  ]);

  const todayRows = todayRes.data || [];
  const monthRows = monthRes.data || [];
  const todayViews = todayRows.reduce((s, r) => s + (r.view_count || 0), 0);
  const monthViews = monthRows.reduce((s, r) => s + (r.view_count || 0), 0);
  // Distinct entities viewed today is a reasonable stand-in for "today visitors"
  // since this table doesn't track unique sessions, only per-entity daily counts.
  const todayVisitors = new Set(todayRows.map(r => r.entity_id)).size;

  // Top entities this month by total views
  const totals = {};
  monthRows.forEach(r => { totals[r.entity_id] = (totals[r.entity_id] || 0) + (r.view_count || 0); });
  const topIds = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);

  let topEntities = [];
  if (topIds.length) {
    const { data: entities } = await getDb().from('entity').select('id, name, slug').in('id', topIds);
    const byId = Object.fromEntries((entities || []).map(e => [e.id, e]));
    topEntities = topIds.map(id => ({ entity_id: id, entity: byId[id] || null, count: totals[id] }));
  }

  res.json({
    today_visitors: todayVisitors,
    today_views: todayViews,
    today_conversions: 0, // no conversion tracking source wired up yet
    month_views: monthViews,
    top_entities: topEntities,
  });
});

// ─── PLATFORM ANALYTICS ───────────────────────────────────────────────────

// GET /api/admin/platform-analytics — overall platform stats
router.get('/platform-analytics', authRequired, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [tourists, saves, swipes, itineraries] = await Promise.all([
      getDb().from('tourist_profiles').select('user_id', { count: 'exact', head: true }).gte('created_at', since),
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
    const { data: inserted } = await getDb().from('entity_photos')
      .insert({ entity_slug, url: publicUrl, image_path: fileName, is_cover: is_cover === 'true', sort_order: nextOrder })
      .select('id').single();
    // Don't make the upload wait on vision analysis -- fill in what the photo
    // actually shows a moment later, same fire-and-forget pattern used for
    // calendar mirroring elsewhere in this API.
    if (inserted?.id) {
      analyzePhoto(publicUrl).then(result => {
        if (!result) return;
        return getDb().from('entity_photos').update({
          ai_description: result.description,
          ai_tags: result.tags,
          ai_analyzed_at: new Date().toISOString(),
        }).eq('id', inserted.id);
      }).catch(() => {});
    }
  }
  res.json({ url: publicUrl, path: fileName });
});

// POST /api/admin/gcr/backfill-photo-analysis — run AI vision tagging over
// EXISTING entity_photos rows that predate this feature (imported from
// Google Places, bulk CSV, etc — anything not uploaded through a path that
// already calls analyzePhoto()). This costs one real Anthropic API call per
// photo, which is why it's a manually-triggered batch, not something that
// runs on its own — call it repeatedly (or raise `limit`) to work through
// the backlog at whatever pace/cost you're comfortable with.
// Body: { limit? } -- defaults to 25 photos per call.
router.post('/gcr/backfill-photo-analysis', authRequired, async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit) || 25, 200);
  const { data: photos, error } = await getDb().from('entity_photos')
    .select('id, url').is('ai_analyzed_at', null).not('url', 'is', null).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  if (!photos?.length) return res.json({ processed: 0, remaining: 0, message: 'Nothing left to analyze.' });

  let processed = 0;
  for (const photo of photos) {
    const result = await analyzePhoto(photo.url);
    if (result) {
      await getDb().from('entity_photos').update({
        ai_description: result.description, ai_tags: result.tags, ai_analyzed_at: new Date().toISOString(),
      }).eq('id', photo.id);
      processed++;
    } else {
      // Still stamp ai_analyzed_at so a permanently-broken image URL doesn't
      // get retried forever every time this batch runs -- one failed attempt
      // is enough to skip it going forward.
      await getDb().from('entity_photos').update({ ai_analyzed_at: new Date().toISOString() }).eq('id', photo.id);
    }
  }

  const { count: remaining } = await getDb().from('entity_photos').select('id', { count: 'exact', head: true }).is('ai_analyzed_at', null);
  res.json({ processed, remaining: remaining || 0 });
});

// ─── ARTISTS ─────────────────────────────────────────────────────────────────

// POST /api/admin/artists — create new artist
router.post('/artists', authRequired, async (req, res) => {
  const { name, bio, genre, hometown, image_url, website_url, spotify_url, social_instagram, social_facebook, social_tiktok } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await getDb().from('artists').insert({
    name,
    bio: bio || null,
    genre: genre || null,
    hometown: hometown || null,
    image_url: image_url || null,
    website_url: website_url || null,
    spotify_url: spotify_url || null,
    social_instagram: social_instagram || null,
    social_facebook: social_facebook || null,
    social_tiktok: social_tiktok || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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

// DELETE /api/admin/artists/:id — delete artist
router.delete('/artists/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('artists').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
      .select('user_id, phone, name, arrival, departure')
      .eq('sms_opt_in', true)
      .not('phone', 'is', null);

    if (in_town_only) {
      baseQuery = baseQuery.lte('arrival', today).gte('departure', today);
    }

    const { data: allTourists, error: baseErr } = await baseQuery;
    if (baseErr) throw baseErr;
    if (!allTourists?.length) return res.json({ sent: 0, total: 0, message: 'No tourists match base filters' });

    let eligible = new Set(allTourists.map(t => t.user_id));

    // Step 2 — filter by preference tags
    if (tags.length > 0) {
      const { data: scores } = await db
        .from('user_preference_scores')
        .select('user_id, tag, score')
        .in('tag', tags.map(t => t.toLowerCase().trim()))
        .gte('score', min_score);

      if (scores?.length) {
        const byTourist = {};
        scores.forEach(s => {
          if (!byTourist[s.user_id]) byTourist[s.user_id] = new Set();
          byTourist[s.user_id].add(s.tag.toLowerCase().trim());
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
        .select('user_id:tourist_id, entity_slug')
        .in('entity_slug', swiped_right)
        .eq('direction', 'like');

      const swipers = new Set((swipes || []).map(s => s.user_id));
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
        db.from('tourist_swipe_events').select('user_id:tourist_id').eq('category', category).eq('direction', 'like'),
        db.from('tourist_saves').select('user_id').eq('category', category),
      ]);
      const catEngaged = new Set([
        ...(catSwipes || []).map(s => s.user_id),
        ...(catSaves || []).map(s => s.user_id),
      ]);
      eligible = new Set([...eligible].filter(id => catEngaged.has(id)));
    }

    if (!eligible.size) return res.json({ sent: 0, total: 0, message: 'No tourists match all filters' });

    // Step 6 — get phones for eligible tourist IDs
    const eligibleTourists = allTourists.filter(t => eligible.has(t.user_id));

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
      .select('user_id')
      .eq('sms_opt_in', true)
      .not('phone', 'is', null);

    if (in_town_only) baseQuery = baseQuery.lte('arrival', today).gte('departure', today);

    const { data: allTourists } = await baseQuery;
    if (!allTourists?.length) return res.json({ count: 0 });

    let eligible = new Set(allTourists.map(t => t.user_id));

    if (tags.length > 0) {
      const { data: scores } = await db
        .from('user_preference_scores')
        .select('user_id, tag, score')
        .in('tag', tags.map(t => t.toLowerCase().trim()))
        .gte('score', min_score);
      if (scores?.length) {
        const byTourist = {};
        scores.forEach(s => { if (!byTourist[s.user_id]) byTourist[s.user_id] = new Set(); byTourist[s.user_id].add(s.tag); });
        const tagSet = new Set(tags.map(t => t.toLowerCase().trim()));
        eligible = new Set([...eligible].filter(id => {
          const m = byTourist[id] || new Set();
          return match_type === 'all' ? [...tagSet].every(t => m.has(t)) : [...tagSet].some(t => m.has(t));
        }));
      } else eligible = new Set();
    }

    if (swiped_right.length > 0) {
      const { data: swipes } = await db.from('tourist_swipe_events').select('user_id:tourist_id').in('entity_slug', swiped_right).eq('direction', 'like');
      const s = new Set((swipes || []).map(s => s.user_id));
      eligible = new Set([...eligible].filter(id => s.has(id)));
    }

    if (saved.length > 0) {
      const { data: saves } = await db.from('tourist_saves').select('user_id').in('entity_slug', saved);
      const s = new Set((saves || []).map(s => s.user_id));
      eligible = new Set([...eligible].filter(id => s.has(id)));
    }

    if (category) {
      const [{ data: cs }, { data: cv }] = await Promise.all([
        db.from('tourist_swipe_events').select('user_id:tourist_id').eq('category', category).eq('direction', 'like'),
        db.from('tourist_saves').select('user_id').eq('category', category),
      ]);
      const ce = new Set([...(cs||[]).map(s=>s.user_id), ...(cv||[]).map(s=>s.user_id)]);
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

// ── RAG STATUS & REINDEXING ────────────────────────────────────────────────────
router.get('/rag-status', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { data: businesses } = await db.from('entity').select('id,slug,name,is_active').eq('is_active', true);
    res.json({
      indexed_businesses: 0,
      total_gcr_businesses: businesses?.length || 0,
      total_chunks: 0,
      last_updated: null,
      businesses: (businesses || []).map(b => ({ slug: b.slug, name: b.name, indexed: false }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/gcr/reindex/:slug', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const db = getDb();
    const { data: entity } = await db.from('entity').select('*').eq('slug', slug).single();
    if (!entity) return res.status(404).json({ error: 'Business not found' });
    res.json({ slug: slug, name: entity.name, chunks_indexed: 0, embedding_status: 'pending' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PRICING ITEMS ────────────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/pricing-items', authRequired, async (req, res) => {
  const eid = await getEntityId(req.params.slug);
  if (!eid) return res.json({ pricing_items: [] });
  const { data, error } = await getDb().from('pricing_items').select('*').eq('entity_id', eid).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ pricing_items: data || [] });
});
router.get('/gcr/entities/:slug/whats-included', authRequired, async (req, res) => {
  const eid = await getEntityId(req.params.slug);
  if (!eid) return res.json({ whats_included: [] });
  const { data, error } = await getDb().from('whats_included').select('*').eq('entity_id', eid).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ whats_included: data || [] });
});
router.get('/gcr/entities/:slug/requirements', authRequired, async (req, res) => {
  const eid = await getEntityId(req.params.slug);
  if (!eid) return res.json({ requirements: [] });
  const { data, error } = await getDb().from('requirements').select('*').eq('entity_id', eid).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ requirements: data || [] });
});
router.post('/gcr/entities/:slug/pricing-items', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const eid = await getEntityId(slug);
  if (!eid) return res.status(404).json({ error: 'Entity not found' });
  const { data, error } = await getDb().from('pricing_items').insert({ ...req.body, entity_id: eid }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/pricing-items/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('pricing_items').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/pricing-items/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('pricing_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── WHAT'S INCLUDED ──────────────────────────────────────────────────────────
router.post('/gcr/entities/:slug/whats-included', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const eid = await getEntityId(slug);
  if (!eid) return res.status(404).json({ error: 'Entity not found' });
  const { data, error } = await getDb().from('whats_included').insert({ ...req.body, entity_id: eid }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/whats-included/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('whats_included').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/whats-included/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('whats_included').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── FAQs ─────────────────────────────────────────────────────────────────────
router.post('/gcr/entities/:slug/faqs', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const eid = await getEntityId(slug);
  if (!eid) return res.status(404).json({ error: 'Entity not found' });
  const { data, error } = await getDb().from('faqs').insert({ ...req.body, entity_id: eid }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/faqs/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('faqs').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/faqs/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('faqs').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── REQUIREMENTS ─────────────────────────────────────────────────────────────
router.post('/gcr/entities/:slug/requirements', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const eid = await getEntityId(slug);
  if (!eid) return res.status(404).json({ error: 'Entity not found' });
  const { data, error } = await getDb().from('requirements').insert({ ...req.body, entity_id: eid }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/requirements/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('requirements').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/requirements/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('requirements').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SIDES / ADD-ONS ──────────────────────────────────────────────────────────
router.post('/gcr/entities/:slug/sides', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_sides').insert({ ...req.body, entity_slug: slug, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/sides/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_sides').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/sides/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_sides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── DAILY FEATURES / SPECIALS ────────────────────────────────────────────────
router.post('/gcr/entities/:slug/daily-features', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_daily_features').insert({ ...req.body, entity_slug: slug, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/daily-features/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_daily_features').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/daily-features/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_daily_features').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SECONDARY HOURS ──────────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/secondary-hours', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_secondary_hours').select('*').eq('entity_slug', req.params.slug).order('hours_type, day_of_week');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ secondary_hours: data || [] });
});
router.get('/gcr/entities/:slug/faqs', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const eid = await getEntityId(slug);
  const [f1, f2] = await Promise.all([
    eid ? getDb().from('faqs').select('*').eq('entity_id', eid).order('sort_order') : { data: [] },
    getDb().from('entity_faqs').select('*').eq('entity_slug', slug).order('sort_order'),
  ]);
  res.json({ faqs: [...(f1.data || []), ...(f2.data || [])] });
});
router.post('/gcr/entities/:slug/secondary-hours', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_secondary_hours').insert({ ...req.body, entity_slug: slug, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/secondary-hours/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_secondary_hours').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/secondary-hours/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_secondary_hours').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ACTIVITY SCHEDULES ───────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/schedules', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('activity_schedules').select('*').eq('entity_slug', req.params.slug).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/gcr/entities/:slug/schedules', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('activity_schedules').insert({ ...req.body, entity_slug: slug, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/schedules/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('activity_schedules').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/schedules/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('activity_schedules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── TEAM MEMBERS ─────────────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/team', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_team_members').select('*').eq('entity_slug', req.params.slug).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/gcr/entities/:slug/team', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_team_members').insert({ ...req.body, entity_slug: slug }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/team/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_team_members').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/team/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_team_members').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── REVIEWS ──────────────────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/reviews', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_reviews').select('*').eq('entity_slug', req.params.slug).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/gcr/entities/:slug/reviews', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_reviews').insert({ ...req.body, entity_slug: slug }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/reviews/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_reviews').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/reviews/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_reviews').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── POLICIES ─────────────────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/policies', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_policies').select('*').eq('entity_slug', req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/gcr/entities/:slug/policies', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_policies').insert({ ...req.body, entity_slug: slug }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/policies/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_policies').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/policies/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_policies').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── BLOG POSTS ───────────────────────────────────────────────────────────────
router.get('/gcr/entities/:slug/blog', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_blog_posts').select('*').eq('entity_slug', req.params.slug).order('published_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/gcr/entities/:slug/blog', authRequired, async (req, res) => {
  const slug = req.params.slug;
  const { data, error } = await getDb().from('entity_blog_posts').insert({ ...req.body, entity_slug: slug }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  invalidateCache(res, slug);
  res.status(201).json(data);
});

router.put('/gcr/blog/:id', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('entity_blog_posts').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/gcr/blog/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('entity_blog_posts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── RAG Q&A (public endpoint) ──────────────────────────────────────────────────
router.post('/gcr/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    res.json({ answer: 'RAG search not yet implemented. Contact admin to enable.', sources: [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── USER → ENTITY LINKING (admin manually links dashboard users to GCR entities) ─
// POST /api/admin/link-user  { user_email, entity_slug }
router.post('/link-user', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { user_email, entity_slug, role = 'owner' } = req.body;
    if (!user_email || !entity_slug) return res.status(400).json({ error: 'user_email and entity_slug required' });

    // Look up user
    const { data: user, error: userErr } = await db.from('users').select('id, email, name').eq('email', user_email).maybeSingle();
    if (userErr || !user) return res.status(404).json({ error: `User not found: ${user_email}` });

    // Look up entity
    const { data: entity, error: entErr } = await db.from('entity').select('id, slug, name, entity_type').eq('slug', entity_slug).maybeSingle();
    if (entErr || !entity) return res.status(404).json({ error: `Entity not found: ${entity_slug}` });

    // Upsert entity_owners
    const { error: ownerErr } = await db.from('entity_owners').upsert({
      user_id: user.id,
      entity_id: entity.id,
      entity_slug: entity.slug,
      role,
    }, { onConflict: 'user_id,entity_id' });
    if (ownerErr) return res.status(500).json({ error: ownerErr.message });

    // Also update users.entity_id + users.entity_slug for quick lookup
    await db.from('users').update({ entity_id: entity.id, entity_slug: entity.slug }).eq('id', user.id);

    res.json({
      success: true,
      linked: { user: { id: user.id, email: user.email, name: user.name }, entity: { id: entity.id, slug: entity.slug, name: entity.name, type: entity.entity_type }, role }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/invite-business  { entity_slug, email }
// Sends a real invite email with a claim link — the recipient sets their own
// password on the claim page, which creates a real Supabase Auth account
// (not a manually-inserted one) and links it to the entity.
router.post('/invite-business', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { entity_slug, email } = req.body || {};
    if (!entity_slug || !email) return res.status(400).json({ error: 'entity_slug and email required' });

    const { data: entity, error: entErr } = await db.from('entity').select('slug, name').eq('slug', entity_slug).maybeSingle();
    if (entErr || !entity) return res.status(404).json({ error: `Entity not found: ${entity_slug}` });

    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('hex');

    const { error: inviteErr } = await db.from('business_invites').insert({
      entity_slug,
      email: email.toLowerCase(),
      token,
      invited_by: req.admin ? req.admin.userId || req.admin.email || null : null,
    });
    if (inviteErr) return res.status(500).json({ error: inviteErr.message });

    const baseUrl = process.env.PUBLIC_DASHBOARD_URL || 'https://app.cybercheckinc.com';
    const claimUrl = `${baseUrl}/claim-business.html?token=${token}`;

    const { sendEmail } = require('../utils/email');
    const result = await sendEmail({
      to: email,
      subject: `You've been invited to manage ${entity.name} on Gulf Coast Radar`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
          <tr><td style="background:#0b7a75;padding:28px 32px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;">You're invited</h1>
          </td></tr>
          <tr><td style="padding:32px;">
            <p style="margin:0 0 20px;color:#374151;font-size:15px;">You've been invited to manage <strong>${entity.name}</strong>'s listing on Gulf Coast Radar — bookings, calendar sync, waivers, and more.</p>
            <a href="${claimUrl}" style="display:inline-block;background:#f7941d;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px;">Set Up Your Account →</a>
            <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;">This link expires in 14 days. If you weren't expecting this, you can ignore this email.</p>
          </td></tr>
        </table>
      </body></html>`,
    });

    res.json({ success: true, sent: !!(result && result.success !== false), claim_url: claimUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/link-user?entity_slug=xxx  — see who is linked to an entity
router.get('/link-user', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { entity_slug, user_email } = req.query;
    if (!entity_slug && !user_email) return res.status(400).json({ error: 'entity_slug or user_email required' });

    let q = db.from('entity_owners').select('*, entity:entity_slug(name, entity_type), user:user_id(email, name)');
    if (entity_slug) q = q.eq('entity_slug', entity_slug);
    if (user_email) q = q.eq('user_id', db.from('users').select('id').eq('email', user_email));

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/link-user  { user_email, entity_slug }  — unlink
router.delete('/link-user', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { user_email, entity_slug } = req.body;
    if (!user_email || !entity_slug) return res.status(400).json({ error: 'user_email and entity_slug required' });

    const { data: user } = await db.from('users').select('id').eq('email', user_email).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });

    await db.from('entity_owners').delete().eq('user_id', user.id).eq('entity_slug', entity_slug);

    // Clear quick lookup if it was pointing at this entity
    const { data: remaining } = await db.from('entity_owners').select('entity_slug').eq('user_id', user.id);
    if (!remaining || remaining.length === 0) {
      await db.from('users').update({ entity_id: null, entity_slug: null }).eq('id', user.id);
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/users — list all dashboard users with their linked entity
router.get('/users', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { data, error } = await db.from('users').select('id, email, name, role, entity_slug, entity_id, created_at').order('created_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/gcr/import-gcr-items — bulk "GCR Section Items" CSV format.
// Body: raw array of CSV rows shaped:
//   { entity_slug, section_key, group_title, item_name, item_description, price_text, price_numeric, item_type }
// Upserts the section by (entity_slug, section_name=section_key) and the item by
// (section_id, item_name) so re-running the same CSV updates rather than duplicates.
// group_title (if present) is stored in metadata.group since entity_section_items
// has no separate grouping table.
router.post('/gcr/import-gcr-items', authRequired, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body?.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Expected a non-empty array of CSV rows' });

  const db = getDb();
  const errors = [];
  let inserted = 0, skipped = 0;
  const sectionCache = new Map(); // "slug|section_key" -> section_id

  for (const row of rows) {
    try {
      const slug = (row.entity_slug || '').trim();
      const sectionKey = (row.section_key || '').trim();
      const itemName = (row.item_name || '').trim();
      if (!slug || !sectionKey || !itemName) { errors.push('Missing entity_slug/section_key/item_name on a row'); continue; }

      const { data: entity } = await db.from('entity').select('slug').eq('slug', slug).maybeSingle();
      if (!entity) { errors.push(`Entity not found: ${slug}`); continue; }

      const cacheKey = slug + '|' + sectionKey;
      let sectionId = sectionCache.get(cacheKey);
      if (!sectionId) {
        const { data: existingSection } = await db.from('entity_sections').select('id').eq('entity_slug', slug).eq('section_name', sectionKey).maybeSingle();
        if (existingSection) {
          sectionId = existingSection.id;
        } else {
          const { data: created, error: secErr } = await db.from('entity_sections')
            .insert({ entity_slug: slug, section_type: 'offerings', section_name: sectionKey })
            .select('id').single();
          if (secErr) throw secErr;
          sectionId = created.id;
        }
        sectionCache.set(cacheKey, sectionId);
      }

      const { data: existingItem } = await db.from('entity_section_items').select('id').eq('section_id', sectionId).eq('item_name', itemName).maybeSingle();
      const itemRow = {
        entity_slug: slug,
        section_id: sectionId,
        item_name: itemName,
        description: row.item_description || null,
        price_from: row.price_numeric ? parseFloat(row.price_numeric) || null : null,
        price_label: row.price_text || null,
        metadata: { group: row.group_title || null, item_type: row.item_type || null },
      };
      if (existingItem) {
        await db.from('entity_section_items').update(itemRow).eq('id', existingItem.id);
        skipped++;
      } else {
        await db.from('entity_section_items').insert(itemRow);
        inserted++;
      }
    } catch (e) {
      errors.push(`${row.entity_slug || 'row'}: ${e.message}`);
    }
  }

  res.json({ success: true, inserted, updated: skipped, errors });
});

// ── Ad Network — rotating ads shown on free-tier QR menus ──────────────────

// GET /api/admin/gcr/ads — list all ads (admin view)
router.get('/gcr/ads', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('ads').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ads: data || [] });
});

// POST /api/admin/gcr/ads — create an ad
router.post('/gcr/ads', authRequired, async (req, res) => {
  const { advertiser_name, tagline, image_url, logo_url, badge_text, cta_text, cta_url, weight, is_active } = req.body;
  if (!advertiser_name || !String(advertiser_name).trim()) return res.status(400).json({ error: 'advertiser_name required' });

  const { data, error } = await getDb().from('ads').insert({
    advertiser_name: String(advertiser_name).trim(),
    tagline: tagline || null,
    image_url: image_url || null,
    logo_url: logo_url || null,
    badge_text: badge_text || null,
    cta_text: cta_text || 'Learn More',
    cta_url: cta_url || null,
    weight: weight != null ? parseInt(weight, 10) : 1,
    is_active: is_active !== false,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, ad: data });
});

// PUT /api/admin/gcr/ads/:id — update an ad
router.put('/gcr/ads/:id', authRequired, async (req, res) => {
  const { advertiser_name, tagline, image_url, logo_url, badge_text, cta_text, cta_url, weight, is_active } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (advertiser_name !== undefined) updates.advertiser_name = advertiser_name;
  if (tagline !== undefined) updates.tagline = tagline;
  if (image_url !== undefined) updates.image_url = image_url;
  if (logo_url !== undefined) updates.logo_url = logo_url;
  if (badge_text !== undefined) updates.badge_text = badge_text;
  if (cta_text !== undefined) updates.cta_text = cta_text;
  if (cta_url !== undefined) updates.cta_url = cta_url;
  if (weight !== undefined) updates.weight = parseInt(weight, 10);
  if (is_active !== undefined) updates.is_active = !!is_active;

  const { data, error } = await getDb().from('ads').update(updates).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, ad: data });
});

// DELETE /api/admin/gcr/ads/:id
router.delete('/gcr/ads/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('ads').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── GCR Coupons — platform-wide promo codes (separate from per-business CyberCheck coupons) ──

router.get('/gcr/coupons', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('gcr_coupons').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ coupons: data || [] });
});

router.post('/gcr/coupons', authRequired, async (req, res) => {
  const { code, type, amount, max_uses, expires_at, description } = req.body;
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'code required' });
  if (amount == null) return res.status(400).json({ error: 'amount required' });

  const { data, error } = await getDb().from('gcr_coupons').insert({
    code: String(code).trim().toUpperCase(),
    type: type === 'fixed' ? 'fixed' : 'percentage',
    amount: parseFloat(amount),
    max_uses: max_uses != null && max_uses !== '' ? parseInt(max_uses, 10) : null,
    expires_at: expires_at || null,
    description: description || null,
    active: true,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, coupon: data });
});

router.delete('/gcr/coupons/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('gcr_coupons').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/admin/gcr/customers — platform-wide view of tourists who've used GCR.
// "Customer" here means a tourist_profiles row (the closest real signal we have
// to a CyberCheck-style customer record at the platform level, since the
// `customers` table is per-business/site-scoped, not GCR-wide).
// status is derived, not stored: lead = hasn't finished onboarding,
// vip = has set up a trip AND opted into SMS (real engagement), customer = everyone else.
router.get('/gcr/customers', authRequired, async (req, res) => {
  const { data, error } = await getDb()
    .from('tourist_profiles')
    .select('user_id, name, phone, destination, arrival, departure, setup_complete, sms_opt_in, last_active, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const customers = (data || []).map(t => ({
    id: t.user_id,
    name: t.name || null,
    email: null, // tourist auth is phone-based, no email captured
    phone: t.phone || null,
    status: !t.setup_complete ? 'lead' : (t.sms_opt_in ? 'vip' : 'customer'),
    destination: t.destination || null,
    last_active: t.last_active || null,
    created_at: t.created_at,
  }));

  res.json({ customers });
});

// ── Page Rails — admin management of sponsored/algorithmic card rows ───────
// Powers the "Rail Manager" panel: create/reorder rails per page, and for
// sponsored rails, manage which businesses fill each slot.

// GET /api/admin/gcr/page-rails?page=restaurants — list rails for a page (all, including inactive)
router.get('/gcr/page-rails', authRequired, async (req, res) => {
  let query = getDb().from('page_rails').select('*').order('page').order('sort_order');
  if (req.query.page) query = query.eq('page', req.query.page);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rails: data || [] });
});

// POST /api/admin/gcr/page-rails — create a rail
router.post('/gcr/page-rails', authRequired, async (req, res) => {
  const { page, title, eyebrow, emoji, rail_type, algorithm, category, sort_order, card_limit } = req.body;
  if (!page || !title) return res.status(400).json({ error: 'page and title required' });
  if (!['sponsored', 'algorithm'].includes(rail_type)) return res.status(400).json({ error: "rail_type must be 'sponsored' or 'algorithm'" });
  if (rail_type === 'algorithm' && !['top_rated', 'near_you', 'for_you', 'newest'].includes(algorithm)) {
    return res.status(400).json({ error: 'algorithm rails require a valid algorithm value' });
  }

  const { data, error } = await getDb().from('page_rails').insert({
    page, title,
    eyebrow: eyebrow || null,
    emoji: emoji || null,
    rail_type,
    algorithm: rail_type === 'algorithm' ? algorithm : null,
    category: category || null,
    sort_order: sort_order ?? 0,
    card_limit: card_limit || 12,
    is_active: true,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, rail: data });
});

// PUT /api/admin/gcr/page-rails/:id — update a rail
router.put('/gcr/page-rails/:id', authRequired, async (req, res) => {
  const { title, eyebrow, emoji, rail_type, algorithm, category, sort_order, card_limit, is_active } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (title !== undefined) updates.title = title;
  if (eyebrow !== undefined) updates.eyebrow = eyebrow;
  if (emoji !== undefined) updates.emoji = emoji;
  if (rail_type !== undefined) updates.rail_type = rail_type;
  if (algorithm !== undefined) updates.algorithm = algorithm;
  if (category !== undefined) updates.category = category;
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (card_limit !== undefined) updates.card_limit = card_limit;
  if (is_active !== undefined) updates.is_active = !!is_active;

  const { data, error } = await getDb().from('page_rails').update(updates).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, rail: data });
});

// DELETE /api/admin/gcr/page-rails/:id
router.delete('/gcr/page-rails/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('page_rails').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/admin/gcr/page-rails/:id/items — sponsored slots for one rail
router.get('/gcr/page-rails/:id/items', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('page_rail_items').select('*').eq('rail_id', req.params.id).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ items: data || [] });
});

// POST /api/admin/gcr/page-rails/:id/items — add a business to a sponsored rail
router.post('/gcr/page-rails/:id/items', authRequired, async (req, res) => {
  const { entity_slug, sort_order, is_ad, badge_text, starts_at, ends_at } = req.body;
  if (!entity_slug) return res.status(400).json({ error: 'entity_slug required' });

  const { data: entity } = await getDb().from('entity').select('slug').eq('slug', entity_slug).maybeSingle();
  if (!entity) return res.status(404).json({ error: 'No entity with that slug' });

  const { data, error } = await getDb().from('page_rail_items').insert({
    rail_id: req.params.id,
    entity_slug,
    sort_order: sort_order ?? 0,
    is_ad: is_ad !== false,
    badge_text: badge_text || null,
    starts_at: starts_at || null,
    ends_at: ends_at || null,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, item: data });
});

// PUT /api/admin/gcr/page-rail-items/:id — update a sponsored slot (reorder, change dates/badge)
router.put('/gcr/page-rail-items/:id', authRequired, async (req, res) => {
  const { sort_order, is_ad, badge_text, starts_at, ends_at } = req.body;
  const updates = {};
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (is_ad !== undefined) updates.is_ad = !!is_ad;
  if (badge_text !== undefined) updates.badge_text = badge_text;
  if (starts_at !== undefined) updates.starts_at = starts_at;
  if (ends_at !== undefined) updates.ends_at = ends_at;

  const { data, error } = await getDb().from('page_rail_items').update(updates).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, item: data });
});

// DELETE /api/admin/gcr/page-rail-items/:id — remove a business from a sponsored rail
router.delete('/gcr/page-rail-items/:id', authRequired, async (req, res) => {
  const { error } = await getDb().from('page_rail_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── AI Provider Config — admin control of which AI does what ─────────────────
const { invalidateCache: invalidateAICache, PROVIDERS } = require('../utils/ai-provider')

// GET /api/admin/ai-config — get all task configs + available providers/models
router.get('/ai-config', authRequired, async (req, res) => {
  const { data, error } = await getDb().from('ai_provider_config').select('*').order('task')
  if (error) return res.status(500).json({ error: error.message })
  res.json({ configs: data || [], providers: PROVIDERS })
})

// PUT /api/admin/ai-config/:task — update which AI handles a task
router.put('/ai-config/:task', authRequired, async (req, res) => {
  const { provider, model, is_active, notes } = req.body
  if (!provider || !model) return res.status(400).json({ error: 'provider and model required' })

  const { data, error } = await getDb().from('ai_provider_config').upsert({
    task: req.params.task,
    provider,
    model,
    is_active: is_active !== false,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'task' }).select('*').single()

  if (error) return res.status(500).json({ error: error.message })

  invalidateAICache()
  res.json({ success: true, config: data })
})

// ── PHOTO REPAIR — heal phantom entity_photos rows ────────────────────────────
// Legacy import runs (June 3–6, predates this session) wrote entity_photos.url
// pointing at predictable Supabase Storage paths (.../entity-photos/<slug>/photo_01.jpg)
// for ~1,266 businesses without ever uploading the file — the row exists, the
// URL looks real, but storage.objects has nothing there, so every image 404s
// and profiles fall back to the emoji hero. 99% of those businesses already
// carry real Google Places photo references in entity.google_places_data —
// this endpoint fetches those (using the same GOOGLE_PLACES_API_KEY the
// find-place-ids.js / fix-wolf-bay-full.js scripts already use) and uploads
// them into storage at the EXACT path each phantom row already references, so
// the existing URL heals with no other row changes. Idempotent + resumable:
// repaired entities drop out of the phantom-detection query on their own, so
// calling this repeatedly with no state tracking converges to zero remaining.
// Storage paths follow <slug>/<filename> (one level), so per-entity existence
// checks use the real Storage API (list() with a folder prefix) rather than
// querying storage.objects directly — PostgREST doesn't expose the storage
// schema, only the dedicated Storage endpoint does.
async function candidateRowsBySlug(db, slugFilter) {
  let q = db
    .from('entity_photos')
    .select('id,entity_slug,url,sort_order')
    .like('url', '%/entity-photos/%')
    .order('entity_slug').order('sort_order');
  if (slugFilter) q = q.in('entity_slug', slugFilter);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const pathOf = (url) => decodeURIComponent(url.split('/entity-photos/')[1] || '');
  const bySlug = new Map();
  for (const p of data || []) {
    const path = pathOf(p.url);
    const filename = path.split('/').slice(1).join('/');
    if (!path || !filename) continue;
    if (!bySlug.has(p.entity_slug)) bySlug.set(p.entity_slug, []);
    bySlug.get(p.entity_slug).push({ ...p, path, filename });
  }
  return bySlug;
}

// Confirms which candidate rows for ONE slug are actually phantom (storage
// list() only checked for the slugs we're about to process, not all ~1,266 —
// checking every slug up front would be 1,266 Storage API calls per status
// call, too slow for a status probe).
async function phantomRowsForSlug(db, slug, rows) {
  const { data: existing, error } = await db.storage.from('entity-photos').list(slug, { limit: 1000 });
  if (error) throw new Error(`storage.list(${slug}) failed: ` + error.message);
  const realFilenames = new Set((existing || []).map(o => o.name));
  return rows.filter(r => !realFilenames.has(r.filename));
}

router.get('/repair-photos/status', authRequired, async (req, res) => {
  try {
    const bySlug = await candidateRowsBySlug(getDb());
    res.json({
      note: 'These are pattern-matched candidates (URL points at our bucket) — not yet confirmed against Storage, which POST /api/admin/repair-photos checks per batch as it processes. Call POST repeatedly (default 8 entities/call) until it reports done:true.',
      candidate_entities: bySlug.size,
      candidate_photo_rows: [...bySlug.values()].reduce((s, a) => s + a.length, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/repair-photos', authRequired, async (req, res) => {
  const db = getDb();
  const KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });

  const entityLimit = Math.min(parseInt(req.body?.limit) || 8, 20);
  const startAfter = req.body?.after_slug || null; // pagination cursor for large runs

  try {
    const allCandidates = await candidateRowsBySlug(db);
    let candidateSlugs = [...allCandidates.keys()].sort();
    if (startAfter) candidateSlugs = candidateSlugs.filter(s => s > startAfter);
    const batchSlugs = candidateSlugs.slice(0, entityLimit);

    const { data: entities } = batchSlugs.length
      ? await db.from('entity').select('slug,google_places_data').in('slug', batchSlugs)
      : { data: [] };
    const placesBySlug = new Map((entities || []).map(e => [e.slug, e.google_places_data]));

    let repaired = 0, deleted = 0, alreadyOk = 0;
    const errors = [];

    for (const slug of batchSlugs) {
      const candidateRows = allCandidates.get(slug);
      let rows;
      try {
        rows = await phantomRowsForSlug(db, slug, candidateRows);
      } catch (e) {
        errors.push({ slug, reason: e.message });
        continue;
      }
      alreadyOk += candidateRows.length - rows.length;
      const photos = placesBySlug.get(slug)?.photos || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const gphoto = photos[i];
        if (!gphoto?.name) {
          // No real photo available for this row — delete rather than leave a
          // permanently-broken image tile on the profile.
          const { error: delErr } = await db.from('entity_photos').delete().eq('id', row.id);
          if (delErr) errors.push({ slug, id: row.id, reason: 'delete failed: ' + delErr.message });
          else deleted++;
          continue;
        }
        try {
          const mediaUrl = `https://places.googleapis.com/v1/${gphoto.name}/media?maxWidthPx=1600&key=${KEY}`;
          const r = await fetch(mediaUrl, { redirect: 'follow' });
          if (!r.ok) { errors.push({ slug, id: row.id, reason: `places fetch ${r.status}` }); continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 500) { errors.push({ slug, id: row.id, reason: 'empty response' }); continue; }
          const contentType = r.headers.get('content-type') || 'image/jpeg';
          const { error: upErr } = await db.storage.from('entity-photos').upload(row.path, buf, { contentType, upsert: true });
          if (upErr) { errors.push({ slug, id: row.id, reason: 'upload failed: ' + upErr.message }); continue; }
          repaired++;
        } catch (e) {
          errors.push({ slug, id: row.id, reason: String(e.message || e).slice(0, 150) });
        }
      }
    }

    res.json({
      entities_processed: batchSlugs.length,
      photos_repaired: repaired,
      rows_already_had_real_file: alreadyOk,
      unrecoverable_rows_deleted: deleted,
      candidate_entities_remaining: candidateSlugs.length - batchSlugs.length,
      next_after_slug: batchSlugs.length ? batchSlugs[batchSlugs.length - 1] : null,
      errors: errors.slice(0, 30),
      done: candidateSlugs.length <= entityLimit,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REHOST EXTERNAL PHOTOS — permanently save third-party CDN images ─────────
// Instagram/Facebook CDN URLs (scontent-*.cdninstagram.com etc.) are signed
// and expire — any entity_photos row pointing straight at one will eventually
// 404. This downloads each given URL once and re-uploads it into our own
// entity-photos storage bucket (same bucket/convention repair-photos above
// uses), then writes an entity_photos row pointing at the new, permanent
// Supabase URL. Source URL is fetched server-side (this API has normal
// internet egress, unlike a sandboxed dev session), so this is meant to be
// called soon after the source URLs are collected, before they expire.
router.post('/gcr/rehost-photos', authRequired, async (req, res) => {
  const db = getDb();
  const { entity_slug, urls } = req.body || {};
  if (!entity_slug || !Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: 'entity_slug and a non-empty urls[] are required' });
  }

  const { data: existing } = await db.storage.from('entity-photos').list(entity_slug, { limit: 1000 });
  const existingNums = (existing || [])
    .map(o => parseInt((o.name.match(/photo_(\d+)\./) || [])[1], 10))
    .filter(n => !isNaN(n));
  let nextNum = (existingNums.length ? Math.max(...existingNums) : 0) + 1;

  const { data: existingRows } = await db.from('entity_photos').select('sort_order').eq('entity_slug', entity_slug);
  let nextSort = (existingRows || []).reduce((m, r) => Math.max(m, r.sort_order || 0), 0) + 1;

  const results = [];
  for (const sourceUrl of urls) {
    try {
      const r = await fetch(sourceUrl, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { results.push({ sourceUrl, ok: false, reason: `fetch ${r.status}` }); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 500) { results.push({ sourceUrl, ok: false, reason: 'empty response' }); continue; }
      const contentType = r.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const filename = `photo_${String(nextNum).padStart(2, '0')}.${ext}`;
      const path = `${entity_slug}/${filename}`;

      const { error: upErr } = await db.storage.from('entity-photos').upload(path, buf, { contentType, upsert: true });
      if (upErr) { results.push({ sourceUrl, ok: false, reason: 'upload failed: ' + upErr.message }); continue; }

      const { data: { publicUrl } } = db.storage.from('entity-photos').getPublicUrl(path);
      const { error: insErr } = await db.from('entity_photos').insert({ entity_slug, url: publicUrl, sort_order: nextSort });
      if (insErr) { results.push({ sourceUrl, ok: false, reason: 'row insert failed: ' + insErr.message }); continue; }

      results.push({ sourceUrl, ok: true, storedUrl: publicUrl });
      nextNum++; nextSort++;
    } catch (e) {
      results.push({ sourceUrl, ok: false, reason: String(e.message || e).slice(0, 150) });
    }
  }

  const stored = results.filter(r => r.ok).length;
  res.json({ entity_slug, requested: urls.length, stored, failed: urls.length - stored, results });
});

module.exports = router;

// ── SOCIAL POSTS — paste FB/IG URLs, each becomes a card ──────────────────────

// POST /api/admin/social-posts/scrape
// Body: { urls: ["https://fb.com/...", "https://instagram.com/p/..."] }
// Scrapes each URL via oEmbed and saves to social_posts table
router.post('/social-posts/scrape', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { urls, entity_slug, card_type = 'post', show_on_home = true } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'urls array required' });
    }

    const results = [];

    for (const rawUrl of urls) {
      const url = rawUrl.trim();
      if (!url) continue;

      try {
        const isFacebook = url.includes('facebook.com') || url.includes('fb.com') || url.includes('fb.watch');
        const isInstagram = url.includes('instagram.com');

        let image_url = null;
        let caption = null;
        let author_name = null;
        let author_url = null;
        let source = 'manual';

        if (isInstagram) {
          source = 'instagram';
          // Instagram oEmbed — gives thumbnail + caption
          const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${process.env.FB_APP_ID}|${process.env.FB_APP_SECRET}`;
          try {
            const r = await fetch(oembedUrl);
            if (r.ok) {
              const data = await r.json();
              image_url = data.thumbnail_url || null;
              caption = data.title || null;
              author_name = data.author_name || null;
              author_url = data.author_url || null;
            }
          } catch {}

          // Fallback: public oembed without token (works for public posts)
          if (!image_url) {
            try {
              const r2 = await fetch(`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}`);
              if (r2.ok) {
                const data = await r2.json();
                image_url = data.thumbnail_url || null;
                caption = data.title || null;
                author_name = data.author_name || null;
                author_url = data.author_url || null;
              }
            } catch {}
          }

        } else if (isFacebook) {
          source = 'facebook';
          // Facebook oEmbed — only gives author_name, no image
          try {
            const oembedUrl = `https://www.facebook.com/plugins/post/oembed.json/?url=${encodeURIComponent(url)}`;
            const r = await fetch(oembedUrl);
            if (r.ok) {
              const data = await r.json();
              author_name = data.author_name || null;
              author_url = data.author_url || null;
            }
          } catch {}
        }

        // Extract entity name from URL if no author
        // facebook.com/BusinessName/posts/123 → "BusinessName"
        // instagram.com/p/CODE → use author_name
        let card_entity_name = author_name;
        if (!card_entity_name) {
          const fbMatch = url.match(/facebook\.com\/([^\/\?]+)\//);
          if (fbMatch && fbMatch[1] !== 'permalink.php' && fbMatch[1] !== 'groups') {
            card_entity_name = fbMatch[1].replace(/\./g, ' ');
          }
        }

        // Upsert to social_posts
        const { data: post, error } = await db.from('social_posts').upsert({
          post_url: url,
          source,
          entity_slug: entity_slug || null,
          image_url,
          caption,
          author_name,
          author_url,
          card_type,
          card_entity_name,
          show_on_home,
          show_on_profile: !!entity_slug,
          is_active: true,
          created_by: 'admin',
          post_date: new Date().toISOString(),
        }, { onConflict: 'post_url' }).select().single();

        results.push({
          url,
          success: !error,
          id: post?.id,
          image_url,
          caption: caption?.slice(0, 80),
          author_name,
          card_entity_name,
          error: error?.message,
        });

      } catch (e) {
        results.push({ url, success: false, error: e.message });
      }
    }

    res.json({ processed: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/social-posts  — manually add/edit a post (with your own image + caption)
router.post('/social-posts', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const {
      post_url, image_url, caption, card_title, card_entity_name,
      card_type = 'post', entity_slug, card_city, source = 'manual',
      show_on_home = true, show_on_profile = false, post_date,
    } = req.body;

    if (!post_url && !image_url) {
      return res.status(400).json({ error: 'post_url or image_url required' });
    }

    const { data, error } = await db.from('social_posts').upsert({
      post_url: post_url || `manual:${Date.now()}`,
      source,
      entity_slug: entity_slug || null,
      image_url: image_url || null,
      caption: caption || null,
      card_title: card_title || null,
      card_entity_name: card_entity_name || null,
      card_city: card_city || null,
      card_type,
      show_on_home,
      show_on_profile,
      is_active: true,
      created_by: 'admin',
      post_date: post_date || new Date().toISOString(),
    }, { onConflict: 'post_url' }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/social-posts — list all posts
router.get('/social-posts', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { entity_slug, source, card_type, limit = 50 } = req.query;
    let q = db.from('social_posts').select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (entity_slug) q = q.eq('entity_slug', entity_slug);
    if (source) q = q.eq('source', source);
    if (card_type) q = q.eq('card_type', card_type);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/social-posts/:id — update a post (add image, change card_type, link entity)
router.put('/social-posts/:id', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const allowed = ['image_url','caption','card_title','card_entity_name','card_city','card_type','entity_slug','show_on_home','show_on_profile','is_active','post_date'];
    const updates = {};
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    const { data, error } = await db.from('social_posts').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/social-posts/:id
router.delete('/social-posts/:id', authRequired, async (req, res) => {
  try {
    const db = getDb();
    const { error } = await db.from('social_posts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
