/**
 * Full Google Places (New API) pull for:
 *  - Wolf Bay Restaurant (Orange Beach)
 *  - Ginny Lane Bar & Grill (Gulf Shores)
 * Uses same fields as import-google-places.js — amenities, hours, photos, tags, everything.
 */
require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');

const db  = createClient(process.env.GCR_SUPABASE_URL.trim(), process.env.GCR_SUPABASE_SERVICE_KEY.trim());
const KEY = process.env.GOOGLE_PLACES_API_KEY;

const TARGETS = [
  { slug: 'wolf-bay-restaurant',   query: 'Wolf Bay Restaurant Orange Beach Alabama' },
  { slug: 'ginny-lane-bar-grill',  query: 'Ginny Lane Bar Grill Gulf Shores Alabama' },
];

const FIELDS = [
  'id','displayName','formattedAddress','shortFormattedAddress','addressComponents',
  'nationalPhoneNumber','internationalPhoneNumber','websiteUri','googleMapsUri',
  'rating','userRatingCount','priceLevel','priceRange','businessStatus',
  'primaryType','primaryTypeDisplayName','types',
  'location','utcOffsetMinutes','plusCode',
  'regularOpeningHours','regularSecondaryOpeningHours',
  'delivery','dineIn','takeout','curbsidePickup','reservable',
  'outdoorSeating','liveMusic','restroom','goodForChildren','menuForChildren',
  'goodForGroups','goodForWatchingSports','allowsDogs',
  'servesBreakfast','servesBrunch','servesLunch','servesDinner',
  'servesBeer','servesWine','servesCocktails','servesCoffee','servesDessert','servesVegetarianFood',
  'accessibilityOptions','paymentOptions','parkingOptions',
  'generativeSummary','reviewSummary','editorialSummary',
  'photos','iconBackgroundColor','googleMapsLinks',
].join(',');

function bool(val) { return val === true || val === false ? val : null; }

function parseAddress(components) {
  let streetNumber = '', street = '', city = '', state = 'AL', zip = '';
  for (const c of (components || [])) {
    if (!c?.types) continue;
    if (c.types.includes('street_number'))               streetNumber = c.shortText || '';
    if (c.types.includes('route'))                       street       = c.shortText || '';
    if (c.types.includes('locality'))                    city         = c.shortText || '';
    if (c.types.includes('administrative_area_level_1')) state        = c.shortText || 'AL';
    if (c.types.includes('postal_code'))                 zip          = c.shortText || '';
  }
  return { address_line_1: `${streetNumber} ${street}`.trim(), city, state, zip };
}

async function searchNew(query) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress' },
    body: JSON.stringify({ textQuery: query, maxResultCount: 3 }),
  });
  const d = await r.json();
  return d.places || [];
}

async function getDetailsNew(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': FIELDS },
  });
  return r.json();
}

function getPhotoUrl(photoName) {
  return `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1200&key=${KEY}`;
}

