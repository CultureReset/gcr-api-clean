const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function normalizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/photos/')) {
    const slug = url.split('/')[2];
    const filename = url.split('/').pop();
    return `${process.env.GCR_SUPABASE_URL}/storage/v1/object/public/entity-photos/${slug}/${filename}`;
  }
  return url;
}

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

  const [hours, secondaryHours, photos, tags, menuSections, drinkSections, hhSections, entitySections, specials, events, sides, dailyFeatures, pricing, whatsIncluded, faqs, requirements] = await Promise.all([
    db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_secondary_hours').select('*').eq('entity_slug', slug).order('hours_type, day_of_week'),
    db.from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_tags').select('*').eq('entity_slug', slug),
    db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_sections').select('*').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_events').select('*').eq('entity_slug', slug).eq('is_active', true).order('event_date'),
    db.from('entity_sides').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('entity_daily_features').select('*').eq('entity_slug', slug).eq('is_active', true),
    db.from('pricing_items').select('*').eq('entity_id', entity.id).order('sort_order'),
    db.from('whats_included').select('*').eq('entity_id', entity.id).order('sort_order'),
    db.from('faqs').select('*').eq('entity_id', entity.id),
    db.from('requirements').select('*').eq('entity_id', entity.id).order('sort_order'),
  ]);

  // Fetch items for each section type
  const menuSectionIds = (menuSections.data || []).map(s => s.id);
  const drinkSectionIds = (drinkSections.data || []).map(s => s.id);
  const hhSectionIds = (hhSections.data || []).map(s => s.id);
  const entitySectionIds = (entitySections.data || []).map(s => s.id);

  const [menuItems, drinkItems, hhItems, entitySectionItems] = await Promise.all([
    menuSectionIds.length
      ? db.from('menu_items').select('*').in('section_id', menuSectionIds).order('id')
      : { data: [] },
    drinkSectionIds.length
      ? db.from('drink_items').select('*').in('section_id', drinkSectionIds).order('id')
      : { data: [] },
    hhSectionIds.length
      ? db.from('happy_hour_items').select('*').in('section_id', hhSectionIds).order('id')
      : { data: [] },
    entitySectionIds.length
      ? db.from('entity_section_items').select('*').in('section_id', entitySectionIds).order('id')
      : { data: [] },
  ]);

  // Nest items into sections
  const nest = (sections, items) =>
    (sections || []).map(sec => ({
      ...sec,
      items: (items || []).filter(i => i.section_id === sec.id),
    }));

  const normalizedPhotos = (photos.data || []).map(p => ({ ...p, url: normalizeImageUrl(p.url), image_url: normalizeImageUrl(p.image_url) }));
  return {
    ...entity,
    hero_image_url: normalizeImageUrl(entity.hero_image_url),
    hours: hours.data || [],
    secondary_hours: secondaryHours.data || [],
    photos: normalizedPhotos,
    tags: tags.data || [],
    menu_sections: nest(menuSections.data, menuItems.data),
    drink_sections: nest(drinkSections.data, drinkItems.data),
    happy_hour_sections: nest(hhSections.data, hhItems.data),
    sections: nest(entitySections.data, entitySectionItems.data),
    specials: specials.data || [],
    events: events.data || [],
    sides: sides.data || [],
    daily_features: dailyFeatures.data || [],
    pricing: pricing.data || [],
    whats_included: whatsIncluded.data || [],
    faqs: faqs.data || [],
    requirements: requirements.data || [],
  };
}

