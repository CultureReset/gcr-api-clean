#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const sb = createClient(process.env.GCR_SUPABASE_URL, process.env.GCR_SUPABASE_SERVICE_KEY);

const PHOTO_WIDTH = 1600;
const PHOTOS_PER_VENUE = 2;
const GOOGLE_DATA_DIR = path.join(__dirname, 'google-data');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadPhoto(photoName) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${PHOTO_WIDTH}&key=${API_KEY}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Photo ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadToStorage(buf, slug, index) {
  const filePath = `${slug}/photo_${String(index+1).padStart(2,'0')}.jpg`;
  const { error } = await sb.storage.from('entity-photos').upload(filePath, buf, {
    contentType: 'image/jpeg', upsert: true
  });
  if (error) throw new Error(`Storage: ${error.message}`);
  const { data: { publicUrl } } = sb.storage.from('entity-photos').getPublicUrl(filePath);
  return publicUrl;
}

async function main() {
  if (!API_KEY) { console.error('Missing GOOGLE_PLACES_API_KEY'); process.exit(1); }

  // Get all entities with no hero image
  let all = [];
  let from = 0;
  while (true) {
    const { data } = await sb.from('entity').select('slug, name, hero_image_url').range(from, from + 999);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  const missing = all.filter(e => !e.hero_image_url);
  console.log(`Total missing hero image: ${missing.length}`);

  let ok = 0, noJson = 0, noPhotos = 0, errors = 0;

  for (let i = 0; i < missing.length; i++) {
    const entity = missing[i];
    const prefix = `[${i+1}/${missing.length}]`;

    // Check for local JSON
    const jsonPath = path.join(GOOGLE_DATA_DIR, `${entity.slug}.json`);
    if (!fs.existsSync(jsonPath)) {
      console.log(`${prefix} SKIP (no json): ${entity.slug}`);
      noJson++;
      continue;
    }

    const place = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const photos = (place.photos || []).slice(0, PHOTOS_PER_VENUE);

    if (!photos.length) {
      console.log(`${prefix} SKIP (no photos on Google): ${entity.slug}`);
      noPhotos++;
      continue;
    }

    try {
      const photoUrls = [];
      for (let p = 0; p < photos.length; p++) {
        await sleep(200);
        const buf = await downloadPhoto(photos[p].name);
        const url = await uploadToStorage(buf, entity.slug, p);
        photoUrls.push(url);
      }

      // Set hero image
      await sb.from('entity').update({ hero_image_url: photoUrls[0] }).eq('slug', entity.slug);

      // Insert into entity_photos (skip if already has some)
      const { data: existing } = await sb.from('entity_photos').select('id').eq('entity_slug', entity.slug).limit(1);
      if (!existing?.length) {
        const rows = photoUrls.map((url, idx) => ({
          entity_slug: entity.slug,
          url,
          sort_order: idx,
          is_cover: idx === 0,
        }));
        await sb.from('entity_photos').insert(rows);
      }

      console.log(`${prefix} ✓ ${entity.slug} — ${photoUrls.length} photos`);
      ok++;
    } catch (e) {
      console.log(`${prefix} ✗ ${entity.slug} — ${e.message}`);
      errors++;
    }

    await sleep(300);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`✓ OK: ${ok}`);
  console.log(`✗ Errors: ${errors}`);
  console.log(`- No local JSON: ${noJson}`);
  console.log(`- No photos on Google: ${noPhotos}`);
}

main().catch(e => { console.error(e); process.exit(1); });
