// ============================================================
// EVENT OUTBOX — one signed event per occurrence, to Paperclip (DECISIONS #87)
// ============================================================
//
// lib/businessEvents.js emit() fans an event out to the automations installed
// here (lib/automationEngine.js emitEvent, unchanged) AND hands it to this
// module, which records it as a business_event_outbox row
// (sql/nextgent_event_outbox.sql) and posts it, signed (lib/serviceSigning.js
// signedPost, CONTRACT §3), as
//
//   POST /api/nextgent/events
//   { companyId, event, eventId, occurredAt, ref }
//
// Paperclip fans it out to the company's event-triggered routines. The row is
// the parity point for "never fail the thing that fired it": a post that
// fails is retried from lib/scheduler.js (always-on) and from the vercel.json
// cron /api/automations/cron/outbox, with a doubling backoff, until it goes or
// EVENT_OUTBOX_MAX_ATTEMPTS is reached, when the row is parked as `dead` with
// its last error. A sent row is never sent twice; `eventId` is the row id, so
// Paperclip can deduplicate a retry that crossed a late answer.
//
// ── ref: ids and a non-PII summary ──────────────────────────────────────
//
// `ref` never carries a customer's name, email, phone, notes or the record
// itself (#37). It is built by refFor() from an allow-list of keys, and a
// value that looks like an email address or a phone number is dropped even
// under an allowed key. Customer details stay in gcr: a routine that needs
// them reads them at run time through the business MCP with its install
// token (read_section on booking.records with the id), and send_message takes
// a `to_ref` so the address never transits Paperclip either (routes/mcp.js).
//
// ── Off until Phase C ───────────────────────────────────────────────────
//
// EVENTS_TO_PAPERCLIP (default false) gates the whole module: unset, nothing
// is recorded and nothing is posted, so the outbox cannot grow while nobody
// drains it. A business with no company (lib/companyLinks.js) has no platform
// state to send to; its events are skipped here and still run locally.
//
// Env (all documented in .env.example):
//   EVENTS_TO_PAPERCLIP            true to record and post (default off)
//   EVENT_OUTBOX_INLINE            false to leave every send to the drain (default true)
//   EVENT_OUTBOX_BACKOFF_SECONDS   first retry wait, doubled per attempt (default 60)
//   EVENT_OUTBOX_MAX_BACKOFF_SECONDS  cap on the wait (default 3600)
//   EVENT_OUTBOX_MAX_ATTEMPTS      then the row is dead (default 20)
//   EVENT_OUTBOX_DRAIN_LIMIT       rows per drain (default 100)

const crypto = require('crypto');
const supabase = require('../db');
const { envBool, envInt } = require('./env');
const { companyForSlug } = require('./companyLinks');

const TABLE = 'business_event_outbox';
const EVENTS_PATH = '/api/nextgent/events';

let clock = () => new Date();
let post = (path, body) => require('./serviceSigning').signedPost(path, body);

const enabled = () => envBool('EVENTS_TO_PAPERCLIP', false);
const missingTable = (error) => new RegExp(TABLE).test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);

/* ── ref ──────────────────────────────────────────────────────────────── */

// Every key a ref may carry. Nothing else gets through, whatever the payload.
const REF_KEYS = Object.freeze([
    'booking_id', 'date', 'end_date', 'start_time', 'end_time', 'party', 'status', 'source', 'changed', 'ended_at',
    'payment_id', 'amount_cents', 'currency',
    'review_id', 'rating',
    'app', 'install_id', 'table', 'record_id',
    'request_id',
]);
const EMAILISH = /@/;
// Digits with phone punctuation only, seven or more digits — but a date or a
// timestamp (2026-11-01, 2026-11-01T19:00:00Z) is a summary, not a number.
const PHONEISH = /^\+?\d[\d\s().-]{6,}$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
const MAX_REF_STRING = 120;

const looksLikePhone = (s) => PHONEISH.test(s) && !DATEISH.test(s) && s.replace(/\D/g, '').length >= 7;

/** A scalar an id or a summary may be; an address-looking string is dropped. */
function refScalar(v) {
    if (typeof v === 'number' || typeof v === 'boolean') return Number.isFinite(v) || typeof v === 'boolean' ? v : undefined;
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    if (!s || s.length > MAX_REF_STRING || EMAILISH.test(s) || looksLikePhone(s)) return undefined;
    return s;
}

/** Keep only allowed keys with scalar values (changed: an array of field names). */
function pickRef(candidate) {
    const out = {};
    for (const key of REF_KEYS) {
        const v = candidate[key];
        if (v === undefined || v === null) continue;
        if (key === 'changed') {
            const list = Array.isArray(v) ? v.map(refScalar).filter((x) => typeof x === 'string') : [];
            if (list.length) out.changed = list;
            continue;
        }
        const s = refScalar(v);
        if (s !== undefined) out[key] = s;
    }
    return out;
}

/**
 * The ids and non-PII summary of an event's payload (the shapes
 * lib/businessEvents.js emits: { booking }, { payment }, { review },
 * { app, installId, table, record, source }, an intake request).
 */
