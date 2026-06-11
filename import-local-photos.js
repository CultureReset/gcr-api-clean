#!/usr/bin/env node
/**
 * Import photo URLs from local data.json files into entity_photos
 * for businesses that currently have zero photos in the DB.
 *
 * Usage: node import-local-photos.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.GCR_SUPABASE_URL, process.env.GCR_SUPABASE_SERVICE_KEY);

const DIRS = [
  '/Users/owner/cyber-admin/gcr-directory',
  '/Users/owner/cyber-admin/gcr-directory-cleaned',
  '/Users/owner/cyber-admin/gcr-directory-v2',
];

async function fetchAll(table, select, filter) {
  let all = [], from = 0;
  while (true) {
    let q = db.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data } = await q;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function run() {
  console.log('Loading missing businesses from DB...');
  const [entities, allPhotos] = await Promise.all([
    fetchAll('entity', 'slug, name, google_place_id', q => q.eq('is_active', true)),
    fetchAll('entity_photos', 'entity_slug', null)
  ]);

  const withPhotos = new Set(allPhotos.map(r => r.entity_slug));
  const missing    = entities.filter(e => !withPhotos.has(e.slug));
  const bySlug     = new Map(missing.map(e => [e.slug, e]));
  const byPlaceId  = new Map(missing.filter(e => e.google_place_id).map(e => [e.google_place_id, e]));
  console.log('Businesses with no photos:', missing.length);

  // Walk all local dirs and collect data.json files
  const localFiles = [];
  function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { if (fs.statSync(p).isDirectory()) walk(p); else if (f === 'data.json') localFiles.push(p); } catch {}
    }
  }
  for (const dir of DIRS) { if (fs.existsSync(dir)) walk(dir); }
  console.log('Local data.json files found:', localFiles.length);
  console.log('Starting import...\n');

  let imported = 0, skippedNoPhotos = 0, skippedNoMatch = 0, totalPhotos = 0, errors = 0;

  for (const file of localFiles) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pid    = d.place_id || d.google_place_id;
      const entity = bySlug.get(d.slug) || (pid && byPlaceId.get(pid));
      if (!entity) { skippedNoMatch++; continue; }

      // Collect unique photo URLs
      const rawPhotos = [...(d.google_photos || []), ...(d.images || []), ...(d.photos || [])];
      const urls = [...new Set(
        rawPhotos
          .map(p => typeof p === 'string' ? p : p.url || p.photo_url || p.src || '')
          .filter(u => u && u.startsWith('http'))
      )];

      if (!urls.length) { skippedNoPhotos++; continue; }

      const records = urls.map((url, i) => ({
        entity_slug: entity.slug,
        url,
        is_cover:   i === 0,
        sort_order: i
      }));

      const { error } = await db.from('entity_photos').insert(records);
      if (error) { errors++; console.log('ERROR ' + entity.slug + ': ' + error.message); continue; }

      await db.from('entity').update({ hero_image_url: urls[0] }).eq('slug', entity.slug);

      totalPhotos += records.length;
      imported++;
      console.log('✓ ' + entity.slug + ' — ' + records.length + ' photos');
    } catch (e) {
      errors++;
      console.log('ERROR: ' + e.message);
    }
  }

  console.log('\n=== DONE ===');
  console.log('Businesses imported:      ', imported);
  console.log('Total photos inserted:    ', totalPhotos);
  console.log('Skipped (no photos):      ', skippedNoPhotos);
  console.log('Skipped (no DB match):    ', skippedNoMatch);
  console.log('Errors:                   ', errors);
}

run().catch(e => { console.error(e); process.exit(1); });
