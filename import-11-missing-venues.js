#!/usr/bin/env node
/**
 * Fetch the 11 GML venues missing from GCR via Google Places API,
 * then upsert them into the entity table.
 *
 * Run:  node import-11-missing-venues.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const FIELD_MASK = [
  'places.id','places.displayName','places.formattedAddress','places.location',
  'places.nationalPhoneNumber','places.websiteUri','places.rating','places.userRatingCount',
  'places.regularOpeningHours','places.photos','places.types',
  'places.primaryType','places.primaryTypeDisplayName','places.addressComponents',
  'places.priceLevel','places.businessStatus','places.editorialSummary',
  // amenity flags
  'places.allowsDogs','places.delivery','places.dineIn','places.takeout',
  'places.curbsidePickup','places.reservable','places.outdoorSeating',
  'places.restroom','places.goodForChildren','places.goodForGroups',
  'places.goodForWatchingSports','places.liveMusic','places.menuForChildren',
  // food/drink flags
  'places.servesBreakfast','places.servesBrunch','places.servesLunch',
  'places.servesDinner','places.servesBeer','places.servesWine',
  'places.servesCocktails','places.servesCoffee','places.servesDessert',
  'places.servesVegetarianFood',
  // options
  'places.paymentOptions','places.parkingOptions','places.accessibilityOptions',
].join(',');

const PHOTO_WIDTH = 1200;
const SUPABASE_BUCKET = 'entity-media';

const VENUES = [
  { name: 'Flounders Chowder House',              city: 'Pensacola Beach', state: 'FL' },
  { name: 'Paradise Bar & Grill',                  city: 'Orange Beach',    state: 'AL' },
  { name: 'Tipsy Pelican Patio Bar',               city: 'Gulf Shores',     state: 'AL' },
  { name: "Moe's Original BBQ Foley",              city: 'Foley',           state: 'AL' },
  { name: "Lillian's Pizza",                       city: 'Lillian',         state: 'AL' },
  { name: 'Gulf Coast Elks Lodge 2782',            city: 'Gulf Shores',     state: 'AL' },
  { name: 'Crabs on the Beach',                    city: 'Gulf Shores',     state: 'AL' },
  { name: "Pedro's Tacos & Tequila Bar Gulf Breeze", city: 'Gulf Breeze',   state: 'FL' },
  { name: 'El Paso Tacos & Tequila Navarre',       city: 'Navarre',         state: 'FL' },
  { name: 'Wolf Bay at Orange Beach',              city: 'Orange Beach',    state: 'AL' },
  { name: 'Southwind Marina & Tiki Bar',           city: 'Orange Beach',    state: 'AL' },
];

function slugify(name) {
  return name.toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^-|-$/g, '');
}

function getCity(components) {
  const locality = components?.find(c => c.types?.includes('locality'));
  return locality?.longText || '';
}

function getState(components) {
  const state = components?.find(c => c.types?.includes('administrative_area_level_1'));
  return state?.shortText || '';
}

function getZip(components) {
  const zip = components?.find(c => c.types?.includes('postal_code'));
  return zip?.longText || '';
}

function getAddress(components) {
  const num    = components?.find(c => c.types?.includes('street_number'))?.longText || '';
  const street = components?.find(c => c.types?.includes('route'))?.longText || '';
  return [num, street].filter(Boolean).join(' ');
}

async function searchPlace(venue) {
  const query = `${venue.name} ${venue.city} ${venue.state}`;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
  });
  const data = await res.json();
  return data.places?.[0] || null;
}

async function main() {
  if (!API_KEY) { console.error('Missing GOOGLE_PLACES_API_KEY'); process.exit(1); }

  const rows = [];

  for (const venue of VENUES) {
    process.stdout.write(`Searching: ${venue.name} ... `);
    const place = await searchPlace(venue);

    if (!place) {
      console.log('❌ NOT FOUND');
      continue;
    }

    const comp = place.addressComponents || [];
    const slug = slugify(place.displayName?.text || venue.name);

    // Check if slug already exists — append place ID suffix if so
    const { data: existing } = await sb.from('entity').select('slug').eq('slug', slug).limit(1);
    const finalSlug = existing?.length
      ? `${slug}-${place.id.slice(-6)}`
      : slug;

    // Download first photo and upload to Supabase
    let heroUrl = null;
    const firstPhoto = place.photos?.[0];
    if (firstPhoto) {
      try {
        const photoUrl = `https://places.googleapis.com/v1/${firstPhoto.name}/media?maxWidthPx=${PHOTO_WIDTH}&key=${API_KEY}`;
        const imgRes = await fetch(photoUrl);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const ext = 'jpg';
          const storagePath = `entities/${finalSlug}/hero.${ext}`;
          const { error: uploadErr } = await sb.storage
            .from(SUPABASE_BUCKET)
            .upload(storagePath, buf, { contentType: 'image/jpeg', upsert: true });
          if (!uploadErr) {
            const { data: pubData } = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
            heroUrl = pubData.publicUrl;
          }
        }
      } catch (e) { /* skip photo on error */ }
    }

    const p = place; // shorthand
    const row = {
      slug:               finalSlug,
      name:               p.displayName?.text || venue.name,
      entity_type:        'restaurant',
      address_line_1:     getAddress(comp),
      city:               getCity(comp) || venue.city,
      state:              getState(comp) || venue.state,
      zip:                getZip(comp),
      phone:              p.nationalPhoneNumber || null,
      website_url:        p.websiteUri || null,
      rating:             p.rating || null,
      review_count:       p.userRatingCount || null,
      google_place_id:    p.id,
      latitude:           p.location?.latitude || null,
      longitude:          p.location?.longitude || null,
      hero_image_url:     heroUrl,
      description:        p.editorialSummary?.text || null,
      // amenities
      outdoor_seating:    p.outdoorSeating    ?? false,
      live_music:         p.liveMusic         ?? false,
      reservable:         p.reservable        ?? false,
      dine_in:            p.dineIn            ?? true,
      takeout:            p.takeout           ?? false,
      delivery:           p.delivery          ?? false,
      good_for_groups:    p.goodForGroups     ?? false,
      good_for_kids:      p.goodForChildren   ?? false,
      // food/drink
      serves_breakfast:   p.servesBreakfast   ?? false,
      serves_brunch:      p.servesBrunch      ?? false,
      serves_lunch:       p.servesLunch       ?? false,
      serves_dinner:      p.servesDinner      ?? false,
      serves_beer:        p.servesBeer        ?? false,
      serves_wine:        p.servesWine        ?? false,
      serves_cocktails:   p.servesCocktails   ?? false,
      is_active:          true,
    };

    rows.push(row);
    console.log(`✓  ${row.name}  →  ${row.slug}  (${row.city}, ${row.state})${heroUrl ? ' 📷' : ''}`);

    await new Promise(r => setTimeout(r, 400));
  }

  if (!rows.length) {
    console.log('\nNo venues found.');
    return;
  }

  // Just save to JSON for review — don't import yet
  const fs = require('fs');
  fs.writeFileSync('/Users/owner/missing-venues-data.json', JSON.stringify(rows, null, 2));
  console.log(`\nSaved ${rows.length} venues to /Users/owner/missing-venues-data.json`);
  console.log('\nReview the data, then run import when ready.');
}

main().catch(console.error);
