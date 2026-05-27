const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// Cache-control for all GETs
router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  next();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getEntityBySlug(slug) {
  const { data, error } = await db
    .from('entity')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();
  if (error || !data) return null;
  return data;
}

async function buildFullEntity(slug) {
  const entity = await getEntityBySlug(slug);
  if (!entity) return null;

  const [hours, photos, tags, menuSections, drinkSections, hhSections, specials, events] = await Promise.all([
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_tags').select('*').eq('entity_slug', slug),
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
  ]);

  // Fetch items for each section type
  const menuSectionIds = (menuSections.data || []).map(s => s.id);
  const drinkSectionIds = (drinkSections.data || []).map(s => s.id);
  const hhSectionIds = (hhSections.data || []).map(s => s.id);

  const [menuItems, drinkItems, hhItems] = await Promise.all([
    menuSectionIds.length
      ? db.from('menu_items').select('*').in('section_id', menuSectionIds).order('id')
      : { data: [] },
    drinkSectionIds.length
      ? db.from('drink_items').select('*').in('section_id', drinkSectionIds).order('id')
      : { data: [] },
    hhSectionIds.length
      ? db.from('happy_hour_items').select('*').in('section_id', hhSectionIds).order('id')
      : { data: [] },
  ]);

  // Nest items into sections
  const nest = (sections, items) =>
    (sections || []).map(sec => ({
      ...sec,
      items: (items || []).filter(i => i.section_id === sec.id),
    }));

  return {
    ...entity,
    hours: hours.data || [],
    photos: photos.data || [],
    tags: tags.data || [],
    menu_sections: nest(menuSections.data, menuItems.data),
    drink_sections: nest(drinkSections.data, drinkItems.data),
    happy_hour_sections: nest(hhSections.data, hhItems.data),
    specials: specials.data || [],
    events: events.data || [],
  };
}

