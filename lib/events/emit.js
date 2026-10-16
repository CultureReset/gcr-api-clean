// DRAFT. Event emit helper for NEXT GENT modules.
//
// Atomicity: supabase-js has no transactions. Two supported ways:
//   1. Preferred: the module writes through a SQL function that changes data AND inserts into
//      ng.events_outbox in one statement (see migrations/nextgent/0010_emit_fn.sql).
//   2. Fallback (this helper): write, then emit. On emit failure we log and the reconciler
//      (worker.js → reconcile) can backfill from updated_at. Good enough for phase 1.
const db = require('../../db');

const TYPE_RE = /^[a-z-]+\.[a-z_.]+$/;

/**
 * emit({ businessId, moduleId, type, entityTable, entityId, payload, actor })
 * actor: { kind: 'user'|'agent'|'system', id, paperclipTaskId? }
 */
async function emit(evt) {
  if (!evt || !TYPE_RE.test(evt.type || '')) throw new Error(`bad event type: ${evt && evt.type}`);
  if (!evt.moduleId || !evt.type.startsWith(evt.moduleId + '.')) throw new Error('event type must start with its moduleId');
  const row = {
    business_id: evt.businessId || null,
    module_id: evt.moduleId,
    type: evt.type,
    entity_table: evt.entityTable || null,
    entity_id: evt.entityId || null,
    payload: evt.payload || {},
    actor: evt.actor || { kind: 'system' },
  };
  const { data, error } = await db.schema('ng').from('events_outbox').insert(row).select('id, event_id').single();
  if (error) {
    console.error('[events] emit failed', evt.type, error.message);
    return null;
  }
  return data;
}

/** Diff helper so payloads carry only what changed. */
function changed(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  return out;
}

module.exports = { emit, changed };
