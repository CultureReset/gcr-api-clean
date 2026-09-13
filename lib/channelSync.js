// ============================================================
// CHANNEL SYNC — iCal in and iCal out.
// ============================================================
//
// A property that takes bookings here is almost never taking them ONLY
// here. It is on Airbnb, on Vrbo, maybe on Booking.com, and the thing
// that ruins an owner's week is the same night sold twice.
//
// iCal is how those platforms agree to talk. Airbnb, Vrbo and
// Booking.com all publish a per-listing .ics feed and all accept one in
// return, with no contract, no certification and no partner programme.
// It is polled rather than pushed — so it is minutes-late, not instant —
// but it works today, for free, for everybody.
//
//   import: their feed  → booking_calendar   (a night sold there closes here)
//   export: our calendar → an .ics URL        (a night sold here closes there)
//
// ── The parsing is not ours ─────────────────────────────────────────────
//
// RFC 5545 is a swamp: floating times, TZID parameters, DTEND exclusive
// on all-day events but inclusive in some writers' heads, RRULE, escaped
// commas, folded lines at 75 octets. `node-ical` (Apache-2.0) has been
// fighting that for a decade and we have not. Same for `ical-generator`
// (MIT) on the way out.
//
// ── Nothing here is lodging-only ────────────────────────────────────────
//
// A charter boat with a listing on a marketplace uses the identical path.
// The only thing that differs is whether the claim lands on nights or on
// a day, and that comes from the product, not from this file.
// ============================================================

'use strict';

const crypto = require('crypto');
const ical = require('node-ical');
const icalGenerator = require('ical-generator').default || require('ical-generator');

const supabase = require('../db');
const core = require('./bookingCore');

/** How long we will wait on someone else's feed before giving up. */
const FETCH_TIMEOUT_MS = parseInt(process.env.CHANNEL_FETCH_TIMEOUT_MS || '20000', 10);
/** A feed far larger than any real listing is a mistake or an attack. */
const MAX_FEED_BYTES = 5 * 1024 * 1024;

/* ── import ─────────────────────────────────────────────────────────── */

/**
 * Fetch one feed, with the guards a URL from a text box needs.
 *
 * The owner types this URL, so it is not hostile in the usual sense — but
 * it is still an arbitrary address this server will connect to, so it is
 * capped in time and size and refused if it is not http(s).
 */