// ─── GET /api/gcr/entities ────────────────────────────────────────────────────
router.get('/entities', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    let query = db
      .from('entity')
      .select(`
        id, slug, name, subtitle, entity_type, entity_subtype, icon,
        phone, rating, review_count, city, state, address_line_1,
        hero_image_url, website_url, directions_url, call_url,
        booking_url, reservation_url, order_url, price_range,
        price_from, price_to, price_unit, secondary_types,
        hh_days, hh_start, hh_end, hh_description,
        live_music, outdoor_seating, good_for_kids, good_for_groups,
        serves_beer, serves_wine, serves_cocktails,
        featured, is_active, description,
        social_instagram, social_facebook, social_tiktok
      `)
      .eq('is_active', true)
      .order('name')
      .range(offset, offset + limit - 1);

    if (req.query.type) {
      if (req.query.type === 'coffee') {
        // Coffee & Sweets: show both coffee and dessert places
        query = query.in('entity_type', ['coffee', 'dessert', 'bakery']);
      } else if (req.query.type === 'staying') {
        // Hotels & Rentals: show hotels, condos, vacation homes
        query = query.in('entity_type', ['hotel', 'condo', 'vacation-rental']);
      } else {
        query = query.eq('entity_type', req.query.type);
      }
    }
    if (req.query.subtype) query = query.eq('entity_subtype', req.query.subtype);
    if (req.query.city)    query = query.ilike('city', `%${req.query.city}%`);
    if (req.query.search)  query = query.ilike('name', `%${req.query.search}%`);
    if (req.query.featured === 'true') query = query.eq('featured', true);

    const { data: entities, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const slugs = (entities || []).map(e => e.slug);

    // Batch fetch tags, photos, hours for all entities
    const [tagRows, photoRows, hourRows] = await Promise.all([
      slugs.length ? db.from('entity_tags').select('entity_slug, tag_name, tag_category').in('entity_slug', slugs) : { data: [] },
      slugs.length ? db.from('entity_photos').select('entity_slug, url, is_cover, sort_order, caption').in('entity_slug', slugs).order('sort_order') : { data: [] },
      slugs.length ? db.from('entity_hours').select('entity_slug, day_of_week, opens_at, closes_at, is_closed').in('entity_slug', slugs).order('day_of_week') : { data: [] },
    ]);

    const tagMap = {}, photoMap = {}, hourMap = {};
    (tagRows.data || []).forEach(r => { if (!tagMap[r.entity_slug]) tagMap[r.entity_slug] = []; tagMap[r.entity_slug].push(r); });
    (photoRows.data || []).forEach(r => { if (!photoMap[r.entity_slug]) photoMap[r.entity_slug] = []; photoMap[r.entity_slug].push(r); });
    (hourRows.data || []).forEach(r => { if (!hourMap[r.entity_slug]) hourMap[r.entity_slug] = []; hourMap[r.entity_slug].push(r); });

    const results = (entities || []).map(e => ({
      ...e,
      tags: tagMap[e.slug] || [],
      photos: photoMap[e.slug] || [],
      hours: hourMap[e.slug] || [],
    }));

    res.json({ entities: results, total: results.length, offset, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/entity/:slug ────────────────────────────────────────────────
router.get('/entity/:slug', async (req, res) => {
  try {
    const entity = await buildFullEntity(req.params.slug);
    if (!entity) return res.status(404).json({ error: 'Not found' });
    res.json(entity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/events ──────────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  try {
    let query = db
      .from('entity_events')
      .select('*, entity:entity_slug(slug, name, icon, hero_image_url, city, address_line_1, phone), artist:artist_id(id, name, slug, bio, genre, hometown, image_url, website_url, social_instagram, social_facebook, social_tiktok, spotify_url)')
      .eq('is_active', true)
      .order('event_date', { ascending: true });

    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const results = (data || []).map(ev => ({
      id: ev.id,
      event_name: ev.event_name,
      description: ev.description,
      event_date: ev.event_date,
      start_time: ev.start_time,
      end_time: ev.end_time,
      day_of_week: ev.day_of_week,
      recurring: ev.recurring,
      artist_name: ev.artist?.name || ev.artist_name || null,
      artist: ev.artist || null,
      cover_charge: ev.cover_charge,
      image_url: ev.image_url || ev.artist?.image_url || null,
      entity_slug: ev.entity_slug,
      entity_name: ev.entity?.name || '',
      icon: ev.entity?.icon || '🏪',
      hero_image_url: ev.entity?.hero_image_url || null,
      city: ev.entity?.city || '',
      address_line_1: ev.entity?.address_line_1 || '',
      phone: ev.entity?.phone || '',
    }));

    res.json({ events: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/specials ────────────────────────────────────────────────────
router.get('/specials', async (req, res) => {
  try {
    let query = db
      .from('entity_specials')
      .select('*, entity:entity_slug(slug, name, icon, hero_image_url, city, address_line_1, phone)')
      .eq('is_active', true)
      .order('id', { ascending: false });

    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const results = (data || []).map(s => ({
      id: s.id,
      special_name: s.special_name,
      description: s.description,
      discount_type: s.discount_type,
      discount_value: s.discount_value,
      discount_text: s.discount_text,
      days: s.days,
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
      start_date: s.start_date,
      end_date: s.end_date,
      image_url: s.image_url,
      entity_slug: s.entity_slug,
      entity_name: s.entity?.name || s.entity_name || '',
      icon: s.entity?.icon || '🏪',
      hero_image_url: s.entity?.hero_image_url || null,
      city: s.entity?.city || '',
      address_line_1: s.entity?.address_line_1 || '',
      phone: s.entity?.phone || '',
    }));

    res.json({ specials: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/happy-hours ─────────────────────────────────────────────────
router.get('/happy-hours', async (req, res) => {
  try {
    // Get all entities that have happy hour data
    const { data: entities, error } = await db
      .from('entity')
      .select(`
        id, slug, name, icon, hero_image_url, entity_subtype, city,
        address_line_1, phone, directions_url, call_url, booking_url,
        reservation_url, rating, hh_days, hh_start, hh_end, hh_description
      `)
      .eq('is_active', true)
      .not('hh_days', 'is', null)
      .order('name');

    if (error) return res.status(500).json({ error: error.message });

    const slugs = (entities || []).map(e => e.slug);

    // Fetch HH sections + items + photos + hours in parallel
    const [hhSections, photoRows, hourRows] = await Promise.all([
      slugs.length ? db.from('happy_hour_sections').select('*').in('entity_slug', slugs).order('sort_order') : { data: [] },
      slugs.length ? db.from('entity_photos').select('entity_slug, url, sort_order').in('entity_slug', slugs).order('sort_order') : { data: [] },
      slugs.length ? db.from('entity_hours').select('entity_slug, day_of_week, opens_at, closes_at, is_closed').in('entity_slug', slugs) : { data: [] },
    ]);

    const sectionIds = (hhSections.data || []).map(s => s.id);
    const { data: hhItems } = sectionIds.length
      ? await db.from('happy_hour_items').select('*').in('section_id', sectionIds).order('id')
      : { data: [] };

    // Build maps
    const hhSectionMap = {}, photoMap = {}, hourMap = {};
    (hhSections.data || []).forEach(s => { if (!hhSectionMap[s.entity_slug]) hhSectionMap[s.entity_slug] = []; hhSectionMap[s.entity_slug].push({ ...s, items: (hhItems || []).filter(i => i.section_id === s.id) }); });
    (photoRows.data || []).forEach(r => { if (!photoMap[r.entity_slug]) photoMap[r.entity_slug] = []; photoMap[r.entity_slug].push(r); });
    (hourRows.data || []).forEach(r => { if (!hourMap[r.entity_slug]) hourMap[r.entity_slug] = []; hourMap[r.entity_slug].push(r); });

    const results = (entities || []).map(e => ({
      ...e,
      hh_sections: hhSectionMap[e.slug] || [],
      photos: photoMap[e.slug] || [],
      hours: hourMap[e.slug] || [],
    }));

    res.json({ happyHours: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/gcr/search ─────────────────────────────────────────────────────
router.post('/search', async (req, res) => {
  try {
    const { query: q, city, limit = 50 } = req.body;
    if (!q || !q.trim()) return res.status(400).json({ error: 'Query required' });

    const term = q.toLowerCase().trim();
    const keywords = term.split(/\s+/).filter(k => k.length >= 2);
    const matchedSlugs = new Set();

    const orFilter = (...fields) =>
      keywords.flatMap(k => fields.map(f => `${f}.ilike.%${k}%`)).join(',');

    // Search all tables in parallel
    const [byEntity, byMenuItems, byDrinkItems, byHHItems, bySpecials, byEvents] = await Promise.all([
      db.from('entity').select('slug').eq('is_active', true).or(orFilter('name', 'description', 'subtitle', 'city', 'entity_subtype')),
      db.from('menu_items').select('entity_slug').or(orFilter('item_name', 'description')),
      db.from('drink_items').select('entity_slug').or(orFilter('item_name', 'description')),
      db.from('happy_hour_items').select('entity_slug').or(orFilter('item_name', 'description')),
      db.from('entity_specials').select('entity_slug').eq('is_active', true).or(orFilter('special_name', 'description', 'discount_text')),
      db.from('entity_events').select('entity_slug').eq('is_active', true).or(orFilter('event_name', 'description', 'artist_name')),
    ]);

    (byEntity.data || []).forEach(r => matchedSlugs.add(r.slug));
    [byMenuItems, byDrinkItems, byHHItems, bySpecials, byEvents].forEach(res =>
      (res.data || []).forEach(r => r.entity_slug && matchedSlugs.add(r.entity_slug))
    );

    if (!matchedSlugs.size) return res.json({ query: q, results: [], total: 0 });

    // Fetch full entity data for matches
    let entityQuery = db
      .from('entity')
      .select(`
        id, slug, name, subtitle, entity_subtype, icon, phone, rating,
        review_count, city, state, address_line_1, hero_image_url,
        directions_url, call_url, booking_url, reservation_url, order_url,
        price_range, hh_days, hh_start, hh_end, featured, is_active
      `)
      .eq('is_active', true)
      .in('slug', [...matchedSlugs])
      .limit(limit);

    if (city) entityQuery = entityQuery.ilike('city', `%${city}%`);

    const { data: entities, error } = await entityQuery;
    if (error) return res.status(500).json({ error: error.message });

    const slugList = (entities || []).map(e => e.slug);

    // Fetch matched content + photos
    const [menuMatches, drinkMatches, hhMatches, specialMatches, eventMatches, photoRows] = await Promise.all([
      db.from('menu_items').select('entity_slug, item_name, description, price').in('entity_slug', slugList).or(orFilter('item_name', 'description')),
      db.from('drink_items').select('entity_slug, item_name, description, price').in('entity_slug', slugList).or(orFilter('item_name', 'description')),
      db.from('happy_hour_items').select('entity_slug, item_name, description, price').in('entity_slug', slugList).or(orFilter('item_name', 'description')),
      db.from('entity_specials').select('entity_slug, special_name, description, discount_text').in('entity_slug', slugList).eq('is_active', true),
      db.from('entity_events').select('entity_slug, event_name, event_date, artist_name').in('entity_slug', slugList).eq('is_active', true),
      db.from('entity_photos').select('entity_slug, url, sort_order').in('entity_slug', slugList).order('sort_order'),
    ]);

    // Build match maps
    const menuMap = {}, drinkMap = {}, hhMap = {}, specialMap = {}, eventMap = {}, photoMap = {};
    (menuMatches.data || []).forEach(r => { if (!menuMap[r.entity_slug]) menuMap[r.entity_slug] = []; menuMap[r.entity_slug].push(r); });
    (drinkMatches.data || []).forEach(r => { if (!drinkMap[r.entity_slug]) drinkMap[r.entity_slug] = []; drinkMap[r.entity_slug].push(r); });
    (hhMatches.data || []).forEach(r => { if (!hhMap[r.entity_slug]) hhMap[r.entity_slug] = []; hhMap[r.entity_slug].push(r); });
    (specialMatches.data || []).forEach(r => { if (!specialMap[r.entity_slug]) specialMap[r.entity_slug] = []; specialMap[r.entity_slug].push(r); });
    (eventMatches.data || []).forEach(r => { if (!eventMap[r.entity_slug]) eventMap[r.entity_slug] = []; eventMap[r.entity_slug].push(r); });
    (photoRows.data || []).forEach(r => { if (!photoMap[r.entity_slug]) photoMap[r.entity_slug] = []; photoMap[r.entity_slug].push(r); });

    const score = (name, desc) => {
      const n = (name || '').toLowerCase(), d = (desc || '').toLowerCase();
      if (n === term) return 100;
      if (n.startsWith(term)) return 80;
      if (n.includes(term)) return 60;
      if (d.includes(term)) return 30;
      return 0;
    };

    const results = (entities || []).map(e => {
      const menuItems = [...(menuMap[e.slug] || []), ...(drinkMap[e.slug] || []), ...(hhMap[e.slug] || [])];
      const specials = specialMap[e.slug] || [];
      const events = eventMap[e.slug] || [];
      const nameScore = score(e.name, e.subtitle);
      const itemScore = menuItems.length ? score(menuItems[0].item_name, menuItems[0].description) : 0;
      const relevance = Math.max(nameScore, itemScore) + (e.rating || 0);

      return {
        ...e,
        photos: photoMap[e.slug] || [],
        matched_menu_items: menuItems,
        matched_specials: specials,
        matched_events: events,
        _relevance: relevance,
      };
    }).sort((a, b) => b._relevance - a._relevance);

    res.json({ query: q, results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/sections ────────────────────────────────────────────────────
router.get('/sections', async (req, res) => {
  try {
    const sections = [
      { type: 'restaurants', name: 'Restaurants', icon: '🍽️', count: 0 },
      { type: 'coffee-sweets', name: 'Coffee & Sweets', icon: '☕', count: 0 },
      { type: 'happy-hours', name: 'Happy Hours', icon: '🍻', count: 0 },
      { type: 'events', name: 'Events', icon: '🎉', count: 0 },
      { type: 'things-to-do', name: 'Things To Do', icon: '🎯', count: 0 },
      { type: 'services', name: 'Services', icon: '🛠️', count: 0 },
      { type: 'public-spots', name: 'Public Spots', icon: '✨', count: 0 },
      { type: 'shopping', name: 'Shopping', icon: '🛍️', count: 0 },
      { type: 'hotel', name: 'Staying', icon: '🏨', count: 0 },
    ];

    const typeMap = {
      'restaurants': 'restaurant',
      'coffee-sweets': 'coffee',
      'happy-hours': null,
      'events': 'event',
      'things-to-do': 'activity',
      'services': 'service',
      'public-spots': 'park',
      'shopping': 'shopping',
      'hotel': 'hotel'
    };

    for (let section of sections) {
      const entityType = typeMap[section.type];
      if (entityType) {
        const { count } = await db
          .from('entity')
          .select('id', { count: 'exact', head: true })
          .eq('entity_type', entityType)
          .eq('is_active', true);
        section.count = count || 0;
      }
    }

    res.json({ sections, total_entities: sections.reduce((s, t) => s + t.count, 0), total_types: sections.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/category-page-config/:category ───────────────────────────────
router.get('/category-page-config/:category', async (req, res) => {
  try {
    const pageConfig = {
      restaurants: {
        page_title: 'Restaurants',
        page_description: 'Browse Gulf Coast spots, then use tags at the top to narrow the results by vibe, location, and what people care about most.'
      },
      'coffee-sweets': {
        page_title: 'Coffee & Sweets',
        page_description: 'Find your favorite coffee shop, bakery, or dessert spot on the Gulf Coast.'
      },
      'happy-hours': {
        page_title: 'Happy Hours',
        page_description: 'Discover happy hour specials and drink deals across the Gulf Coast.'
      },
      events: {
        page_title: 'Events & Entertainment',
        page_description: 'Find live music, concerts, festivals, and events happening now on the Gulf Coast.'
      },
      'things-to-do': {
        page_title: 'Things To Do',
        page_description: 'Explore activities, attractions, tours, and adventures on the Gulf Coast.'
      },
      services: {
        page_title: 'Services',
        page_description: 'Find local services and professionals on the Gulf Coast.'
      },
      'public-spots': {
        page_title: 'Public Spots',
        page_description: 'Discover parks, beaches, and public areas on the Gulf Coast.'
      },
      shopping: {
        page_title: 'Shopping',
        page_description: 'Browse retail stores and boutiques on the Gulf Coast.'
      },
      hotel: {
        page_title: 'Staying',
        page_description: 'Find hotels, resorts, and vacation rentals on the Gulf Coast.'
      },
      feed: {
        page_title: 'Live Feed',
        page_description: 'See what\'s happening now on the Gulf Coast.'
      }
    };

    const config = pageConfig[req.params.category];
    if (!config) return res.status(404).json({ error: 'Category not found' });

    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/entities/:parentSlug/children ───────────────────────────────
router.get('/entities/:parentSlug/children', async (req, res) => {
  try {
    const { data, error } = await db
      .from('entity')
      .select('*')
      .eq('parent_slug', req.params.parentSlug)
      .eq('is_active', true)
      .order('name');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ children: data || [], total: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/live-now ────────────────────────────────────────────────────
router.get('/live-now', async (req, res) => {
  try {
    const now = new Date();
    const nowTime = now.toTimeString().slice(0, 5);
    const nowDate = now.toISOString().split('T')[0];

    const { data: entities, error } = await db
      .from('entity')
      .select('id, slug, name, subtitle, entity_subtype, icon, phone, rating, review_count, city, state, address_line_1, hero_image_url, website_url, hh_days, hh_start, hh_end, hh_description')
      .eq('is_active', true)
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });

    const liveNow = (entities || []).filter(e => {
      const hasHH = e.hh_days && e.hh_start && e.hh_end && nowTime >= e.hh_start && nowTime <= e.hh_end;
      return hasHH;
    });

    res.json({ liveNow, total: liveNow.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
