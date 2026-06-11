#!/usr/bin/env node
/**
 * Pull Google Places photos for businesses that have NO entity_photos records.
 * Same logic as pull-google-full.js but targets only the missing ones.
 * Resume-safe via google-data/_missing-manifest.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const sb = createClient(process.env.GCR_SUPABASE_URL, process.env.GCR_SUPABASE_SERVICE_KEY);

const OUT_DIR = path.join(__dirname, 'google-data');
const PHOTOS_DIR = path.join(OUT_DIR, 'photos');
const MANIFEST_FILE = path.join(OUT_DIR, '_missing-manifest.json');

const PHOTOS_HIGH = 1;
const PHOTOS_LOW  = 1;
const PHOTO_WIDTH = 1600;
const STREET_VIEW_WIDTH  = 1200;
const STREET_VIEW_HEIGHT = 800;

const HIGH_VALUE_TYPES = new Set([
  'restaurant','bar','cafe','bakery','coffee_shop','ice_cream_shop','meal_takeaway','meal_delivery',
  'pizza_restaurant','seafood_restaurant','breakfast_restaurant','brunch_restaurant',
  'sports_bar','pub','wine_bar','american_restaurant','mexican_restaurant','italian_restaurant',
  'chinese_restaurant','japanese_restaurant','sushi_restaurant','steak_house','hamburger_restaurant',
  'sandwich_shop','barbecue_restaurant','fast_food_restaurant','diner','donut_shop','dessert_shop',
  'food_court','deli','catering','cocktail_bar','brewery','winery','distillery',
  'lodging','hotel','motel','resort_hotel','bed_and_breakfast','rv_park','campground',
  'apartment_building','apartment_complex','extended_stay_hotel','guest_house','cottage','cabin','inn',
  'condominium_complex','vacation_rental',
  'marina','fishing_charter','fishing_pier','boat_launch','boat_rental','dock',
  'water_park','swimming_pool','beach',
  'tour_agency','travel_agency','sailing_charter','sightseeing_tour_agency',
  'parasailing','jet_ski_rental','kayak_rental','boat_tour','dolphin_tour',
  'sunset_cruise','snorkeling_tour','scuba_diving','surf_shop','dive_shop',
  'tourist_attraction','tourist_information_center','amusement_park','amusement_center','aquarium','zoo',
  'museum','park','dog_park','state_park','national_park','nature_preserve',
  'movie_theater','night_club','performing_arts_theater','event_venue',
  'bowling_alley','golf_course','miniature_golf_course','video_arcade','escape_room',
  'store','shopping_mall','clothing_store','gift_shop','art_gallery','sporting_goods_store',
  'liquor_store','market','seafood_market',
]);

const FIELD_MASK = [
  'id','displayName','primaryType','types',
  'formattedAddress','location',
  'internationalPhoneNumber','nationalPhoneNumber','websiteUri','googleMapsUri',
  'businessStatus','rating','userRatingCount',
  'photos','editorialSummary',
].join(',');

const RATE_DELAY_MS     = 200;
const BUSINESS_DELAY_MS = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadManifest() {
  if (fs.existsSync(MANIFEST_FILE)) return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  return { completed: {}, errors: {}, started: new Date().toISOString() };
}
function saveManifest(m) { fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2)); }

async function fetchAll(table, select, filter) {
  let all = [], from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data } = await q;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function searchPlaceByText(query, lat, lng) {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const body = {
    textQuery: query,
    maxResultCount: 1,
    locationBias: { circle: { center: { latitude: lat || 30.2942, longitude: lng || -87.5736 }, radius: 50000 } }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': API_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Search ${r.status}`);
  return (await r.json()).places?.[0] || null;
}

async function fetchPlaceDetails(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': API_KEY, 'X-Goog-FieldMask': FIELD_MASK }
  });
  if (!r.ok) throw new Error(`Details ${r.status}`);
  return r.json();
}

async function downloadPhoto(photoName, outPath) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${PHOTO_WIDTH}&key=${API_KEY}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Photo ${r.status}`);
  fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
}

async function downloadStreetView(lat, lng, outPath) {
  const url = `https://maps.googleapis.com/maps/api/streetview?size=${STREET_VIEW_WIDTH}x${STREET_VIEW_HEIGHT}&location=${lat},${lng}&fov=80&key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`StreetView ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 8000) return 0;
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

async function processOne(entity, manifest) {
  const slug = entity.slug;
  if (manifest.completed[slug]) return { slug, status: 'already_done' };

  let placeId = entity.google_place_id;

  if (!placeId) {
    const query = `${entity.name} ${entity.city || 'Orange Beach'} AL`;
    const result = await searchPlaceByText(query, entity.latitude, entity.longitude);
    await sleep(RATE_DELAY_MS);
    if (!result) {
      manifest.errors[slug] = 'not_found';
      saveManifest(manifest);
      return { slug, status: 'not_found' };
    }
    placeId = result.id;
  }

  const details = await fetchPlaceDetails(placeId);
  await sleep(RATE_DELAY_MS);

  const photoDir = path.join(PHOTOS_DIR, slug);
  fs.mkdirSync(photoDir, { recursive: true });

  const pType = details.primaryType || '';
  const photoLimit = HIGH_VALUE_TYPES.has(pType) ? PHOTOS_HIGH : PHOTOS_LOW;
  const photos = (details.photos || []).slice(0, photoLimit);

  let photoCount = 0;
  for (let i = 0; i < photos.length; i++) {
    const outPath = path.join(photoDir, `photo_${String(i+1).padStart(2,'0')}.jpg`);
    if (fs.existsSync(outPath)) { photoCount++; continue; }
    try { await downloadPhoto(photos[i].name, outPath); photoCount++; } catch {}
    await sleep(RATE_DELAY_MS);
  }

  const lat = details.location?.latitude || entity.latitude;
  const lng = details.location?.longitude || entity.longitude;
  let hasStreetView = false;
  if (lat && lng) {
    const svPath = path.join(photoDir, 'street_view.jpg');
    if (!fs.existsSync(svPath)) {
      try { const b = await downloadStreetView(lat, lng, svPath); hasStreetView = b > 0; } catch {}
      await sleep(RATE_DELAY_MS);
    } else hasStreetView = true;
  }

  // Insert entity_photos records into DB
  if (photoCount > 0 || hasStreetView) {
    const records = [];
    for (let i = 1; i <= photoCount; i++) {
      records.push({
        entity_slug: slug,
        url: `https://mkepugvdlktfsossumox.supabase.co/storage/v1/object/public/entity-photos/${slug}/photo_${String(i).padStart(2,'0')}.jpg`,
        is_cover: i === 1,
        sort_order: i - 1
      });
    }
    if (hasStreetView) {
      records.push({
        entity_slug: slug,
        url: `https://mkepugvdlktfsossumox.supabase.co/storage/v1/object/public/entity-photos/${slug}/street_view.jpg`,
        is_cover: records.length === 0,
        sort_order: records.length
      });
    }

    // Upload files to Supabase storage
    for (const rec of records) {
      const filename = rec.url.split('/').pop();
      const filePath = path.join(photoDir, filename);
      if (!fs.existsSync(filePath)) continue;
      const buf = fs.readFileSync(filePath);
      await sb.storage.from('entity-photos').upload(`${slug}/${filename}`, buf, { contentType: 'image/jpeg', upsert: true });
    }

    // Insert DB records
    await sb.from('entity_photos').upsert(records, { onConflict: 'entity_slug,url' });
  }

  manifest.completed[slug] = { placeId, photoCount, hasStreetView, pulledAt: new Date().toISOString() };
  saveManifest(manifest);
  return { slug, status: 'ok', photoCount, hasStreetView };
}

async function main() {
  if (!API_KEY) { console.error('Missing GOOGLE_PLACES_API_KEY'); process.exit(1); }
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });

  console.log('Loading businesses with no photos from DB...');
  const [entities, allPhotos] = await Promise.all([
    fetchAll('entity', 'slug, name, city, google_place_id, latitude, longitude', q => q.eq('is_active', true)),
    fetchAll('entity_photos', 'entity_slug', null)
  ]);

  const withPhotos = new Set(allPhotos.map(r => r.entity_slug));
  const queue = entities.filter(e => !withPhotos.has(e.slug));

  const limitArg = process.argv.find(a => /^\d+$/.test(a));
  const limit = limitArg ? parseInt(limitArg) : null;
  const finalQueue = limit ? queue.slice(0, limit) : queue;

  console.log(`Businesses missing photos: ${queue.length}`);
  if (limit) console.log(`Running first ${finalQueue.length}`);

  const manifest = loadManifest();
  console.log(`Already completed: ${Object.keys(manifest.completed).length}`);
  console.log('Starting...\n');

  let ok = 0, notFound = 0, errors = 0, skipped = 0;
  for (let i = 0; i < finalQueue.length; i++) {
    const e = finalQueue[i];
    const prefix = `[${i+1}/${finalQueue.length}]`;
    try {
      const r = await processOne(e, manifest);
      if (r.status === 'already_done') { skipped++; continue; }
      if (r.status === 'ok') { ok++; console.log(`${prefix} ✓ ${e.slug} — ${r.photoCount} photos${r.hasStreetView?' +SV':''}`); }
      else { notFound++; console.log(`${prefix} ✗ ${e.slug} — not found on Google`); }
    } catch (err) {
      errors++;
      manifest.errors[e.slug] = err.message;
      saveManifest(manifest);
      console.log(`${prefix} ERROR ${e.slug}: ${err.message}`);
    }
    await sleep(BUSINESS_DELAY_MS);
  }

  console.log('\n=== DONE ===');
  console.log(`OK: ${ok} | Not found: ${notFound} | Errors: ${errors} | Already done: ${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
