#!/usr/bin/env node
/**
 * The iCal channel sync, checked offline.
 *
 * These are real feed bodies in the shapes Airbnb, Vrbo and Booking.com
 * actually publish, run through the same parser the live sync uses. No
 * network: a test that depends on Airbnb being up is a test that fails on
 * a Sunday for no reason.
 *
 * What matters most here is the DTEND reading. An all-day VEVENT's DTEND
 * is EXCLUSIVE by RFC 5545, and every lodging platform means exactly that
 * by it. Getting it wrong by one day either double-books a turnover night
 * or loses one on every single booking — and it is invisible until a
 * guest arrives to find someone in the room.
 *
 *   node scripts/test-channel-sync.js
 */

'use strict';

const path = require('node:path');
const Module = require('node:module');

// channelSync requires ../db at load; it is never used by the pure
// functions under test, so a bare stub is enough.
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = new Module(dbPath, null);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = { from: () => ({}) };

const channels = require('../lib/channelSync');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (err) {
        failures.push(name + ' — ' + err.message);
    }
}
function eq(actual, expected, note) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((note ? note + ': ' : '') + 'expected ' + b + ', got ' + a);
}
function ok(value, note) {
    if (!value) throw new Error(note || 'expected a truthy value');
}

function ics(lines) {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN']
        .concat(lines, ['END:VCALENDAR']).join('\r\n');
}

/* ── the shapes the real platforms send ─────────────────────────────── */

const AIRBNB = ics([
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20300704',
    'DTEND;VALUE=DATE:20300708',
    'UID:1234567890abcdef@airbnb.com',
    'SUMMARY:Reserved',
    'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/ABC123',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20300801',
    'DTEND;VALUE=DATE:20300804',
    'UID:owner-block-1@airbnb.com',
    'SUMMARY:Airbnb (Not available)',
    'END:VEVENT',
]);

const VRBO = ics([
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20300910',
    'DTEND;VALUE=DATE:20300915',
    'UID:VRBO-98765',
    'SUMMARY:Reserved - Jane D.',
    'END:VEVENT',
]);

const BOOKINGCOM = ics([
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20301101',
    'DTEND;VALUE=DATE:20301103',
    'UID:booking-com-5544332211',
    'SUMMARY:CLOSED - Not available',
    'END:VEVENT',
]);

/* ── parsing ────────────────────────────────────────────────────────── */

check('an Airbnb reservation lands on the right nights', () => {
    const claims = channels.parseFeed(AIRBNB);
    const reservation = claims.find((c) => c.external_uid === '1234567890abcdef@airbnb.com');
    ok(reservation, 'found the reservation');
    eq(reservation.date, '2030-07-04', 'arrival');
    eq(reservation.end_date, '2030-07-08', 'checkout date, stored as-is');
    eq(reservation.blocked, false, 'a real booking, not an owner block');
});

check('an owner block is recognised as a block', () => {
    const claims = channels.parseFeed(AIRBNB);
    const block = claims.find((c) => c.external_uid === 'owner-block-1@airbnb.com');
    ok(block, 'found the block');
    eq(block.blocked, true, '"Airbnb (Not available)" is the owner closing dates');
});

check('Vrbo and Booking.com parse the same way', () => {
    const vrbo = channels.parseFeed(VRBO);
    eq(vrbo.length, 1);
    eq(vrbo[0].date, '2030-09-10');
    eq(vrbo[0].end_date, '2030-09-15');

    const bdc = channels.parseFeed(BOOKINGCOM);
    eq(bdc.length, 1);
    eq(bdc[0].date, '2030-11-01');
    eq(bdc[0].blocked, true, '"CLOSED - Not available" closes the dates');
});

check('a cancelled event releases its dates', () => {
    const claims = channels.parseFeed(ics([
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20300704',
        'DTEND;VALUE=DATE:20300708',
        'UID:gone@airbnb.com',
        'STATUS:CANCELLED',
        'SUMMARY:Reserved',
        'END:VEVENT',
    ]));
    eq(claims.length, 0, 'a cancelled reservation must not hold a night');
});

check('a one-night stay is one night, not zero', () => {
    const claims = channels.parseFeed(ics([
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20300704',
        'DTEND;VALUE=DATE:20300705',
        'UID:one-night',
        'SUMMARY:Reserved',
        'END:VEVENT',
    ]));
    eq(claims[0].date, '2030-07-04');
    eq(claims[0].end_date, '2030-07-05');
});

check('an event with no DTEND still claims its night', () => {
    const claims = channels.parseFeed(ics([
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20300704',
        'UID:no-end',
        'SUMMARY:Reserved',
        'END:VEVENT',
    ]));
    eq(claims.length, 1);
    eq(claims[0].date, '2030-07-04');
    eq(claims[0].end_date, '2030-07-05', 'defaults to one night rather than nothing');
});

