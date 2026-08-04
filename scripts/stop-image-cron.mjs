/**
 * One-shot: stop the runaway `image-liveness` cron job.
 *
 * Context. At 2026-08-04T12:55Z a session scheduled
 *   cron.schedule('image-liveness', '15 seconds', 'select public.image_liveness_tick()')
 * Each tick takes 50-92s (see Postgres logs), so runs stack up indefinitely,
 * each firing 250 pg_net probes across ~52k entity_photos rows. The stacked
 * runs exhaust connection slots: PostgREST's established pool keeps serving
 * (/api/gcr/home-feed still returns 200) while every NEW connection times out —
 * the Supabase SQL editor, the MCP client, everything.
 *
 * That is why this runs here. A build step executes on Vercel's network and
 * talks to PostgREST over HTTPS, which is the one path still answering. It
 * needs no new Postgres connection.
 *
 * Never fails the build. If it cannot fix things it says so and exits 0 —
 * a deploy that dies here would leave the site down as well as the database.
 */

const url = process.env.GCR_SUPABASE_URL;
const key = process.env.GCR_SUPABASE_SERVICE_KEY;

const log = (m) => console.log(`[stop-image-cron] ${m}`);

if (!url || !key) {
  log('GCR_SUPABASE_URL / GCR_SUPABASE_SERVICE_KEY not present at build time — skipping.');
  process.exit(0);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
};

/** Call a Postgres function through PostgREST. */
async function rpc(fn, body) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, text: await res.text().catch(() => '') };
}

try {
  // cron.unschedule lives in the `cron` schema, which PostgREST does not
  // expose. exec_sql is in public and runs arbitrary SQL, so it is the bridge.
  // routes/tourist.js:316 already calls it, so it should exist here.
  log('attempting cron.unschedule via exec_sql …');
  let r = await rpc('exec_sql', { sql: "select cron.unschedule('image-liveness');" });
  log(`exec_sql -> ${r.status} ${r.text.slice(0, 200)}`);

  if (r.status === 404) {
    // No exec_sql. Try unschedule_job(name), which some projects expose.
    log('exec_sql not found; trying cron.unschedule wrappers …');
    for (const fn of ['unschedule_job', 'cron_unschedule', 'stop_cron_job']) {
      const alt = await rpc(fn, { job_name: 'image-liveness' });
      log(`${fn} -> ${alt.status} ${alt.text.slice(0, 120)}`);
      if (alt.status < 300) { r = alt; break; }
    }
  }

  if (r.status < 300) {
    log('SUCCESS — image-liveness unscheduled. Draining the pg_net backlog …');
    const drain = await rpc('exec_sql', {
      sql: 'delete from net._http_response; delete from public.image_probe;',
    });
    log(`drain -> ${drain.status} ${drain.text.slice(0, 200)}`);
    log('Connection slots should free up within a minute.');
  } else {
    log('COULD NOT STOP THE JOB FROM HERE.');
    log('Restart the project (Settings -> General -> Restart project), then');
    log("immediately run:  select cron.unschedule('image-liveness');");
  }
} catch (err) {
  log(`errored: ${err.message}`);
  log('Build continues regardless.');
}

process.exit(0);