async function processOne(slug, query) {
  console.log('\n' + '='.repeat(60));
  console.log('Searching:', query);

  const candidates = await searchNew(query);
  if (!candidates.length) { console.log('NO RESULTS — skipping'); return; }

  console.log('Top result:', candidates[0].displayName?.text, '|', candidates[0].formattedAddress);
  const place = await getDetailsNew(candidates[0].id);

  const address = parseAddress(place.addressComponents);
  const acc  = place.accessibilityOptions  || {};
  const pay  = place.paymentOptions        || {};
  const park = place.parkingOptions        || {};
  const gen  = place.generativeSummary     || {};
  const rev  = place.reviewSummary         || {};
  const ed   = place.editorialSummary      || {};

  const updates = {
    google_place_id:                  place.id,
    google_maps_uri:                  place.googleMapsUri || null,
    business_status:                  place.businessStatus || 'OPERATIONAL',
    primary_type:                     place.primaryType || null,
    entity_subtype:                   place.primaryType || null,
    formatted_address:                place.formattedAddress || null,
    short_formatted_address:          place.shortFormattedAddress || null,
    address_line_1:                   address.address_line_1,
    city:                             address.city,
    state:                            address.state,
    zip:                              address.zip,
    phone:                            place.nationalPhoneNumber || null,
    website:                          place.websiteUri || null,
    rating:                           place.rating || null,
    review_count:                     place.userRatingCount || 0,
    price_level:                      place.priceLevel ? parseInt(place.priceLevel.replace('PRICE_LEVEL_','')) || null : null,
    editorial_summary:                ed.text || (ed.overview && ed.overview.text) || null,
    ai_overview:                      gen.overview && gen.overview.text || null,
    ai_review_summary:                rev.text && rev.text.text || null,
    delivery:                         bool(place.delivery),
    dine_in:                          bool(place.dineIn),
    takeout:                          bool(place.takeout),
    curbside_pickup:                  bool(place.curbsidePickup),
    reservable:                       bool(place.reservable),
    outdoor_seating:                  bool(place.outdoorSeating),
    live_music:                       bool(place.liveMusic),
    restroom:                         bool(place.restroom),
    good_for_children:                bool(place.goodForChildren),
    menu_for_children:                bool(place.menuForChildren),
    good_for_groups:                  bool(place.goodForGroups),
    good_for_watching_sports:         bool(place.goodForWatchingSports),
    allows_dogs:                      bool(place.allowsDogs),
    serves_breakfast:                 bool(place.servesBreakfast),
    serves_brunch:                    bool(place.servesBrunch),
    serves_lunch:                     bool(place.servesLunch),
    serves_dinner:                    bool(place.servesDinner),
    serves_beer:                      bool(place.servesBeer),
    serves_wine:                      bool(place.servesWine),
    serves_cocktails:                 bool(place.servesCocktails),
    serves_coffee:                    bool(place.servesCoffee),
    serves_dessert:                   bool(place.servesDessert),
    serves_vegetarian:                bool(place.servesVegetarianFood),
    wheelchair_accessible_entrance:   bool(acc.wheelchairAccessibleEntrance),
    wheelchair_accessible_parking:    bool(acc.wheelchairAccessibleParking),
    wheelchair_accessible_restroom:   bool(acc.wheelchairAccessibleRestroom),
    wheelchair_accessible_seating:    bool(acc.wheelchairAccessibleSeating),
    accepts_credit_cards:             bool(pay.acceptsCreditCards),
    accepts_debit_cards:              bool(pay.acceptsDebitCards),
    accepts_nfc:                      bool(pay.acceptsNfc),
    accepts_cash_only:                bool(pay.acceptsCashOnly),
    free_parking_lot:                 bool(park.freeParkingLot),
    paid_parking_lot:                 bool(park.paidParkingLot),
    free_street_parking:              bool(park.freeStreetParking),
    paid_street_parking:              bool(park.paidStreetParking),
    valet_parking:                    bool(park.valetParking),
    google_places_data:               place,
    is_active:                        true,
  };

  const photoNames = (place.photos || []).slice(0, 3).map(p => p.name);
  if (photoNames.length) updates.hero_image_url = getPhotoUrl(photoNames[0]);

  const { error: entErr } = await db.from('entity').update(updates).eq('slug', slug);
  console.log('Entity updated:', entErr ? entErr.message : 'OK');
  console.log('  address:', updates.address_line_1, updates.city, updates.state, updates.zip);
  console.log('  phone:', updates.phone, '| website:', updates.website);
  console.log('  serves_beer:', updates.serves_beer, '| outdoor_seating:', updates.outdoor_seating, '| live_music:', updates.live_music);

  // Photos — clear old, insert fresh
  await db.from('entity_photos').delete().eq('entity_slug', slug);
  for (let i = 0; i < photoNames.length; i++) {
    await db.from('entity_photos').insert({ entity_slug: slug, url: getPhotoUrl(photoNames[i]), sort_order: i, is_cover: i === 0 });
  }
  console.log('Photos inserted:', photoNames.length);

  // Tags — clear old google tags, insert fresh
  await db.from('entity_tags').delete().eq('entity_slug', slug).in('tag_category', ['google_type', 'google_primary_type']);
  const tags = [];
  if (place.primaryType) tags.push({ entity_slug: slug, tag_name: place.primaryType, tag_category: 'google_primary_type' });
  for (const t of (place.types || [])) {
    if (t !== place.primaryType) tags.push({ entity_slug: slug, tag_name: t, tag_category: 'google_type' });
  }
  if (tags.length) await db.from('entity_tags').insert(tags);
  console.log('Tags inserted:', tags.length);

  // Hours — clear old, insert fresh
  if (place.regularOpeningHours && place.regularOpeningHours.periods) {
    await db.from('entity_hours').delete().eq('entity_slug', slug);
    const rows = place.regularOpeningHours.periods
      .filter(p => p.open && p.close)
      .map(p => ({
        entity_slug: slug,
        day_of_week: p.open.day,
        opens_at:  String(p.open.hour).padStart(2,'0') + ':' + String(p.open.minute).padStart(2,'0') + ':00',
        closes_at: String(p.close.hour).padStart(2,'0') + ':' + String(p.close.minute).padStart(2,'0') + ':00',
        is_closed: false,
      }));
    if (rows.length) await db.from('entity_hours').insert(rows);
    console.log('Hours inserted:', rows.length);
  }

  console.log('Done:', slug);
}

async function run() {
  for (const { slug, query } of TARGETS) {
    await processOne(slug, query);
  }
  console.log('\nAll done.');
}

run().catch(console.error);