function refFor(event, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const c = {};
    const b = p.booking && typeof p.booking === 'object' ? p.booking : null;
    if (b) {
        Object.assign(c, {
            booking_id: b.booking_id ?? b.id, date: b.date, end_date: b.end_date, start_time: b.start_time, end_time: b.end_time,
            party: b.party, status: b.status, source: b.source,
        });
        if (Array.isArray(p.changed)) c.changed = p.changed;
        if (p.ended_at) c.ended_at = p.ended_at;
    }
    const pay = p.payment && typeof p.payment === 'object' ? p.payment : null;
    if (pay) Object.assign(c, { payment_id: pay.id ?? pay.payment_id, amount_cents: pay.amount_cents ?? pay.amount, currency: pay.currency, source: pay.source, status: pay.status, booking_id: pay.booking_id });
    const r = p.review && typeof p.review === 'object' ? p.review : null;
    if (r) Object.assign(c, { review_id: r.review_id ?? r.id, rating: r.rating, booking_id: r.booking_id });
    if (typeof p.app === 'string') {
        Object.assign(c, { app: p.app, install_id: p.installId ?? p.install_id, table: p.table, source: p.source, record_id: p.record && typeof p.record === 'object' ? p.record.id : undefined });
    }
    if (event === 'intake.created') c.request_id = p.request_id ?? p.id;
    return pickRef(c);
}

/* ── the outbox ───────────────────────────────────────────────────────── */

function backoffMs(attempts) {
    const first = envInt('EVENT_OUTBOX_BACKOFF_SECONDS', 60) * 1000;
    const cap = envInt('EVENT_OUTBOX_MAX_BACKOFF_SECONDS', 3600) * 1000;
    return Math.min(first * 2 ** Math.max(0, attempts - 1), cap);
}

/** The body Paperclip receives for one row. */
const bodyFor = (row) => ({ companyId: row.company_id, event: row.event, eventId: row.id, occurredAt: row.occurred_at, ref: row.ref || {} });

/**
 * Try to send one row; record the outcome on it. Resolves { sent } or
 * { sent: false, error, status: 'pending' | 'dead' }. Never throws.
 */
async function send(row, { now = clock() } = {}) {
    const attempts = (row.attempts || 0) + 1;
    try {
        await post(EVENTS_PATH, bodyFor(row));
        const patch = { status: 'sent', attempts, sent_at: now.toISOString(), last_error: null };
        await supabase.from(TABLE).update(patch).eq('id', row.id);
        Object.assign(row, patch);
        return { sent: true };
    } catch (e) {
        const message = String(e?.message || e).slice(0, 500);
        const dead = attempts >= envInt('EVENT_OUTBOX_MAX_ATTEMPTS', 20);
        const patch = {
            status: dead ? 'dead' : 'pending',
            attempts,
            last_error: message,
            next_attempt_at: new Date(now.getTime() + backoffMs(attempts)).toISOString(),
        };
        await supabase.from(TABLE).update(patch).eq('id', row.id).then(() => {}, () => {});
        Object.assign(row, patch);
        return { sent: false, error: message, status: patch.status };
    }
}

/**
 * Record one emitted event for its company and try to send it. Called by
 * lib/businessEvents.js after the local fan-out. Never throws. Resolves
 * { skipped } when off or the business has no company, else
 * { recorded: true, sent }.
 */
async function enqueue({ event, slug, payload, eventId = crypto.randomUUID(), occurredAt = clock().toISOString() }) {
    if (!enabled()) return { skipped: 'off' };
    if (!event || !slug) return { skipped: 'no_event' };
    try {
        const companyId = await companyForSlug(slug);
        if (!companyId) return { skipped: 'no_company' };
        const row = {
            id: eventId,
            entity_slug: slug,
            company_id: String(companyId),
            event,
            occurred_at: occurredAt,
            ref: refFor(event, payload),
            status: 'pending',
            attempts: 0,
            next_attempt_at: occurredAt,
        };
        const { error } = await supabase.from(TABLE).insert(row);
        if (error) {
            if (!missingTable(error)) console.error(`[event-outbox] ${event} for ${slug}:`, error.message);
            return { skipped: missingTable(error) ? 'no_table' : 'insert_failed', error: error.message };
        }
        if (!envBool('EVENT_OUTBOX_INLINE', true)) return { recorded: true, sent: false };
        const out = await send(row);
        return { recorded: true, sent: out.sent };
    } catch (e) {
        console.error(`[event-outbox] ${event} for ${slug}:`, e.message);
        return { skipped: 'error', error: e.message };
    }
}

/**
 * Send every pending row whose next attempt is due, oldest first, up to
 * EVENT_OUTBOX_DRAIN_LIMIT. From lib/scheduler.js and the cron. Never throws.
 */
async function drain({ now = clock(), limit = envInt('EVENT_OUTBOX_DRAIN_LIMIT', 100) } = {}) {
    if (!enabled()) return { enabled: false, due: 0, sent: 0, failed: 0 };
    const { data: rows, error } = await supabase.from(TABLE)
        .select('*')
        .eq('status', 'pending')
        .lte('next_attempt_at', now.toISOString())
        .order('occurred_at', { ascending: true })
        .limit(limit);
    if (error) return { enabled: true, due: 0, sent: 0, failed: 0, error: missingTable(error) ? `${TABLE} is not set up yet (sql/ORDER.md).` : error.message };
    let sent = 0;
    let failed = 0;
    let dead = 0;
    for (const row of rows || []) {
        const out = await send(row, { now });
        if (out.sent) sent += 1;
        else { failed += 1; if (out.status === 'dead') dead += 1; }
    }
    return { enabled: true, due: (rows || []).length, sent, failed, dead };
}

module.exports = {
    TABLE,
    EVENTS_PATH,
    REF_KEYS,
    enabled,
    refFor,
    bodyFor,
    enqueue,
    send,
    drain,
    _setPost: (impl) => { post = impl; },
    _setClock: (fn) => { clock = fn; },
};
