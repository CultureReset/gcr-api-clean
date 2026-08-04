#!/usr/bin/env node
/**
 * Find out which images actually load.
 *
 * Requests every URL in entity_photos (plus every entity.hero_image_url) and
 * records what came back, so "is this image live?" becomes a column you can
 * query instead of a guess. Run it anywhere with real network access — your
 * laptop, a Vercel cron, CI. It cannot be run from a sandboxed agent, whose
 * proxy refuses the CONNECT tunnel to storage and image hosts.
 *
 *   node scripts/check-image-liveness.mjs                 # check everything
 *   node scripts/check-image-liveness.mjs --limit 500     # dry run first
 *   node scripts/check-image-liveness.mjs --only google   # one host class
 *   node scripts/check-image-liveness.mjs --recheck       # include already-checked
 *
 * Needs GCR_SUPABASE_URL + GCR_SUPABASE_SERVICE_KEY, the same pair the API
 * uses. GOOGLE_PLACES_API_KEY is optional but without it every Places photo
 * URL answers 403 and gets recorded as needs_key rather than dead — an
 * unkeyed 403 says nothing about whether the photo is still there.
 *
 * Creates image_liveness on first run. Nothing is deleted: this only ever
 * writes verdicts, so a bad run can be re-run and never costs you photos.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.GCR_SUPABASE_URL;
const SERVICE_KEY = process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set GCR_SUPABASE_URL and GCR_SUPABASE_SERVICE_KEY first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true);
};
const LIMIT = Number(flag('limit', 0)) || 0;
const ONLY = flag('only', null);
const RECHECK = args.includes('--recheck');
const CONCURRENCY = Number(flag('concurrency', 24));
const TIMEOUT_MS = 15000;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** Which host a URL belongs to — the classes fail for different reasons. */
function classify(url) {
  if (/googleapis\.com|googleusercontent|ggpht/i.test(url)) return 'google';
  if (/\.supabase\.co/i.test(url)) return 'supabase';
  return 'external';
}

/**
 * A Places photo URL is only fetchable with a key. Without one the 403 is
 * about the key, not the photo, so it must not be recorded as dead.
 */
function withKey(url, kind) {
  if (kind !== 'google' || !PLACES_KEY) return url;
  return url + (url.includes('?') ? '&' : '?') + `key=${PLACES_KEY}`;
}

async function check(url) {
  const kind = classify(url);
  if (kind === 'google' && !PLACES_KEY) {
    return { kind, status: null, verdict: 'needs_key', content_type: null, bytes: null };
  }
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  try {
    // HEAD first — cheap. Plenty of image hosts don't implement it, so a 405
    // or 501 falls through to a ranged GET rather than being called dead.
    let r = await fetch(withKey(url, kind), { method: 'HEAD', redirect: 'follow', signal: ctl });
    if (r.status === 405 || r.status === 501 || r.status === 403) {
      r = await fetch(withKey(url, kind), {
        method: 'GET', redirect: 'follow', signal: ctl,
        headers: { Range: 'bytes=0-2047' },   // enough to confirm it decodes
      });
    }
    const ct = r.headers.get('content-type') || '';
    const len = Number(r.headers.get('content-length') || 0) || null;
    let verdict;
    if (!r.ok) verdict = r.status === 404 || r.status === 410 ? 'gone' : `http_${r.status}`;
    else if (!/^image\//i.test(ct)) verdict = 'not_an_image';   // usually an HTML error page served with 200
    else if (len !== null && len < 512) verdict = 'suspicious_tiny';
    else verdict = 'live';
    return { kind, status: r.status, verdict, content_type: ct.slice(0, 60), bytes: len };
  } catch (e) {
    const msg = String(e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code || e?.message || e);
    return { kind, status: null, verdict: `unreachable:${msg}`.slice(0, 60), content_type: null, bytes: null };
  }
}

async function ensureTable() {
  const { error } = await db.rpc('exec_sql', {
    sql: `create table if not exists public.image_liveness (
            url           text primary key,
            kind          text,
            status        int,
            verdict       text,
            content_type  text,
            bytes         bigint,
            checked_at    timestamptz not null default now()
          );
          create index if not exists image_liveness_verdict_idx on public.image_liveness(verdict);`,
  }).catch(() => ({ error: true }));
  if (error) {
    console.log('Could not auto-create image_liveness — run this once in the SQL editor:\n');
    console.log(`  create table if not exists public.image_liveness (
    url text primary key, kind text, status int, verdict text,
    content_type text, bytes bigint, checked_at timestamptz not null default now());
  create index if not exists image_liveness_verdict_idx on public.image_liveness(verdict);\n`);
  }
}

/** Every distinct URL the platform could try to render, both sources. */
async function collectUrls() {
  const urls = new Set();
  for (const [table, col] of [['entity_photos', 'url'], ['entity', 'hero_image_url']]) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(table).select(col).range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      if (!data?.length) break;
      for (const row of data) {
        const u = row[col];
        if (u && /^https?:\/\//i.test(u)) urls.add(u);
      }
      if (data.length < 1000) break;
    }
  }
  return [...urls];
}

async function main() {
  await ensureTable();

  let urls = await collectUrls();
  if (ONLY) urls = urls.filter((u) => classify(u) === ONLY);

  if (!RECHECK) {
    const seen = new Set();
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('image_liveness').select('url').range(from, from + 999);
      if (!data?.length) break;
      data.forEach((r) => seen.add(r.url));
      if (data.length < 1000) break;
    }
    urls = urls.filter((u) => !seen.has(u));
    if (seen.size) console.log(`skipping ${seen.size} already checked (--recheck to redo)`);
  }
  if (LIMIT) urls = urls.slice(0, LIMIT);

  console.log(`checking ${urls.length} urls, ${CONCURRENCY} at a time`);
  if (!PLACES_KEY && urls.some((u) => classify(u) === 'google')) {
    console.log('note: GOOGLE_PLACES_API_KEY unset — Places photos recorded as needs_key, not dead');
  }

  const tally = {};
  let done = 0, buffer = [];
  const queue = [...urls];

  async function worker() {
    for (;;) {
      const url = queue.pop();
      if (!url) return;
      const r = await check(url);
      tally[r.verdict] = (tally[r.verdict] || 0) + 1;
      buffer.push({ url, ...r, checked_at: new Date().toISOString() });
      if (buffer.length >= 200) {
        const batch = buffer; buffer = [];
        await db.from('image_liveness').upsert(batch, { onConflict: 'url' });
      }
      if (++done % 250 === 0) process.stdout.write(`  ${done}/${urls.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (buffer.length) await db.from('image_liveness').upsert(buffer, { onConflict: 'url' });

  console.log(`\n\nchecked ${done} urls:\n`);
  for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(7)}  ${v}`);
  }
  console.log(`
Now queryable, e.g. businesses left with nothing that renders:

  select e.slug, e.name
  from entity e
  where e.is_active
    and not exists (
      select 1 from entity_photos p
      join image_liveness l on l.url = p.url
      where p.entity_slug = e.slug and l.verdict = 'live')
    and not exists (
      select 1 from image_liveness l
      where l.url = e.hero_image_url and l.verdict = 'live');
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