async function fetchFeed(url) {
    const address = String(url || '').trim();
    let parsed;
    try {
        parsed = new URL(address);
    } catch {
        throw new Error('That does not look like a calendar link.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('A calendar link has to start with https://');
    }

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(parsed.toString(), {
            signal: controller.signal,
            redirect: 'follow',
            headers: { Accept: 'text/calendar, text/plain, */*' },
        });
        if (!response.ok) {
            throw new Error('That calendar link answered ' + response.status + '. Check it is the "export" link, not the page.');
        }
        const text = await response.text();
        if (text.length > MAX_FEED_BYTES) throw new Error('That calendar is implausibly large.');
        if (!/BEGIN:VCALENDAR/i.test(text)) {
            throw new Error('That link did not return a calendar. On Airbnb it is Availability → Sync calendars → Export.');
        }
        return text;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('That calendar link timed out.');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * An .ics body → the claims it describes.
 *
 * DTEND on an all-day event is EXCLUSIVE by the spec, and that is exactly
 * what every lodging platform means by it: a stay of the 4th to the 8th
 * occupies four nights and frees the 8th for the next arrival. We store
 * end_date as that same checkout date and let bookingCore's endExclusive
 * do the reading, so no translation happens here and none can go wrong.
 */
function parseFeed(text) {
    const parsed = ical.sync.parseICS(text);
    const claims = [];

    for (const key of Object.keys(parsed)) {
        const event = parsed[key];
        if (!event || event.type !== 'VEVENT') continue;
        // A cancelled event releases its dates rather than claiming them.
        if (String(event.status || '').toUpperCase() === 'CANCELLED') continue;

        const start = core.toDate(isoOf(event.start));
        if (!start) continue;
        const end = core.toDate(isoOf(event.end)) || core.addDays(start, 1);

        const summary = String(event.summary || '').trim();
        claims.push({
            external_uid: String(event.uid || (start + '-' + end)).slice(0, 200),
            date: start,
            end_date: end,
            title: summary.slice(0, 200) || 'Reserved',
            // Airbnb writes "Airbnb (Not available)" for an owner block and
            // "Reserved" for a real booking. Both close the night, so both
            // are claims; the wording is kept for the owner to read.
            blocked: /not available|blocked|unavailable/i.test(summary),
            description: String(event.description || '').slice(0, 1000) || null,
        });
    }
    return claims;
}

function isoOf(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

/**
 * Pull a channel's feed into booking_calendar.
 *
 * Upserts on (source, external_uid), so re-running is free and a
 * reservation that moved dates moves here instead of duplicating. Rows
 * that vanish from the feed are cancelled rather than deleted — an owner
 * looking at last month wants to see that a booking existed.
 */
async function importChannel(channel) {
    const started = new Date().toISOString();
    const source = 'ical:' + String(channel.name || 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

    let claims;
    try {
        claims = parseFeed(await fetchFeed(channel.url));
    } catch (err) {
        await supabase.from('booking_channels').update({
            last_synced_at: started,
            last_status: 'error',
            last_error: String(err.message).slice(0, 500),
            updated_at: started,
        }).eq('id', channel.id);
        return { ok: false, error: err.message, imported: 0 };
    }

    const seen = [];
    let imported = 0;

    for (const claim of claims.slice(0, 2000)) {
        const row = {
            entity_slug: channel.entity_slug,
            date: claim.date,
            end_date: claim.end_date,
            kind: claim.blocked ? 'block' : 'booking',
            source: source,
            status: 'active',
            title: claim.title,
            external_uid: claim.external_uid,
            product_id: channel.product_id || null,
            resource_id: channel.resource_id || null,
            details: { channel: channel.name, description: claim.description },
            updated_at: started,
        };

        const { data: existing } = await supabase.from('booking_calendar')
            .select('id')
            .eq('entity_slug', channel.entity_slug)
            .eq('source', source)
            .eq('external_uid', claim.external_uid)
            .maybeSingle();

        if (existing) await supabase.from('booking_calendar').update(row).eq('id', existing.id);
        else await supabase.from('booking_calendar').insert(row);

        seen.push(claim.external_uid);
        imported += 1;
    }

    // Gone from the feed means cancelled on their side.
    const { data: stale } = await supabase.from('booking_calendar')
        .select('id, external_uid')
        .eq('entity_slug', channel.entity_slug)
        .eq('source', source)
        .eq('status', 'active')
        .limit(2000);
    const dropped = (stale || []).filter(function (row) {
        return seen.indexOf(row.external_uid) === -1;
    });
    if (dropped.length) {
        await supabase.from('booking_calendar')
            .update({ status: 'cancelled', updated_at: started })
            .in('id', dropped.map(function (r) { return r.id; }));
    }

    await supabase.from('booking_channels').update({
        last_synced_at: started,
        last_status: 'ok',
        last_error: null,
        events_imported: imported,
        updated_at: started,
    }).eq('id', channel.id);

    return { ok: true, imported: imported, cancelled: dropped.length };
}

/* ── export ─────────────────────────────────────────────────────────── */

/**
 * The token in an export URL.
 *
 * Not a password — it is an unguessable path, which is exactly what every
 * platform does with these (an Airbnb export URL is a long random string
 * too). It reveals only that dates are taken, never who took them.
 */
function exportToken(channelId) {
    const secret = process.env.JWT_SECRET || process.env.SUPABASE_KEY || 'cc-channel';
    return crypto.createHmac('sha256', secret).update('channel:' + String(channelId)).digest('hex').slice(0, 32);
}

/**
 * Our calendar as an .ics body.
 *
 * Deliberately says nothing about the guest. A channel needs to know the
 * dates are gone, and an export URL is a long-lived unauthenticated link —
 * so it carries no name, no email, no phone and no amount.
 */
async function exportCalendar(channel) {
    const from = new Date().toISOString().slice(0, 10);
    const to = core.addDays(from, 540);

    let query = supabase.from('booking_calendar')
        .select('id, date, end_date, kind, status, source, product_id, resource_id')
        .eq('entity_slug', channel.entity_slug)
        .eq('status', 'active')
        .gte('date', core.addDays(from, -30))
        .lte('date', to)
        .limit(3000);
    if (channel.product_id) query = query.eq('product_id', channel.product_id);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const calendar = icalGenerator({
        name: channel.name || 'Bookings',
        prodId: { company: 'gcr-api-clean', product: 'booking-platform', language: 'EN' },
        timezone: 'UTC',
    });

    for (const row of data || []) {
        // Never echo a channel's own claims back at it: Airbnb reading its
        // own reservations back from us is a feedback loop that can only
        // cause confusion.
        if (channel.echo !== true && String(row.source || '').startsWith('ical:')) continue;

        const start = core.toDate(row.date);
        if (!start) continue;
        // DTEND exclusive, matching how every platform reads an all-day
        // event — and matching how we read theirs on the way in.
        const end = core.toDate(row.end_date) || core.addDays(start, 1);

        calendar.createEvent({
            id: String(row.id),
            start: new Date(start + 'T00:00:00Z'),
            end: new Date((end > start ? end : core.addDays(start, 1)) + 'T00:00:00Z'),
            allDay: true,
            summary: row.kind === 'block' ? 'Blocked' : 'Reserved',
            description: 'Unavailable',
        });
    }

    return calendar.toString();
}

/* ── the whole set, for a cron ──────────────────────────────────────── */

/** Refresh every active import feed. Used by the scheduled sync. */
async function syncAll(options) {
    const opts = options || {};
    let query = supabase.from('booking_channels')
        .select('*')
        .eq('active', true)
        .eq('direction', 'import')
        .eq('kind', 'ical')
        .limit(opts.limit || 200);
    if (opts.entitySlug) query = query.eq('entity_slug', opts.entitySlug);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const results = [];
    for (const channel of data || []) {
        if (!channel.url) continue;
        // Sequential on purpose: these are other people's servers, and a
        // burst of parallel requests to Airbnb is how a feed URL gets rate
        // limited for everybody on this deployment.
        const result = await importChannel(channel);
        results.push({ id: channel.id, name: channel.name, ...result });
    }
    return results;
}

module.exports = {
    fetchFeed,
    parseFeed,
    importChannel,
    exportCalendar,
    exportToken,
    syncAll,
};
