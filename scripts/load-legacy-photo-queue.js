#!/usr/bin/env node
/**
 * Rebuilds / resumes legacy_photo_migration_queue from the legacy GCR project.
 *
 * Replaces the older approach of generating static insert_chunk_NN.sql files.
 * Those were fragile: the chunk files lived only on scratch disk, and because
 * the queue table had no unique constraint, re-running a chunk silently
 * double-inserted. This script derives the row set from the source of truth
 * every time and relies on a unique index for idempotency, so it is safe to
 * run repeatedly and safe to interrupt.
 *
 * Prerequisite: migrations/2026-07-25-legacy-photo-queue-dedupe.sql
 *
 *   LEGACY_SUPABASE_URL          https://adpnhipmdefutkzzltbs.supabase.co
 *   LEGACY_SUPABASE_SERVICE_KEY  service_role key for the legacy project
 *   TARGET_SUPABASE_URL          https://mkepugvdlktfsossumox.supabase.co
 *   TARGET_SUPABASE_SERVICE_KEY  service_role key for the target project
 *
 * Usage:
 *   node scripts/load-legacy-photo-queue.js              # dry run (default)
 *   node scripts/load-legacy-photo-queue.js --apply
 *   node scripts/load-legacy-photo-queue.js --apply --collisions=include
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const BUCKET_MATCH = '%/entity-images/%';
// The queue only ever carried the first three photos per entity: legacy
// sort_order 0/1/2 map to queue sort_order 100/101/102.
const SOURCE_SORT_ORDERS = [0, 1, 2];
const SORT_OFFSET = 100;
const PLACE_ID_SUFFIX = /-ChIJ[A-Za-z0-9_-]+$/;
const PAGE = 1000;
const INSERT_BATCH = 500;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const COLLISION_POLICY =
  (args.find((a) => a.startsWith('--collisions=')) || '--collisions=skip').split('=')[1];

if (!['skip', 'include'].includes(COLLISION_POLICY)) {
  console.error('--collisions must be "skip" or "include"');
  process.exit(1);
}

function client(urlVar, keyVar) {
  const url = process.env[urlVar];
  const key = process.env[keyVar];
  if (!url || !key) {
    console.error(`Missing ${urlVar} / ${keyVar}`);
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const legacy = client('LEGACY_SUPABASE_URL', 'LEGACY_SUPABASE_SERVICE_KEY');
const target = client('TARGET_SUPABASE_URL', 'TARGET_SUPABASE_SERVICE_KEY');

/** Reads a whole table through the 1000-row PostgREST ceiling. */
async function fetchAll(db, table, columns, refine = (q) => q) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await refine(db.from(table).select(columns))
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

