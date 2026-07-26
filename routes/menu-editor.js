// Menu Editor — PIN-protected, accessible via URL link
// URL: /menu-editor.html?slug=restaurant-slug
// Auth: POST /api/menu-editor/:slug/auth with { pin }

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { logEdit } = require('../lib/edit-log');
const { analyzePhoto } = require('../lib/analyze-photo');

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

  // The PIN is shared by the whole business, not a per-person credential, so
  // there's no real identity to attach to edits made through it yet (that
  // arrives once the dashboard/SMS side is wired to business_staff). Until
  // then, whoever is behind the PIN can optionally say who they are so the
  // audit log isn't just "someone edited this" — same header the frontend's
  // "who's editing" prompt sends.
  req.actorName = req.headers['x-actor-name'] || req.body?.actor_name || null;

  // Admin bypass — if admin token is present, allow access
  if (adminToken) {
    req.entitySlug = slug;
    req.actorRole = 'admin';
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
  req.actorRole = 'owner';
  next();
}

// Shared logEdit() call shaped for this router's req — every write route
// passes req plus what changed so the channel/actor fields are never typed
// out by hand at each call site.
function log(req, fields) {
  return logEdit({
    entity_slug: req.entitySlug,
    channel: 'menu_editor',
    actor_name: req.actorName,
    actor_role: req.actorRole,
    ...fields,
  });
}

