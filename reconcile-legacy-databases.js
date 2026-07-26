#!/usr/bin/env node
/**
 * Reconcile every "business identity" table across all legacy Supabase
 * projects against the live entity table in cyber check. READ-ONLY —
 * this script never writes anywhere. Its only output is a report.
 * ───────────────────────────────────────────────────────────────────────────
 * Six Supabase projects exist on this account. This script connects to five
 * of them (everything except the destination) and, for each one's business
 * table, tries to match every row against the current entity table by:
 *   1. google_place_id (exact, reliable — no ambiguity)
 *   2. normalized name (fallback — same normalizer as import-legacy-menus.js)
 *
 * For every row it reports: matched / unmatched, which slug it matched, and
 * which of a fixed set of "interesting" fields (description, tags, photos,
 * menu, events, hours) the source has that look worth comparing.
 *
 * This does NOT decide what to import. It answers exactly one question per
 * row: "does this already exist in cyber check, and under what slug?" —
 * so a human (or a follow-up insert-only script, same pattern as
 * import-legacy-menus.js) can decide what's worth pulling in next.
 *
 * Usage:
 *   node reconcile-legacy-databases.js                 # all 5 sources
 *   node reconcile-legacy-databases.js --only=gcrbiz    # one source (see SOURCES keys)
 *   node reconcile-legacy-databases.js --out=report.json
 *
 * Env — destination (required):
 *   GCR_SUPABASE_URL / GCR_SUPABASE_SERVICE_KEY
 *
 * Env — one URL/KEY pair per source, all optional (skipped if unset):
 *   LEGACY_GCR_URL / LEGACY_GCR_KEY                 → "gulf coast radar"
 *   LEGACY_LAUNCHGCR_URL / LEGACY_LAUNCHGCR_KEY     → "launch gcr"
 *   LEGACY_CULTURERESET_URL / LEGACY_CULTURERESET_KEY → "CultureReset's Project"
 *   LEGACY_PROFILES_URL / LEGACY_PROFILES_KEY       → "profiles"
 *   LEGACY_DEALORSHIP_URL / LEGACY_DEALORSHIP_KEY   → "dealorship"
 */

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').map(s => s.trim()).filter(Boolean);
const OUT = (process.argv.find(a => a.startsWith('--out=')) || '--out=reconcile-report.json').replace('--out=', '');

