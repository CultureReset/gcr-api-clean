#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const sb = createClient(process.env.GCR_SUPABASE_URL, process.env.GCR_SUPABASE_SERVICE_KEY);

const PHOTO_WIDTH = 1600;
const PHOTOS_PER_VENUE = 3;

const MISSING_VENUES = [
  { name: "Gulf Coast Elks Lodge 2782",          place_id: "ChIJ871ogkgOmogRT9qYZBYPgio" },
  { name: "Lillian Community Club",              place_id: "ChIJy17bbAqkkIgR5iVJSDRi4iI" },
  { name: "McGuire's Irish Pub",                 place_id: "ChIJWwUFBrjAkIgRbjKDxHv4RuQ" },
  { name: "Moonshine Saloon",                    place_id: "ChIJRWmt0ZK7kIgRXqDq8DW9Jg0" },
  { name: "Paddy O'Leary's Irish Pub",           place_id: "ChIJl4kaA-jFkIgRyviSWYoqF4w" },
  { name: "Peg Leg Pete's",                      place_id: "ChIJcy4crj3GkIgRrtDw5yXIghQ" },
  { name: "Red Fish Blue Fish",                  place_id: "ChIJidW9TOfFkIgRk2ziPgnGzd8" },
  { name: "The Country Gym",                     place_id: "ChIJTxm_f6fbkIgRCZc2ZyxoUEU" },
  { name: "Windjammers on the Pier",             place_id: "ChIJT7hcxiAnkYgRbYSX0vRwfKE" },
];