const baseSlug = (slug) => slug.replace(PLACE_ID_SUFFIX, '');

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}   collisions=${COLLISION_POLICY}\n`);

  const [legacyEntities, legacyPhotos, targetEntities, existingRows] = await Promise.all([
    fetchAll(legacy, 'entity', 'id, slug'),
    fetchAll(legacy, 'entity_photos', 'entity_id, image_url, is_cover, sort_order', (q) =>
      q.like('image_url', BUCKET_MATCH).in('sort_order', SOURCE_SORT_ORDERS)),
    fetchAll(target, 'entity', 'slug'),
    fetchAll(target, 'legacy_photo_migration_queue', 'entity_slug, source_url'),
  ]);

  const entityById = new Map(legacyEntities.map((e) => [e.id, e]));
  const targetSlugs = new Set(targetEntities.map((e) => e.slug));
  const alreadyQueued = new Set(existingRows.map((r) => `${r.entity_slug}\n${r.source_url}`));

  // Stripping the -ChIJ… suffix can collapse two distinct legacy businesses
  // onto one target slug. Those need a decision, not a default.
  const idsPerBaseSlug = new Map();
  for (const p of legacyPhotos) {
    const e = entityById.get(p.entity_id);
    if (!e) continue;
    const bs = baseSlug(e.slug);
    if (!idsPerBaseSlug.has(bs)) idsPerBaseSlug.set(bs, new Set());
    idsPerBaseSlug.get(bs).add(e.id);
  }
  const colliding = new Set(
    [...idsPerBaseSlug].filter(([, ids]) => ids.size > 1).map(([bs]) => bs)
  );

  const stats = { orphanPhoto: 0, noTargetEntity: 0, collisionSkipped: 0, deduped: 0 };
  const rows = new Map();

  for (const p of legacyPhotos) {
    const e = entityById.get(p.entity_id);
    if (!e) { stats.orphanPhoto++; continue; }

    const slug = baseSlug(e.slug);
    if (!targetSlugs.has(slug)) { stats.noTargetEntity++; continue; }
    if (colliding.has(slug) && COLLISION_POLICY === 'skip') { stats.collisionSkipped++; continue; }

    const key = `${slug}\n${p.image_url}`;
    const existing = rows.get(key);
    if (existing) {
      // Same photo listed twice; keep the strongest claim to cover + earliest slot.
      stats.deduped++;
      existing.is_cover = existing.is_cover || !!p.is_cover;
      existing.sort_order = Math.min(existing.sort_order, SORT_OFFSET + p.sort_order);
      continue;
    }
    rows.set(key, {
      entity_slug: slug,
      source_url: p.image_url,
      is_cover: !!p.is_cover,
      sort_order: SORT_OFFSET + p.sort_order,
      status: 'pending',
    });
  }

  const desired = [...rows.values()];
  const missing = desired.filter((r) => !alreadyQueued.has(`${r.entity_slug}\n${r.source_url}`));
  const stale = existingRows.filter((r) => !rows.has(`${r.entity_slug}\n${r.source_url}`));

  console.log(`legacy photos in scope       ${legacyPhotos.length}`);
  console.log(`  skipped, no legacy entity  ${stats.orphanPhoto}`);
  console.log(`  skipped, no target entity  ${stats.noTargetEntity}`);
  console.log(`  skipped, slug collision    ${stats.collisionSkipped} (${colliding.size} slugs)`);
  console.log(`  collapsed duplicates       ${stats.deduped}`);
  console.log(`\ntarget queue size            ${desired.length}`);
  console.log(`already loaded               ${existingRows.length}`);
  console.log(`to insert                    ${missing.length}`);
  if (stale.length) {
    console.log(`\n!! ${stale.length} queued rows are NOT in the derived set (review before trusting)`);
  }

  const report = path.join(__dirname, '..', 'legacy-photo-queue-report.json');
  fs.writeFileSync(report, JSON.stringify({
    generatedAt: new Date().toISOString(),
    collisionPolicy: COLLISION_POLICY,
    stats,
    collidingSlugs: [...colliding].sort(),
    desiredCount: desired.length,
    alreadyLoaded: existingRows.length,
    toInsert: missing.length,
    staleQueuedRows: stale,
  }, null, 2));
  console.log(`\nreport -> ${report}`);

  if (!APPLY) {
    console.log('\nDry run: nothing written. Re-run with --apply to load.');
    return;
  }
  if (!missing.length) {
    console.log('\nNothing to insert; queue already matches source.');
    return;
  }

  let inserted = 0;
  for (let i = 0; i < missing.length; i += INSERT_BATCH) {
    const batch = missing.slice(i, i + INSERT_BATCH);
    // Requires legacy_photo_queue_slug_url_key. Re-running a batch is a no-op.
    const { error } = await target
      .from('legacy_photo_migration_queue')
      .upsert(batch, { onConflict: 'entity_slug,source_url', ignoreDuplicates: true });
    if (error) throw new Error(`insert at offset ${i}: ${error.message}`);
    inserted += batch.length;
    console.log(`  inserted ${inserted}/${missing.length}`);
  }

  const { count } = await target
    .from('legacy_photo_migration_queue')
    .select('*', { count: 'exact', head: true });
  console.log(`\nDone. Queue now holds ${count} rows.`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