const destUrl = (process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const destKey = (process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
if (!destUrl || !destKey) { console.error('Missing GCR_SUPABASE_URL / GCR_SUPABASE_SERVICE_KEY (destination).'); process.exit(1); }
const dest = createClient(destUrl, destKey);

// One entry per legacy project. `table`/`nameCol`/`placeCol` describe where
// that project's business-identity rows live. `select` lists every column
// worth reporting on — kept minimal per project since schemas vary wildly.
const SOURCES = {
  gcr: {
    label: 'gulf coast radar',
    urlEnv: 'LEGACY_GCR_URL', keyEnv: 'LEGACY_GCR_KEY',
    table: 'entity', nameCol: 'name', placeCol: null, // no place_id column in this schema
    select: 'id, name, entity_subtype',
  },
  launchgcr: {
    label: 'launch gcr',
    urlEnv: 'LEGACY_LAUNCHGCR_URL', keyEnv: 'LEGACY_LAUNCHGCR_KEY',
    table: 'entity', nameCol: 'name', placeCol: null,
    select: 'id, name, entity_subtype',
  },
  gcrbiz: {
    label: "CultureReset's Project (gcr_businesses)",
    urlEnv: 'LEGACY_CULTURERESET_URL', keyEnv: 'LEGACY_CULTURERESET_KEY',
    table: 'gcr_businesses', nameCol: 'name', placeCol: 'place_id',
    select: 'id, name, place_id, category, description, menu, photos, events, has_happy_hour',
  },
  profiles: {
    label: 'profiles (businesses)',
    urlEnv: 'LEGACY_PROFILES_URL', keyEnv: 'LEGACY_PROFILES_KEY',
    table: 'businesses', nameCol: 'name', placeCol: null,
    select: 'site_id, name, type, gcr_category, gcr_description, gcr_tags',
    // This project mixes real tenants with dev/test rows — exclude the obvious junk.
    excludeNamePattern: /^(agent test business|test biz|test pizza shop|cybercheck platform)$/i,
  },
  dealorship: {
    label: 'dealorship',
    urlEnv: 'LEGACY_DEALORSHIP_URL', keyEnv: 'LEGACY_DEALORSHIP_KEY',
    table: 'entity', nameCol: 'name', placeCol: null, // entity_slug already matches cyber check's convention
    select: 'entity_slug, name, industry_code, description',
  },
};

function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|the)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function fetchAll(client, table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

function hasContent(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 3;
  if (typeof v === 'boolean') return v === true;
  return true;
}

async function main() {
  console.log('=== RECONCILE (read-only — no writes) ===\n');

  console.log('Loading destination entity table (cyber check)...');
  const destEntities = await fetchAll(dest, 'entity', 'slug, name, google_place_id');
  const destByPlaceId = new Map();
  const destByName = new Map();
  for (const e of destEntities) {
    if (e.google_place_id) destByPlaceId.set(e.google_place_id, e.slug);
    const k = normName(e.name);
    if (!k) continue;
    if (!destByName.has(k)) destByName.set(k, []);
    destByName.get(k).push(e.slug);
  }
  console.log(`  ${destEntities.length} entities, ${destByPlaceId.size} with a place_id\n`);

  const report = { generated_note: 'read-only reconciliation, no writes performed', destination_entity_count: destEntities.length, sources: {} };

  for (const [key, cfg] of Object.entries(SOURCES)) {
    if (ONLY.length && !ONLY.includes(key)) continue;

    const url = (process.env[cfg.urlEnv] || '').trim();
    const svcKey = (process.env[cfg.keyEnv] || '').trim();
    if (!url || !svcKey) {
      console.log(`── ${cfg.label} ── SKIPPED (${cfg.urlEnv}/${cfg.keyEnv} not set)\n`);
      report.sources[key] = { label: cfg.label, skipped: true, reason: `${cfg.urlEnv}/${cfg.keyEnv} not set` };
      continue;
    }

    console.log(`── ${cfg.label} ──`);
    const client = createClient(url, svcKey);
    let rows;
    try {
      rows = await fetchAll(client, cfg.table, cfg.select);
    } catch (err) {
      console.log(`  ERROR: ${err.message}\n`);
      report.sources[key] = { label: cfg.label, error: err.message };
      continue;
    }

    if (cfg.excludeNamePattern) {
      const before = rows.length;
      rows = rows.filter(r => !cfg.excludeNamePattern.test((r[cfg.nameCol] || '').trim()));
      console.log(`  ${before - rows.length} rows excluded as dev/test junk`);
    }

    const results = { by_place_id: 0, by_name_single: 0, by_name_ambiguous: 0, no_match: 0 };
    const noMatchSample = [], ambiguousSample = [];
    const contentFields = {};

    for (const row of rows) {
      let matchType = null, matchSlug = null;

      if (cfg.placeCol && row[cfg.placeCol] && destByPlaceId.has(row[cfg.placeCol])) {
        matchType = 'place_id'; matchSlug = destByPlaceId.get(row[cfg.placeCol]);
      } else {
        const candidates = destByName.get(normName(row[cfg.nameCol])) || [];
        if (candidates.length === 1) { matchType = 'name_single'; matchSlug = candidates[0]; }
        else if (candidates.length > 1) { matchType = 'name_ambiguous'; }
      }

      if (matchType === 'place_id') results.by_place_id++;
      else if (matchType === 'name_single') results.by_name_single++;
      else if (matchType === 'name_ambiguous') { results.by_name_ambiguous++; if (ambiguousSample.length < 10) ambiguousSample.push(row[cfg.nameCol]); }
      else { results.no_match++; if (noMatchSample.length < 10) noMatchSample.push(row[cfg.nameCol]); }

      // Track which "interesting" fields actually carry content in this source,
      // regardless of match status — this is what answers "what have I got".
      for (const field of Object.keys(row)) {
        if ([cfg.nameCol, cfg.placeCol, 'id', 'site_id', 'entity_slug'].includes(field)) continue;
        if (!contentFields[field]) contentFields[field] = 0;
        if (hasContent(row[field])) contentFields[field]++;
      }
    }

    console.log(`  ${rows.length} rows total`);
    console.log(`  matched by place_id:     ${results.by_place_id}`);
    console.log(`  matched by unique name:  ${results.by_name_single}`);
    console.log(`  ambiguous name (skip):   ${results.by_name_ambiguous}`);
    console.log(`  no match at all:         ${results.no_match}`);
    console.log(`  fields with real content (out of ${rows.length} rows):`);
    Object.entries(contentFields).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`    ${String(n).padStart(5)}  ${f}`));
    console.log('');

    report.sources[key] = {
      label: cfg.label,
      total_rows: rows.length,
      matched_by_place_id: results.by_place_id,
      matched_by_name: results.by_name_single,
      ambiguous_name_matches: results.by_name_ambiguous,
      no_match: results.no_match,
      no_match_sample: noMatchSample,
      ambiguous_sample: ambiguousSample,
      content_field_counts: contentFields,
    };
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${OUT}`);
}

main().catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