const FIELD_MASK = [
  'id','displayName','primaryType','primaryTypeDisplayName','types',
  'formattedAddress','shortFormattedAddress','addressComponents','addressDescriptor',
  'location','plusCode',
  'internationalPhoneNumber','nationalPhoneNumber','websiteUri',
  'googleMapsUri','googleMapsLinks',
  'businessStatus','priceLevel','priceRange','rating','userRatingCount','openingDate',
  'regularOpeningHours','utcOffsetMinutes',
  'allowsDogs','delivery','dineIn','takeout','curbsidePickup','reservable','outdoorSeating',
  'restroom','goodForChildren','goodForGroups','goodForWatchingSports','liveMusic','menuForChildren',
  'servesBreakfast','servesBrunch','servesLunch','servesDinner','servesBeer','servesWine',
  'servesCocktails','servesCoffee','servesDessert','servesVegetarianFood',
  'paymentOptions','parkingOptions','accessibilityOptions',
  'photos','editorialSummary','generativeSummary','reviewSummary','neighborhoodSummary',
  'iconBackgroundColor','consumerAlert',
].join(',');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const r = await fetch(url, {
    headers: { 'X-Goog-Api-Key': API_KEY, 'X-Goog-FieldMask': FIELD_MASK }
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function uploadPhoto(photoName, slug, index) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${PHOTO_WIDTH}&key=${API_KEY}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Photo ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());

  // Upload to Supabase entity-media bucket
  const filePath = `${slug}/photo_${String(index+1).padStart(2,'0')}.jpg`;
  const { data, error } = await sb.storage.from('entity-photos').upload(filePath, buf, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw new Error(`Storage upload: ${error.message}`);
  const { data: { publicUrl } } = sb.storage.from('entity-photos').getPublicUrl(filePath);
  return publicUrl;
}

function parseAddress(components) {
  const get = (type) => components?.find(c => c.types?.includes(type))?.longText || '';
  return {
    address_line_1: `${get('street_number')} ${get('route')}`.trim(),
    city: get('locality') || get('sublocality') || get('administrative_area_level_2'),
    state: get('administrative_area_level_1'),
    zip: get('postal_code'),
  };
}

function parseHours(regularOpeningHours) {
  if (!regularOpeningHours?.periods) return [];
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return regularOpeningHours.periods.map(p => ({
    day_of_week: p.open?.day ?? null,
    day_name: days[p.open?.day] || null,
    opens_at: p.open?.time ? `${p.open.time.slice(0,2)}:${p.open.time.slice(2)}` : null,
    closes_at: p.close?.time ? `${p.close.time.slice(0,2)}:${p.close.time.slice(2)}` : null,
    is_closed: false,
  }));
}

async function processVenue(venue) {
  console.log(`\n--- ${venue.name} ---`);

  const d = await fetchDetails(venue.place_id);
  await sleep(300);

  const addr = parseAddress(d.addressComponents);
  const slug = slugify(venue.name);

  // Build entity row
  const row = {
    slug,
    name: d.displayName?.text || venue.name,
    is_active: true,
    google_place_id: venue.place_id,
    google_maps_uri: d.googleMapsUri || null,
    business_status: d.businessStatus || null,
    primary_type: d.primaryType || null,
    primary_type_display: d.primaryTypeDisplayName?.text || null,
    formatted_address: d.formattedAddress || null,
    short_formatted_address: d.shortFormattedAddress || null,
    address_line_1: addr.address_line_1 || null,
    city: addr.city || null,
    state: addr.state || null,
    zip: addr.zip || null,
    latitude: d.location?.latitude || null,
    longitude: d.location?.longitude || null,
    phone: d.nationalPhoneNumber || null,
    international_phone: d.internationalPhoneNumber || null,
    website_url: d.websiteUri || null,
    rating: d.rating || null,
    review_count: d.userRatingCount || null,
    price_level: { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 }[d.priceLevel] ?? null,
    // amenities
    allows_dogs: d.allowsDogs ?? null,
    delivery: d.delivery ?? null,
    dine_in: d.dineIn ?? null,
    takeout: d.takeout ?? null,
    curbside_pickup: d.curbsidePickup ?? null,
    reservable: d.reservable ?? null,
    outdoor_seating: d.outdoorSeating ?? null,
    restroom: d.restroom ?? null,
    good_for_kids: d.goodForChildren ?? null,
    good_for_groups: d.goodForGroups ?? null,
    good_for_watching_sports: d.goodForWatchingSports ?? null,
    live_music: d.liveMusic ?? null,
    menu_for_children: d.menuForChildren ?? null,
    serves_breakfast: d.servesBreakfast ?? null,
    serves_brunch: d.servesBrunch ?? null,
    serves_lunch: d.servesLunch ?? null,
    serves_dinner: d.servesDinner ?? null,
    serves_beer: d.servesBeer ?? null,
    serves_wine: d.servesWine ?? null,
    serves_cocktails: d.servesCocktails ?? null,
    serves_coffee: d.servesCoffee ?? null,
    serves_dessert: d.servesDessert ?? null,
    serves_vegetarian: d.servesVegetarianFood ?? null,
    // payment
    accepts_credit_cards: d.paymentOptions?.acceptsCreditCards ?? null,
    accepts_debit_cards: d.paymentOptions?.acceptsDebitCards ?? null,
    accepts_nfc: d.paymentOptions?.acceptsNfc ?? null,
    accepts_cash_only: d.paymentOptions?.acceptsCashOnly ?? null,
    // parking
    parking_type: d.parkingOptions ? Object.keys(d.parkingOptions).find(k => d.parkingOptions[k]) || null : null,
    free_parking_lot: d.parkingOptions?.freeParkingLot ?? null,
    paid_parking_lot: d.parkingOptions?.paidParkingLot ?? null,
    free_street_parking: d.parkingOptions?.freeStreetParking ?? null,
    // accessibility
    wheelchair_accessible_entrance: d.accessibilityOptions?.wheelchairAccessibleEntrance ?? null,
    wheelchair_accessible_parking: d.accessibilityOptions?.wheelchairAccessibleParking ?? null,
    wheelchair_accessible_restroom: d.accessibilityOptions?.wheelchairAccessibleRestroom ?? null,
    wheelchair_accessible_seating: d.accessibilityOptions?.wheelchairAccessibleSeating ?? null,
    // content
    description: d.editorialSummary?.text || null,
    editorial_summary: d.editorialSummary?.text || null,
    ai_overview: d.generativeSummary?.overview?.text || null,
    ai_review_summary: d.reviewSummary?.text || null,
    ai_neighborhood_summary: d.neighborhoodSummary?.text || null,
    icon_background_color: d.iconBackgroundColor || null,
    utc_offset_minutes: d.utcOffsetMinutes ?? null,
    google_places_data: d,
  };

  // Upsert entity
  const { data: inserted, error: insertErr } = await sb.from('entity').upsert(row, { onConflict: 'slug' }).select('id,slug').single();
  if (insertErr) throw new Error(`Insert entity: ${insertErr.message}`);
  console.log(`  ✓ Entity inserted: ${inserted.slug} (id: ${inserted.id})`);

  // Hours
  const hours = parseHours(d.regularOpeningHours);
  if (hours.length) {
    await sb.from('entity_hours').delete().eq('entity_slug', slug);
    const hoursRows = hours.map(h => ({ ...h, entity_slug: slug }));
    const { error: hoursErr } = await sb.from('entity_hours').insert(hoursRows);
    if (hoursErr) console.log(`  ⚠ Hours error: ${hoursErr.message}`);
    else console.log(`  ✓ Hours inserted: ${hours.length} days`);
  }

  // Photos — upload 3 to Supabase storage
  const photos = (d.photos || []).slice(0, PHOTOS_PER_VENUE);
  const photoUrls = [];
  for (let i = 0; i < photos.length; i++) {
    try {
      await sleep(200);
      const url = await uploadPhoto(photos[i].name, slug, i);
      photoUrls.push(url);
      console.log(`  ✓ Photo ${i+1} uploaded`);
    } catch (e) {
      console.log(`  ⚠ Photo ${i+1} failed: ${e.message}`);
    }
  }

  if (photoUrls.length) {
    // Set first as hero
    await sb.from('entity').update({ hero_image_url: photoUrls[0] }).eq('slug', slug);
    // Insert into entity_photos
    await sb.from('entity_photos').delete().eq('entity_slug', slug);
    const photoRows = photoUrls.map((url, i) => ({
      entity_slug: slug,
      url,
      sort_order: i,
      is_cover: i === 0,
    }));
    const { error: photoErr } = await sb.from('entity_photos').insert(photoRows);
    if (photoErr) console.log(`  ⚠ entity_photos error: ${photoErr.message}`);
    else console.log(`  ✓ entity_photos inserted: ${photoRows.length}`);
  }

  return { slug, photos: photoUrls.length, hours: hours.length };
}

async function main() {
  if (!API_KEY) { console.error('Missing GOOGLE_PLACES_API_KEY'); process.exit(1); }
  console.log(`Importing ${MISSING_VENUES.length} missing venues...\n`);

  const results = [];
  for (const venue of MISSING_VENUES) {
    try {
      const r = await processVenue(venue);
      results.push({ ...r, status: 'ok' });
    } catch (e) {
      console.log(`  ✗ FAILED: ${e.message}`);
      results.push({ name: venue.name, status: 'error', error: e.message });
    }
    await sleep(500);
  }

  console.log('\n=== SUMMARY ===');
  results.forEach(r => {
    if (r.status === 'ok') console.log(`✓ ${r.slug} — ${r.photos} photos, ${r.hours} hour slots`);
    else console.log(`✗ ${r.name} — ${r.error}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