check('a timed event (not all-day) is still read', () => {
    // Some smaller channels publish timed events rather than all-day ones.
    const claims = channels.parseFeed(ics([
        'BEGIN:VEVENT',
        'DTSTART:20300704T140000Z',
        'DTEND:20300708T110000Z',
        'UID:timed-1',
        'SUMMARY:Reserved',
        'END:VEVENT',
    ]));
    eq(claims.length, 1);
    eq(claims[0].date, '2030-07-04');
    eq(claims[0].end_date, '2030-07-08');
});

check('a folded line and an escaped comma survive', () => {
    // RFC 5545 folds at 75 octets and escapes commas. A hand-rolled
    // parser gets this wrong; this is why the library is here.
    const claims = channels.parseFeed(ics([
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20300704',
        'DTEND;VALUE=DATE:20300706',
        'UID:folded-1',
        'SUMMARY:Reserved for Smith\\, J. — a very long summary line that goes',
        ' well past the seventy-five octet limit and is therefore folded',
        'END:VEVENT',
    ]));
    eq(claims.length, 1);
    ok(claims[0].title.includes('Smith, J.'), 'unescaped: ' + claims[0].title);
});

check('an empty calendar is empty, not an error', () => {
    eq(channels.parseFeed(ics([])), []);
});

check('junk that is not a calendar does not throw', () => {
    // parseFeed is only reached after fetchFeed has checked for
    // BEGIN:VCALENDAR, but it must not explode if it ever is.
    const claims = channels.parseFeed('this is not a calendar at all');
    ok(Array.isArray(claims), 'returns a list');
});

/* ── the nights a claim actually occupies ───────────────────────────── */

const core = require('../lib/bookingCore');

check('an imported stay occupies the right nights and frees the checkout day', () => {
    const claim = channels.parseFeed(AIRBNB)[0];
    const calendarRow = {
        date: claim.date,
        end_date: claim.end_date,
        status: 'active',
        kind: 'booking',
        party: 1,
        product_id: 'p1',
    };
    const occupied = (date) => core.usedCapacity([calendarRow], { date, productId: 'p1', endExclusive: true });

    eq(occupied('2030-07-03'), 0, 'the night before is free');
    eq(occupied('2030-07-04'), 1, 'arrival night is taken');
    eq(occupied('2030-07-07'), 1, 'last night is taken');
    eq(occupied('2030-07-08'), 0, 'they leave that morning — the night is sellable');
});

check('an Airbnb booking blocks a stay that would overlap it', () => {
    const claim = channels.parseFeed(AIRBNB)[0];
    const claims = [{
        date: claim.date, end_date: claim.end_date,
        status: 'active', kind: 'booking', party: 1, product_id: 'p1',
    }];
    const product = {
        id: 'p1', schedule_mode: 'date_range', capacity_mode: 'exclusive',
        capacity: 1, min_nights: 1, booking_window_days: 3650,
    };
    const now = new Date('2030-06-01T00:00:00Z');

    const clash = core.availabilityForStay({ product, claims, from: '2030-07-05', to: '2030-07-07', now });
    eq(clash.ok, false, 'a direct booking cannot take nights Airbnb already sold');

    const after = core.availabilityForStay({ product, claims, from: '2030-07-08', to: '2030-07-10', now });
    ok(after.ok, 'but the turnover day itself is bookable: ' + after.error);
});

/* ── the export token ───────────────────────────────────────────────── */

check('an export token is stable, opaque and unguessable from the id', () => {
    const a = channels.exportToken('11111111-1111-4111-8111-111111111111');
    const b = channels.exportToken('11111111-1111-4111-8111-111111111111');
    const other = channels.exportToken('22222222-2222-4222-8222-222222222222');
    eq(a, b, 'the same channel always gets the same URL');
    ok(a !== other, 'different channels get different URLs');
    ok(/^[0-9a-f]{32}$/.test(a), 'hex, 32 chars: ' + a);
    ok(!a.includes('1111'), 'and it does not leak the id');
});

/* ── report ─────────────────────────────────────────────────────────── */

if (failures.length) {
    console.error('\nChannel sync: ' + failures.length + ' failure' + (failures.length === 1 ? '' : 's') + '\n');
    failures.forEach((f) => console.error('  ✗ ' + f));
    console.error('');
    process.exit(1);
}

console.log('Channel sync: ' + passed + ' checks passed — Airbnb, Vrbo and Booking.com feeds, DTEND, export tokens.');
