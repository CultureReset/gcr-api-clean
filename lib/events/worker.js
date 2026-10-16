// DRAFT. Delivers ng.events_outbox rows to consumers: installed modules, event-triggered automations,
// Paperclip (signed POST /api/nextgent/events) and connectors. Run from the existing cron tick
// (routes/automations.js publicRouter /cron/tick) or a LISTEN ng_events loop.
const db = require('../../db');
const { signRequest } = require('../nextgent/sign');
const loader = require('../moduleLoader');

const BATCH = 100;
const backoff = (n) => Math.min(3600, 2 ** n * 15); // seconds

/** Which consumers get this event, from manifests + installs. */
async function consumersFor(evt) {
  const out = ['paperclip'];
  if (!evt.business_id) return out;
  const { data: installs } = await db.schema('ng').from('module_install')
    .select('module_id').eq('business_id', evt.business_id).eq('status', 'installed');
  for (const { module_id } of installs || []) {
    const m = loader.manifest(module_id);
    if (m && m.events.consumes.some((p) => matches(p, evt.type))) out.push(`module:${module_id}`);
  }
  // automations with trigger { type: 'event', event: '<type>' } → consumer `automation:<id>` (wired in phase 2)
  return out;
}

const matches = (pattern, type) => pattern === type ||
  (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));

async function deliverPaperclip(evt) {
  const base = process.env.PAPERCLIP_URL, secret = process.env.NEXTGENT_SERVICE_SECRET;
  if (!base || !secret) return { skipped: 'paperclip not configured' };
  const url = `${base.replace(/\/$/, '')}/api/nextgent/events`;
  const rawBody = JSON.stringify({
    eventId: evt.event_id, type: evt.type, moduleId: evt.module_id,
    businessId: evt.business_id, entity: { table: evt.entity_table, id: evt.entity_id },
    payload: evt.payload, actor: evt.actor, at: evt.created_at,
  });
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signRequest(secret, { method: 'POST', url, rawBody }) }, body: rawBody });
  if (!res.ok) throw new Error(`paperclip ${res.status}`);
  return { ok: true };
}

async function deliverModule(moduleId, evt) {
  const handler = loader.eventHandler(moduleId);
  if (!handler) return { skipped: 'no handler' };
  await handler(evt);
  return { ok: true };
}

/** One pass: fan out new events into ng.event_delivery, then attempt due deliveries. */
async function tick() {
  const ng = db.schema('ng');
  const { data: fresh } = await ng.from('events_outbox').select('*')
    .not('id', 'in', `(select outbox_id from ng.event_delivery)`) // NOTE: replace with an RPC; PostgREST can't subquery
    .order('id').limit(BATCH);
  for (const evt of fresh || []) {
    const rows = (await consumersFor(evt)).map((consumer) => ({ outbox_id: evt.id, consumer }));
    await ng.from('event_delivery').upsert(rows, { onConflict: 'outbox_id,consumer', ignoreDuplicates: true });
  }
  const { data: due } = await ng.from('event_delivery')
    .select('outbox_id, consumer, attempts, events_outbox(*)')
    .eq('status', 'pending').lte('next_attempt_at', new Date().toISOString()).limit(BATCH);
  for (const d of due || []) {
    const evt = d.events_outbox;
    try {
      const r = d.consumer === 'paperclip' ? await deliverPaperclip(evt)
        : d.consumer.startsWith('module:') ? await deliverModule(d.consumer.slice(7), evt)
        : { skipped: 'unknown consumer' };
      await ng.from('event_delivery').update({ status: r.skipped ? 'skipped' : 'delivered', delivered_at: new Date().toISOString(), last_error: r.skipped || null })
        .eq('outbox_id', d.outbox_id).eq('consumer', d.consumer);
    } catch (e) {
      const attempts = d.attempts + 1;
      await ng.from('event_delivery').update({
        attempts, last_error: e.message, status: attempts >= 8 ? 'failed' : 'pending',
        next_attempt_at: new Date(Date.now() + backoff(attempts) * 1000).toISOString(),
      }).eq('outbox_id', d.outbox_id).eq('consumer', d.consumer);
    }
  }
  return { fanned: (fresh || []).length, attempted: (due || []).length };
}

module.exports = { tick, consumersFor, matches };
