const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// ─── Central-time helper ────────────────────────────────────────────────────
// Vercel serverless functions run in UTC. now.toTimeString()/getDay() return
// UTC-based "local" values which are WRONG for Gulf Coast business hours.
// Always use this to get the real Gulf Coast (America/Chicago) clock.
function getCentralNow() {
  const TZ = 'America/Chicago';
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'long',
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    nowTime: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`, // "HH:MM"
    today: `${parts.year}-${parts.month}-${parts.day}`,                    // "YYYY-MM-DD"
    todayName: parts.weekday.toLowerCase(),                                // "tuesday"
  };
}

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

const SUPABASE_URL = (process.env.GCR_SUPABASE_URL || '').trim();

function normalizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/photos/')) {
    const slug = url.split('/')[2];
    const filename = url.split('/').pop();
    return `${SUPABASE_URL}/storage/v1/object/public/entity-photos/${slug}/${filename}`;
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

  const entityType = (entity.entity_type || '').toLowerCase();
  const isFood = ['restaurant','coffee','dessert','bakery','bar'].includes(entityType);
  const isStay = ['hotel','condo','vacation-rental'].includes(entityType);
  const isActivity = entityType === 'activity';
  const isService = entityType === 'service';
  const isShopping = entityType === 'shopping';
  const isPark = entityType === 'park';

  // ── CORE queries — every business ──────────────────────────────────────────
  const corePromises = [
    db.from('entity_hours').select('day_of_week,opens_at,closes_at,is_closed').eq('entity_slug', slug).order('day_of_week'),
    db.from('entity_photos').select('id,url,image_url,caption,alt_text,sort_order,is_cover').eq('entity_slug', slug).order('sort_order').limit(50),
    db.from('entity_tags').select('tag_name,tag_category').eq('entity_slug', slug),
    db.from('entity_events').select('id,event_name,description,event_date,start_time,end_time,cover_charge,image_url,artist_name,artist_id,day_of_week,recurring, artist:artists!entity_events_artist_id_fkey(id,slug,name,genre,image_url,social_instagram,social_facebook,spotify_url)').eq('entity_slug', slug).eq('is_active', true).order('event_date').limit(20),
    db.from('entity_reviews').select('id,reviewer_name,rating,title,body,verified_purchase,created_at').eq('entity_slug', slug).eq('approved', true).order('created_at', { ascending: false }).limit(20),
    db.from('faqs').select('id,question,answer,category,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_team_members').select('id,name,title,bio,photo_url,specialty,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_policies').select('id,policy_type,title,type,body,content').eq('entity_slug', slug),
    db.from('entity_blog_posts').select('id,title,slug,excerpt,body,cover_url,published_at').eq('entity_slug', slug).order('published_at', { ascending: false }).limit(10),
    db.from('entity_secondary_hours').select('*').eq('entity_slug', slug),
    db.from('announcements').select('id,message,type,starts_at,ends_at').eq('entity_slug', slug).eq('active', true),
    db.from('entity_modules').select('module_key,enabled,sort_order,settings').eq('entity_slug', slug),
    db.from('entity_sections').select('id,module_key,section_type,section_name,subtitle,icon,layout,sort_order,is_active').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
    db.from('entity_about_bullets').select('id,text,icon,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_perfect_for').select('id,label,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_social_posts').select('id,platform,post_url,caption,media_url,thumbnail_url,posted_at,likes_count').eq('entity_slug', slug).order('posted_at', { ascending: false }).limit(12),
  ];

  const [
    hours, photos, tags, events, reviews, faqs, team, policies, blogPosts, secondaryHours, announcements, modulesRes, sectionsRes,
    aboutBulletsRes, perfectForRes, socialPostsRes
  ] = await Promise.all(corePromises);

  // Flexible offerings sections (charters, rentals, tours, etc.) — universal across all entity types
  const sectionRows = sectionsRes?.data || [];
  const sectionIds = sectionRows.map(s => s.id);
  const sectionItemsRes = sectionIds.length
    ? await db.from('entity_section_items')
        .select('id,section_id,item_name,description,duration,price_from,price_to,price_label,icon,sort_order,metadata')
        .in('section_id', sectionIds).order('sort_order')
    : { data: [] };
  const sectionItems = sectionItemsRes.data || [];
  const flexSections = sectionRows.map(s => ({
    ...s,
    items: sectionItems.filter(i => i.section_id === s.id),
  }));

  const modulesData = modulesRes.data || [];
  // Full module list for the response (control panel: enabled + order + settings)
  const modulesFull = modulesData
    .map(m => ({ module_key: m.module_key, enabled: m.enabled !== false, sort_order: m.sort_order ?? 0, settings: m.settings || {} }))
    .sort((a, b) => a.sort_order - b.sort_order);
  // Set of enabled module keys — preserves existing conditional-fetch logic below
  const modules = new Set(modulesData.filter(m => m.enabled !== false).map(m => m.module_key));

  // ── CONDITIONAL queries — only run if module is enabled ───────────────────
  const conditionalPromises = [];
  const conditionalKeys = [];

  if (isFood || modules.has('menu')) {
    conditionalPromises.push(
      db.from('menu_sections').select('id,section_name,sort_order,time_range,available_days').eq('entity_slug', slug).order('sort_order'),
      db.from('drink_sections').select('id,section_name,sort_order,days_of_week,start_time,end_time').eq('entity_slug', slug).order('sort_order'),
      db.from('happy_hour_sections').select('id,section_name,sort_order,days_of_week,start_time,end_time').eq('entity_slug', slug).order('sort_order'),
      db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
      db.from('entity_sides').select('id,item_name,side_name,description,price,sort_order').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
      db.from('entity_daily_features').select('id,label,feature_name,value,description,price,sort_order').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
      db.from('order_links').select('id,label,url,type').eq('entity_slug', slug),
    );
    conditionalKeys.push('menuSections','drinkSections','hhSections','specials','sides','dailyFeatures','orderLinks');
  }

  if (isActivity || modules.has('activity')) {
    conditionalPromises.push(
      db.from('pricing_items').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('whats_included').select('id,item_name,included_item,icon,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('requirements').select('id,requirement_name,requirement_text,applies_to,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('activity_schedules').select('*').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
      db.from('meeting_points').select('id,name,address,lat,lng,instructions,parking_note').eq('entity_slug', slug).order('sort_order'),
      db.from('activity_options').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('fish_species').select('id,species,season').eq('entity_slug', slug).order('sort_order'),
      db.from('what_to_bring').select('id,item,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('activity_details').select('*').eq('entity_slug', slug).maybeSingle(),
    );
    conditionalKeys.push('pricing','whatsIncluded','requirements','schedules','meetingPoints','activityOptions','fishSpecies','whatToBring','activityDetails');
  }

  if (isStay || modules.has('stay')) {
    conditionalPromises.push(
      db.from('property_details').select('*').eq('entity_slug', slug).maybeSingle(),
      db.from('room_types').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('amenities').select('id,name,category,icon,is_shared').eq('entity_slug', slug),
      db.from('property_fees').select('id,name,amount,type,mandatory').eq('entity_slug', slug),
      db.from('stay_links').select('id,label,url,platform').eq('entity_slug', slug),
      db.from('availability').select('id,date,status,spots_remaining').eq('entity_slug', slug).gte('date', new Date().toISOString().split('T')[0]).order('date').limit(60),
      db.from('bookable_resources').select('id,name,slug,resource_type,description,nightly_price,cleaning_fee,service_fee,bedrooms,bathrooms,sqft,capacity,min_nights,check_in_time,check_out_time,amenities,faqs,house_rules,photo_urls,booking_url,wifi_ssid,parking_info,is_active').eq('entity_slug', slug).eq('is_active', true),
    );
    conditionalKeys.push('propertyDetails','roomTypes','amenities','propertyFees','stayLinks','availability','bookableResources');
  }

  if (isService || modules.has('services')) {
    conditionalPromises.push(
      db.from('service_categories').select('id,name,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('service_menu').select('id,category_id,name,description,price,duration_minutes,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('service_packages').select('id,name,description,price,includes').eq('entity_slug', slug),
      db.from('class_schedule').select('id,class_name,day_of_week,start_time,duration_minutes,capacity').eq('entity_slug', slug).order('day_of_week'),
    );
    conditionalKeys.push('serviceCategories','serviceMenu','servicePackages','classSchedule');
  }

  if (isShopping || modules.has('shop')) {
    conditionalPromises.push(
      db.from('product_categories').select('id,name,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('products').select('id,category_id,name,description,price,in_stock,sort_order').eq('entity_slug', slug).eq('in_stock', true).order('sort_order'),
    );
    conditionalKeys.push('productCategories','products');
  }

  if (isPark || modules.has('park')) {
    conditionalPromises.push(
      db.from('facilities').select('id,name,available').eq('entity_slug', slug),
      db.from('spot_rules').select('id,rule').eq('entity_slug', slug),
      db.from('access_info').select('id,entry_point,parking_note,fee').eq('entity_slug', slug).maybeSingle(),
    );
    conditionalKeys.push('facilities','spotRules','accessInfo');
  }

  if (modules.has('loyalty')) {
    conditionalPromises.push(
      db.from('loyalty_programs').select('program_name,keyword,sms_number').eq('entity_slug', slug).eq('active', true).maybeSingle(),
    );
    conditionalKeys.push('loyaltyProgram');
  }

  // Run all conditional queries in parallel
  const conditionalResults = await Promise.all(conditionalPromises);
  const cond = {};
  conditionalKeys.forEach((key, i) => { cond[key] = conditionalResults[i]; });

  // ── SECTION ITEMS — only if sections exist ─────────────────────────────────
  const menuSectionIds = ((cond.menuSections?.data) || []).map(s => s.id);
  const drinkSectionIds = ((cond.drinkSections?.data) || []).map(s => s.id);
  const hhSectionIds = ((cond.hhSections?.data) || []).map(s => s.id);
  const pricingItemIds = ((cond.pricing?.data) || []).map(p => p.id);
  const roomTypeIds = ((cond.roomTypes?.data) || []).map(r => r.id);

  const itemPromises = [];
  const itemKeys = [];

  if (menuSectionIds.length) { itemPromises.push(db.from('menu_items').select('id,section_id,item_name,description,price,image_url,sort_order,is_available').in('section_id', menuSectionIds).order('sort_order')); itemKeys.push('menuItems'); }
  if (drinkSectionIds.length) { itemPromises.push(db.from('drink_items').select('id,section_id,item_name,description,price,is_on_tap,sort_order').in('section_id', drinkSectionIds).order('sort_order')); itemKeys.push('drinkItems'); }
  if (hhSectionIds.length) { itemPromises.push(db.from('happy_hour_items').select('id,section_id,item_name,description,price,original_price,sort_order,is_available').in('section_id', hhSectionIds).order('sort_order')); itemKeys.push('hhItems'); }
  if (pricingItemIds.length) { itemPromises.push(db.from('price_tiers').select('*').in('price_item_id', pricingItemIds).order('sort_order')); itemKeys.push('priceTiers'); }
  if (roomTypeIds.length) { itemPromises.push(db.from('room_amenities').select('id,room_type_id,name').in('room_type_id', roomTypeIds)); itemKeys.push('roomAmenities'); }

  const itemResults = await Promise.all(itemPromises);
  const items = {};
  itemKeys.forEach((key, i) => { items[key] = itemResults[i]?.data || []; });

  const nest = (sections, itemList) =>
    (sections || []).map(sec => ({
      ...sec, items: (itemList || []).filter(i => i.section_id === sec.id),
    }));

  const normalizedPhotos = (photos.data || []).map(p => ({ ...p, url: normalizeImageUrl(p.url), image_url: normalizeImageUrl(p.image_url) }));

  return {
    ...entity,
    hero_image_url: normalizeImageUrl(entity.hero_image_url),
    // Flexible offerings (charters, rentals, tours, services) — universal
    sections: flexSections,
    // Core
    hours: hours.data || [],
    secondary_hours: secondaryHours.data || [],
    photos: normalizedPhotos,
    tags: tags.data || [],
    events: (events.data || []).map(ev => ({
      ...ev,
      artist_slug: ev.artist?.slug || null,
      artist_name: ev.artist?.name || ev.artist_name || null,
      artist_genre: ev.artist?.genre || null,
      artist_image: ev.artist?.image_url ? normalizeImageUrl(ev.artist.image_url) : null,
      image_url: normalizeImageUrl(ev.image_url || ev.artist?.image_url),
    })),
    reviews: reviews.data || [],
    faqs: faqs.data || [],
    team: team.data || [],
    policies: policies.data || [],
    blog_posts: blogPosts.data || [],
    announcements: announcements.data || [],
    social_posts: socialPostsRes.data || [],
    about_bullets: aboutBulletsRes.data || [],
    perfect_for: perfectForRes.data || [],
    good_for_children: entity.good_for_children ?? entity.good_for_kids ?? null,
    modules: modulesFull,
    module_keys: [...modules],
    // Food/Menu
    menu_sections: nest(cond.menuSections?.data, items.menuItems),
    drink_sections: nest(cond.drinkSections?.data, items.drinkItems),
    happy_hour_sections: nest(cond.hhSections?.data, items.hhItems),
    specials: cond.specials?.data || [],
    sides: cond.sides?.data || [],
    daily_features: cond.dailyFeatures?.data || [],
    order_links: cond.orderLinks?.data || [],
    // Activity
    pricing: (cond.pricing?.data || []).map(item => ({
      ...item,
      tiers: items.priceTiers?.filter(t => t.price_item_id === item.id) || [],
    })),
    whats_included: cond.whatsIncluded?.data || [],
    requirements: cond.requirements?.data || [],
    schedules: cond.schedules?.data || [],
    meeting_points: cond.meetingPoints?.data || [],
    activity_options: cond.activityOptions?.data || [],
    fish_species: cond.fishSpecies?.data || [],
    what_to_bring: cond.whatToBring?.data || [],
    activity_details: cond.activityDetails?.data || null,
    // Stay
    property_details: cond.propertyDetails?.data || null,
    room_types: (cond.roomTypes?.data || []).map(room => ({
      ...room,
      room_amenities: items.roomAmenities?.filter(a => a.room_type_id === room.id) || [],
    })),
    amenities: cond.amenities?.data || [],
    property_fees: cond.propertyFees?.data || [],
    stay_links: cond.stayLinks?.data || [],
    availability: cond.availability?.data || [],
    bookable_resources: cond.bookableResources?.data || [],
    // Services
    service_categories: cond.serviceCategories?.data || [],
    service_menu: cond.serviceMenu?.data || [],
    service_packages: cond.servicePackages?.data || [],
    class_schedule: cond.classSchedule?.data || [],
    // Shop
    product_categories: cond.productCategories?.data || [],
    products: cond.products?.data || [],
    // Park
    facilities: cond.facilities?.data || [],
    spot_rules: cond.spotRules?.data || [],
    access_info: cond.accessInfo?.data || null,
    // Loyalty
    loyalty_program: cond.loyaltyProgram?.data || null,
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
    const userId = req.query.user_id || null;
    const sortMode = req.query.sort || 'default'; // 'distance' | 'rating' | 'default'

    // ── Personalization: reuse the same tag-score system that already powers
    // Trip Swipe (GET /api/tourist/preferences → user_preference_scores), so
    // listing-page ranking and swipe-deck ranking learn from the same signal
    // instead of maintaining two different recommendation systems.
    let prefScoreByTag = {};
    if (userId && sortMode === 'default') {
      const { data: scores } = await db.from('user_preference_scores').select('tag, score').eq('tourist_id', userId);
      (scores || []).forEach(s => { prefScoreByTag[(s.tag || '').toLowerCase().trim()] = s.score; });
    }
    const hasPrefSignal = Object.keys(prefScoreByTag).length > 0;

    const results = (entities || []).map(e => {
      const photos = (photoMap[e.slug] || []).map(p => ({ ...p, url: normalizeImageUrl(p.url) }));
      const row = { ...e, tags: tagMap[e.slug] || [], photos, hours: hourMap[e.slug] || [], hero_image_url: normalizeImageUrl(e.hero_image_url) };
      if (userLat !== null && userLng !== null && e.latitude && e.longitude) {
        row.distance_miles = haversine(userLat, userLng, e.latitude, e.longitude);
      }
      return row;
    });

    if (sortMode === 'distance') {
      results.sort((a, b) => (a.distance_miles ?? 9999) - (b.distance_miles ?? 9999));
    } else if (sortMode === 'rating') {
      results.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else {
      // Default ranking: blend personalization (when we have it), rating, and proximity.
      // This replaces the old hardcoded alphabetical-by-name default.
      results.forEach(row => {
        let affinityScore = 0;
        if (hasPrefSignal) {
          const tagNames = (row.tags || []).map(t => (t.tag_name || '').toLowerCase().trim()).filter(Boolean);
          const matchedScores = tagNames.map(t => prefScoreByTag[t]).filter(s => s != null);
          if (matchedScores.length) {
            const avg = matchedScores.reduce((a, b) => a + b, 0) / matchedScores.length;
            affinityScore = Math.max(0, Math.min(1, avg / 30)); // scores are roughly 0-30+, clamp to 0..1
          }
        }
        const ratingScore = (row.rating || 0) / 5; // 0..1
        const distanceScore = row.distance_miles != null ? Math.max(0, 1 - row.distance_miles / 25) : 0.5; // closer = higher, neutral if unknown
        // Weights: personalization matters most once we have signal, otherwise
        // this naturally falls back to a rating/distance blend (score ~= 0 + ratingScore*0.6 + distanceScore*0.4)
        row._score = affinityScore * 0.5 + ratingScore * 0.3 + distanceScore * 0.2;
      });
      results.sort((a, b) => b._score - a._score);
      results.forEach(row => { delete row._score; });
    }

    res.set('Cache-Control', 'public, s-maxage=180, stale-while-revalidate=900');
    res.json({ entities: results, total: results.length, offset, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/entities/paginated ──────────────────────────────────────────
// NEW small-page endpoint for CategoryListings.jsx's infinite-scroll path.
// Sits ALONGSIDE the existing /entities (which still fetches everything for the
// old client-side-filter path) — nothing about /entities changes.
//
// Query params:
//   category   — listing-page bucket (restaurants, things-to-do, nightlife, etc.)
//                resolved via utils/listing-category-map.js, same mapping the
//                frontend's categoryMap.js uses client-side today.
//   tag        — filter to entities having this entity_tags.tag_name
//   search     — name search (same as /entities)
//   sort       — 'distance' | 'rating' | 'default' (personalized blend)
//   lat/lng    — for distance scoring/sorting
//   user_id    — for personalized ranking via user_preference_scores
//   limit      — page size, default 24, max 100
//   offset     — pagination offset
//
// Returns: { entities, total, offset, limit, hasMore }
router.get('/entities/paginated', async (req, res) => {
  try {
    const { subtypesForCategory } = require('../utils/listing-category-map');
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const category = req.query.category || null;
    const tag = req.query.tag || null;

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
        latitude, longitude
      `, { count: 'exact' })
      .eq('is_active', true);

    if (category) {
      const subtypes = subtypesForCategory(category);
      if (category === 'staying') {
        query = query.or(`entity_type.in.(hotel,condo,vacation-rental),entity_subtype.in.(${subtypes.join(',')})`);
      } else if (subtypes.length) {
        query = query.in('entity_subtype', subtypes);
      } else {
        // Unknown category — return nothing rather than silently ignoring the filter
        return res.json({ entities: [], total: 0, offset, limit, hasMore: false });
      }
    }
    if (req.query.search) query = query.ilike('name', `%${req.query.search}%`);

    // Tag filtering requires a join — resolve matching slugs first when a tag is given
    if (tag) {
      const { data: tagRows } = await db.from('entity_tags').select('entity_slug').eq('tag_name', tag);
      const slugsWithTag = [...new Set((tagRows || []).map(r => r.entity_slug))];
      if (!slugsWithTag.length) return res.json({ entities: [], total: 0, offset, limit, hasMore: false });
      query = query.in('slug', slugsWithTag);
    }

    // We need the full matching set (pre-pagination) to rank, then slice —
    // capped at 3000 as a safety bound so a category filter that somehow
    // matches almost everything can't blow up memory/latency.
    const { data: allMatching, error } = await query.limit(3000);
    if (error) return res.status(500).json({ error: error.message });

    const total = allMatching?.length || 0;
    const slugs = (allMatching || []).map(e => e.slug);

    const [tagRows2, photoRows] = await Promise.all([
      slugs.length ? db.from('entity_tags').select('entity_slug, tag_name, tag_category').in('entity_slug', slugs).limit(10000) : { data: [] },
      slugs.length ? db.from('entity_photos').select('entity_slug, url, is_cover, sort_order, caption').in('entity_slug', slugs).eq('is_cover', true).limit(3000) : { data: [] },
    ]);
    const tagMap = {}, photoMap = {};
    (tagRows2.data || []).forEach(r => { if (!tagMap[r.entity_slug]) tagMap[r.entity_slug] = []; tagMap[r.entity_slug].push(r); });
    (photoRows.data || []).forEach(r => { photoMap[r.entity_slug] = r; });

    const userLat = req.query.lat ? parseFloat(req.query.lat) : null;
    const userLng = req.query.lng ? parseFloat(req.query.lng) : null;
    const userId = req.query.user_id || null;
    const sortMode = req.query.sort || 'default';

    let prefScoreByTag = {};
    if (userId && sortMode === 'default') {
      const { data: scores } = await db.from('user_preference_scores').select('tag, score').eq('tourist_id', userId);
      (scores || []).forEach(s => { prefScoreByTag[(s.tag || '').toLowerCase().trim()] = s.score; });
    }
    const hasPrefSignal = Object.keys(prefScoreByTag).length > 0;

    const scored = (allMatching || []).map(e => {
      const row = {
        ...e,
        tags: tagMap[e.slug] || [],
        hero_image_url: normalizeImageUrl(photoMap[e.slug]?.url || e.hero_image_url),
      };
      if (userLat !== null && userLng !== null && e.latitude && e.longitude) {
        row.distance_miles = haversine(userLat, userLng, e.latitude, e.longitude);
      }
      return row;
    });

    if (sortMode === 'distance') {
      scored.sort((a, b) => (a.distance_miles ?? 9999) - (b.distance_miles ?? 9999));
    } else if (sortMode === 'rating') {
      scored.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else {
      scored.forEach(row => {
        let affinityScore = 0;
        if (hasPrefSignal) {
          const tagNames = (row.tags || []).map(t => (t.tag_name || '').toLowerCase().trim()).filter(Boolean);
          const matchedScores = tagNames.map(t => prefScoreByTag[t]).filter(s => s != null);
          if (matchedScores.length) {
            const avg = matchedScores.reduce((a, b) => a + b, 0) / matchedScores.length;
            affinityScore = Math.max(0, Math.min(1, avg / 30));
          }
        }
        const ratingScore = (row.rating || 0) / 5;
        const distanceScore = row.distance_miles != null ? Math.max(0, 1 - row.distance_miles / 25) : 0.5;
        row._score = affinityScore * 0.5 + ratingScore * 0.3 + distanceScore * 0.2;
      });
      scored.sort((a, b) => b._score - a._score);
      scored.forEach(row => { delete row._score; });
    }

    const page = scored.slice(offset, offset + limit);

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({ entities: page, total, offset, limit, hasMore: offset + limit < total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Page Rails — admin-configured horizontal card rows, sponsored or algorithmic ──
// Same building block used on the homepage AND on category pages (per Matt's
// design: every page is a stack of swipeable rails, each independently sellable
// for ad placement). One rail = one row of ~5-12 cards that slides left/right.

// Resolve one rail's content — either the curated sponsored list, or run the
// named algorithm against the rail's target category.
async function resolveRailContent(rail, { userLat, userLng, userId } = {}) {
  const limit = rail.card_limit || 12;

  if (rail.rail_type === 'sponsored') {
    const now = new Date().toISOString();
    const { data: items } = await db
      .from('page_rail_items')
      .select('entity_slug, sort_order, is_ad, badge_text, starts_at, ends_at')
      .eq('rail_id', rail.id)
      .order('sort_order')
      .limit(limit);
    const active = (items || []).filter(i => (!i.starts_at || i.starts_at <= now) && (!i.ends_at || i.ends_at >= now));
    if (!active.length) return [];

    const slugs = active.map(i => i.entity_slug);
    const { data: entities } = await db
      .from('entity')
      .select('id, slug, name, subtitle, entity_type, entity_subtype, icon, rating, review_count, city, hero_image_url, price_range, latitude, longitude')
      .in('slug', slugs)
      .eq('is_active', true);
    const bySlug = Object.fromEntries((entities || []).map(e => [e.slug, e]));

    return active
      .map(i => {
        const e = bySlug[i.entity_slug];
        if (!e) return null;
        return { ...e, is_ad: i.is_ad !== false, badge_text: i.badge_text || null };
      })
      .filter(Boolean);
  }

  // Algorithm rails — pull from the same category-mapped pool as /entities/paginated
  const { subtypesForCategory } = require('../utils/listing-category-map');
  const category = rail.category;
  let query = db
    .from('entity')
    .select('id, slug, name, subtitle, entity_type, entity_subtype, icon, rating, review_count, city, hero_image_url, price_range, latitude, longitude')
    .eq('is_active', true);

  if (category) {
    const subtypes = subtypesForCategory(category);
    if (category === 'staying') {
      query = query.or(`entity_type.in.(hotel,condo,vacation-rental),entity_subtype.in.(${subtypes.join(',')})`);
    } else if (subtypes.length) {
      query = query.in('entity_subtype', subtypes);
    } else {
      return [];
    }
  }

  const { data: candidates } = await query.limit(500);
  if (!candidates?.length) return [];

  if (rail.algorithm === 'newest') {
    return candidates.slice(0, limit); // DB already orders by insertion in practice; good enough for a "newest" rail without an extra query
  }

  const slugs = candidates.map(e => e.slug);

  if (rail.algorithm === 'near_you') {
    if (userLat == null || userLng == null) return []; // nothing to show without a location
    const withDist = candidates
      .filter(e => e.latitude && e.longitude)
      .map(e => ({ ...e, distance_miles: haversine(userLat, userLng, e.latitude, e.longitude) }))
      .sort((a, b) => a.distance_miles - b.distance_miles);
    return withDist.slice(0, limit);
  }

  if (rail.algorithm === 'for_you') {
    if (!userId) return []; // no personalization possible for anonymous visitors
    const [tagRows, scores] = await Promise.all([
      db.from('entity_tags').select('entity_slug, tag_name').in('entity_slug', slugs),
      db.from('user_preference_scores').select('tag, score').eq('tourist_id', userId),
    ]);
    const prefScoreByTag = {};
    (scores.data || []).forEach(s => { prefScoreByTag[(s.tag || '').toLowerCase().trim()] = s.score; });
    if (!Object.keys(prefScoreByTag).length) return []; // no signal yet — let the page fall back to other rails

    const tagMap = {};
    (tagRows.data || []).forEach(r => { if (!tagMap[r.entity_slug]) tagMap[r.entity_slug] = []; tagMap[r.entity_slug].push(r.tag_name); });

    const scored = candidates.map(e => {
      const tagNames = (tagMap[e.slug] || []).map(t => (t || '').toLowerCase().trim());
      const matched = tagNames.map(t => prefScoreByTag[t]).filter(s => s != null);
      const affinity = matched.length ? matched.reduce((a, b) => a + b, 0) / matched.length : -Infinity;
      return { ...e, _affinity: affinity };
    }).filter(e => e._affinity > -Infinity);
    scored.sort((a, b) => b._affinity - a._affinity);
    scored.forEach(e => { delete e._affinity; });
    return scored.slice(0, limit);
  }

  // Default / 'top_rated'
  return candidates
    .filter(e => e.rating != null)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, limit);
}

// GET /api/gcr/page-rails/:page — resolved rails for a page (e.g. 'home', 'restaurants').
// Query params: lat, lng, user_id (optional, improves near_you/for_you rails)
// Returns: { rails: [ { id, title, eyebrow, emoji, rail_type, algorithm, items: [...] } ] }
// Empty rails (e.g. for_you with no signal yet, near_you with no location) are
// omitted from the response so the frontend never renders an empty row.
router.get('/page-rails/:page', async (req, res) => {
  try {
    const { data: rails, error } = await db
      .from('page_rails')
      .select('*')
      .eq('page', req.params.page)
      .eq('is_active', true)
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });

    const userLat = req.query.lat ? parseFloat(req.query.lat) : null;
    const userLng = req.query.lng ? parseFloat(req.query.lng) : null;
    const userId = req.query.user_id || null;

    const resolved = await Promise.all(
      (rails || []).map(async rail => {
        const items = await resolveRailContent(rail, { userLat, userLng, userId });
        return { id: rail.id, title: rail.title, eyebrow: rail.eyebrow, emoji: rail.emoji, rail_type: rail.rail_type, algorithm: rail.algorithm, items };
      })
    );

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({ rails: resolved.filter(r => r.items.length > 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/entity/:slug ────────────────────────────────────────────────
// ─── Ad Network — public serving + tracking (consumed by qr-menu.html etc.) ──

// GET /api/gcr/ads?limit=6 — weighted-random selection of active ads
router.get('/ads', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 6;
  const { data, error } = await db.from('ads').select('*').eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });

  // Weighted shuffle: higher weight = more likely to appear earlier
  const pool = (data || []).flatMap(ad => Array(Math.max(1, ad.weight || 1)).fill(ad));
  const seen = new Set();
  const picked = [];
  while (picked.length < limit && seen.size < (data || []).length) {
    const ad = pool[Math.floor(Math.random() * pool.length)];
    if (!ad || seen.has(ad.id)) continue;
    seen.add(ad.id);
    picked.push(ad);
  }
  res.json({ ads: picked });
});

// POST /api/gcr/ads/:id/impression — fire-and-forget view counter
router.post('/ads/:id/impression', async (req, res) => {
  const { data } = await db.from('ads').select('impressions').eq('id', req.params.id).single();
  if (data) await db.from('ads').update({ impressions: (data.impressions || 0) + 1 }).eq('id', req.params.id);
  res.json({ success: true });
});

// POST /api/gcr/ads/:id/click — fire-and-forget click counter
router.post('/ads/:id/click', async (req, res) => {
  const { data } = await db.from('ads').select('clicks').eq('id', req.params.id).single();
  if (data) await db.from('ads').update({ clicks: (data.clicks || 0) + 1 }).eq('id', req.params.id);
  res.json({ success: true });
});

router.get('/entity/:slug', async (req, res) => {
  try {
    const entity = await buildFullEntity(req.params.slug);
    if (!entity) return res.status(404).json({ error: 'Not found' });
    // Cache at Vercel edge for 2 min, allow stale for 10 min while revalidating
    res.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
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

// ─── POST /api/gcr/entity/:slug/daily-update ──────────────────────────────────
// Quick same-day save from cybercheck-links- daily-menu.html — manager-facing
// "today's specials / menu tweaks" page. PIN-authenticated via x-menu-pin header
// (must match entity.menu_pin exactly — this page has no token exchange step).
// Body: { specials: [...], menu: [...], drinks: [...], hh: [...], events: [...] }
//   Each array element with an `id` is treated as an update to an existing row;
//   elements without an `id` are inserted as new rows.
router.post('/entity/:slug/daily-update', async (req, res) => {
  try {
    const slug = req.params.slug;
    const pin = req.headers['x-menu-pin'];
    if (!pin) return res.status(401).json({ error: 'PIN required' });

    const { data: entity } = await db.from('entity').select('slug, menu_pin').eq('slug', slug).single();
    if (!entity) return res.status(404).json({ error: 'Business not found' });
    if (!entity.menu_pin) return res.status(403).json({ error: 'Menu editing not enabled for this business' });
    if (String(entity.menu_pin) !== String(pin)) return res.status(401).json({ error: 'Incorrect PIN' });

    const { specials = [], menu = [], drinks = [], hh = [], events = [] } = req.body;

    // Specials — entity_specials has no section grouping, just entity_slug-owned rows
    for (const s of specials) {
      const row = {
        entity_slug: slug,
        special_name: s.name || s.special_name,
        description: s.description || null,
        discount_text: s.price != null && s.price !== '' ? `$${s.price}` : (s.discount_text || null),
        is_active: true,
      };
      if (s.id) await db.from('entity_specials').update(row).eq('id', s.id).eq('entity_slug', slug);
      else await db.from('entity_specials').insert(row);
    }

    // Menu / Drinks / Happy Hour items — these live in menu_items/drink_items/happy_hour_items,
    // each tied to a section_id. Only update items that already have an id + section_id;
    // skip brand-new items here since there's no section context to attach them to
    // (use the full menu editor at /api/menu-editor for creating new sections/items).
    const updateItemTable = async (table, items, priceField = 'price') => {
      for (const it of items) {
        if (!it.id) continue; // no section to attach a new item to from this quick-edit page
        const row = {
          item_name: it.name || it.item_name,
          description: it.description || null,
        };
        if (priceField) row[priceField] = it.price != null && it.price !== '' ? parseFloat(it.price) : null;
        await db.from(table).update(row).eq('id', it.id);
      }
    };
    await updateItemTable('menu_items', menu);
    await updateItemTable('drink_items', drinks);
    await updateItemTable('happy_hour_items', hh);

    // Events — entity_events owned directly by entity_slug
    for (const e of events) {
      const row = {
        entity_slug: slug,
        event_name: e.name || e.event_name,
        description: e.description || null,
        is_active: true,
      };
      if (e.id) await db.from('entity_events').update(row).eq('id', e.id).eq('entity_slug', slug);
      else await db.from('entity_events').insert(row);
    }

    res.json({ success: true, slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/events ──────────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  try {
    let query = db
      .from('entity_events')
      .select('*, entity:entity_slug(slug, name, icon, hero_image_url, city, address_line_1, phone), artist:artists!entity_events_artist_id_fkey(id, name, slug, bio, genre, hometown, image_url, website_url, social_instagram, social_facebook, social_tiktok, spotify_url)')
      .eq('is_active', true)
      .order('event_date', { ascending: true, nullsFirst: false });

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
      event_type: ev.event_type || null,
      artist_name: ev.artist?.name || ev.artist_name || null,
      artist: ev.artist || null,
      cover_charge: ev.cover_charge,
      image_url: normalizeImageUrl(ev.image_url || ev.artist?.image_url || ev.entity?.hero_image_url),
      entity_slug: ev.entity_slug,
      entity_name: ev.entity?.name || '',
      icon: ev.entity?.icon || '🏪',
      hero_image_url: normalizeImageUrl(ev.entity?.hero_image_url),
      city: ev.entity?.city || '',
      address_line_1: ev.entity?.address_line_1 || '',
      phone: ev.entity?.phone || '',
    }));

    // Sort: dated events first (ascending), then recurring by day_of_week
    results.sort((a, b) => {
      if (a.event_date && b.event_date) return a.event_date.localeCompare(b.event_date);
      if (a.event_date && !b.event_date) return -1;
      if (!a.event_date && b.event_date) return 1;
      const dowOrder = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
      return (dowOrder[a.day_of_week] ?? 7) - (dowOrder[b.day_of_week] ?? 7);
    });

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

    res.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
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
      { type: 'nightlife', name: 'Bars & Nightlife', icon: '🍸', count: 0 },
      { type: 'wellness', name: 'Health & Wellness', icon: '💆', count: 0 },
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
      nightlife: {
        page_title: 'Bars & Nightlife',
        page_description: 'Bars, breweries, clubs, and nightlife on the Gulf Coast.'
      },
      wellness: {
        page_title: 'Health & Wellness',
        page_description: 'Spas, salons, gyms, and wellness services on the Gulf Coast.'
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
      .eq('parent_entity_slug', req.params.parentSlug)
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
    const { nowTime, today: nowDate } = getCentralNow();

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
    const { page_path, entity_slug } = req.body;
    if (!page_path && !entity_slug) return res.status(200).json({ ok: true });

    // gcr_page_views is a daily rollup table (entity_id, view_date, view_count),
    // not a raw event log — only entity profile views are tracked here.
    // Resolve slug from the path if not given directly (e.g. /business/:slug)
    let slug = entity_slug;
    if (!slug && page_path) {
      const m = page_path.match(/\/business\/([^/?]+)/);
      if (m) slug = decodeURIComponent(m[1]);
    }
    if (!slug) return res.status(200).json({ ok: true }); // not an entity page — nothing to roll up

    const { data: entity } = await db.from('entity').select('id').eq('slug', slug).maybeSingle();
    if (!entity) return res.status(200).json({ ok: true });

    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await db.from('gcr_page_views').select('id, view_count').eq('entity_id', entity.id).eq('view_date', today).maybeSingle();
    if (existing) {
      await db.from('gcr_page_views').update({ view_count: (existing.view_count || 0) + 1 }).eq('id', existing.id);
    } else {
      await db.from('gcr_page_views').insert({ entity_id: entity.id, view_date: today, view_count: 1 });
    }
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

// ─── POST /api/gcr/nfc-card-lead ─────────────────────────────────────────────
router.post('/nfc-card-lead', async (req, res) => {
  const { name, phone, email, business_name, business_type, industry, website, met_at, source, entity_id } = req.body;

  const { data, error } = await db.from('leads').insert([{
    name,
    phone,
    email,
    business_name,
    business_type,
    industry,
    website,
    met_at,
    source: source || 'nfc-card-matt',
    entity_id: entity_id || null,
    status: 'new'
  }]).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, lead: data });
});

// ─── GET /api/gcr/home-feed ───────────────────────────────────────────────────
// Returns all sliding card rows for the home page in one request
router.get('/home-feed', async (req, res) => {
  try {
    const { nowTime, today, todayName } = getCentralNow();
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

    const ENTITY_COLS = 'id,slug,name,entity_type,entity_subtype,hero_image_url,rating,city,price_range';

    // Run all queries in parallel
    const [eventsRes, specialsRes, hhRes, liveMusicRes, thingsRes] = await Promise.all([

      // 🎉 Events tonight / this week
      db.from('entity_events')
        .select(`id, event_name, event_date, start_time, cover_charge, image_url, artist_name, day_of_week, recurring, entity_slug, entity:entity_slug(${ENTITY_COLS})`)
        .eq('is_active', true)
        .or(`event_date.eq.${today},and(recurring.eq.true,day_of_week.eq.${todayName})`)
        .order('start_time')
        .limit(20),

      // ⭐ Specials active today
      db.from('entity_specials')
        .select(`id, title, special_name, description, discount_text, image_url, entity_slug, entity:entity_slug(${ENTITY_COLS})`)
        .eq('is_active', true)
        .limit(20),

      // 🍺 Happy hours active RIGHT NOW
      db.from('entity')
        .select(`id, slug, name, hero_image_url, hh_days, hh_start, hh_end, hh_description, rating, city`)
        .eq('is_active', true)
        .not('hh_start', 'is', null)
        .not('hh_end', 'is', null)
        .limit(50),

      // 🎸 Live music events today
      db.from('entity_events')
        .select(`id, event_name, event_date, start_time, image_url, artist_name, artist_id, entity_slug, entity:entity_slug(${ENTITY_COLS}), artist:artists!entity_events_artist_id_fkey(id,slug,name,image_url)`)
        .eq('is_active', true)
        .or(`event_date.eq.${today},and(recurring.eq.true,day_of_week.eq.${todayName})`)
        .not('artist_name', 'is', null)
        .order('start_time')
        .limit(20),

      // 🌊 Things to do — activities, tours, charters
      db.from('entity')
        .select(ENTITY_COLS)
        .eq('is_active', true)
        .in('entity_type', ['activity','charter','tour','park'])
        .order('rating', { ascending: false, nullsFirst: false })
        .limit(20),
    ]);

    // Filter happy hours to only ones active right now
    const happyHoursNow = (hhRes.data || []).filter(e => {
      if (!e.hh_start || !e.hh_end) return false;
      const days = (e.hh_days || '').toLowerCase().trim();

      // Check if today's day is covered
      const dayMatch = (() => {
        if (!days) return true;                          // no restriction = always
        if (days.includes('daily')) return true;         // "Daily" always matches
        if (days.includes('every day')) return true;
        if (days.includes(todayName)) return true;       // "sunday" in string
        if (days.includes(todayName.slice(0, 3))) return true; // "sun" in string
        // Handle "Mon-Fri" / "Monday–Friday" style ranges
        const dayOrder = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        const todayIdx = dayOrder.indexOf(todayName);
        // Look for range patterns like "mon-fri", "monday–friday", "mon–sat"
        const rangeMatch = days.match(/(\w+)\s*[-–]\s*(\w+)/);
        if (rangeMatch) {
          const startDay = dayOrder.findIndex(d => d.startsWith(rangeMatch[1].slice(0,3)));
          const endDay   = dayOrder.findIndex(d => d.startsWith(rangeMatch[2].slice(0,3)));
          if (startDay !== -1 && endDay !== -1) {
            if (startDay <= endDay) return todayIdx >= startDay && todayIdx <= endDay;
            else return todayIdx >= startDay || todayIdx <= endDay; // wraps Sat→Sun
          }
        }
        return false;
      })();

      if (!dayMatch) return false;

      // Compare times — hh_start/hh_end are "HH:MM:SS", nowTime is "HH:MM"
      const start = e.hh_start.slice(0, 5);
      const end   = e.hh_end.slice(0, 5);
      return nowTime >= start && nowTime <= end;
    });

    // Social posts for home feed
    const { data: socialPosts } = await db
      .from('social_posts')
      .select('id,image_url,caption,card_title,card_entity_name,card_city,card_type,post_url,entity_slug,post_date,source')
      .eq('is_active', true)
      .eq('show_on_home', true)
      .order('post_date', { ascending: false })
      .limit(30);

    res.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
    res.json({
      events:           eventsRes.data   || [],
      specials:         specialsRes.data || [],
      happyHours:       happyHoursNow,
      happyHoursAll:    hhRes.data       || [],   // full list for "coming up" fallback
      liveMusic:        liveMusicRes.data || [],
      thingsToDo:       thingsRes.data   || [],
      socialPosts:      socialPosts      || [],
      meta: {
        serverTime:  nowTime,
        serverDay:   todayName,
        serverDate:  today,
      }
    });
  } catch (err) {
    console.error('home-feed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/gcr/availability-search ───────────────────────────────────────
// Search by date range — returns bookable businesses (photographers, charters,
// rentals, etc.) that have availability data for the requested dates.
// Tourists who are signed in use this to find who can take them during their trip.
//
// Body: { date_from, date_to, type, query, lat, lng }
//   type: 'charter' | 'photographer' | 'rental' | 'activity' | 'all'
//   date_from/date_to: YYYY-MM-DD
router.post('/availability-search', async (req, res) => {
  try {
    const {
      date_from,
      date_to,
      type = 'all',
      query = '',
      lat,
      lng,
      limit = 50,
    } = req.body;

    if (!date_from) return res.status(400).json({ error: 'date_from required' });

    const dateTo = date_to || date_from;

    // 1. Find entities with availability data in this date range
    let availQuery = db
      .from('business_availability')
      .select('entity_slug, availability_date, time_slot, end_time, status, remaining_spots, total_capacity, booking_type')
      .gte('availability_date', date_from)
      .lte('availability_date', dateTo)
      .neq('status', 'full') // exclude fully booked slots
      .order('availability_date')
      .order('time_slot');

    const { data: availRows, error: availErr } = await availQuery;
    if (availErr) return res.status(500).json({ error: availErr.message });

    // Group availability by entity_slug
    const availMap = {};
    (availRows || []).forEach(row => {
      if (!availMap[row.entity_slug]) availMap[row.entity_slug] = [];
      availMap[row.entity_slug].push(row);
    });

    // Slugs that have availability data
    const availSlugs = Object.keys(availMap);

    // 2. Also search by entity type even without availability data
    // (businesses that haven't set up email parsing yet still show up,
    //  just without the slot-level detail)
    const TYPE_FILTERS = {
      charter:      ['fishing_charter', 'charter', 'fishing-charter', 'boat_charter'],
      photographer: ['photographer', 'photography', 'photo_session'],
      rental:       ['boat_rental', 'boat-rental', 'jet_ski', 'kayak', 'equipment_rental'],
      activity:     ['activity', 'tour', 'parasailing', 'dolphin_cruise', 'sunset_cruise'],
      all:          [],
    };

    const subtypes = TYPE_FILTERS[type] || [];

    let entityQuery = db
      .from('entity')
      .select(`
        id, slug, name, subtitle, entity_type, entity_subtype, icon,
        phone, rating, review_count, city, state, hero_image_url,
        booking_url, reservation_url, price_from, price_unit,
        duration_text, latitude, longitude, daily_capacity, capacity_per_slot,
        description
      `)
      .eq('is_active', true)
      .limit(limit);

    // Filter by type
    if (type !== 'all' && subtypes.length > 0) {
      entityQuery = entityQuery.in('entity_subtype', subtypes);
    } else if (type === 'all') {
      // For 'all' with availability — only bookable types
      entityQuery = entityQuery.in('entity_type', ['activity', 'service']);
    }

    // Optional keyword filter
    if (query.trim()) {
      const term = query.trim();
      entityQuery = entityQuery.or(`name.ilike.%${term}%,description.ilike.%${term}%,entity_subtype.ilike.%${term}%`);
    }

    const { data: entities, error: entErr } = await entityQuery;
    if (entErr) return res.status(500).json({ error: entErr.message });

    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;

    // 3. Build results — merge entity data with availability slots
    const results = (entities || []).map(e => {
      const slots = availMap[e.slug] || [];
      const hasAvailability = slots.length > 0;

      // Find best available slot in range
      const openSlots = slots.filter(s => s.status !== 'full');
      const lowestRemaining = openSlots.length
        ? Math.min(...openSlots.map(s => s.remaining_spots).filter(n => n != null))
        : null;

      // Unique dates with availability
      const availDates = [...new Set(openSlots.map(s => s.availability_date))].sort();

      const distance_miles = (userLat && userLng && e.latitude && e.longitude)
        ? haversine(userLat, userLng, e.latitude, e.longitude)
        : null;

      return {
        ...e,
        has_availability: hasAvailability,
        available_dates: availDates,
        slots: openSlots,
        lowest_remaining: lowestRemaining,
        distance_miles,
        // Availability confidence for sorting:
        // 0 = no data, 1 = has entity but no slots, 2 = has slots with data
        _avail_rank: hasAvailability ? 2 : (e.booking_url ? 1 : 0),
      };
    });

    // Sort: availability data first, then by distance, then rating
    results.sort((a, b) => {
      if (b._avail_rank !== a._avail_rank) return b._avail_rank - a._avail_rank;
      if (a.distance_miles != null && b.distance_miles != null) return a.distance_miles - b.distance_miles;
      return (b.rating || 0) - (a.rating || 0);
    });

    res.json({
      date_from,
      date_to: dateTo,
      type,
      results,
      total: results.length,
      with_availability: results.filter(r => r.has_availability).length,
    });
  } catch (err) {
    console.error('availability-search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gcr/social-posts/feed — all active social posts across all entities for the swipe deck
router.get('/social-posts/feed', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 50)
    const offset = Math.max(parseInt(req.query.offset) || 0,  0)
    const { data, error } = await db
      .from('social_posts')
      .select('id, entity_slug, source, post_url, image_url, video_url, caption, media_type, post_date, platform_post_id')
      .eq('is_active', true)
      .order('post_date', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) return res.status(500).json({ error: error.message })

    // Enrich with entity name for the card display
    const slugs = [...new Set((data || []).map(p => p.entity_slug).filter(Boolean))]
    const nameMap = {}
    if (slugs.length) {
      const { data: entities } = await db.from('entity').select('slug, name').in('slug', slugs)
      ;(entities || []).forEach(e => { nameMap[e.slug] = e.name })
    }
    const posts = (data || []).map(p => ({ ...p, entity_name: nameMap[p.entity_slug] || null }))
    res.json({ posts })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Social Posts — business pastes their IG/FB/TikTok URL, we fetch metadata ──
// GET  /api/gcr/entity/:slug/social-posts  — list active posts for a profile page
// POST /api/gcr/entity/:slug/social-posts  — paste a URL, fetch oEmbed, save
// DELETE /api/gcr/social-posts/:id         — remove a post

// Resolve oEmbed metadata from Instagram, Facebook, or TikTok
async function fetchOEmbed(postUrl) {
  const url = postUrl.trim()
  let oembedUrl = null

  if (url.includes('instagram.com')) {
    oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&fields=thumbnail_url,title,author_name,media_type&maxwidth=640`
    // Instagram oEmbed is free without token for basic fields — try it first
    // Fallback: just store the URL and derive thumbnail from post shortcode
  } else if (url.includes('facebook.com')) {
    oembedUrl = `https://www.facebook.com/plugins/post/oembed.json/?url=${encodeURIComponent(url)}&maxwidth=640`
  } else if (url.includes('tiktok.com')) {
    oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
  }

  if (!oembedUrl) return null

  try {
    const res = await fetch(oembedUrl, { headers: { 'User-Agent': 'GulfCoastRadar/1.0' }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Detect platform and media type from URL
function detectPost(url) {
  if (url.includes('instagram.com')) {
    const platform = 'instagram'
    const isReel = url.includes('/reel/')
    const isVideo = url.includes('/tv/')
    const media_type = isReel ? 'reel' : isVideo ? 'video' : 'image'
    return { platform, media_type }
  }
  if (url.includes('facebook.com')) return { platform: 'facebook', media_type: 'video' }
  if (url.includes('tiktok.com')) return { platform: 'tiktok', media_type: 'video' }
  return null
}

router.get('/entity/:slug/social-posts', async (req, res) => {
  try {
    const { data, error } = await db.from('entity_social_posts')
      .select('id, platform, post_url, media_type, thumbnail_url, video_url, caption, duration_seconds, sort_order')
      .eq('entity_slug', req.params.slug)
      .eq('is_active', true)
      .order('sort_order')
    if (error) return res.status(500).json({ error: error.message })
    res.json({ posts: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/entity/:slug/social-posts', async (req, res) => {
  try {
    const { post_url, duration_seconds } = req.body
    if (!post_url) return res.status(400).json({ error: 'post_url required' })

    const detected = detectPost(post_url)
    if (!detected) return res.status(400).json({ error: 'URL must be from Instagram, Facebook, or TikTok' })

    // Try oEmbed to get thumbnail + caption
    const oembed = await fetchOEmbed(post_url)

    // For Instagram Reels, derive a thumbnail from the shortcode as fallback
    let thumbnail_url = oembed?.thumbnail_url || null
    if (!thumbnail_url && post_url.includes('instagram.com')) {
      const match = post_url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)
      if (match) {
        // Public Instagram CDN thumbnail pattern
        thumbnail_url = `https://www.instagram.com/${match[1]}/${match[2]}/media/?size=l`
      }
    }

    const { data, error } = await db.from('entity_social_posts').insert({
      entity_slug: req.params.slug,
      platform: detected.platform,
      post_url: post_url.trim(),
      media_type: detected.media_type,
      thumbnail_url,
      caption: oembed?.title || oembed?.author_name || null,
      duration_seconds: duration_seconds || null,
      is_active: true,
      fetched_at: new Date().toISOString(),
    }).select('*').single()

    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, post: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/social-posts/:id', async (req, res) => {
  try {
    const { error } = await db.from('entity_social_posts').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Artist Live Page ─────────────────────────────────────────────────────────
// GET /api/gcr/artist/:slug/live — all data needed for the fan-facing live request page
router.get('/artist/:slug/live', async (req, res) => {
  try {
    const { data, error } = await db
      .from('artist_profiles')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('is_active', true)
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Artist not found' })

    // Get active show if set
    let activeShow = null
    if (data.active_show_id) {
      const { data: show } = await db
        .from('entity_events')
        .select('id, event_name, start_time, end_time, entity_slug, entity:entity_slug(name, city)')
        .eq('id', data.active_show_id)
        .maybeSingle()
      activeShow = show || null
    }

    res.json({
      artist: {
        slug:            data.slug,
        name:            data.artist_name,
        photo_url:       data.photo_url,
        genre:           data.genre,
        hometown:        data.hometown,
        bio:             data.bio,
        cashapp:         data.cashapp_handle || data.cashtag,
        venmo:           data.venmo_handle   || data.venmo,
        songs:           data.songs          || [],
        default_min:     data.default_min_request_amount || 5,
        request_enabled: data.request_enabled !== false,
        shoutout_enabled: data.shoutout_enabled !== false,
        instagram_url:   data.instagram_url,
        spotify_url:     data.spotify_url,
      },
      show: activeShow ? {
        id:         activeShow.id,
        venue:      activeShow.entity?.name || activeShow.event_name,
        city:       activeShow.entity?.city || null,
        start_time: activeShow.start_time,
        end_time:   activeShow.end_time,
      } : null
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/gcr/artist/:slug/request — log a song request
router.post('/artist/:slug/request', async (req, res) => {
  try {
    const { song, name, message, amount, type } = req.body
    await db.from('artist_requests').insert({
      artist_slug: req.params.slug,
      song:        song || null,
      fan_name:    name || null,
      message:     message || null,
      amount:      amount || 0,
      type:        type || 'request', // 'request' | 'shoutout' | 'tip'
      paid:        false,
      created_at:  new Date().toISOString(),
    })
    res.json({ success: true })
  } catch (err) {
    // Table may not exist yet — don't block the fan flow
    res.json({ success: true })
  }
})

module.exports = router;