// ─── GET /api/gcr/entities ────────────────────────────────────────────────────
router.get('/entities', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 5000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    let query = db
      .from('entity')
      .select(`
        id, slug, name, subtitle, entity_type, entity_subtype, icon,
        phone, rating, review_count, city, state, address_line_1,
        hero_image_url, website_url, directions_url, call_url,
        booking_url, reservation_url, order_url, price_range,
        hh_days, hh_start, hh_end, hh_description,
        live_music, outdoor_seating,
        featured, is_active, description,
        social_instagram, social_facebook, social_tiktok,
        duration_text, price_from, price_unit,
        known_for, highlights, good_for,
        what_makes_it_different, secondary_subtypes, seo_keywords,
        latitude, longitude,
        editorial_summary, ai_overview, ai_review_summary,
        price_level, price_range_low, price_range_high,
        delivery, dine_in, takeout, curbside_pickup, reservable,
        serves_breakfast, serves_brunch, serves_lunch, serves_dinner,
        serves_beer, serves_wine, serves_cocktails, serves_coffee, serves_dessert, serves_vegetarian,
        good_for_groups, good_for_children, allows_dogs, good_for_watching_sports,
        wheelchair_accessible_entrance, wheelchair_accessible_parking,
        wheelchair_accessible_restroom, wheelchair_accessible_seating,
        google_maps_uri, primary_type_display, also_appears_on,
        national_phone, google_place_id, business_status
      `)
      .eq('is_active', true)
      .order('name')
      .range(offset, offset + limit - 1);

    if (req.query.type) {
      if (req.query.type === 'coffee') {
        query = query.or(`entity_type.in.(coffee,dessert,bakery),also_appears_on.cs.{coffee-sweets}`);
      } else if (req.query.type === 'staying') {
        query = query.or(`entity_type.in.(hotel,condo,vacation-rental),also_appears_on.cs.{staying}`);
      } else {
        // page name → entity_type mapping for also_appears_on cross-page lookups
        const PAGE_TO_TYPE = {
          'restaurants':  'restaurant',
          'things-to-do': 'activity',
          'services':     'service',
          'shopping':     'shopping',
          'public-spots': 'park',
        };
        const page = req.query.type;
        const primaryType = PAGE_TO_TYPE[page] || page;
        query = query.or(`entity_type.eq.${primaryType},also_appears_on.cs.{${page}}`);
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
      slugs.length ? db.from('entity_tags').select('entity_slug, tag_name, tag_category').in('entity_slug', slugs).limit(10000) : { data: [] },
      slugs.length ? db.from('entity_photos').select('entity_slug, url, is_cover, sort_order, caption').in('entity_slug', slugs).order('sort_order').limit(10000) : { data: [] },
      slugs.length ? db.from('entity_hours').select('entity_slug, day_of_week, opens_at, closes_at, is_closed').in('entity_slug', slugs).order('day_of_week').limit(10000) : { data: [] },
    ]);

    const tagMap = {}, photoMap = {}, hourMap = {};
    (tagRows.data || []).forEach(r => { if (!tagMap[r.entity_slug]) tagMap[r.entity_slug] = []; tagMap[r.entity_slug].push(r); });
    (photoRows.data || []).forEach(r => { if (!photoMap[r.entity_slug]) photoMap[r.entity_slug] = []; photoMap[r.entity_slug].push(r); });
    (hourRows.data || []).forEach(r => { if (!hourMap[r.entity_slug]) hourMap[r.entity_slug] = []; hourMap[r.entity_slug].push(r); });

    const userLat = req.query.lat ? parseFloat(req.query.lat) : null;
    const userLng = req.query.lng ? parseFloat(req.query.lng) : null;
    const sortByDist = req.query.sort === 'distance' && userLat !== null && userLng !== null;

    const results = (entities || []).map(e => {
      const photos = (photoMap[e.slug] || []).map(p => ({ ...p, url: normalizeImageUrl(p.url) }));
      const row = { ...e, tags: tagMap[e.slug] || [], photos, hours: hourMap[e.slug] || [], hero_image_url: normalizeImageUrl(e.hero_image_url) };
      if (userLat !== null && userLng !== null && e.latitude && e.longitude) {
        row.distance_miles = haversine(userLat, userLng, e.latitude, e.longitude);
      }
      return row;
    });

    if (sortByDist) results.sort((a, b) => (a.distance_miles ?? 9999) - (b.distance_miles ?? 9999));

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

// ─── POST /api/gcr/entity/:slug/set-pin ──────────────────────────────────────
router.post('/entity/:slug/set-pin', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const { error } = await db.from('entity').update({ menu_pin: String(pin) }).eq('slug', req.params.slug);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
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
      image_url: normalizeImageUrl(ev.image_url || ev.artist?.image_url),
      entity_slug: ev.entity_slug,
      entity_name: ev.entity?.name || '',
      icon: ev.entity?.icon || '🏪',
      hero_image_url: normalizeImageUrl(ev.entity?.hero_image_url),
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
      image_url: normalizeImageUrl(s.image_url),
      entity_slug: s.entity_slug,
      entity_name: s.entity?.name || s.entity_name || '',
      icon: s.entity?.icon || '🏪',
      hero_image_url: normalizeImageUrl(s.entity?.hero_image_url),
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

    const results = (entities || []).map(e => {
      const photos = (photoMap[e.slug] || []).map(p => ({ ...p, url: normalizeImageUrl(p.url) }));
      return {
        ...e,
        hero_image_url: normalizeImageUrl(e.hero_image_url),
        hh_sections: hhSectionMap[e.slug] || [],
        photos,
        hours: hourMap[e.slug] || [],
      };
    });

    res.json({ happyHours: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/gcr/search ─────────────────────────────────────────────────────
router.post('/search', async (req, res) => {
  try {
    const { query: q, city, limit = 50, lat, lng } = req.body;
    if (!q || !q.trim()) return res.status(400).json({ error: 'Query required' });

    const term = q.toLowerCase().trim();
    const keywords = term.split(/\s+/).filter(k => k.length >= 2);
    const matchedSlugs = new Set();

    const orFilter = (...fields) =>
      keywords.flatMap(k => fields.map(f => `${f}.ilike.%${k}%`)).join(',');

    // Search all tables in parallel — events only matched if query hits event/artist name directly
    const [byEntity, byMenuItems, byDrinkItems, byHHItems, bySpecials, byEvents] = await Promise.all([
      db.from('entity').select('slug').eq('is_active', true).or(orFilter('name', 'description', 'subtitle', 'city', 'entity_subtype')),
      db.from('menu_items').select('entity_slug').or(orFilter('item_name', 'description')),
      db.from('drink_items').select('entity_slug').or(orFilter('item_name', 'description')),
      db.from('happy_hour_items').select('entity_slug').or(orFilter('item_name', 'description')),
      db.from('entity_specials').select('entity_slug').eq('is_active', true).or(orFilter('special_name', 'description', 'discount_text')),
      db.from('entity_events').select('entity_slug').eq('is_active', true).or(orFilter('event_name', 'artist_name')),
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
        price_range, hh_days, hh_start, hh_end, featured, is_active,
        latitude, longitude
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
      db.from('entity_events').select('entity_slug, event_name, event_date, artist_name').in('entity_slug', slugList).eq('is_active', true).or(orFilter('event_name', 'artist_name')),
      db.from('entity_photos').select('entity_slug, url, sort_order').in('entity_slug', slugList).order('sort_order'),
    ]);

    // Build match maps — deduplicate menu items by name within each entity
    const menuMap = {}, drinkMap = {}, hhMap = {}, specialMap = {}, eventMap = {}, photoMap = {};
    const dedupeItems = (map, rows) => {
      (rows || []).forEach(r => {
        if (!map[r.entity_slug]) map[r.entity_slug] = new Map();
        const key = (r.item_name || '').toLowerCase();
        if (!map[r.entity_slug].has(key)) map[r.entity_slug].set(key, r);
      });
      Object.keys(map).forEach(slug => { map[slug] = [...map[slug].values()]; });
    };
    dedupeItems(menuMap, menuMatches.data);
    dedupeItems(drinkMap, drinkMatches.data);
    dedupeItems(hhMap, hhMatches.data);
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

    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;

    const results = (entities || []).map(e => {
      const menuItems = [...(menuMap[e.slug] || []), ...(drinkMap[e.slug] || []), ...(hhMap[e.slug] || [])];
      const specials = specialMap[e.slug] || [];
      const events = (eventMap[e.slug] || []).filter(ev =>
        keywords.some(k => (ev.event_name || '').toLowerCase().includes(k) || (ev.artist_name || '').toLowerCase().includes(k))
      );
      const nameScore = score(e.name, e.subtitle);
      const itemScore = menuItems.length ? score(menuItems[0].item_name, menuItems[0].description) : 0;
      const relevance = Math.max(nameScore, itemScore) + (e.rating || 0);
      const distance_miles = (userLat && userLng && e.latitude && e.longitude)
        ? haversine(userLat, userLng, e.latitude, e.longitude)
        : null;

      return {
        ...e,
        photos: photoMap[e.slug] || [],
        matched_menu_items: menuItems,
        matched_specials: specials,
        matched_events: events,
        _relevance: relevance,
        distance_miles,
      };
    }).sort((a, b) => b._relevance - a._relevance);

    // Build flattened items list (all items across all restaurants)
    const flattenedItems = [];
    results.forEach(restaurant => {
      (restaurant.matched_menu_items || []).forEach(item => {
        flattenedItems.push({
          item_name: item.item_name,
          description: item.description,
          price: item.price,
          restaurant_name: restaurant.name,
          restaurant_slug: restaurant.slug,
          restaurant_rating: restaurant.rating,
          type: 'menu'
        });
      });
      (restaurant.matched_specials || []).forEach(special => {
        flattenedItems.push({
          item_name: special.special_name,
          description: special.description || special.discount_text,
          restaurant_name: restaurant.name,
          restaurant_slug: restaurant.slug,
          restaurant_rating: restaurant.rating,
          type: 'special'
        });
      });
      (restaurant.matched_events || []).forEach(event => {
        flattenedItems.push({
          item_name: event.event_name,
          description: event.description || event.artist_name,
          event_date: event.event_date,
          restaurant_name: restaurant.name,
          restaurant_slug: restaurant.slug,
          restaurant_rating: restaurant.rating,
          type: 'event'
        });
      });
    });

    // Sort flattened items by relevance (items that match the query term first)
    flattenedItems.sort((a, b) => {
      const aScore = score(a.item_name, a.description);
      const bScore = score(b.item_name, b.description);
      return bScore - aScore;
    });

    res.json({
      query: q,
      results,
      items: flattenedItems,
      total: results.length,
      total_items: flattenedItems.length
    });
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

// ─── Page view tracking ───────────────────────────────────────────────────────
router.post('/track', async (req, res) => {
  try {
    const { page_path, referrer, session_id, device_type, source, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = req.body;
    if (!page_path) return res.status(200).json({ ok: true });
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    await db.from('gcr_page_views').insert({
      page_path, referrer: referrer || null, session_id: session_id || null,
      device_type: device_type || null, source: source || null,
      utm_source: utm_source || null, utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null, utm_term: utm_term || null,
      utm_content: utm_content || null, ip_address: ip
    });
    res.status(200).json({ ok: true });
  } catch {
    res.status(200).json({ ok: true });
  }
});

// ─── Business claim submissions ───────────────────────────────────────────────
router.post('/claim', async (req, res) => {
  try {
    const { business_name, category, contact_name, phone, email, website, message } = req.body || {};
    if (!business_name || !phone) return res.status(400).json({ error: 'business_name and phone required' });
    const { error } = await db.from('business_claims').insert({
      business_name: business_name.trim(),
      category:      category || null,
      contact_name:  contact_name?.trim() || null,
      phone:         phone.trim(),
      email:         email?.trim() || null,
      website:       website?.trim() || null,
      message:       message?.trim() || null,
      status:        'new',
      created_at:    new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('claim error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/gcr/locations/autocomplete ─────────────────────────────────────
router.get('/locations/autocomplete', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });

  const { data, error } = await db
    .from('entity')
    .select('slug, name, city, state, entity_type, entity_subtype, hero_image_url, latitude, longitude')
    .eq('is_active', true)
    .ilike('name', `%${q}%`)
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ results: data || [] });
});

module.exports = router;
