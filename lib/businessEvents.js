// ============================================================
// BUSINESS EVENTS — what happened to a business, for its automations
// ============================================================
//
// The routes that save bookings, payments and reviews call these after their
// own work is saved; each turns the change into an automation event
// (lib/automationEngine.js emitEvent, CONTRACT §9). Nothing here throws: an
// automation must never fail the thing that fired it.
//
//   bookingSaved(slug, before, after)   booking.created | booking.changed | booking.cancelled
//   paymentReceived(slug, payment)      payment.received
//   reviewReceived(slug, review)        review.received
//   sectionWritten(slug, table, before, after)
//                                       a row written through /api/business
//                                       (routes/business-data.js): the same
//                                       events, by table — bookings and
//                                       booking_calendar → bookingSaved,
//                                       a new entity_reviews row → reviewReceived
//   appRecordCreated(slug, { appKey, manifest, table, record, source, installId })
//                                       the events the installed manifest
//                                       declares (events.emits, already
//                                       <manifest id>.<event>, DECISIONS #55)
//                                       for a new record of that table or
//                                       bound source — exactly as declared
//   completeBookings({ now })           booking.completed — from the scheduled
//                                       check: a booking whose end has passed
//                                       and that was not cancelled is marked
//                                       completed, once, and the event fires.
//   intakeCreated(slug, request)        intake.created — a business submitted
//                                       its links (routes/intake.js)
//
// Every emit also goes to Paperclip, once, as a signed event with ids and a
// non-PII summary only, through the outbox in lib/eventOutbox.js (DECISIONS
// #87; off until EVENTS_TO_PAPERCLIP is set). The local fan-out is unchanged.
//
// `bookings` is the canonical booking record (DECISIONS #53; routes/platform.js
// writes it, lib/dataContracts.js names it booking.records). booking_calendar
// mirrors each booking as a date claim — one claim per booking, beside the
// blocks and the imported claims the email parser, the booking page and the
// owner's own entries write — and that mirror is what these events read,
// since every source lands there whatever wrote the booking.

const crypto = require('crypto');
const supabase = require('../db');
const { envInt, envStr } = require('./env');
const outbox = require('./eventOutbox');

const CANCELLED = new Set(['cancelled', 'canceled', 'declined', 'no-show', 'no_show']);
const isCancelled = (status) => CANCELLED.has(String(status || '').toLowerCase());

/**
 * One occurrence: the local fan-out (lib/automationEngine.js emitEvent, as
 * before) and the outbox row for Paperclip (lib/eventOutbox.js; ids only).
 * Each occurrence has one id and one time, so the two sides name the same
 * event. Never throws.
 */
async function emit(event, slug, payload) {
    const eventId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    let local;
    try {
        const { emitEvent } = require('./automationEngine');
        local = await emitEvent(event, slug, payload);
    } catch (e) {
        console.error(`[events] ${event} for ${slug}:`, e.message);
        local = { ran: 0, error: e.message };
    }
    const sent = await outbox.enqueue({ event, slug, payload, eventId, occurredAt });
    return { ...local, eventId, occurredAt, outbox: sent };
}

/** The parts of a booking an automation reads, whatever wrote it. */
function bookingPayload(row) {
    if (!row) return null;
    const d = row.details && typeof row.details === 'object' ? row.details : {};
    return {
        booking_id: row.id || row.booking_id || null,
        date: row.date || null,
        end_date: row.end_date || null,
        start_time: row.start_time || d.event_time || null,
        end_time: d.end_time || row.end_time || null,
        party: row.party ?? null,
        title: row.title || null,
        source: row.source || null,
        status: row.status || null,
        customer_name: d.customer_name || d.guest_name || d.customer || d.name || null,
        customer_email: d.customer_email || d.guest_email || d.email || null,
        customer_phone: d.customer_phone || d.guest_phone || d.phone || null,
        details: d,
    };
}

const CHANGE_FIELDS = ['date', 'end_date', 'start_time', 'party', 'title'];

/**
 * A booking row was written. `before` is the row as it was (null for a new
 * one); `after` as it is now.
 */
async function bookingSaved(slug, before, after) {
    if (!slug || !after) return null;
    if ((after.kind && after.kind !== 'booking')) return null;
    const payload = bookingPayload(after);
    if (!before) {
        if (isCancelled(after.status)) return null;
        return emit('booking.created', slug, { booking: payload });
    }
    if (isCancelled(after.status) && !isCancelled(before.status)) {
        return emit('booking.cancelled', slug, { booking: payload });
    }
    const changed = CHANGE_FIELDS.filter((f) => String(before[f] ?? '') !== String(after[f] ?? ''));
    if (changed.length && !isCancelled(after.status)) {
        return emit('booking.changed', slug, { booking: payload, changed, before: bookingPayload(before) });
    }
    return null;
}