// ─── POST /api/menu-editor/create ──────────────────────────────────────────────
// Create a brand-new entity from the menu editor's "New Restaurant" / AI-onboard flow.
// Body: { name, slug?, tagline?, icon?, pin?, ai_data?, ai_summary? }
//   - slug: optional explicit slug (from pages/new.js); auto-generated from name if absent
//   - pin: optional explicit PIN (from pages/new.js); random 4-digit if absent (AI flow)
// Returns: { success, slug, pin, token, name }
router.post('/create', async (req, res) => {
  try {
    const { name, slug: requestedSlug, tagline, icon, pin: requestedPin, ai_data, ai_summary } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Restaurant name required' });

    // Build a URL-safe slug from the provided one or derive from name
    const baseSlug = (requestedSlug || name)
      .toString().toLowerCase().trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!baseSlug) return res.status(400).json({ error: 'Could not derive a valid slug' });

    // This form only collects a name (no phone/place id), so the strongest
    // duplicate check available is an exact name match. Block it outright
    // rather than silently minting a "-2" slug for what's likely the same
    // restaurant signing up twice, or a name collision with an
    // already-imported business — surface it so a human decides.
    const { data: nameMatch } = await db.from('entity').select('slug').ilike('name', String(name).trim()).limit(1).maybeSingle();
    if (nameMatch) {
      return res.status(409).json({ error: `A business named "${name}" already exists (slug: ${nameMatch.slug}). Contact support to get access to that profile instead of creating a duplicate.` });
    }

    // Ensure slug is unique — append -2, -3, etc. if taken
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
      const { data: existing } = await db.from('entity').select('slug').eq('slug', slug).maybeSingle();
      if (!existing) break;
      slug = `${baseSlug}-${suffix++}`;
      if (suffix > 50) return res.status(409).json({ error: 'Could not generate a unique slug' });
    }

    // PIN: use requested 4-digit PIN if valid, otherwise generate a random one
    let pin = requestedPin && /^\d{4}$/.test(String(requestedPin)) ? String(requestedPin) : null;
    if (!pin) pin = String(Math.floor(1000 + Math.random() * 9000));

    const insertRow = {
      slug,
      name: String(name).trim(),
      subtitle: tagline || null,
      icon: icon || '🍽️',
      entity_type: 'restaurant',
      entity_subtype: 'restaurant',
      menu_pin: pin,
      is_active: true,
    };
    // Stash AI onboarding chat/summary in description so nothing is lost, if provided
    if (ai_summary) insertRow.description = typeof ai_summary === 'string' ? ai_summary : JSON.stringify(ai_summary);

    const { data: created, error } = await db.from('entity').insert(insertRow).select('slug, name').single();
    if (error) return res.status(500).json({ error: error.message });

    logEdit({ entity_slug: created.slug, channel: 'menu_editor', actor_role: 'owner', action: 'create', table_name: 'entity', record_id: created.slug, new_value: insertRow });

    const token = makeToken(created.slug, pin);
    res.json({ success: true, slug: created.slug, name: created.name, pin, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ─── BUSINESS-TYPE TAB MANIFEST ───────────────────────────────────────────────
// The editor used to always assume "restaurant" — same 12 tabs no matter what
// business the slug belonged to, so a charter/marina would just get empty
// Menu/Drinks/Happy Hour tabs instead of anything relevant to them. This maps
// entity_type/entity_subtype to which tabs actually apply, using columns that
// already exist on `entity` (fuel_options, daily_capacity, capacity_per_slot)
// and the existing business_availability table — no new schema needed beyond
// what 006_staff_editor_and_audit_log.sql already added.
const RESTAURANT_TYPES = new Set(['restaurant', 'coffee', 'dessert', 'bakery']);
const BOOKABLE_TYPES = new Set(['activity', 'hotel', 'condo', 'vacation-rental']);
const BOOKABLE_SUBTYPES = new Set([
  'fishing_charter', 'dolphin_cruise', 'boat_rental', 'kayak_rental', 'jet_ski',
  'tour_agency', 'travel_agency', 'tourist_attraction', 'golf_course', 'campground',
]);

function buildTabManifest(entity) {
  const tabs = ['today', 'gallery', 'share', 'specials', 'events', 'hours', 'business', 'preview'];
  const isRestaurant = RESTAURANT_TYPES.has(entity.entity_type);
  const isBookable = BOOKABLE_TYPES.has(entity.entity_type) || BOOKABLE_SUBTYPES.has(entity.entity_subtype);
  const isMarina = entity.entity_subtype === 'marina';

  if (isRestaurant) tabs.splice(1, 0, 'menu', 'drinks', 'happyHour', 'sides', 'daily');
  if (isBookable) tabs.splice(1, 0, 'availability');
  if (isMarina) tabs.splice(1, 0, 'fuel');
  return tabs;
}

// ─── GET /api/menu-editor/:slug/data ──────────────────────────────────────────
// Load all menu data for the editor
router.get('/:slug/data', pinAuth, async (req, res) => {
  const slug = req.entitySlug;

  // Try extended select (includes rotating_sections + theme if columns exist)
  let entity;
  const { data: entityFull, error: entitySelErr } = await db.from('entity')
    .select('id, slug, name, description, hero_image_url, phone, website_url, address_line_1, hh_days, hh_start, hh_end, hh_description, gallery_sections, rotating_sections, theme, entity_type, entity_subtype, fuel_options, daily_capacity, capacity_per_slot, price_from, price_to, price_unit')
    .eq('slug', slug).single();
  if (entitySelErr && (entitySelErr.code === '42703' || (entitySelErr.message || '').includes('does not exist'))) {
    const { data } = await db.from('entity').select('id, slug, name, description, hero_image_url, phone, website_url, address_line_1, hh_days, hh_start, hh_end, hh_description, gallery_sections, entity_type, entity_subtype, fuel_options, daily_capacity, capacity_per_slot, price_from, price_to, price_unit').eq('slug', slug).single();
    entity = data;
  } else {
    entity = entityFull;
  }
  if (!entity) return res.status(404).json({ error: 'Not found' });

  const [menuSections, drinkSections, hhSections, specials, events, hours, sides, dailyFeatures, photos, availability] = await Promise.all([
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_sides').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_daily_features').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('business_availability').select('*').eq('entity_slug', slug).gte('availability_date', new Date().toISOString().slice(0, 10)).order('availability_date').order('time_slot'),
  ]);

  const [menuItems, drinkItems, hhItems] = await Promise.all([
    (menuSections.data || []).length ? db.from('menu_items').select('*').in('section_id', (menuSections.data || []).map(s => s.id)).order('id') : { data: [] },
    (drinkSections.data || []).length ? db.from('drink_items').select('*').in('section_id', (drinkSections.data || []).map(s => s.id)).order('id') : { data: [] },
    (hhSections.data || []).length ? db.from('happy_hour_items').select('*').in('section_id', (hhSections.data || []).map(s => s.id)).order('id') : { data: [] },
  ]);

  // Dietary tags per item, so the editor shows current state without an
  // extra round trip per row. Keyed by fk column so each item type's tags
  // attach to the right rows below.
  const [menuTagRows, drinkTagRows, hhTagRows] = await Promise.all([
    (menuItems.data || []).length ? db.from('menu_item_dietary_tags').select('menu_item_id, tag:dietary_tag_id(id, name, icon)').in('menu_item_id', menuItems.data.map(i => i.id)) : { data: [] },
    (drinkItems.data || []).length ? db.from('drink_item_dietary_tags').select('drink_item_id, tag:dietary_tag_id(id, name, icon)').in('drink_item_id', drinkItems.data.map(i => i.id)) : { data: [] },
    (hhItems.data || []).length ? db.from('happy_hour_item_dietary_tags').select('happy_hour_item_id, tag:dietary_tag_id(id, name, icon)').in('happy_hour_item_id', hhItems.data.map(i => i.id)) : { data: [] },
  ]);
  const tagsByFk = (rows, fk) => {
    const map = {};
    (rows || []).forEach(r => { (map[r[fk]] = map[r[fk]] || []).push(r.tag); });
    return map;
  };
  const menuTagsById = tagsByFk(menuTagRows.data, 'menu_item_id');
  const drinkTagsById = tagsByFk(drinkTagRows.data, 'drink_item_id');
  const hhTagsById = tagsByFk(hhTagRows.data, 'happy_hour_item_id');

  res.json({
    entity,
    tabs: buildTabManifest(entity),
    hours: hours.data || [],
    menu_sections: (menuSections.data || []).map(s => ({ ...s, items: (menuItems.data || []).filter(i => i.section_id === s.id).map(i => ({ ...i, dietary_tags: menuTagsById[i.id] || [] })) })),
    drink_sections: (drinkSections.data || []).map(s => ({ ...s, items: (drinkItems.data || []).filter(i => i.section_id === s.id).map(i => ({ ...i, dietary_tags: drinkTagsById[i.id] || [] })) })),
    happy_hour_sections: (hhSections.data || []).map(s => ({ ...s, items: (hhItems.data || []).filter(i => i.section_id === s.id).map(i => ({ ...i, dietary_tags: hhTagsById[i.id] || [] })) })),
    specials: specials.data || [],
    events: events.data || [],
    sides: sides.data || [],
    daily_features: dailyFeatures.data || [],
    entity_photos: photos.data || [],
    gallery_sections: entity?.gallery_sections || [],
    availability: availability.data || [],
  });
});

// ─── AVAILABILITY / "SPOTS REMAINING" ─────────────────────────────────────────
// business_availability already existed (total_capacity/booked_count/
// remaining_spots/status) but had no self-serve write path — 100% admin-only.
// These let the business itself post "2 spots left on the 4pm charter" the
// same way they'd post a special.

router.post('/:slug/availability', pinAuth, async (req, res) => {
  const { availability_date, time_slot, end_time, total_capacity, booked_count, status, last_minute_deal, last_minute_price } = req.body;
  if (!availability_date) return res.status(400).json({ error: 'availability_date required' });
  const remaining_spots = total_capacity != null ? Math.max(0, total_capacity - (booked_count || 0)) : null;
  const { data, error } = await db.from('business_availability').insert({
    entity_slug: req.entitySlug, availability_date, time_slot: time_slot || null, end_time: end_time || null,
    total_capacity: total_capacity ?? null, booked_count: booked_count || 0, remaining_spots,
    status: status || (remaining_spots === 0 ? 'full' : 'available'),
    last_minute_deal: last_minute_deal || null, last_minute_price: last_minute_price != null ? parseFloat(last_minute_price) : null,
    source_platform: 'menu_editor',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'business_availability', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/availability/:id', pinAuth, async (req, res) => {
  const { availability_date, time_slot, end_time, total_capacity, booked_count, status, last_minute_deal, last_minute_price } = req.body;
  const update = { last_updated: new Date().toISOString() };
  if (availability_date !== undefined) update.availability_date = availability_date;
  if (time_slot !== undefined) update.time_slot = time_slot;
  if (end_time !== undefined) update.end_time = end_time;
  if (total_capacity !== undefined) update.total_capacity = total_capacity;
  if (booked_count !== undefined) update.booked_count = booked_count;
  if (last_minute_deal !== undefined) update.last_minute_deal = last_minute_deal;
  if (last_minute_price !== undefined) update.last_minute_price = last_minute_price != null ? parseFloat(last_minute_price) : null;
  if (total_capacity !== undefined || booked_count !== undefined) {
    const { data: existing } = await db.from('business_availability').select('total_capacity, booked_count').eq('id', req.params.id).single();
    const cap = total_capacity !== undefined ? total_capacity : existing?.total_capacity;
    const booked = booked_count !== undefined ? booked_count : (existing?.booked_count || 0);
    update.remaining_spots = cap != null ? Math.max(0, cap - booked) : null;
  }
  if (status !== undefined) update.status = status;
  else if (update.remaining_spots === 0) update.status = 'full';
  const { data, error } = await db.from('business_availability').update(update).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'business_availability', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/availability/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('business_availability').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'business_availability', record_id: req.params.id });
  res.json({ success: true });
});

// ─── FUEL / PRICING (marina-style businesses) ─────────────────────────────────
// entity.fuel_options is an existing jsonb column (Google Places import used
// it for gas-station-shaped data) — reused here as a small free-form list of
// { name, price, unit, updated_at } so a marina can update fuel prices the
// same way a restaurant updates a menu price.

router.put('/:slug/fuel', pinAuth, async (req, res) => {
  const { fuel_options } = req.body;
  if (!Array.isArray(fuel_options)) return res.status(400).json({ error: 'fuel_options must be an array' });
  const stamped = fuel_options.map(f => ({ ...f, updated_at: new Date().toISOString() }));
  const { error } = await db.from('entity').update({ fuel_options: stamped, updated_at: new Date().toISOString() }).eq('slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'entity', record_id: req.entitySlug, field_name: 'fuel_options', new_value: stamped });
  res.json({ success: true, fuel_options: stamped });
});

// ─── MENU SECTIONS ────────────────────────────────────────────────────────────

router.post('/:slug/menu-sections', pinAuth, async (req, res) => {
  const { section_name, sort_order, meal_period, description, default_accompaniment, substitution_notes, source } = req.body;
  const { data, error } = await db.from('menu_sections').insert({
    entity_slug: req.entitySlug, section_name, sort_order: sort_order || 0,
    meal_period: meal_period || null, description: description || null,
    default_accompaniment: default_accompaniment || null, substitution_notes: substitution_notes || null, source: source || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'menu_sections', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/menu-sections/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['section_name','sort_order','meal_period','description','default_accompaniment','substitution_notes','source'].forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await db.from('menu_sections').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'menu_sections', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/menu-sections/:id', pinAuth, async (req, res) => {
  await db.from('menu_items').delete().eq('section_id', req.params.id);
  const { error } = await db.from('menu_sections').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'menu_sections', record_id: req.params.id });
  res.json({ success: true });
});

// ─── MENU ITEMS ───────────────────────────────────────────────────────────────

router.post('/:slug/menu-items', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url, source } = req.body;
  const { data, error } = await db.from('menu_items').insert({ entity_slug: req.entitySlug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, tags: tags || null, image_url: image_url || null, source: source || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'menu_items', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/menu-items/:id', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, tags, image_url, source } = req.body;
  const patch = { item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, tags: tags || null, image_url: image_url || null };
  if (source !== undefined) patch.source = source;
  const { data, error } = await db.from('menu_items').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'menu_items', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/menu-items/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('menu_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'menu_items', record_id: req.params.id });
  res.json({ success: true });
});

// ─── DIETARY TAGS ─────────────────────────────────────────────────────────────
// Same catalog + join tables as /api/admin/gcr/dietary-tags — this is just the
// PIN-scoped write path onto the identical tables, so a business editing
// through its own PIN link and an admin editing through the dashboard are
// changing the exact same rows, not two different systems.
const DIETARY_ITEM_TABLES = {
  'menu-items': { itemTable: 'menu_items', joinTable: 'menu_item_dietary_tags', fk: 'menu_item_id' },
  'drink-items': { itemTable: 'drink_items', joinTable: 'drink_item_dietary_tags', fk: 'drink_item_id' },
  'hh-items': { itemTable: 'happy_hour_items', joinTable: 'happy_hour_item_dietary_tags', fk: 'happy_hour_item_id' },
};

router.get('/:slug/dietary-tags', pinAuth, async (req, res) => {
  const { data, error } = await db.from('dietary_tags').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

Object.entries(DIETARY_ITEM_TABLES).forEach(([urlKey, { itemTable, joinTable, fk }]) => {
  router.post(`/:slug/${urlKey}/:id/dietary-tags`, pinAuth, async (req, res) => {
    const { dietary_tag_id } = req.body;
    if (!dietary_tag_id) return res.status(400).json({ error: 'dietary_tag_id required' });
    // Same ownership guard as every other route in this file — confirm the
    // item actually belongs to the entity this PIN token is scoped to before
    // touching the join table (it has no entity_slug column of its own).
    const { data: item } = await db.from(itemTable).select('entity_slug').eq('id', req.params.id).maybeSingle();
    if (!item || item.entity_slug !== req.entitySlug) return res.status(404).json({ error: 'Item not found' });
    const row = { [fk]: req.params.id, dietary_tag_id };
    const { data, error } = await db.from(joinTable).upsert(row, { onConflict: `${fk},dietary_tag_id` }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    log(req, { action: 'create', table_name: joinTable, record_id: data.id, new_value: data });
    res.status(201).json(data);
  });

  router.delete(`/:slug/${urlKey}/:id/dietary-tags/:tagId`, pinAuth, async (req, res) => {
    const { data: item } = await db.from(itemTable).select('entity_slug').eq('id', req.params.id).maybeSingle();
    if (!item || item.entity_slug !== req.entitySlug) return res.status(404).json({ error: 'Item not found' });
    const { error } = await db.from(joinTable).delete().eq(fk, req.params.id).eq('dietary_tag_id', req.params.tagId);
    if (error) return res.status(500).json({ error: error.message });
    log(req, { action: 'delete', table_name: joinTable, record_id: req.params.id });
    res.json({ success: true });
  });
});

// ─── MODIFIER OPTION GROUPS ────────────────────────────────────────────────────
router.get('/:slug/option-groups', pinAuth, async (req, res) => {
  const { data, error } = await db.from('menu_item_option_groups').select('*').eq('entity_slug', req.entitySlug).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/:slug/option-groups', pinAuth, async (req, res) => {
  const { menu_item_id, label, required, min_picks, max_picks, sort_order } = req.body;
  if (!label) return res.status(400).json({ error: 'label required' });
  const { data, error } = await db.from('menu_item_option_groups').insert({
    entity_slug: req.entitySlug, menu_item_id: menu_item_id || null, label,
    required: required || false, min_picks: min_picks || 0, max_picks: max_picks ?? null, sort_order: sort_order || 0,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'menu_item_option_groups', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/option-groups/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['label','required','min_picks','max_picks','sort_order','menu_item_id'].forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await db.from('menu_item_option_groups').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'menu_item_option_groups', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/option-groups/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('menu_item_option_groups').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'menu_item_option_groups', record_id: req.params.id });
  res.json({ success: true });
});

// ─── DRINK OPTION GROUPS (Size, and any other required pick-one/pick-N rule) ──
// Same shape as menu_item_option_groups above, for drink_items instead.
// drink_item_id is required — unlike menu_item_option_groups there's no
// reusable business-level (item-less) group on the drinks side.
router.get('/:slug/drink-option-groups', pinAuth, async (req, res) => {
  const { data, error } = await db.from('drink_item_option_groups').select('*').eq('entity_slug', req.entitySlug).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/:slug/drink-option-groups', pinAuth, async (req, res) => {
  const { drink_item_id, label, required, min_picks, max_picks, sort_order } = req.body;
  if (!drink_item_id) return res.status(400).json({ error: 'drink_item_id required' });
  if (!label) return res.status(400).json({ error: 'label required' });
  const { data, error } = await db.from('drink_item_option_groups').insert({
    entity_slug: req.entitySlug, drink_item_id, label,
    required: required || false, min_picks: min_picks || 0, max_picks: max_picks ?? null, sort_order: sort_order || 0,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'drink_item_option_groups', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/drink-option-groups/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['label','required','min_picks','max_picks','sort_order'].forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await db.from('drink_item_option_groups').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'drink_item_option_groups', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/drink-option-groups/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('drink_item_option_groups').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'drink_item_option_groups', record_id: req.params.id });
  res.json({ success: true });
});

// ─── MEAL PERIODS ──────────────────────────────────────────────────────────────
router.get('/:slug/meal-periods', pinAuth, async (req, res) => {
  const { data, error } = await db.from('menu_periods').select('*').eq('entity_slug', req.entitySlug).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/:slug/meal-periods', pinAuth, async (req, res) => {
  const { name, days_of_week, start_time, end_time, sort_order } = req.body;
  if (!name || !days_of_week || !start_time || !end_time) return res.status(400).json({ error: 'name, days_of_week, start_time, end_time required' });
  const { data, error } = await db.from('menu_periods').insert({ entity_slug: req.entitySlug, name, days_of_week, start_time, end_time, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'menu_periods', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/meal-periods/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['name','days_of_week','start_time','end_time','sort_order'].forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await db.from('menu_periods').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'menu_periods', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/meal-periods/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('menu_periods').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'menu_periods', record_id: req.params.id });
  res.json({ success: true });
});

// ─── DRESSINGS ─────────────────────────────────────────────────────────────────
router.get('/:slug/dressings', pinAuth, async (req, res) => {
  const { data, error } = await db.from('dressings').select('*').eq('entity_slug', req.entitySlug).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/:slug/dressings', pinAuth, async (req, res) => {
  const { name, price, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await db.from('dressings').insert({ entity_slug: req.entitySlug, name, price: price != null ? parseFloat(price) : 0, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'dressings', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/dressings/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['name','price','sort_order'].forEach(k => { if (req.body[k] !== undefined) patch[k] = k === 'price' ? parseFloat(req.body[k]) : req.body[k]; });
  const { data, error } = await db.from('dressings').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'dressings', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/dressings/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('dressings').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'dressings', record_id: req.params.id });
  res.json({ success: true });
});

router.post('/:slug/menu-items/:id/dressings', pinAuth, async (req, res) => {
  const { dressing_id } = req.body;
  if (!dressing_id) return res.status(400).json({ error: 'dressing_id required' });
  const { data: item } = await db.from('menu_items').select('entity_slug').eq('id', req.params.id).maybeSingle();
  if (!item || item.entity_slug !== req.entitySlug) return res.status(404).json({ error: 'Item not found' });
  const { data, error } = await db.from('menu_item_dressings').upsert({ menu_item_id: req.params.id, dressing_id }, { onConflict: 'menu_item_id,dressing_id' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'menu_item_dressings', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.delete('/:slug/menu-items/:id/dressings/:dressingId', pinAuth, async (req, res) => {
  const { data: item } = await db.from('menu_items').select('entity_slug').eq('id', req.params.id).maybeSingle();
  if (!item || item.entity_slug !== req.entitySlug) return res.status(404).json({ error: 'Item not found' });
  const { error } = await db.from('menu_item_dressings').delete().eq('menu_item_id', req.params.id).eq('dressing_id', req.params.dressingId);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'menu_item_dressings', record_id: req.params.id });
  res.json({ success: true });
});

// ─── CHANNEL-SPECIFIC PRICING ──────────────────────────────────────────────────
const CHANNEL_PRICE_TABLES = {
  'menu-items': { itemTable: 'menu_items', priceTable: 'menu_item_channel_prices', fk: 'menu_item_id' },
  'drink-items': { itemTable: 'drink_items', priceTable: 'drink_item_channel_prices', fk: 'drink_item_id' },
  'hh-items': { itemTable: 'happy_hour_items', priceTable: 'happy_hour_item_channel_prices', fk: 'happy_hour_item_id' },
};

Object.entries(CHANNEL_PRICE_TABLES).forEach(([urlKey, { itemTable, priceTable, fk }]) => {
  router.get(`/:slug/${urlKey}/:id/channel-prices`, pinAuth, async (req, res) => {
    const { data, error } = await db.from(priceTable).select('*').eq(fk, req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  router.post(`/:slug/${urlKey}/:id/channel-prices`, pinAuth, async (req, res) => {
    const { channel, price, source } = req.body;
    if (!channel || price == null) return res.status(400).json({ error: 'channel and price required' });
    const { data: item } = await db.from(itemTable).select('entity_slug').eq('id', req.params.id).maybeSingle();
    if (!item || item.entity_slug !== req.entitySlug) return res.status(404).json({ error: 'Item not found' });
    const row = { [fk]: req.params.id, channel, price: parseFloat(price), source: source || null };
    const { data, error } = await db.from(priceTable).upsert(row, { onConflict: `${fk},channel` }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    log(req, { action: 'create', table_name: priceTable, record_id: data.id, new_value: data });
    res.status(201).json(data);
  });

  router.delete(`/:slug/${urlKey}/:id/channel-prices/:priceId`, pinAuth, async (req, res) => {
    const { data: item } = await db.from(itemTable).select('entity_slug').eq('id', req.params.id).maybeSingle();
    if (!item || item.entity_slug !== req.entitySlug) return res.status(404).json({ error: 'Item not found' });
    const { error } = await db.from(priceTable).delete().eq('id', req.params.priceId).eq(fk, req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    log(req, { action: 'delete', table_name: priceTable, record_id: req.params.priceId });
    res.json({ success: true });
  });
});

// ─── DRINK SECTIONS + ITEMS ───────────────────────────────────────────────────

router.post('/:slug/drink-sections', pinAuth, async (req, res) => {
  const { section_name, sort_order, meal_period, description, default_accompaniment, substitution_notes, source } = req.body;
  const { data, error } = await db.from('drink_sections').insert({
    entity_slug: req.entitySlug, section_name, sort_order: sort_order || 0,
    meal_period: meal_period || null, description: description || null,
    default_accompaniment: default_accompaniment || null, substitution_notes: substitution_notes || null, source: source || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'drink_sections', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/drink-sections/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['section_name','sort_order','meal_period','description','default_accompaniment','substitution_notes','source'].forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await db.from('drink_sections').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'drink_sections', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/drink-sections/:id', pinAuth, async (req, res) => {
  await db.from('drink_items').delete().eq('section_id', req.params.id);
  const { error } = await db.from('drink_sections').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'drink_sections', record_id: req.params.id });
  res.json({ success: true });
});

router.post('/:slug/drink-items', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, image_url, source } = req.body;
  const { data, error } = await db.from('drink_items').insert({ entity_slug: req.entitySlug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, image_url: image_url || null, source: source || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'drink_items', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/drink-items/:id', pinAuth, async (req, res) => {
  const { item_name, description, price, section_id, image_url, source } = req.body;
  const patch = { item_name, description: description || null, price: price != null ? parseFloat(price) : null, section_id: section_id || null, image_url: image_url || null };
  if (source !== undefined) patch.source = source;
  const { data, error } = await db.from('drink_items').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'drink_items', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/drink-items/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('drink_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'drink_items', record_id: req.params.id });
  res.json({ success: true });
});

// ─── HAPPY HOUR ───────────────────────────────────────────────────────────────

router.put('/:slug/happy-hour', pinAuth, async (req, res) => {
  const { hh_days, hh_start, hh_end, hh_description } = req.body;
  const { error } = await db.from('entity').update({ hh_days, hh_start, hh_end, hh_description, updated_at: new Date().toISOString() }).eq('slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'entity', record_id: req.entitySlug, field_name: 'happy_hour', new_value: { hh_days, hh_start, hh_end, hh_description } });
  res.json({ success: true });
});

router.post('/:slug/hh-sections', pinAuth, async (req, res) => {
  const { section_name, sort_order, meal_period, description, default_accompaniment, substitution_notes, source } = req.body;
  const { data, error } = await db.from('happy_hour_sections').insert({
    entity_slug: req.entitySlug, section_name, sort_order: sort_order || 0,
    meal_period: meal_period || null, description: description || null,
    default_accompaniment: default_accompaniment || null, substitution_notes: substitution_notes || null, source: source || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'happy_hour_sections', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/hh-sections/:id', pinAuth, async (req, res) => {
  const patch = {};
  ['section_name','sort_order','meal_period','description','default_accompaniment','substitution_notes','source'].forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await db.from('happy_hour_sections').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'happy_hour_sections', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/hh-sections/:id', pinAuth, async (req, res) => {
  await db.from('happy_hour_items').delete().eq('section_id', req.params.id);
  const { error } = await db.from('happy_hour_sections').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'happy_hour_sections', record_id: req.params.id });
  res.json({ success: true });
});

router.post('/:slug/hh-items', pinAuth, async (req, res) => {
  const { item_name, description, price, original_price, section_id, image_url, source } = req.body;
  const { data, error } = await db.from('happy_hour_items').insert({ entity_slug: req.entitySlug, section_id: section_id || null, item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null, source: source || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'happy_hour_items', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/hh-items/:id', pinAuth, async (req, res) => {
  const { item_name, description, price, original_price, image_url, source } = req.body;
  const patch = { item_name, description: description || null, price: price != null ? parseFloat(price) : null, original_price: original_price != null ? parseFloat(original_price) : null, image_url: image_url || null };
  if (source !== undefined) patch.source = source;
  const { data, error } = await db.from('happy_hour_items').update(patch).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'happy_hour_items', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/hh-items/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('happy_hour_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'happy_hour_items', record_id: req.params.id });
  res.json({ success: true });
});

// ─── SPECIALS ─────────────────────────────────────────────────────────────────

router.post('/:slug/specials', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_specials').insert({ entity_slug: req.entitySlug, ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'entity_specials', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/specials/:id', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_specials').update(req.body).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'entity_specials', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/specials/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('entity_specials').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'entity_specials', record_id: req.params.id });
  res.json({ success: true });
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────

router.post('/:slug/events', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_events').insert({ entity_slug: req.entitySlug, ...req.body, is_active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'entity_events', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.put('/:slug/events/:id', pinAuth, async (req, res) => {
  const { data, error } = await db.from('entity_events').update(req.body).eq('id', req.params.id).eq('entity_slug', req.entitySlug).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'entity_events', record_id: req.params.id, new_value: data });
  res.json(data);
});

router.delete('/:slug/events/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('entity_events').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'entity_events', record_id: req.params.id });
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
    const { data: insertedPhoto } = await db.from('entity_photos').insert({ entity_slug: slug, url: publicUrl, image_path: storagePath, is_cover: nextOrder === 0, sort_order: nextOrder, caption: label || null }).select('id').single();
    // Fire-and-forget — never make the phone sit and wait on a vision call
    // just to finish uploading a photo (same pattern as admin.js's upload route).
    if (insertedPhoto?.id) {
      analyzePhoto(publicUrl).then(result => {
        if (!result) return;
        return db.from('entity_photos').update({ ai_description: result.description, ai_tags: result.tags, ai_analyzed_at: new Date().toISOString() }).eq('id', insertedPhoto.id);
      }).catch(() => {});
    }
  } else if (type === 'hero') {
    await db.from('entity').update({ hero_image_url: publicUrl, hero_image_path: storagePath }).eq('slug', slug);
  } else {
    const table = TABLE_MAP[type];
    if (table && itemId) {
      await db.from(table).update({ image_url: publicUrl, image_path: storagePath }).eq('id', itemId).eq('entity_slug', slug);
    }
  }
  log(req, { action: 'create', table_name: 'entity_photos', field_name: type, new_value: { url: publicUrl, item_id: itemId } });

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

      let heroUrl = null;

      const freshUploadUrls = [];
      for (let i = 0; i < gallery.length; i++) {
        const img = gallery[i];
        let imageUrl = img.url;

        // Upload base64 if present
        if (img.url && img.url.startsWith('data:')) {
          const uploaded = await uploadBase64Image(slug, null, 'hero', img.url);
          if (uploaded) { imageUrl = uploaded.url; freshUploadUrls.push(imageUrl); }
        }

        // Map gallery type to photo_type and is_cover
        const typeMap = {
          'Hero':       { photo_type: 'exterior', is_cover: false },
          'Business':   { photo_type: null,        is_cover: false },
          'Trip Swipe': { photo_type: null,        is_cover: false },
          'food':       { photo_type: 'food',      is_cover: false },
          'exterior':   { photo_type: 'exterior',  is_cover: false },
          'interior':   { photo_type: 'interior',  is_cover: false },
          'outdoor':    { photo_type: 'outdoor',   is_cover: false },
          'event':      { photo_type: 'event',     is_cover: false },
        };
        const mapped = typeMap[img.type] || { photo_type: null, is_cover: false };

        // First Hero photo becomes the entity hero_image_url
        if (img.type === 'Hero' && !heroUrl) heroUrl = imageUrl;

        await db.from('entity_photos').insert({
          entity_slug:  slug,
          url:          imageUrl,
          photo_type:   img.photo_type || mapped.photo_type || null,
          is_cover:     img.is_cover || mapped.is_cover || false,
          sort_order:   i,
          caption:      img.label || img.caption || null,
          usage_note:   img.type || null,
        });
      }

      // Update hero image on the entity if one was marked as Hero
      if (heroUrl) {
        await db.from('entity').update({ hero_image_url: heroUrl }).eq('slug', slug);
      }

      // Only analyze photos that were actually just uploaded (base64 -> real
      // URL this save) -- this endpoint deletes and reinserts the whole
      // gallery on every save, so re-analyzing already-existing photos every
      // time would burn a fresh vision call per photo on every single save.
      for (const url of freshUploadUrls) {
        analyzePhoto(url).then(result => {
          if (!result) return;
          return db.from('entity_photos').update({ ai_description: result.description, ai_tags: result.tags, ai_analyzed_at: new Date().toISOString() }).eq('entity_slug', slug).eq('url', url);
        }).catch(() => {});
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
            available_days: sec.available_days || null,
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
                is_catch_of_day: item.catch_of_the_day || false,
                is_available: item.available !== false,
                has_market_price: item.market_price || false,
                metadata: (item.images && item.images.length > 0) ? { images: item.images.slice(0, 3) } : null,
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
            available_days: sec.available_days || null,
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
                is_on_tap: item.on_tap || false,
                is_available: item.available !== false,
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

    // 4. Sides + Add-ons (save all)
    if (sides && sides.length > 0) {
      await db.from('entity_sides').delete().eq('entity_slug', slug);
      for (const side of sides) {
        let imageUrl = side.image_url || (side.images && side.images[0]?.url);
        if (imageUrl && imageUrl.startsWith('data:')) {
          const uploaded = await uploadBase64Image(slug, null, 'side', imageUrl);
          if (uploaded) imageUrl = uploaded.url;
        }
        const { error: sErr } = await db.from('entity_sides').insert({
          entity_slug: slug,
          side_name: side.name || 'Side',
          description: side.description || null,
          price: side.price !== '' && side.price != null ? parseFloat(side.price) || null : null,
          image_url: imageUrl || null,
          is_active: true,
          item_type: side.type || 'side',
        });
        if (sErr) console.error('Side insert:', sErr.code, sErr.message);
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

    log(req, { action: 'update', table_name: 'entity', record_id: slug, field_name: 'bulk_save', new_value: { business, areas_count: areas.length, gallery_count: gallery.length } });
    res.json({ success: true, message: 'Menu saved successfully' });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

// ─── STAFF (phone-recognized SMS toggle access) ───────────────────────────────
// Whoever holds the PIN (owner/manager) can add other people by phone number
// with a role. 'owner'/'manager' is really just a label today — the real
// access split is that only PIN holders get the full editor, while everyone
// added here gets recognized by routes/sms.js's inbound webhook for
// toggle-only commands (SOLD OUT <item>, ON TAP <item>, etc.), regardless of
// the role string. A future dashboard/SMS-identity merge can make role
// actually gate something server-side; for now it's descriptive.

function normalizeStaffPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

router.get('/:slug/staff', pinAuth, async (req, res) => {
  const { data, error } = await db.from('business_staff').select('*').eq('entity_slug', req.entitySlug).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ staff: data || [] });
});

router.post('/:slug/staff', pinAuth, async (req, res) => {
  const { phone, name, role } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const normalized = normalizeStaffPhone(phone);
  const { data, error } = await db.from('business_staff')
    .upsert({ entity_slug: req.entitySlug, phone: normalized, name: name || null, role: role || 'staff', is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'entity_slug,phone' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'create', table_name: 'business_staff', record_id: data.id, new_value: data });
  res.status(201).json(data);
});

router.delete('/:slug/staff/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('business_staff').update({ is_active: false }).eq('id', req.params.id).eq('entity_slug', req.entitySlug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'business_staff', record_id: req.params.id });
  res.json({ success: true });
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

// POST /:slug/set-hero — immediately set a gallery photo as the entity hero
router.post('/:slug/set-hero', pinAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const { error } = await db.from('entity').update({ hero_image_url: url }).eq('slug', req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'entity', record_id: req.params.slug, field_name: 'hero_image_url', new_value: url });
  res.json({ success: true, hero_image_url: url });
});

// PATCH /:slug/photo/:id — update a single photo's type, caption, sort_order, is_cover
router.patch('/:slug/photo/:id', pinAuth, async (req, res) => {
  const { photo_type, caption, sort_order, is_cover, usage_note } = req.body;
  const update = {};
  if (photo_type   !== undefined) update.photo_type  = photo_type;
  if (caption      !== undefined) update.caption     = caption;
  if (sort_order   !== undefined) update.sort_order  = sort_order;
  if (is_cover     !== undefined) update.is_cover    = is_cover;
  if (usage_note   !== undefined) update.usage_note  = usage_note;
  const { error } = await db.from('entity_photos').update(update).eq('id', req.params.id).eq('entity_slug', req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'update', table_name: 'entity_photos', record_id: req.params.id, new_value: update });
  res.json({ success: true });
});

// DELETE /:slug/photo/:id — delete a single gallery photo
router.delete('/:slug/photo/:id', pinAuth, async (req, res) => {
  const { error } = await db.from('entity_photos').delete().eq('id', req.params.id).eq('entity_slug', req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  log(req, { action: 'delete', table_name: 'entity_photos', record_id: req.params.id });
  res.json({ success: true });
});

module.exports = router;
