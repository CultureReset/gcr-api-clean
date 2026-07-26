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

const { getContractForIndustry, getIndustryFacts } = require('../lib/industry-contract');

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
  if (req.method === 'GET') res.set('Cache-Control', 'max-age=300, s-maxage=300, stale-while-revalidate=60');
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
    // entity_photos has url/caption (NOT image_url/alt_text — selecting missing
    // columns errors the whole query and silently blanked photos platform-wide)
    // limit(500): some vacation-rental complexes carry 100-260+ photos (e.g.
    // Bay Breeze RV has 266) — the old limit(50) silently dropped everything
    // past the 50th, which looked like "half my photos are missing" on any
    // business with more than 50. 500 is comfortably above the current max.
    db.from('entity_photos').select('id,url,image_path,caption,photo_type,sort_order,is_cover').eq('entity_slug', slug).order('sort_order').limit(500),
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
    db.from('entity_sections').select('id,module_key,section_type,section_name,subtitle,icon,image_url,image_path,layout,sort_order,is_active').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
    db.from('entity_about_bullets').select('id,text,icon,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_perfect_for').select('id,label,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_social_posts').select('id,platform,post_url,caption,media_url,thumbnail_url,posted_at,likes_count').eq('entity_slug', slug).order('posted_at', { ascending: false }).limit(12),
    // Hub detection: does anything list this entity as its parent? (marinas,
    // condo towers, multi-venue complexes — see entity.parent_entity_slug,
    // NOT parent_slug — that column doesn't exist and silently made this
    // query fail/return 0 for every entity). head:true + count:'exact'
    // means Postgres only returns the count, not the rows.
    db.from('entity').select('id', { count: 'exact', head: true }).eq('parent_entity_slug', slug).eq('is_active', true),
    // Specials/discounts are universal, NOT a restaurant-only concept (a
    // last-minute condo rate cut, a discounted dolphin cruise seat, are just
    // as much a "special" as a food deal) — this used to only be fetched
    // inside the isFood conditional block below, so every non-food business
    // silently had its entity_specials rows ignored no matter what was in
    // the table.
    db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
    // Structured facts + proximity + exclusions — these tables held tens of
    // thousands of rows that never reached the payload; the voice AI (and
    // anything else reading the entity) needs them queryable at the source.
    db.from('entity_attributes').select('category,key,label,value,value_type,unit,is_filterable').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_nearby_landmarks').select('kind,name,types,spatial_relationship,containment,travel_distance_meters,straight_line_distance_meters').eq('entity_slug', slug).order('sort_order').limit(25),
    db.from('whats_excluded').select('id,excluded_item,sort_order').eq('entity_slug', slug).order('sort_order'),
    // Money pack — structured fees / deposits / refund rules / weather rules
    // (universal: any business can carry these, per industry_table_contract)
    db.from('entity_offer_fee').select('id,offer_id,resource_id,fee_name,fee_type,amount,amount_type,mandatory,refundable,description,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_offer_deposit').select('id,offer_id,resource_id,deposit_name,deposit_type,amount,amount_type,refundable,due_at,refund_window_days,description,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_refund_policy').select('id,offer_id,policy_name,policy_type,full_refund_window_hours,partial_refund_window_hours,partial_refund_percent,non_refundable,weather_dependent,reschedule_allowed,cancellation_fee,terms,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('weather_rules').select('id,rule_type,condition,threshold,action,refund_percent,description,sort_order').eq('entity_slug', slug).order('sort_order'),
  ];

  const [
    hours, photos, tags, events, reviews, faqs, team, policies, blogPosts, secondaryHours, announcements, modulesRes, sectionsRes,
    aboutBulletsRes, perfectForRes, socialPostsRes, childCountRes, specialsRes,
    attributesRes, landmarksRes, whatsExcludedRes,
    offerFeesRes, offerDepositsRes, refundPoliciesRes, weatherRulesRes
  ] = await Promise.all(corePromises);

  // Flexible offerings sections (charters, rentals, tours, etc.) — universal across all entity types
  const sectionRows = sectionsRes?.data || [];
  const sectionIds = sectionRows.map(s => s.id);
  const sectionItemsRes = sectionIds.length
    ? await db.from('entity_section_items')
        .select('id,section_id,item_name,description,duration,price_from,price_to,price_label,icon,image_url,image_path,sort_order,metadata')
        .in('section_id', sectionIds).order('sort_order')
    : { data: [] };
  const sectionItems = sectionItemsRes.data || [];
  // price_tiers can link via section_item_id (universal entity_section_items —
  // this is what real data actually uses) or price_item_id (activity-specific
  // pricing_items, below). Fetch both; whichever side has rows attaches.
  const sectionItemIds = sectionItems.map(i => i.id);
  const sectionTiersRes = sectionItemIds.length
    ? await db.from('price_tiers').select('*').in('section_item_id', sectionItemIds).order('sort_order')
    : { data: [] };
  const sectionTiers = sectionTiersRes.data || [];
  const flexSections = sectionRows.map(s => ({
    ...s,
    items: sectionItems
      .filter(i => i.section_id === s.id)
      .map(i => ({ ...i, tiers: sectionTiers.filter(t => t.section_item_id === i.id) })),
  }));

  // Universal offerings (offerings + offering_prices) — trips, rentals, tours,
  // storage tiers, ride tickets. Merged into the same sections shape the page
  // already renders, grouped by offerings.section (fallback: kind).
  const [offeringsRes, offeringPricesRes, amenityRowsRes, marinaRes, availTodayRes, industryFacts] = await Promise.all([
    db.from('offerings').select('id,section,name,description,unit,kind,price_from,capacity,duration_minutes,event_date,fee_note,sort_order,image_url').eq('entity_slug', slug).eq('active', true).order('sort_order'),
    db.from('offering_prices').select('id,offering_id,label,price,age_min,age_max,season,duration_label,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('entity_amenities').select('id,amenity,category,sort_order').eq('entity_slug', slug).order('sort_order'),
    db.from('marina_details').select('*').eq('entity_slug', slug).maybeSingle(),
    db.from('business_availability').select('total_capacity,remaining_spots,status,source_platform,last_updated').eq('entity_slug', slug).eq('availability_date', new Date().toISOString().split('T')[0]).eq('visible_on_profile', true).maybeSingle(),
    // Industry facts: the entity's direct industry table (industry_<code>),
    // resolved through the industry_table_contract router
    getIndustryFacts(db, entity),
  ]);
  const offeringRows = offeringsRes.data || [];
  const offeringPrices = offeringPricesRes.data || [];
  const marinaDetails = marinaRes?.data || null;
  const availabilityToday = availTodayRes?.data || null;
  // Connected parent (marina/complex/condo hub) — child pages link back to it,
  // and unit pages show the complex's amenities alongside their own
  let parentInfo = null;
  let parentAmenities = [];
  if (entity.parent_entity_slug) {
    const [pRes, paRes] = await Promise.all([
      db.from('entity').select('slug,name,entity_type,entity_subtype,hero_image_url').eq('slug', entity.parent_entity_slug).eq('is_active', true).maybeSingle(),
      db.from('entity_tags').select('tag_name').eq('entity_slug', entity.parent_entity_slug).eq('tag_category', 'amenity'),
    ]);
    parentInfo = pRes.data || null;
    parentAmenities = [...new Set((paRes.data || []).map(t => t.tag_name).filter(Boolean))];
  }
  if (marinaDetails) {
    const md = marinaDetails;
    const facts = [
      md.total_slips && { name: 'Boat slips', desc: `${md.total_slips} slips${md.transient_slips ? ` (${md.transient_slips} transient)` : ''}` },
      md.max_vessel_length_ft && { name: 'Max vessel length', desc: `${md.max_vessel_length_ft} ft` },
      (md.has_gas || md.has_diesel) && { name: 'Fuel dock', desc: [md.has_gas && 'gas', md.has_diesel && 'diesel'].filter(Boolean).join(' + ') },
      md.has_pump_out && { name: 'Pump-out', desc: 'available' },
      md.has_dry_storage && { name: 'Dry storage', desc: 'available' },
      (md.has_live_bait || md.has_frozen_bait || md.has_tackle) && { name: 'Bait & tackle', desc: [md.has_live_bait && 'live bait', md.has_frozen_bait && 'frozen bait', md.has_tackle && 'tackle'].filter(Boolean).join(', ') },
      md.vhf_channel && { name: 'VHF channel', desc: String(md.vhf_channel) },
      md.daily_rate_per_ft && { name: 'Daily rate', desc: `$${md.daily_rate_per_ft}/ft` },
      md.transient_rate_per_ft && { name: 'Transient slip rate', desc: `$${md.transient_rate_per_ft}/ft` },
      md.parking_available && { name: 'Trailer / vehicle parking', desc: md.parking_fee_text || 'available' },
      md.shore_power_amps && { name: 'Shore power', desc: md.shore_power_amps },
      md.power_fee_text && { name: 'Commercial power', desc: md.power_fee_text },
      md.store_items?.length && { name: 'Dock store carries', desc: md.store_items.join(', ') },
      md.tackle_notes && { name: 'Tackle notes', desc: md.tackle_notes },
      md.notes && { name: 'Notes', desc: md.notes },
    ].filter(Boolean);
    if (facts.length) {
      flexSections.push({
        id: -1000, module_key: 'marina', section_type: 'marina',
        section_name: 'Marina', subtitle: null, icon: null, layout: 'list',
        sort_order: 950, is_active: true,
        items: facts.map((f, i) => ({ id: -(1001 + i), section_id: null, item_name: f.name, description: f.desc, duration: null, price_from: null, price_to: null, price_label: null, icon: null, sort_order: i, metadata: {}, tiers: [] })),
      });
    }
  }
  if (offeringRows.length) {
    const groups = new Map();
    for (const o of offeringRows) {
      const key = o.section || ({ trip: 'Trips & Charters', rental: 'Rentals', tour: 'Tours', service: 'Services', storage: 'Storage', ticket: 'Tickets' }[o.kind] || 'Offerings');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    let synthId = -1;
    for (const [name, items] of groups) {
      flexSections.push({
        id: synthId--, module_key: 'offerings', section_type: 'offerings',
        section_name: name, subtitle: null, icon: null, layout: 'list',
        sort_order: 900 + flexSections.length, is_active: true,
        items: items.map(o => ({
          id: o.id, section_id: null,
          item_name: o.name,
          description: [o.description, o.fee_note].filter(Boolean).join(' — '),
          duration: o.duration_minutes ? (o.duration_minutes % 60 === 0 ? `${o.duration_minutes / 60} hr` : `${o.duration_minutes} min`) : null,
          price_from: o.price_from, price_to: null,
          price_label: o.unit ? String(o.unit).replace(/_/g, ' ') : null,
          icon: null, sort_order: o.sort_order ?? 0,
          image_url: o.image_url || null,
          metadata: { kind: o.kind, capacity: o.capacity, event_date: o.event_date },
          tiers: offeringPrices.filter(p => p.offering_id === o.id).map(p => ({
            id: p.id, label: [p.label, p.duration_label, p.season && p.season !== 'regular' ? p.season : null].filter(Boolean).join(' — '),
            price: p.price, age_min: p.age_min, age_max: p.age_max, sort_order: p.sort_order ?? 0,
          })),
        })),
      });
    }
  }

  const modulesData = modulesRes.data || [];
  // Full module list for the response (control panel: enabled + order + settings)
  const modulesFull = modulesData
    .map(m => ({ module_key: m.module_key, enabled: m.enabled !== false, sort_order: m.sort_order ?? 0, settings: m.settings || {} }))
    .sort((a, b) => a.sort_order - b.sort_order);
  // Set of enabled module keys — preserves existing conditional-fetch logic below
  const modules = new Set(modulesData.filter(m => m.enabled !== false).map(m => m.module_key));

  // ── Data present ⇒ data displays ───────────────────────────────────────────
  // A pack also loads when its tables actually hold rows for this slug, no
  // matter the entity_type or module switches (a caterer with a menu, a golf
  // course with drinks, a park listing with room data — it all shows).
  // Probes only run for packs whose gate is still false; head-count = cheap,
  // and the endpoint is edge-cached.
  const hasRows = async (table) => {
    try {
      const { count } = await db.from(table).select('id', { count: 'exact', head: true }).eq('entity_slug', slug);
      return (count || 0) > 0;
    } catch (e) { return false; }
  };
  const anyRows = async (...tables) => (await Promise.all(tables.map(hasRows))).some(Boolean);
  const [dataFood, dataActivity, dataStay, dataService, dataShop, dataPark] = await Promise.all([
    (isFood || modules.has('menu'))       ? false : anyRows('menu_sections', 'drink_sections', 'entity_specials'),
    (isActivity || modules.has('activity')) ? false : anyRows('activity_schedules', 'whats_included', 'what_to_bring'),
    (isStay || modules.has('stay'))       ? false : anyRows('property_details', 'room_types', 'bookable_resources'),
    (isService || modules.has('services')) ? false : anyRows('service_menu', 'class_schedule'),
    (isShopping || modules.has('shop'))   ? false : anyRows('products'),
    (isPark || modules.has('park'))       ? false : anyRows('facilities', 'spot_rules'),
  ]);

  // ── CONDITIONAL queries — module enabled, matching type, OR data present ──
  const conditionalPromises = [];
  const conditionalKeys = [];

  if (isFood || modules.has('menu') || dataFood) {
    conditionalPromises.push(
      db.from('menu_sections').select('id,section_name,section_description,sort_order,time_range,available_days,days_of_week,start_time,end_time').eq('entity_slug', slug).order('sort_order'),
      db.from('drink_sections').select('id,section_name,sort_order,days_of_week,start_time,end_time').eq('entity_slug', slug).order('sort_order'),
      db.from('happy_hour_sections').select('id,section_name,sort_order,days_of_week,start_time,end_time').eq('entity_slug', slug).order('sort_order'),
      db.from('entity_sides').select('id,item_name,side_name,description,price,sort_order').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
      db.from('entity_daily_features').select('id,label,feature_name,value,description,price,sort_order').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
      db.from('order_links').select('id,label,url,type').eq('entity_slug', slug),
    );
    conditionalKeys.push('menuSections','drinkSections','hhSections','sides','dailyFeatures','orderLinks');
  }

  if (isActivity || modules.has('activity') || dataActivity) {
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

  if (isStay || modules.has('stay') || dataStay) {
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

  if (isService || modules.has('services') || dataService) {
    conditionalPromises.push(
      db.from('service_categories').select('id,name,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('service_menu').select('id,category_id,name,description,price,duration_minutes,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('service_packages').select('id,name,description,price,includes').eq('entity_slug', slug),
      db.from('class_schedule').select('id,class_name,day_of_week,start_time,duration_minutes,capacity').eq('entity_slug', slug).order('day_of_week'),
    );
    conditionalKeys.push('serviceCategories','serviceMenu','servicePackages','classSchedule');
  }

  if (isShopping || modules.has('shop') || dataShop) {
    conditionalPromises.push(
      db.from('product_categories').select('id,name,sort_order').eq('entity_slug', slug).order('sort_order'),
      db.from('products').select('id,category_id,name,description,price,in_stock,sort_order').eq('entity_slug', slug).eq('in_stock', true).order('sort_order'),
    );
    conditionalKeys.push('productCategories','products');
  }

  if (isPark || modules.has('park') || dataPark) {
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

  const normalizedPhotos = (photos.data || []).map(p => ({ ...p, url: normalizeImageUrl(p.url), image_url: normalizeImageUrl(p.url), alt_text: p.caption || null }));

  return {
    ...entity,
    hero_image_url: normalizeImageUrl(entity.hero_image_url),
    // Structured per-industry facts (industry_<code> row for this business)
    industry_facts: industryFacts || null,
    // Flexible offerings (charters, rentals, tours, services) — universal
    sections: flexSections,
    offerings: offeringRows.map(o => ({ ...o, prices: offeringPrices.filter(p => p.offering_id === o.id) })),
    // Core
    hours: hours.data || [],
    secondary_hours: secondaryHours.data || [],
    photos: normalizedPhotos,
    // entity_tags is canonical; entity_amenities rows (import strays) merge in
    // so amenity data displays no matter which table it landed in
    tags: (() => {
      const base = tags.data || [];
      const seen = new Set(base.map(t => `${(t.tag_category || '')}|${(t.tag_name || '').toLowerCase()}`));
      for (const a of (amenityRowsRes?.data || [])) {
        const key = `amenity|${(a.amenity || '').toLowerCase()}`;
        if (a.amenity && !seen.has(key)) { seen.add(key); base.push({ id: `am-${a.id}`, entity_slug: slug, tag_name: a.amenity, tag_category: 'amenity' }); }
      }
      return base;
    })(),
    marina_details: marinaDetails,
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
    // distinct key from entity.attributes (the legacy textarea array) so the
    // admin editor's populate path keeps working untouched
    structured_attributes: attributesRes.data || [],
    nearby_landmarks: landmarksRes.data || [],
    whats_excluded: whatsExcludedRes.data || [],
    // Money pack (fees / deposits / refund + weather rules)
    fees: offerFeesRes?.data || [],
    deposits: offerDepositsRes?.data || [],
    refund_policies: refundPoliciesRes?.data || [],
    weather_rules: weatherRulesRes?.data || [],
    child_count: childCountRes?.count || 0,
    parent: parentInfo,
    parent_amenities: parentAmenities,
    is_hub: (childCountRes?.count || 0) > 0,
    availability_today: availabilityToday,
    spots_remaining: availabilityToday ? availabilityToday.remaining_spots : null,
    good_for_children: entity.good_for_children ?? entity.good_for_kids ?? null,
    modules: modulesFull,
    module_keys: [...modules],
    // Food/Menu
    menu_sections: nest(cond.menuSections?.data, items.menuItems),
    drink_sections: nest(cond.drinkSections?.data, items.drinkItems),
    happy_hour_sections: nest(cond.hhSections?.data, items.hhItems),
    specials: specialsRes?.data || [],
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
        national_phone, google_place_id, business_status, parent_slug:parent_entity_slug
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

    // A flat .limit(10000) on these joins silently truncated them: the platform
    // has ~83k tags / ~52k photos / ~15k hours rows across ~4k entities, so a
    // single capped query covered only a fraction of the entities asked for —
    // and entity_tags had no .order() at all, so *which* fraction was arbitrary.
    // That's why cards rendered with no tags and no gallery photo to fall back
    // on when hero_image_url was missing. Fetch in slug chunks (in parallel)
    // instead, so every requested entity gets its own complete set.
    const SLUG_CHUNK = 300;
    const slugChunks = [];
    for (let i = 0; i < slugs.length; i += SLUG_CHUNK) slugChunks.push(slugs.slice(i, i + SLUG_CHUNK));

    async function fetchChunked(table, columns, orderCol) {
      if (!slugs.length) return [];
      const batches = await Promise.all(slugChunks.map(batch => {
        let q = db.from(table).select(columns).in('entity_slug', batch);
        if (orderCol) q = q.order(orderCol);
        return q.limit(10000).then(({ data }) => data || []);
      }));
      return batches.flat();
    }

    const today = new Date().toISOString().split('T')[0];
    const [tagData, photoData, hourData, availRows] = await Promise.all([
      fetchChunked('entity_tags', 'entity_slug, tag_name, tag_category'),
      fetchChunked('entity_photos', 'entity_slug, url, is_cover, sort_order, caption, usage_note', 'sort_order'),
      fetchChunked('entity_hours', 'entity_slug, day_of_week, opens_at, closes_at, is_closed', 'day_of_week'),
      slugs.length ? db.from('business_availability').select('entity_slug, total_capacity, remaining_spots, status, source_platform, last_updated, last_minute_deal, last_minute_price, original_price').in('entity_slug', slugs).eq('availability_date', today).eq('visible_on_profile', true) : { data: [] },
    ]);
    const tagRows = { data: tagData }, photoRows = { data: photoData }, hourRows = { data: hourData };

    const tagMap = {}, photoMap = {}, hourMap = {}, availMap = {};
    (tagRows.data || []).forEach(r => { if (!tagMap[r.entity_slug]) tagMap[r.entity_slug] = []; tagMap[r.entity_slug].push(r); });
    // Cap per entity: listing/swipe cards only ever need a hero plus a couple of
    // gallery fallbacks, and now that the fetch above is no longer silently
    // truncated, returning all ~13 photos per entity for a 2000-entity request
    // would balloon the response for no visible benefit. Full galleries still
    // come from the per-entity profile endpoint, which isn't capped.
    const MAX_PHOTOS_PER_ENTITY = 6;
    (photoRows.data || []).forEach(r => {
      if (!photoMap[r.entity_slug]) photoMap[r.entity_slug] = [];
      if (photoMap[r.entity_slug].length < MAX_PHOTOS_PER_ENTITY) photoMap[r.entity_slug].push(r);
    });
    (hourRows.data || []).forEach(r => { if (!hourMap[r.entity_slug]) hourMap[r.entity_slug] = []; hourMap[r.entity_slug].push(r); });
    (availRows.data || []).forEach(r => { availMap[r.entity_slug] = r; });

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
      const { data: scores } = await db.from('user_preference_scores').select('tag, score').eq('user_id', userId);
      (scores || []).forEach(s => { prefScoreByTag[(s.tag || '').toLowerCase().trim()] = s.score; });
    }
    const hasPrefSignal = Object.keys(prefScoreByTag).length > 0;

    const results = (entities || []).map(e => {
      const photos = (photoMap[e.slug] || []).map(p => ({ ...p, url: normalizeImageUrl(p.url) }));
      const avail = availMap[e.slug] || null;
      const row = {
        ...e, tags: tagMap[e.slug] || [], photos, hours: hourMap[e.slug] || [], hero_image_url: normalizeImageUrl(e.hero_image_url),
        // Flat field so GCRCard's existing (previously dead — the column
        // never existed) "🔴 Last spot!" badge logic just works.
        spots_remaining: avail ? avail.remaining_spots : null,
        availability_today: avail,
      };
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
      // Featured businesses are pinned ahead of the score-ranked results (still
      // ordered amongst themselves by score), same as "sponsored first" on any
      // marketplace listing page. Only ~1 entity platform-wide has featured=true
      // today, so this does not reshuffle any existing category page.
      results.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b._score - a._score);
      results.forEach(row => { delete row._score; });
    }

    res.set('Cache-Control', 'public, max-age=180, s-maxage=180, stale-while-revalidate=900');
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
      const { data: scores } = await db.from('user_preference_scores').select('tag, score').eq('user_id', userId);
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

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
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
      db.from('user_preference_scores').select('tag, score').eq('user_id', userId),
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

    res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
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

// ─── GET /api/gcr/industry-contract/:code ────────────────────────────────────
// The table contract for one industry: universal spine rows ('*') plus the
// tables designated for that type of business, in read order. This is what
// the AI router and admin tooling consult instead of hardcoded table lists.
router.get('/industry-contract/:code', async (req, res) => {
  try {
    const tables = await getContractForIndustry(db, req.params.code);
    if (!tables.length) return res.status(404).json({ error: 'Unknown industry code' });
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({ industry_code: req.params.code, tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/entity/:slug', async (req, res) => {
  try {
    const entity = await buildFullEntity(req.params.slug);
    if (!entity) return res.status(404).json({ error: 'Not found' });
    // Cache at Vercel edge for 2 min, allow stale for 10 min while revalidating
    res.set('Cache-Control', 'public, max-age=120, s-maxage=120, stale-while-revalidate=600');
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
    // Entities with a summary hh_days flag, OR real happy_hour_sections content --
    // hh_days alone missed every business whose happy hour was entered as real
    // menu sections/items but never got the summary field filled in.
    const [entitiesRes, hhEntitySlugsRes] = await Promise.all([
      db.from('entity')
        .select(`
          id, slug, name, icon, hero_image_url, entity_subtype, city,
          address_line_1, phone, directions_url, call_url, booking_url,
          reservation_url, rating, hh_days, hh_start, hh_end, hh_description
        `)
        .eq('is_active', true)
        .order('name'),
      db.from('happy_hour_sections').select('entity_slug'),
    ]);
    if (entitiesRes.error) return res.status(500).json({ error: entitiesRes.error.message });

    const hhContentSlugs = new Set((hhEntitySlugsRes.data || []).map(r => r.entity_slug));
    const entities = (entitiesRes.data || []).filter(e => e.hh_days != null || hhContentSlugs.has(e.slug));

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

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
    res.json({ happyHours: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/gcr/search ─────────────────────────────────────────────────────
// Deep multi-table entity search. Returns the set of entity slugs whose name,
// description, menu / drink / happy-hour items, specials, events, tags, amenities,
// FAQs, offerings, section content, activity / charter / pricing / rental / service /
// shopping data, or structured highlights match the term — then a pg_trgm fuzzy
// name fallback. Shared by BOTH the /search endpoint and the AI concierge's
// search_businesses tool so the chatbot searches exactly as deeply as the search
// bar, with no drift. (Exported below as router.searchEntitySlugs.)
async function searchEntitySlugs(rawTerm) {
  const term = (rawTerm || '').toLowerCase().trim();
  if (!term) return { slugs: [], fuzzy: false };
  const keywords = term.split(/\s+/).filter(k => k.length >= 2);
  if (!keywords.length) return { slugs: [], fuzzy: false };
  const orFilter = (...fields) =>
    keywords.flatMap(k => fields.map(f => `${f}.ilike.%${k}%`)).join(',');
  const matchedSlugs = new Set();

  const [byEntity, byMenuItems, byDrinkItems, byHHItems, bySpecials, byEvents, byTags, byAmenities, byFaqs, byOfferings, bySectionItems, byMenuSections, byDrinkSections, byHHSections,
    byPricing, byCharterTrips, byCharterFish, byFishSpecies, byRequirements, byWhatsIncluded, byRoomTypes, byServiceMenu, byServicePackages, byProducts, byMeetingPoints, byActivityOptions, byHighlights, byGoodFor, byKnownFor, byMenuItemDetails] = await Promise.all([
    db.from('entity').select('slug').eq('is_active', true).or(orFilter('name', 'description', 'subtitle', 'city', 'entity_subtype')),
    db.from('menu_items').select('entity_slug').or(orFilter('item_name', 'description')),
    db.from('drink_items').select('entity_slug').or(orFilter('item_name', 'description')),
    db.from('happy_hour_items').select('entity_slug').or(orFilter('item_name', 'description')),
    db.from('entity_specials').select('entity_slug').eq('is_active', true).or(orFilter('special_name', 'description', 'discount_text')),
    db.from('entity_events').select('entity_slug').eq('is_active', true).or(orFilter('event_name', 'artist_name')),
    db.from('entity_tags').select('entity_slug').or(orFilter('tag_name')),
    db.from('entity_amenities').select('entity_slug').or(orFilter('amenity')),
    db.from('faqs').select('entity_slug').or(orFilter('question', 'answer')),
    db.from('offerings').select('entity_slug').eq('active', true).or(orFilter('name', 'description', 'section')),
    db.from('entity_section_items').select('section_id').or(orFilter('item_name', 'description')),
    db.from('menu_sections').select('entity_slug').or(orFilter('section_name')),
    db.from('drink_sections').select('entity_slug').or(orFilter('section_name')),
    db.from('happy_hour_sections').select('entity_slug').or(orFilter('section_name')),
    db.from('pricing_items').select('entity_slug').or(orFilter('item_name', 'description', 'tier_name')),
    db.from('charter_trips').select('entity_slug').eq('is_active', true).or(orFilter('trip_name', 'description', 'best_for', 'trip_type', 'boat_name')),
    db.from('charter_trip_fish_species').select('entity_slug').or(orFilter('species')),
    db.from('fish_species').select('entity_slug').or(orFilter('species')),
    db.from('requirements').select('entity_slug').or(orFilter('requirement_text', 'requirement_name')),
    db.from('whats_included').select('entity_slug').or(orFilter('item_name', 'included_item')),
    db.from('room_types').select('entity_slug').or(orFilter('name', 'description', 'view')),
    db.from('service_menu').select('entity_slug').or(orFilter('name', 'description')),
    db.from('service_packages').select('entity_slug').or(orFilter('name', 'description')),
    db.from('products').select('entity_slug').or(orFilter('name', 'description')),
    db.from('meeting_points').select('entity_slug').or(orFilter('name', 'meeting_point_name', 'address')),
    db.from('activity_options').select('entity_slug').or(orFilter('name', 'description', 'vessel_vehicle')),
    db.from('entity_highlights').select('entity_slug').or(orFilter('highlight')),
    db.from('entity_good_for').select('entity_slug').or(orFilter('audience')),
    db.from('entity_known_for').select('entity_slug').or(orFilter('item')),
    db.from('menu_item_details').select('entity_slug').or(orFilter('marketing_description')),
  ]);

  (byEntity.data || []).forEach(r => matchedSlugs.add(r.slug));
  [byMenuItems, byDrinkItems, byHHItems, bySpecials, byEvents, byTags, byAmenities, byFaqs, byOfferings,
   byMenuSections, byDrinkSections, byHHSections,
   byPricing, byCharterTrips, byCharterFish, byFishSpecies, byRequirements, byWhatsIncluded, byRoomTypes,
   byServiceMenu, byServicePackages, byProducts, byMeetingPoints, byActivityOptions, byHighlights,
   byGoodFor, byKnownFor, byMenuItemDetails].forEach(r =>
    (r.data || []).forEach(row => row.entity_slug && matchedSlugs.add(row.entity_slug))
  );
  // Section items reference their entity via section_id → entity_sections.entity_slug
  if ((bySectionItems.data || []).length) {
    const secIds = [...new Set(bySectionItems.data.map(r => r.section_id).filter(Boolean))];
    if (secIds.length) {
      const { data: secOwners } = await db.from('entity_sections').select('entity_slug').in('id', secIds);
      (secOwners || []).forEach(r => r.entity_slug && matchedSlugs.add(r.entity_slug));
    }
  }

  // No exact substring hit anywhere — fall back to pg_trgm fuzzy name match so a
  // typo ("villagio grill") still resolves; caller can flag these as "did you mean".
  let fuzzy = false;
  if (!matchedSlugs.size) {
    const { data: fuzzyRows } = await db.rpc('fuzzy_entity_search', { search_term: term, match_limit: 20 });
    (fuzzyRows || []).forEach(r => matchedSlugs.add(r.slug));
    if (matchedSlugs.size) fuzzy = true;
  }
  return { slugs: [...matchedSlugs], fuzzy };
}

router.post('/search', async (req, res) => {
  try {
    const { query: q, city, limit = 50, lat, lng, radius } = req.body;
    if (!q || !q.trim()) return res.status(400).json({ error: 'Query required' });

    const term = q.toLowerCase().trim();
    const keywords = term.split(/\s+/).filter(k => k.length >= 2);
    const orFilter = (...fields) =>
      keywords.flatMap(k => fields.map(f => `${f}.ilike.%${k}%`)).join(',');

    // Deep multi-table match (shared with the AI concierge) + fuzzy fallback
    // (searchEntitySlugs only reaches for pg_trgm when substring matching comes
    // up completely empty — a good default for the AI concierge, which wants
    // precise matches, not lookalikes).
    const { slugs: _matchedList, fuzzy: fuzzyFallbackUsed } = await searchEntitySlugs(q);
    const matchedSlugs = new Set(_matchedList);

    // The user-facing search box needs more forgiveness than that: typing one
    // mistyped word ("Bellagio" for "Villagio Grill") can still substring-match
    // plenty of *other* unrelated entities on the rest of the query, so the
    // all-zero-hits fallback above never fires and the typo's real target never
    // shows up. Always blend in trigram-fuzzy name matches alongside whatever
    // substring matching already found, and remember each one's similarity so
    // ranking below can weigh a strong exact/substring hit over a loose fuzzy
    // one instead of treating them the same.
    const fuzzySimilarity = {};
    const { data: fuzzyRows } = await db.rpc('fuzzy_entity_search', { search_term: term, match_limit: 30 });
    let fuzzyMatch = fuzzyFallbackUsed;
    (fuzzyRows || []).forEach(r => {
      fuzzySimilarity[r.slug] = r.similarity;
      if (!matchedSlugs.has(r.slug)) fuzzyMatch = true;
      matchedSlugs.add(r.slug);
    });

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

    // Fetch matched content + photos + all tags/amenities for matched entities.
    // Tags/amenities are fetched in full (not just keyword-matched) so the caller — a UI
    // chip row or the AI concierge — sees the entity's complete feature set, and so
    // multi-amenity queries can be scored by how many requested features an entity has.
    const [menuMatches, drinkMatches, hhMatches, specialMatches, eventMatches, photoRows, tagRows, amenityRows] = await Promise.all([
      db.from('menu_items').select('entity_slug, item_name, description, price').in('entity_slug', slugList).or(orFilter('item_name', 'description')),
      db.from('drink_items').select('entity_slug, item_name, description, price').in('entity_slug', slugList).or(orFilter('item_name', 'description')),
      db.from('happy_hour_items').select('entity_slug, item_name, description, price').in('entity_slug', slugList).or(orFilter('item_name', 'description')),
      db.from('entity_specials').select('entity_slug, special_name, description, discount_text').in('entity_slug', slugList).eq('is_active', true),
      db.from('entity_events').select('entity_slug, event_name, event_date, artist_name').in('entity_slug', slugList).eq('is_active', true).or(orFilter('event_name', 'artist_name')),
      db.from('entity_photos').select('entity_slug, url, sort_order').in('entity_slug', slugList).order('sort_order'),
      db.from('entity_tags').select('entity_slug, tag_name, tag_category').in('entity_slug', slugList),
      db.from('entity_amenities').select('entity_slug, amenity, category').in('entity_slug', slugList),
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

    // Unified feature list per entity: amenity-category tags + entity_amenities rows, deduped.
    // This is the field an amenity query ("hot tub", "sauna") scores against.
    const featureMap = {};
    const addFeature = (slug, label) => {
      if (!slug || !label) return;
      if (!featureMap[slug]) featureMap[slug] = new Set();
      featureMap[slug].add(label);
    };
    (tagRows.data || []).forEach(r => addFeature(r.entity_slug, r.tag_name));
    (amenityRows.data || []).forEach(r => addFeature(r.entity_slug, r.amenity));

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
      const features = [...(featureMap[e.slug] || [])];
      // Which of the query keywords are satisfied by this entity's features — lets a
      // multi-amenity request ("hot tub sauna lazy river") rank places that have MORE
      // of the requested features higher, and tells the AI exactly which ones matched.
      const matchedFeatures = features.filter(f => {
        const fl = f.toLowerCase();
        return keywords.some(k => fl.includes(k));
      });
      const nameScore = score(e.name, e.subtitle);
      const itemScore = menuItems.length ? score(menuItems[0].item_name, menuItems[0].description) : 0;
      // Each matched feature adds a strong, cumulative boost so amenity coverage drives ranking.
      const featureScore = matchedFeatures.length * 40;
      const distance_miles = (userLat && userLng && e.latitude && e.longitude)
        ? haversine(userLat, userLng, e.latitude, e.longitude)
        : null;
      // Proximity nudges rank without overriding a real name/feature match — worth at
      // most +20 (right next to the user), decaying to 0 by 20 miles out. A strong
      // keyword match (60-100) or feature match (40 each) still dominates; this only
      // breaks ties and gives "closer" a real, bounded say in "smart" ranking.
      const proximityScore = distance_miles != null ? Math.max(0, 20 - distance_miles) : 0;
      // pg_trgm similarity is 0..1 — scaled well below a real substring/name hit
      // (worth up to 60-100) so a typo-only match still surfaces but never
      // outranks something that actually matched the typed text.
      const fuzzyScore = (fuzzySimilarity[e.slug] || 0) * 30;
      const relevance = Math.max(nameScore, itemScore) + featureScore + (e.rating || 0) + proximityScore + fuzzyScore;

      return {
        ...e,
        photos: photoMap[e.slug] || [],
        matched_menu_items: menuItems,
        matched_specials: specials,
        matched_events: events,
        features,
        matched_features: matchedFeatures,
        _relevance: relevance,
        distance_miles,
      };
    })
      // Radius filter: only meaningful with a user location; entities with no
      // lat/lng of their own (distance_miles null) are kept rather than silently
      // dropped, since "no location on file" isn't the same as "too far away".
      .filter(e => !(radius && userLat != null && userLng != null && e.distance_miles != null && e.distance_miles > parseFloat(radius)))
      .sort((a, b) => b._relevance - a._relevance);

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
      total_items: flattenedItems.length,
      fuzzy_match: fuzzyMatch,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/search/suggest ──────────────────────────────────────────────
// Autocomplete for the search box: a handful of business names to tap while
// still typing, so the visitor doesn't have to finish (or correctly spell) the
// query by hand. Ranks prefix matches first, then substring matches, then
// pg_trgm fuzzy matches (so a mid-word typo like "bellagio" still surfaces
// "Villagio Grill"). Fetches full display fields in one follow-up query keyed
// by slug rather than trusting fuzzy_entity_search's own return columns, so
// the response shape doesn't depend on that RPC's definition.
router.get('/search/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit) || 8, 20);
    if (q.length < 2) return res.json({ query: q, suggestions: [] });
    const term = q.toLowerCase();

    const rankBySlug = new Map();
    const { data: nameRows } = await db
      .from('entity').select('slug, name')
      .eq('is_active', true).ilike('name', `%${term}%`).limit(limit * 3);
    (nameRows || []).forEach(r => {
      const rank = (r.name || '').toLowerCase().startsWith(term) ? 0 : 1;
      if (!rankBySlug.has(r.slug) || rankBySlug.get(r.slug) > rank) rankBySlug.set(r.slug, rank);
    });

    // Not enough exact/substring hits — blend in fuzzy matches so a misspelled
    // query still fills the dropdown instead of coming up short or empty.
    if (rankBySlug.size < limit) {
      const { data: fuzzyRows } = await db.rpc('fuzzy_entity_search', { search_term: term, match_limit: limit * 2 });
      (fuzzyRows || []).forEach(r => { if (!rankBySlug.has(r.slug)) rankBySlug.set(r.slug, 2); });
    }

    if (!rankBySlug.size) return res.json({ query: q, suggestions: [] });

    const { data: entities, error } = await db
      .from('entity').select('slug, name, city, icon, entity_subtype, hero_image_url')
      .eq('is_active', true).in('slug', [...rankBySlug.keys()]);
    if (error) return res.status(500).json({ error: error.message });

    const suggestions = (entities || [])
      .sort((a, b) => rankBySlug.get(a.slug) - rankBySlug.get(b.slug))
      .slice(0, limit);

    res.json({ query: q, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/sections ────────────────────────────────────────────────────
// GET /api/gcr/entity/:slug/availability-month?month=YYYY-MM
// One business, one month, one merged answer — same three-source union the
// availability search uses (capacity + resource slots + calendar-block veto),
// shaped for calendars: the embeddable widget, profile pages, the AI.
router.get('/entity/:slug/availability-month', async (req, res) => {
  try {
    const slug = req.params.slug;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const from = month + '-01';
    const lastDay = new Date(Date.UTC(parseInt(month.slice(0, 4)), parseInt(month.slice(5, 7)), 0)).getUTCDate();
    const to = month + '-' + String(lastDay).padStart(2, '0');

    const [capRes, resRes, blockRes] = await Promise.all([
      db.from('business_availability')
        .select('availability_date, remaining_spots, total_capacity, status')
        .eq('entity_slug', slug).gte('availability_date', from).lte('availability_date', to),
      db.from('availability')
        .select('date, spots_remaining, spots_total, status')
        .eq('entity_slug', slug).gte('date', from).lte('date', to),
      db.from('booking_calendar')
        .select('date, end_date, kind, offering_id, status')
        .eq('entity_slug', slug).eq('kind', 'block').is('offering_id', null)
        .neq('status', 'cancelled').lte('date', to),
    ]);

    const days = {};
    const mergeDay = (date, remaining, total, status) => {
      const d = days[date] || (days[date] = { date, remaining: null, total: null, status: 'unknown' });
      if (remaining != null) d.remaining = d.remaining == null ? remaining : Math.max(d.remaining, remaining);
      if (total != null) d.total = d.total == null ? total : Math.max(d.total, total);
      if (status && status !== 'unknown' && d.status !== 'blocked') d.status = status;
    };
    (capRes.data || []).forEach(r => mergeDay(r.availability_date, r.remaining_spots, r.total_capacity, r.status));
    (resRes.data || []).forEach(r => mergeDay(r.date, r.spots_remaining, r.spots_total, r.status || 'available'));
    // capacity-derived status when the row didn't carry one
    Object.values(days).forEach(d => {
      if (d.status === 'unknown' && d.remaining != null) {
        d.status = d.remaining <= 0 ? 'full' : d.remaining <= 3 ? 'limited' : 'available';
      }
    });
    // entity-wide blocks veto everything they cover
    (blockRes.data || []).forEach(b => {
      const start = b.date < from ? from : b.date;
      const end = (b.end_date && b.end_date > b.date) ? (b.end_date > to ? to : b.end_date) : b.date;
      if (end < from) return;
      let d = new Date(start + 'T00:00:00Z');
      const endD = new Date(end + 'T00:00:00Z');
      while (d <= endD) {
        const key = d.toISOString().slice(0, 10);
        days[key] = { date: key, remaining: 0, total: days[key]?.total ?? null, status: 'blocked' };
        d = new Date(d.getTime() + 86400000);
      }
    });

    res.set('Cache-Control', 'max-age=300, s-maxage=300, stale-while-revalidate=60');
    res.json({ slug, month, days: Object.values(days).sort((a, b) => a.date < b.date ? -1 : 1) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gcr/taxonomy — the category system, served from the database.
// subtype_taxonomy is the single source of truth (293 curated subtypes):
// frontends hydrate their subtype→section maps and section lists from this
// instead of hand-maintained copies in code.
router.get('/taxonomy', async (req, res) => {
  try {
    const { data, error } = await db
      .from('subtype_taxonomy')
      .select('subtype_key, display_name, entity_type, listing_category, entity_count')
      .order('entity_count', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const map = {};
    const sectionCounts = {};
    (data || []).forEach(row => {
      if (row.subtype_key && row.listing_category) {
        map[row.subtype_key] = row.listing_category;
        sectionCounts[row.listing_category] = (sectionCounts[row.listing_category] || 0) + (row.entity_count || 0);
      }
    });

    res.set('Cache-Control', 'max-age=3600, s-maxage=3600, stale-while-revalidate=600');
    res.json({
      map,
      sections: Object.keys(sectionCounts).map(s => ({ section: s, entity_count: sectionCounts[s] })),
      subtypes: data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const children = data || [];

    // Rental details for unit children (condo units, beach houses): beds,
    // baths, sleeps, nightly price from bookable_resources keyed by the
    // unit's own slug — listing cards render these when present.
    if (children.length) {
      const slugs = children.map(c => c.slug);
      const { data: resources } = await db
        .from('bookable_resources')
        .select('entity_slug,name,resource_type,nightly_price,cleaning_fee,bedrooms,bathrooms,sqft,capacity,min_nights,booking_url,amenities')
        .in('entity_slug', slugs)
        .eq('is_active', true);
      const bySlug = new Map();
      for (const r of resources || []) {
        // keep the richest row per slug (some slugs carry a placeholder row)
        const score = ['nightly_price','bedrooms','bathrooms','capacity'].filter(k => r[k] != null).length;
        const prev = bySlug.get(r.entity_slug);
        if (!prev || score > prev._score) bySlug.set(r.entity_slug, { ...r, _score: score });
      }
      for (const c of children) {
        const r = bySlug.get(c.slug);
        if (r) {
          const { _score, entity_slug, ...rental } = r;
          c.rental = rental;
        }
      }
    }

    res.json({ children, total: children.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/gcr/stay-units ──────────────────────────────────────────────────
// Booking-platform data for the staying page: every unit under a stay-type
// complex (with rental specs), plus a per-complex summary for listing cards
// (unit count, available count, from-price, bedroom range).
router.get('/stay-units', async (req, res) => {
  try {
    const { data: parents, error: pErr } = await db
      .from('entity')
      .select('slug,name,city,hero_image_url')
      .in('entity_type', ['condo', 'hotel', 'vacation-rental'])
      .eq('is_active', true);
    if (pErr) return res.status(500).json({ error: pErr.message });

    const parentSlugs = (parents || []).map(p => p.slug);
    const parentName = new Map((parents || []).map(p => [p.slug, p.name]));

    // Units = child entities of stay complexes (chunked .in to stay under URL limits)
    const units = [];
    for (let i = 0; i < parentSlugs.length; i += 150) {
      const chunk = parentSlugs.slice(i, i + 150);
      const { data } = await db
        .from('entity')
        .select('id,slug,name,entity_type,entity_subtype,parent_entity_slug,city,state,hero_image_url,unit_number,building,unit_floor,view_type,rating,review_count,is_active')
        .in('parent_entity_slug', chunk)
        .eq('is_active', true);
      units.push(...(data || []));
    }

    // Rental specs from bookable_resources keyed by unit slug (richest row wins)
    const unitSlugs = units.map(u => u.slug);
    const bySlug = new Map();
    for (let i = 0; i < unitSlugs.length; i += 200) {
      const chunk = unitSlugs.slice(i, i + 200);
      const { data: resources } = await db
        .from('bookable_resources')
        .select('entity_slug,nightly_price,cleaning_fee,bedrooms,bathrooms,sqft,capacity,min_nights,booking_url,amenities')
        .in('entity_slug', chunk)
        .eq('is_active', true);
      for (const r of resources || []) {
        const score = ['nightly_price', 'bedrooms', 'bathrooms', 'capacity'].filter(k => r[k] != null).length;
        const prev = bySlug.get(r.entity_slug);
        if (!prev || score > prev._score) bySlug.set(r.entity_slug, { ...r, _score: score });
      }
    }

    const summary = {};
    for (const u of units) {
      const r = bySlug.get(u.slug);
      if (r) {
        const { _score, entity_slug, ...rental } = r;
        u.rental = rental;
      }
      u.parent_name = parentName.get(u.parent_entity_slug) || null;
      const s = summary[u.parent_entity_slug] || (summary[u.parent_entity_slug] = {
        unit_count: 0, available_units: 0, price_min: null, beds_min: null, beds_max: null,
      });
      s.unit_count += 1;
      // "available" = actively listed & bookable today; live calendar
      // availability can tighten this later via booking_calendar
      s.available_units += 1;
      if (u.rental?.nightly_price != null) s.price_min = s.price_min == null ? u.rental.nightly_price : Math.min(s.price_min, u.rental.nightly_price);
      if (u.rental?.bedrooms != null) {
        s.beds_min = s.beds_min == null ? u.rental.bedrooms : Math.min(s.beds_min, u.rental.bedrooms);
        s.beds_max = s.beds_max == null ? u.rental.bedrooms : Math.max(s.beds_max, u.rental.bedrooms);
      }
    }

    // Complex amenities for listing cards — the card sells the whole condo
    // (pools, splash pad, tennis, fitness), not just the unit counts. All
    // stay complexes get amenities, units or not.
    for (let i = 0; i < parentSlugs.length; i += 150) {
      const chunk = parentSlugs.slice(i, i + 150);
      const { data: amenityTags } = await db
        .from('entity_tags')
        .select('entity_slug,tag_name')
        .in('entity_slug', chunk)
        .eq('tag_category', 'amenity');
      for (const t of amenityTags || []) {
        const s = summary[t.entity_slug] || (summary[t.entity_slug] = {
          unit_count: 0, available_units: 0, price_min: null, beds_min: null, beds_max: null,
        });
        if (!s.amenities) s.amenities = [];
        if (s.amenities.length < 12 && t.tag_name && !s.amenities.some(a => a.toLowerCase() === t.tag_name.toLowerCase())) {
          s.amenities.push(t.tag_name);
        }
      }
    }

    res.set('Cache-Control', 'public, max-age=120, s-maxage=120, stale-while-revalidate=300');
    res.json({ units, summary, total_units: units.length });
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

    res.set('Cache-Control', 'public, max-age=120, s-maxage=120, stale-while-revalidate=300');
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

    // The unified availability read: three sources, one answer.
    //   business_availability — capacity model fed by the email parser + iCal
    //   availability          — per-resource slot rows from the booking engine
    //   booking_calendar      — entity-wide blocks (manual / iCal) that VETO dates
    const [availRes, resourceRes, blockRes] = await Promise.all([
      availQuery,
      db.from('availability')
        .select('entity_slug, date, start_time, end_time, status, spots_total, spots_remaining')
        .gte('date', date_from)
        .lte('date', dateTo)
        .gt('spots_remaining', 0),
      db.from('booking_calendar')
        .select('entity_slug, date, end_date, kind, offering_id, status')
        .eq('kind', 'block')
        .is('offering_id', null)
        .neq('status', 'cancelled')
        .lte('date', dateTo),
    ]);

    if (availRes.error) return res.status(500).json({ error: availRes.error.message });
    const availRows = availRes.data;

    // Group availability by entity_slug
    const availMap = {};
    (availRows || []).forEach(row => {
      if (!availMap[row.entity_slug]) availMap[row.entity_slug] = [];
      availMap[row.entity_slug].push(row);
    });

    // Merge resource-slot rows (booking-engine world) into the same map,
    // normalized to the business_availability slot shape the response uses
    (resourceRes.data || []).forEach(r => {
      if (!availMap[r.entity_slug]) availMap[r.entity_slug] = [];
      availMap[r.entity_slug].push({
        entity_slug: r.entity_slug,
        availability_date: r.date,
        time_slot: r.start_time || null,
        end_time: r.end_time || null,
        status: r.status || 'available',
        remaining_spots: r.spots_remaining,
        total_capacity: r.spots_total,
        booking_type: null,
      });
    });

    // Entity-wide calendar blocks veto dates: expand each block row into the
    // dates it covers inside the requested window
    const blockedMap = {};
    (blockRes.data || []).forEach(b => {
      const start = b.date < date_from ? date_from : b.date;
      const end = (b.end_date && b.end_date > b.date) ? (b.end_date > dateTo ? dateTo : b.end_date) : b.date;
      if (end < date_from) return;
      if (!blockedMap[b.entity_slug]) blockedMap[b.entity_slug] = new Set();
      let d = new Date(start + 'T00:00:00Z');
      const endD = new Date(end + 'T00:00:00Z');
      while (d <= endD) {
        blockedMap[b.entity_slug].add(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 86400000);
      }
    });
    // Blocked dates drop out of each business's open slots
    Object.keys(availMap).forEach(slug => {
      const blocked = blockedMap[slug];
      if (!blocked) return;
      availMap[slug] = availMap[slug].filter(s => !blocked.has(s.availability_date));
      if (!availMap[slug].length) delete availMap[slug];
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
    // Stays are an entity_type family, not subtypes — and their availability
    // semantics differ: a condo must be open EVERY night of the range, while
    // a charter/photographer just needs ANY open day in it.
    const STAY_TYPES = ['hotel', 'condo', 'vacation-rental'];
    const isStaySearch = type === 'stay';

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
    if (isStaySearch) {
      entityQuery = entityQuery.in('entity_type', STAY_TYPES);
    } else if (type !== 'all' && subtypes.length > 0) {
      entityQuery = entityQuery.in('entity_subtype', subtypes);
    } else if (type === 'all') {
      // For 'all' with availability — bookable types including stays
      entityQuery = entityQuery.in('entity_type', ['activity', 'service', ...STAY_TYPES]);
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

    // Requested day list — drives per-vertical coverage semantics.
    // coverage=all: open EVERY day in the range (stays default to this —
    // a condo has to cover the whole trip). coverage=any: any open day
    // qualifies (charters, photographers, activities default).
    const requestedDates = [];
    {
      let d = new Date(date_from + 'T00:00:00Z');
      const endD = new Date(dateTo + 'T00:00:00Z');
      while (d <= endD && requestedDates.length < 120) {
        requestedDates.push(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 86400000);
      }
    }
    const coverage = (req.body.coverage === 'all' || req.body.coverage === 'any')
      ? req.body.coverage
      : (isStaySearch ? 'all' : 'any');

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

      // A stay that can't cover every requested night has no availability
      // for THIS trip — demote it to contact-to-book instead of listing it
      // as open.
      const coversAll = requestedDates.every(day => availDates.includes(day));
      const meetsCoverage = coverage === 'all' ? coversAll : availDates.length > 0;

      const distance_miles = (userLat && userLng && e.latitude && e.longitude)
        ? haversine(userLat, userLng, e.latitude, e.longitude)
        : null;

      return {
        ...e,
        has_availability: hasAvailability && meetsCoverage,
        covers_all_days: coversAll,
        available_dates: availDates,
        slots: openSlots,
        lowest_remaining: lowestRemaining,
        distance_miles,
        // Availability confidence for sorting:
        // 0 = no data, 1 = has entity but no slots, 2 = has slots meeting coverage
        _avail_rank: (hasAvailability && meetsCoverage) ? 2 : (e.booking_url ? 1 : 0),
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

// POST /api/gcr/opt-in — captures name/phone/consent BEFORE a customer enters
// a booking/checkout flow (used ahead of A2P 10DLC approval — SMS only ever
// actually goes out via sendSms()'s owner-relay mode until that's approved).
// Also lets a business recover an abandoned checkout: if the customer bails
// before paying, this row already has their name + phone to follow up with.
router.post('/opt-in', async (req, res) => {
  try {
    const { entity_slug, click_id, name, phone, email, sms_consent, consent_text } = req.body || {}
    if (!entity_slug || !phone) return res.status(400).json({ error: 'entity_slug and phone required' })

    const { data, error } = await db.from('booking_opt_ins').insert({
      entity_slug,
      click_id: click_id || null,
      name: name || null,
      phone,
      email: email || null,
      sms_consent: !!sms_consent,
      consent_text: consent_text || null,
    }).select('id').single()

    if (error) return res.status(500).json({ error: error.message })
    res.json({ opt_in_id: data.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/gcr/waiver/:slug/sign — clickwrap consent capture: checkbox PLUS
// a typed full-name confirmation (signature_typed_name) that must match the
// customer's name — stronger than a bare checkbox for "I didn't see it"
// disputes, short of a drawn/DocuSign e-signature. Returns a waiver_id the
// caller attaches to the booking so it's traceable to this exact signature.
router.post('/waiver/:slug/sign', async (req, res) => {
  try {
    const { slug } = req.params
    const { customer_name, customer_email, customer_phone, waiver_text, signature_typed_name } = req.body || {}
    if (!customer_name) return res.status(400).json({ error: 'customer_name required' })
    if (!waiver_text) return res.status(400).json({ error: 'waiver_text required' })
    if (!signature_typed_name) return res.status(400).json({ error: 'signature_typed_name required' })
    if (signature_typed_name.trim().toLowerCase() !== customer_name.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Typed name must match your name exactly' })
    }

    const crypto = require('crypto')
    const token = crypto.randomBytes(16).toString('hex')
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim()

    const { data, error } = await db.from('waivers').insert({
      entity_slug: slug,
      customer_name,
      customer_email: customer_email || null,
      customer_phone: customer_phone || null,
      waiver_text,
      signature_typed_name,
      signed_at: new Date().toISOString(),
      ip_address: ip || null,
      token,
    }).select('id, token').single()

    if (error) return res.status(500).json({ error: error.message })
    res.json({ waiver_id: data.id, token: data.token })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/gcr/lodging-search?q=... — condo/hotel typeahead, used by pickup/delivery
// style service bookings (e.g. Gulf Coast Luggo) so a guest can pick their real
// stay off the platform instead of typing a free-text address.
router.get('/lodging-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.json([])

    const { data, error } = await db
      .from('entity')
      .select('slug, name, city, address_line_1')
      .in('entity_type', ['hotel', 'condo', 'vacation-rental'])
      .eq('is_active', true)
      .ilike('name', `%${q}%`)
      .limit(8)

    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// NOTE: pickup/delivery-style bookings (luggage, transportation, etc.) go
// through the broker at /api/transportation/request instead of a one-off
// route here — see routes/transportation.js for the real dispatch flow.

// Exposed so other routes (e.g. the AI concierge chat's get_business_details
// tool) can reuse the same full-profile assembler that powers a business's
// own page, instead of duplicating ~60 tables' worth of query logic.
router.buildFullEntity = buildFullEntity;
router.searchEntitySlugs = searchEntitySlugs;

module.exports = router;