const paymentReceived = (slug, payment) => (slug ? emit('payment.received', slug, { payment }) : null);
const reviewReceived = (slug, review) => (slug ? emit('review.received', slug, { review }) : null);
/** A business submitted its links through the intake form (routes/intake.js). The payload is the request row, as before. */
const intakeCreated = (slug, request) => (slug ? emit('intake.created', slug, request || {}) : null);

/* ── writes through the business data door ────────────────────────────── */

/**
 * A `bookings` row (the canonical record) in the shape bookingPayload reads:
 * its customer columns folded into details, party_size as party.
 */
function fromBookingsRow(row) {
    if (!row) return null;
    const d = row.details && typeof row.details === 'object' ? row.details : {};
    return {
        ...row,
        party: row.party ?? row.party_size ?? null,
        details: {
            customer_name: row.customer_name ?? d.customer_name ?? null,
            customer_email: row.email ?? d.customer_email ?? null,
            customer_phone: row.phone ?? d.customer_phone ?? null,
            ...d,
        },
    };
}

/**
 * A row was created or changed through /api/business (a table name or its
 * contract, lib/dataContracts.js). Fires what the dashboard's own paths fire
 * for the same table; anything else is silent. `before` is null on create.
 */
async function sectionWritten(slug, table, before, after) {
    if (!slug || !table || !after) return null;
    if (table === 'bookings') return bookingSaved(slug, fromBookingsRow(before), fromBookingsRow(after));
    if (table === 'booking_calendar') return bookingSaved(slug, before, after);
    if (table === 'entity_reviews' && !before) {
        return reviewReceived(slug, {
            reviewer_name: after.reviewer_name ?? null,
            rating: after.rating ?? null,
            text: after.body ?? '',
            verified_purchase: after.verified_purchase === true,
            review_id: after.id ?? null,
            booking_id: after.booking_id ?? null,
        });
    }
    return null;
}

/* ── an installed app's own events (DECISIONS #47) ────────────────────── */

// Segments are [a-z][a-z0-9_-]* (DECISIONS #54: app keys carry dashes).
const DOTTED = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

/**
 * The events a manifest declares (events.emits), as valid dotted names. Each
 * is already `<manifest id>.<event>` (the engine's validator requires it,
 * DECISIONS #55); they are emitted exactly as declared.
 */
function declaredEvents(manifest) {
    const list = manifest?.events?.emits;
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string' && DOTTED.test(e)) : [];
}

/**
 * The declared events a new record of `table` (an app table, or the source
 * key of a read-write binding) fires. After the manifest's id, an event with
 * one segment (`core-enquiry-form.submitted`) fires for every new record of
 * the app; one qualified by a table (`<id>.<table>.<verb>`) only for that
 * table. An event not under the manifest's id is taken as declared, whole.
 */
function eventsForTable(manifest, table) {
    const id = typeof manifest?.id === 'string' ? manifest.id : null;
    return declaredEvents(manifest).filter((e) => {
        const rest = id && e.startsWith(`${id}.`) ? e.slice(id.length + 1) : e.split('.').slice(1).join('.');
        return !rest.includes('.') || rest.startsWith(`${table}.`);
    });
}

/**
 * A record was added through an installed app (routes/app-data.js: its own
 * table, or a bound business source; owner or visitor). Emits each declared
 * event for that table, exactly as declared, with the record as the payload.
 * No declaration, no event.
 */
async function appRecordCreated(slug, { appKey, manifest, table, record, source = null, installId = null } = {}) {
    if (!slug || !appKey || !table) return [];
    const out = [];
    for (const event of eventsForTable(manifest, table)) {
        out.push(await emit(event, slug, { app: appKey, installId, table, record: record || {}, source }));
    }
    return out;
}

/* ── booking.completed ────────────────────────────────────────────────── */

/** "14:30", "2:30 PM", "9am" → [hours, minutes], or null. */
function parseClock(value) {
    const m = String(value || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    const ampm = m[3] ? m[3][0] : null;
    if (ampm === 'p' && h < 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return [h, min];
}

/** Minutes a time zone is ahead of UTC at a given instant. */
function zoneOffsetMinutes(timeZone, at) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return Math.round((asUtc - at.getTime()) / 60000);
}

/** A local wall-clock date and time in a zone, as a Date. */
function zonedTime(dateStr, [h, m], timeZone) {
    const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number);
    if (!y || !mo || !d) return null;
    const guess = new Date(Date.UTC(y, mo - 1, d, h, m));
    let zone;
    try { zone = timeZone || envStr('DEFAULT_TIMEZONE', 'UTC'); zoneOffsetMinutes(zone, guess); } catch { zone = 'UTC'; }
    const offset = zoneOffsetMinutes(zone, guess);
    return new Date(guess.getTime() - offset * 60000);
}

