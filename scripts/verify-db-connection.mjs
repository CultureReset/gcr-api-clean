/**
 * Which database is this API actually talking to, and does the connection work?
 *
 *   node scripts/verify-db-connection.mjs
 *
 * Reads the same env vars the API reads — GCR_SUPABASE_URL and
 * GCR_SUPABASE_SERVICE_KEY — so whatever it reports is what the running API
 * gets. On Vercel:  vercel env pull .env.local  then run it.
 *
 * HANDOFF.md §4 lists GCR_SUPABASE_URL as NOT VERIFIED: the deployed value was
 * never read. This is how you read it. It matters because there are two
 * Supabase projects with near-identical schemas, and pointing at the wrong one
 * looks exactly like "connected but every screen is empty."
 *
 * Read-only. Runs count(*) and one select. Writes nothing.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader so this works without dotenv installed.
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const url = process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

const line = (k, v) => console.log('  ' + String(k).padEnd(26) + v);

console.log('\nCONNECTION');
if (!url || !key) {
  line('GCR_SUPABASE_URL', url || 'MISSING');
  line('GCR_SUPABASE_SERVICE_KEY', key ? 'set' : 'MISSING');
  console.log('\n  The API calls process.exit(1) on boot without both of these.');
  console.log('  Nothing is connected. Set them and run this again.\n');
  process.exit(1);
}

const ref = (url.match(/https?:\/\/([a-z0-9]+)\.supabase\./) || [])[1] || '(unrecognised host)';
line('GCR_SUPABASE_URL', url);
line('project ref', ref);
line('service key', key.slice(0, 8) + '…' + key.slice(-4) + `  (${key.length} chars)`);

// The two projects that have been confused for each other. Fingerprints from
// HANDOFF.md §1 — the slug-keyed table count is the unambiguous tell.
const KNOWN = {
  mkepugvdlktfsossumox: { name: 'cyber check', verdict: 'CORRECT — this is the platform database' },
  adpnhipmdefutkzzltbs: { name: 'gulf coast radar', verdict: 'WRONG DATABASE — similar schema, different data' },
};
if (KNOWN[ref]) line('known project', `${KNOWN[ref].name} — ${KNOWN[ref].verdict}`);
else line('known project', 'not one of the two known refs — verify this is intended');

const db = createClient(url, key);

console.log('\nCAN IT READ?');
const t0 = Date.now();
const { data, error } = await db.from('entity').select('slug, name').limit(3);
if (error) {
  line('entity select', 'FAILED after ' + (Date.now() - t0) + 'ms');
  line('message', error.message);
  if (error.hint) line('hint', error.hint);
  console.log('\n  The connection is configured but not working. Every dashboard');
  console.log('  section will render and show nothing, because every read fails.\n');
  process.exit(2);
}
line('entity select', `ok in ${Date.now() - t0}ms`);
data.forEach((e) => line('', `· ${e.slug} — ${e.name}`));

console.log('\nWHICH DATABASE IS THIS?');
const counts = {};
for (const t of ['entity', 'menu_items', 'menu_sections', 'entity_photos']) {
  const { count, error: e } = await db.from(t).select('*', { count: 'exact', head: true });
  counts[t] = e ? 'ERROR: ' + e.message : count;
  line(t, counts[t]);
}
console.log('\n  For reference, from HANDOFF.md:');
console.log('    cyber check (right)       entity 4,067 · menu_items 11,147');
console.log('    gulf coast radar (wrong)  entity 2,301 · menu_items  7,551');

const ok = ref === 'mkepugvdlktfsossumox';
console.log('\nVERDICT');
console.log('  ' + (ok
  ? 'Connected to the correct project and reads work.'
  : 'Connected, reads work, but NOT to the cyber check project. Check the value of GCR_SUPABASE_URL in the gcr-api-clean Vercel project.'));
console.log('');
process.exit(ok ? 0 : 3);
