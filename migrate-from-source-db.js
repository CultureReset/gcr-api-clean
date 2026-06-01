/**
 * migrate-from-source-db.js
 *
 * Pulls all Orange Beach / Gulf Shores business data from a SOURCE Supabase
 * project and upserts it into gcr-api-clean (TARGET).
 *
 * Usage:
 *   SOURCE_URL=https://XXXX.supabase.co SOURCE_KEY=your_service_key node migrate-from-source-db.js
 *
 * Or edit the two lines below directly for each project you run against.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ─── CONFIGURE THESE FOR EACH SOURCE PROJECT ────────────────────────────────
const SOURCE_URL = process.env.SOURCE_URL || 'https://YOUR_SOURCE_PROJECT.supabase.co';
const SOURCE_KEY = process.env.SOURCE_KEY || 'YOUR_SOURCE_SERVICE_ROLE_KEY';
// ────────────────────────────────────────────────────────────────────────────

const TARGET_URL = process.env.GCR_SUPABASE_URL;
const TARGET_KEY = process.env.GCR_SUPABASE_SERVICE_KEY;

if (!TARGET_URL || !TARGET_KEY) {
  console.error('Missing GCR_SUPABASE_URL or GCR_SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}
if (SOURCE_URL.includes('YOUR_SOURCE')) {
  console.error('Set SOURCE_URL and SOURCE_KEY before running.');
  process.exit(1);
}

const src = createClient(SOURCE_URL, SOURCE_KEY);
const tgt = createClient(TARGET_URL, TARGET_KEY);

// Orange Beach / Gulf Shores cities to filter by (case-insensitive)
const TARGET_CITIES = ['orange beach', 'gulf shores', 'foley', 'bon secour', 'gulf coast'];

function isTargetCity(city) {
  if (!city) return false;
  const c = city.toLowerCase();
  return TARGET_CITIES.some(t => c.includes(t));
}

async function fetchAll(client, table, columns = '*', extraFilter = null) {
  let query = client.from(table).select(columns);
  if (extraFilter) query = extraFilter(query);

  const PAGE = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) {
      // Table may not exist in this source DB — skip gracefully
      if (error.code === '42P01' || error.message?.includes('does not exist')) return [];
      throw error;
    }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function upsertBatch(table, rows, conflictCol = 'id') {
  if (!rows.length) return;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await tgt.from(table).upsert(chunk, { onConflict: conflictCol, ignoreDuplicates: false });
    if (error) {
      console.warn(`  ⚠ upsert error on ${table}:`, error.message);
    }
  }
}

// Map source entity columns → gcr-api-clean entity columns
function mapEntity(row) {
  return {
    // Core identity
    id: row.id,
    slug: row.slug,
    name: row.name,
    is_active: row.is_active ?? true,
    featured: row.featured ?? false,
    entity_type: row.entity_type || row.category || null,
    entity_subtype: row.entity_subtype || row.subcategory || null,
    icon: row.icon || null,
    // Description
    description: row.description || row.about || null,
    subtitle: row.subtitle || null,
    // Contact
    phone: row.phone || row.phone_number || null,
    email: row.email || null,
    website_url: row.website_url || row.website || null,
    menu_url: row.menu_url || null,
    reservation_url: row.reservation_url || null,
    order_url: row.order_url || null,
    booking_url: row.booking_url || null,
    directions_url: row.directions_url || null,
    call_url: row.call_url || null,
    // Social
    social_instagram: row.social_instagram || row.instagram || null,
    social_facebook: row.social_facebook || row.facebook || null,
    social_tiktok: row.social_tiktok || row.tiktok || null,
    // Address
    address_line_1: row.address_line_1 || row.address || null,
    address_line_2: row.address_line_2 || null,
    city: row.city || row.location_city || row.location || null,
    state: row.state || 'AL',
    zip: row.zip || row.zip_code || null,
    latitude: row.latitude || row.lat || null,
    longitude: row.longitude || row.lng || null,
    // Ratings
    rating: row.rating || null,
    review_count: row.review_count || row.user_ratings_total || 0,
    price_range: row.price_range || row.price_level || null,
    // Images
    hero_image_url: row.hero_image_url || row.main_image || row.image_url || row.photo_url || null,
    hero_image_path: row.hero_image_path || null,
    logo_url: row.logo_url || row.logo_image || null,
    logo_image_path: row.logo_image_path || null,
    // Happy hour
    hh_days: row.hh_days || null,
    hh_start: row.hh_start || null,
    hh_end: row.hh_end || null,
    hh_description: row.hh_description || null,
    // Meal types
    serves_breakfast: row.serves_breakfast ?? false,
    serves_brunch: row.serves_brunch ?? false,
    serves_lunch: row.serves_lunch ?? false,
    serves_dinner: row.serves_dinner ?? false,
    // Drinks
    serves_beer: row.serves_beer ?? false,
    serves_wine: row.serves_wine ?? false,
    serves_cocktails: row.serves_cocktails ?? false,
    // Attributes
    outdoor_seating: row.outdoor_seating ?? false,
    live_music: row.live_music ?? false,
    reservable: row.reservable ?? false,
    dine_in: row.dine_in ?? true,
    takeout: row.takeout ?? false,
    delivery: row.delivery ?? false,
    good_for_groups: row.good_for_groups ?? false,
    good_for_kids: row.good_for_kids || row.good_for_children ?? false,
  };
}

async function migrateEntityHours(slugs) {
  console.log('  Fetching entity_hours...');
  const rows = await fetchAll(src, 'entity_hours');
  const filtered = rows.filter(r => slugs.has(r.entity_slug));

  // Map old column names if different
  const mapped = filtered.map(r => ({
    id: r.id,
    entity_slug: r.entity_slug,
    day_of_week: r.day_of_week,
    opens_at: r.opens_at || r.open_time || r.open || null,
    closes_at: r.closes_at || r.close_time || r.close || null,
    is_closed: r.is_closed ?? false,
  }));

  await upsertBatch('entity_hours', mapped);
  console.log(`  ✓ entity_hours: ${mapped.length} rows`);
}

async function migrateEntityPhotos(slugs) {
  console.log('  Fetching entity_photos...');
  const rows = await fetchAll(src, 'entity_photos');
  const filtered = rows.filter(r => slugs.has(r.entity_slug));

  const mapped = filtered.map(r => ({
    id: r.id,
    entity_slug: r.entity_slug,
    url: r.url || r.image_url || r.photo_url,
    image_path: r.image_path || null,
    is_cover: r.is_cover ?? false,
    sort_order: r.sort_order ?? 0,
    caption: r.caption || null,
  }));

  await upsertBatch('entity_photos', mapped);
  console.log(`  ✓ entity_photos: ${mapped.length} rows`);
}

async function migrateEntityTags(slugs) {
  console.log('  Fetching entity_tags...');
  const rows = await fetchAll(src, 'entity_tags');
  const filtered = rows.filter(r => slugs.has(r.entity_slug));

  const mapped = filtered.map(r => ({
    id: r.id,
    entity_slug: r.entity_slug,
    tag_name: r.tag_name || r.tag || r.name,
    tag_category: r.tag_category || r.category || null,
  }));

  await upsertBatch('entity_tags', mapped);
  console.log(`  ✓ entity_tags: ${mapped.length} rows`);
}

async function migrateMenus(slugs) {
  console.log('  Fetching menu_sections...');
  const sections = await fetchAll(src, 'menu_sections');
  const filteredSections = sections.filter(r => slugs.has(r.entity_slug));
  await upsertBatch('menu_sections', filteredSections.map(r => ({
    id: r.id, entity_slug: r.entity_slug,
    section_name: r.section_name || r.name, sort_order: r.sort_order ?? 0,
  })));

  const sectionIds = new Set(filteredSections.map(r => r.id));
  console.log('  Fetching menu_items...');
  const items = await fetchAll(src, 'menu_items');
  const filteredItems = items.filter(r => sectionIds.has(r.section_id) || slugs.has(r.entity_slug));
  await upsertBatch('menu_items', filteredItems.map(r => ({
    id: r.id, section_id: r.section_id, entity_slug: r.entity_slug,
    item_name: r.item_name || r.name, description: r.description || null,
    price: r.price || null, tags: r.tags || null,
    image_url: r.image_url || null, image_path: r.image_path || null,
  })));

  console.log(`  ✓ menu: ${filteredSections.length} sections, ${filteredItems.length} items`);
}

async function migrateDrinks(slugs) {
  console.log('  Fetching drink_sections...');
  const sections = await fetchAll(src, 'drink_sections');
  const filteredSections = sections.filter(r => slugs.has(r.entity_slug));
  await upsertBatch('drink_sections', filteredSections.map(r => ({
    id: r.id, entity_slug: r.entity_slug,
    section_name: r.section_name || r.name, sort_order: r.sort_order ?? 0,
  })));

  const sectionIds = new Set(filteredSections.map(r => r.id));
  const items = await fetchAll(src, 'drink_items');
  const filteredItems = items.filter(r => sectionIds.has(r.section_id) || slugs.has(r.entity_slug));
  await upsertBatch('drink_items', filteredItems.map(r => ({
    id: r.id, section_id: r.section_id, entity_slug: r.entity_slug,
    item_name: r.item_name || r.name, description: r.description || null,
    price: r.price || null, image_url: r.image_url || null, image_path: r.image_path || null,
  })));

  console.log(`  ✓ drinks: ${filteredSections.length} sections, ${filteredItems.length} items`);
}

async function migrateHappyHour(slugs) {
  console.log('  Fetching happy_hour_sections...');
  const sections = await fetchAll(src, 'happy_hour_sections');
  const filteredSections = sections.filter(r => slugs.has(r.entity_slug));
  await upsertBatch('happy_hour_sections', filteredSections.map(r => ({
    id: r.id, entity_slug: r.entity_slug,
    section_name: r.section_name || r.name, sort_order: r.sort_order ?? 0,
  })));

  const sectionIds = new Set(filteredSections.map(r => r.id));
  const items = await fetchAll(src, 'happy_hour_items');
  const filteredItems = items.filter(r => sectionIds.has(r.section_id) || slugs.has(r.entity_slug));
  await upsertBatch('happy_hour_items', filteredItems.map(r => ({
    id: r.id, section_id: r.section_id, entity_slug: r.entity_slug,
    item_name: r.item_name || r.name, description: r.description || null,
    price: r.price || null, original_price: r.original_price || null,
    image_url: r.image_url || null, image_path: r.image_path || null,
  })));

  console.log(`  ✓ happy hour: ${filteredSections.length} sections, ${filteredItems.length} items`);
}

async function migrateEvents(slugs) {
  console.log('  Fetching entity_events...');
  const rows = await fetchAll(src, 'entity_events');
  const filtered = rows.filter(r => slugs.has(r.entity_slug));
  await upsertBatch('entity_events', filtered.map(r => ({
    id: r.id, entity_slug: r.entity_slug, entity_name: r.entity_name || null,
    event_name: r.event_name || r.name, description: r.description || null,
    event_date: r.event_date || r.date || null,
    start_time: r.start_time || r.time_start || null,
    end_time: r.end_time || r.time_end || null,
    day_of_week: r.day_of_week || r.weekday || null,
    recurring: r.recurring ?? false,
    artist_id: r.artist_id || null, artist_name: r.artist_name || null,
    cover_charge: r.cover_charge || r.price || null,
    is_active: r.is_active ?? true,
    image_url: r.image_url || null, image_path: r.image_path || null,
  })));
  console.log(`  ✓ entity_events: ${filtered.length} rows`);
}

async function migrateSpecials(slugs) {
  console.log('  Fetching entity_specials...');
  const rows = await fetchAll(src, 'entity_specials');
  const filtered = rows.filter(r => slugs.has(r.entity_slug));
  await upsertBatch('entity_specials', filtered.map(r => ({
    id: r.id, entity_slug: r.entity_slug, entity_name: r.entity_name || null,
    special_name: r.special_name || r.name || r.title,
    description: r.description || r.details || null,
    discount_type: r.discount_type || null, discount_value: r.discount_value || null,
    discount_text: r.discount_text || null,
    days: r.days || null, day_of_week: r.day_of_week || null,
    start_time: r.start_time || null, end_time: r.end_time || null,
    start_date: r.start_date || null, end_date: r.end_date || null,
    is_active: r.is_active ?? true,
    image_url: r.image_url || null, image_path: r.image_path || null,
  })));
  console.log(`  ✓ entity_specials: ${filtered.length} rows`);
}

async function migrateArtists(slugs) {
  console.log('  Fetching artists via entity_events...');
  const events = await fetchAll(src, 'entity_events');
  const filteredEvents = events.filter(r => slugs.has(r.entity_slug) && r.artist_id);
  if (!filteredEvents.length) { console.log('  ✓ artists: 0 linked'); return; }

  const artistIds = [...new Set(filteredEvents.map(r => r.artist_id))];
  const { data: artists, error } = await src.from('artists').select('*').in('id', artistIds);
  if (error || !artists?.length) { console.log('  ✓ artists: 0 found'); return; }

  await upsertBatch('artists', artists.map(r => ({
    id: r.id, name: r.name, slug: r.slug,
    bio: r.bio || null, genre: r.genre || null, hometown: r.hometown || null,
    image_url: r.image_url || null, image_path: r.image_path || null,
    website_url: r.website_url || null,
    social_instagram: r.social_instagram || null,
    social_facebook: r.social_facebook || null,
    social_tiktok: r.social_tiktok || null,
    spotify_url: r.spotify_url || null,
    is_active: r.is_active ?? true,
  })));
  console.log(`  ✓ artists: ${artists.length} rows`);
}

async function main() {
  console.log(`\n🔄 Migration: ${SOURCE_URL} → ${TARGET_URL}\n`);

  // Step 1: Fetch all entities from source
  console.log('Step 1: Fetching entity records from source...');
  const allEntities = await fetchAll(src, 'entity');
  console.log(`  Found ${allEntities.length} total entities in source`);

  // Step 2: Filter to Orange Beach / Gulf Shores
  const targetEntities = allEntities.filter(e =>
    isTargetCity(e.city) || isTargetCity(e.location_city) || isTargetCity(e.location) ||
    (e.state === 'AL') // include all AL if city not set
  );
  console.log(`  Filtered to ${targetEntities.length} Orange Beach / Gulf Shores entities`);

  if (!targetEntities.length) {
    console.log('\n⚠ No matching entities found. Check that city fields are populated in source DB.');
    console.log('  Source cities sampled:', [...new Set(allEntities.slice(0, 20).map(e => e.city || e.location_city || e.location))].join(', '));
    process.exit(0);
  }

  // Step 3: Upsert entities
  console.log('\nStep 2: Upserting entities into target...');
  const mapped = targetEntities.map(mapEntity);
  await upsertBatch('entity', mapped, 'slug');
  const slugs = new Set(mapped.map(e => e.slug));
  console.log(`  ✓ entity: ${mapped.length} rows upserted`);

  // Step 4: Migrate all related tables
  console.log('\nStep 3: Migrating related tables...');
  await migrateEntityHours(slugs);
  await migrateEntityPhotos(slugs);
  await migrateEntityTags(slugs);
  await migrateArtists(slugs);
  await migrateMenus(slugs);
  await migrateDrinks(slugs);
  await migrateHappyHour(slugs);
  await migrateEvents(slugs);
  await migrateSpecials(slugs);

  console.log(`\n✅ Migration complete! ${mapped.length} businesses imported from ${SOURCE_URL}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