/**
 * When a booking is over. Its own end time if it has one, else its start
 * plus BOOKING_DEFAULT_DURATION_MINUTES when that is set, else the end of its
 * last day — so a booking with no times is completed the day after.
 */
function bookingEnd(row, timeZone) {
    const d = row.details && typeof row.details === 'object' ? row.details : {};
    const lastDay = row.end_date || row.date;
    if (!lastDay) return null;
    const end = parseClock(d.end_time || row.end_time);
    if (end) return zonedTime(lastDay, end, timeZone);
    const start = parseClock(row.start_time || d.event_time);
    const duration = envInt('BOOKING_DEFAULT_DURATION_MINUTES', 0);
    if (start && duration && !row.end_date) {
        const t = zonedTime(row.date, start, timeZone);
        return t ? new Date(t.getTime() + duration * 60000) : null;
    }
    const endOfDay = zonedTime(lastDay, [23, 59], timeZone);
    return endOfDay ? new Date(endOfDay.getTime() + 60000) : null;
}

const WATERMARK_KEY = 'booking_complete_watermark';

/**
 * When the completion check was first enabled (scheduler_state,
 * sql/nextgent_scheduler_state.sql). The first run writes its own time and
 * that value then never moves, so only bookings ending after it are ever
 * completed: enabling the check must not sweep a business's history into
 * booking.completed. Resolves { at } or { error }.
 */
async function completionWatermark(now) {
    const read = async () => {
        const { data, error } = await supabase.from('scheduler_state').select('value').eq('key', WATERMARK_KEY).maybeSingle();
        if (error) return { error: error.message };
        const at = data?.value ? new Date(data.value) : null;
        return at && !Number.isNaN(at.getTime()) ? { at } : { at: null };
    };
    const first = await read();
    if (first.error || first.at) return first;
    // First run: insert, never upsert, so two first runs keep the earlier one.
    const { error } = await supabase.from('scheduler_state').insert({ key: WATERMARK_KEY, value: now.toISOString(), updated_at: now.toISOString() });
    if (!error) return { at: now };
    const again = await read();
    return again.at ? again : { error: again.error || error.message };
}

/**
 * Mark every booking whose end has passed — and lies after the check's own
 * watermark — as completed and fire booking.completed for each, once: the
 * status moves active → completed in the same update that claims it, so a
 * second check finds nothing to do.
 */
async function completeBookings({ now = new Date(), limit = envInt('BOOKING_COMPLETE_LIMIT', 200) } = {}) {
    const mark = await completionWatermark(now);
    if (!mark.at) return { checked: 0, completed: 0, error: `Booking completion has no watermark (scheduler_state): ${mark.error}` };
    const since = mark.at;
    const today = now.toISOString().slice(0, 10);
    // Rows that could end after the watermark: their last day is on or after
    // the day before it (a local day can start before the UTC one).
    const sinceDay = new Date(since.getTime() - 24 * 3600e3).toISOString().slice(0, 10);
    const { data: rows, error } = await supabase.from('booking_calendar')
        .select('*')
        .eq('kind', 'booking').eq('status', 'active')
        .lte('date', today)
        .or(`date.gte.${sinceDay},end_date.gte.${sinceDay}`)
        .order('date', { ascending: true })
        .limit(limit);
    if (error) return { checked: 0, completed: 0, error: error.message };

    const zones = new Map();
    async function zoneFor(slug) {
        if (zones.has(slug)) return zones.get(slug);
        const { data } = await supabase.from('entity').select('timezone').eq('slug', slug).maybeSingle();
        const tz = data?.timezone || null;
        zones.set(slug, tz);
        return tz;
    }

    let completed = 0;
    for (const row of rows || []) {
        const end = bookingEnd(row, await zoneFor(row.entity_slug));
        if (!end || end > now || end <= since) continue;
        const { data: claimed } = await supabase.from('booking_calendar')
            .update({ status: 'completed', updated_at: now.toISOString() })
            .eq('id', row.id).eq('status', 'active').select('id');
        if (!claimed?.length) continue;
        completed += 1;
        await emit('booking.completed', row.entity_slug, { booking: bookingPayload({ ...row, status: 'completed' }), ended_at: end.toISOString() });
    }
    return { checked: (rows || []).length, completed };
}

module.exports = {
    emit,
    bookingSaved,
    paymentReceived,
    reviewReceived,
    intakeCreated,
    sectionWritten,
    appRecordCreated,
    declaredEvents,
    eventsForTable,
    completeBookings,
    bookingEnd,
    bookingPayload,
    isCancelled,
};
