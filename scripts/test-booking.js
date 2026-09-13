#!/usr/bin/env node
/**
 * The booking engine, checked offline.
 *
 * No credentials, no network, no database. Everything lib/bookingCore.js
 * decides — what a seat costs, whether a seat exists, what a refund is
 * worth, what the platform's cut is — is decided by pure functions, and
 * this is the file that holds them to it.
 *
 * That matters more here than in most places: this code puts a number on a
 * customer's card. A pricing bug is not a broken page, it is a wrong
 * charge, and the way to not ship one is to be able to run the arithmetic
 * a hundred times a second with no setup.
 *
 *   node scripts/test-booking.js
 */

'use strict';

const core = require('../lib/bookingCore');

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

/* ── fixtures ───────────────────────────────────────────────────────── */
// A six-pack fishing charter: the shape the fishing_charter template makes.

const CHARTER = {
    id: '11111111-1111-4111-8111-111111111111',
    entity_slug: 'test-charters',
    template_id: 'fishing_charter',
    schedule_mode: 'fixed_times',
    capacity_mode: 'seats',
    duration_minutes: 240,
    capacity: 6,
    min_party: 1,
    max_party: 6,
    lead_time_minutes: 720,
    booking_window_days: 365,
    deposit_mode: 'percent',
    deposit_value: 25,
    tax_percent: 0,
    currency: 'usd',
    cancellation_policy: { free_until_hours: 48, partial_until_hours: 24, partial_percent: 50 },
};

const CHARTER_RATES = [
    { id: 'r-adult', label: 'Adult', pricing_mode: 'per_person', amount: 150, occupies_capacity: true, capacity_weight: 1, active: true },
    { id: 'r-child', label: 'Child', pricing_mode: 'per_person', amount: 100, age_max: 11, occupies_capacity: true, capacity_weight: 1, active: true },
    { id: 'r-private', label: 'Private charter', pricing_mode: 'per_group', amount: 900, occupies_capacity: true, capacity_weight: 6, active: true },
];

const CHARTER_EXTRAS = [
    { id: 'x-clean', name: 'Fish cleaning', price: 25, pricing_mode: 'per_booking', max_qty: 1, active: true },
    { id: 'x-rod', name: 'Rod rental', price: 15, pricing_mode: 'per_person', max_qty: 6, active: true },
];

const MORNING_AND_AFTERNOON = [{
    kind: 'weekly', days_of_week: [0, 1, 2, 3, 4, 5, 6], times: ['06:00', '13:00'], active: true,
}];

// Far enough out that the 12-hour cutoff never interferes with a test
// about something else.
const SOON = '2030-07-04';
const NOW = new Date('2030-06-01T12:00:00Z');

/* ── time and date ──────────────────────────────────────────────────── */

check('toMinutes reads both clock formats', () => {
    eq(core.toMinutes('06:00'), 360);
    eq(core.toMinutes('6:00 AM'), 360);
    eq(core.toMinutes('1:30 PM'), 810);
    eq(core.toMinutes('13:30:00'), 810);
    eq(core.toMinutes('12:00 AM'), 0);
    eq(core.toMinutes('12:00 PM'), 720);
    eq(core.toMinutes('nonsense'), null);
    eq(core.toMinutes('25:00'), null);
});

check('toClock round-trips and wraps', () => {
    eq(core.toClock(360), '06:00');
    eq(core.toClock(810), '13:30');
    eq(core.toClock(0), '00:00');
});

check('dayOfWeek is UTC-stable', () => {
    eq(core.dayOfWeek('2030-07-04'), 4); // a Thursday
    eq(core.dayOfWeek('2030-07-07'), 0); // Sunday
});

check('nightsBetween counts nights, not days', () => {
    eq(core.nightsBetween('2030-07-04', '2030-07-07'), 3);
    eq(core.nightsBetween('2030-07-04', '2030-07-04'), 1);
    eq(core.nightsBetween('2030-07-04', null), 1);
});

check('datesBetween is inclusive and capped', () => {
    eq(core.datesBetween('2030-07-04', '2030-07-06').length, 3);
    ok(core.datesBetween('2030-01-01', '2035-01-01').length <= 370, 'a bad range must not run away');
});

/* ── money ──────────────────────────────────────────────────────────── */

check('money stays in integer cents', () => {
    eq(core.toCents(0.1) + core.toCents(0.2), 30, 'the classic float bug must not survive');
    eq(core.toCents('150.00'), 15000);
    eq(core.toCents(null), 0);
    eq(core.toDollars(15000), 150);
    eq(core.toDollars(3333), 33.33);
});

/* ── slots ──────────────────────────────────────────────────────────── */

check('fixed_times yields the scheduled departures', () => {
    const slots = core.slotTimesForDate(CHARTER, MORNING_AND_AFTERNOON, SOON);
    eq(slots.map((s) => s.time), ['06:00', '13:00']);
});

check('duration_slots slices a window and stops before closing', () => {
    const jetski = { schedule_mode: 'duration_slots', duration_minutes: 60, capacity: 8 };
    const schedule = [{ kind: 'weekly', window_start: '09:00', window_end: '12:00', slot_interval_minutes: 60, active: true }];
    eq(core.slotTimesForDate(jetski, schedule, SOON).map((s) => s.time), ['09:00', '10:00', '11:00']);

    // A two-hour ride cannot start at 11:00 against a noon close.
    const twoHour = Object.assign({}, jetski, { duration_minutes: 120 });
    eq(core.slotTimesForDate(twoHour, schedule, SOON).map((s) => s.time), ['09:00', '10:00']);
});

check('open_date offers one slot with no time', () => {
    const pass = { schedule_mode: 'open_date', capacity: 200 };
    const slots = core.slotTimesForDate(pass, [], SOON);
    eq(slots.length, 1);
    eq(slots[0].time, null);
});

check('request mode has no calendar at all', () => {
    eq(core.slotTimesForDate({ schedule_mode: 'request' }, MORNING_AND_AFTERNOON, SOON), []);
});

check('weekday rules close the days they exclude', () => {
    const weekdaysOnly = [{ kind: 'weekly', days_of_week: [1, 2, 3, 4, 5], times: ['09:00'], active: true }];
    eq(core.slotTimesForDate(CHARTER, weekdaysOnly, '2030-07-07').length, 0, 'Sunday');
    eq(core.slotTimesForDate(CHARTER, weekdaysOnly, '2030-07-08').length, 1, 'Monday');
});

check('a blackout closes a date outright', () => {
    const schedules = MORNING_AND_AFTERNOON.concat([
        { kind: 'blackout', specific_date: SOON, active: true },
    ]);
    eq(core.slotTimesForDate(CHARTER, schedules, SOON), []);
    eq(core.slotTimesForDate(CHARTER, schedules, '2030-07-05').length, 2, 'the next day is unaffected');
});

check('a blackout range closes every date inside it', () => {
    const schedules = MORNING_AND_AFTERNOON.concat([
        { kind: 'blackout', valid_from: '2030-07-01', valid_to: '2030-07-10', active: true },
    ]);
    ok(core.isBlackedOut(schedules, '2030-07-05'));
    ok(!core.isBlackedOut(schedules, '2030-07-11'));
});

/* ── availability ───────────────────────────────────────────────────── */

check('an empty calendar sells every seat', () => {
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: [], date: SOON, now: NOW,
    });
    ok(day.bookable);
    eq(day.slots.map((s) => s.remaining), [6, 6]);
    eq(day.slots[0].end_time, '10:00', 'a 4-hour trip leaving at 06:00');
});

check('seats already sold come off that departure only', () => {
    const claims = [{ date: SOON, start_time: '06:00', status: 'active', kind: 'booking', party: 4, product_id: CHARTER.id }];
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW,
    });
    eq(day.slots[0].remaining, 2);
    eq(day.slots[1].remaining, 6, 'the afternoon trip is untouched');
});

check('a full departure reports why', () => {
    const claims = [{ date: SOON, start_time: '06:00', status: 'active', kind: 'booking', party: 6, product_id: CHARTER.id }];
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW,
    });
    eq(day.slots[0].available, false);
    eq(day.slots[0].reason, 'full');
    ok(day.bookable, 'the afternoon is still open, so the day is still bookable');
});

check('another product\'s bookings do not eat these seats', () => {
    const claims = [{ date: SOON, start_time: '06:00', status: 'active', kind: 'booking', party: 6, product_id: 'some-other-product' }];
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW,
    });
    eq(day.slots[0].remaining, 6);
});

check('an external claim with no product closes the slot for everything', () => {
    // A FareHarbor sync or an iCal import that does not know our product ids.
    const claims = [{ date: SOON, start_time: '06:00', status: 'active', kind: 'booking', party: 6, source: 'fareharbor' }];
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW,
    });
    eq(day.slots[0].remaining, 0, 'the safe direction to be wrong in');
});

check('a cancelled booking gives its seats back', () => {
    const claims = [{ date: SOON, start_time: '06:00', status: 'cancelled', kind: 'booking', party: 6, product_id: CHARTER.id }];
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW,
    });
    eq(day.slots[0].remaining, 6);
});

check('the lead time closes departures, not the whole day', () => {
    // 08:00 on the day itself, against a 12-hour cutoff: the 13:00 trip is
    // five hours out and closed; so is the 06:00 one, which has sailed.
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: [],
        date: SOON, now: new Date(SOON + 'T08:00:00Z'),
    });
    eq(day.slots.map((s) => s.reason), ['cutoff', 'cutoff']);
    eq(day.bookable, false);
});

check('a zero lead time sells right up to departure', () => {
    const walkUp = Object.assign({}, CHARTER, { lead_time_minutes: 0 });
    const day = core.availabilityForDate({
        product: walkUp, schedules: MORNING_AND_AFTERNOON, claims: [],
        date: SOON, now: new Date(SOON + 'T08:00:00Z'),
    });
    eq(day.slots[0].available, false, '06:00 has already gone');
    eq(day.slots[1].available, true, '13:00 is still sellable');
});

check('yesterday is never bookable', () => {
    const day = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: [], date: '2030-05-01', now: NOW,
    });
    eq(day.bookable, false);
    eq(day.reason, 'past');
});

check('the booking window has an end', () => {
    const shortWindow = Object.assign({}, CHARTER, { booking_window_days: 30 });
    const day = core.availabilityForDate({
        product: shortWindow, schedules: MORNING_AND_AFTERNOON, claims: [], date: '2030-12-01', now: NOW,
    });
    eq(day.reason, 'beyond_window');
});

check('exclusive capacity means one booking takes the slot', () => {
    const boat = Object.assign({}, CHARTER, { capacity_mode: 'exclusive', capacity: 12 });
    const claims = [{ date: SOON, start_time: '06:00', status: 'active', kind: 'booking', party: 1, product_id: CHARTER.id }];
    const day = core.availabilityForDate({
        product: boat, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW,
    });
    eq(day.slots[0].remaining, 0, 'a party of one still takes the whole boat');
});

check('a resource booked elsewhere blocks this product too', () => {
    const claims = [{ date: SOON, start_time: '06:00', status: 'active', kind: 'booking', party: 1, resource_id: 'boat-1' }];
    const free = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW, resourceId: 'boat-2',
    });
    const taken = core.availabilityForDate({
        product: CHARTER, schedules: MORNING_AND_AFTERNOON, claims: claims, date: SOON, now: NOW, resourceId: 'boat-1',
    });
    ok(free.slots[0].available, 'a different boat is unaffected');
    eq(taken.slots[0].reason, 'resource_busy');
});

check('a multi-day claim blocks every date it spans', () => {
    const claims = [{ date: '2030-07-01', end_date: '2030-07-05', status: 'active', kind: 'booking', party: 6, product_id: CHARTER.id }];
    eq(core.usedCapacity(claims, { date: '2030-07-03', productId: CHARTER.id }), 6);
    eq(core.usedCapacity(claims, { date: '2030-07-06', productId: CHARTER.id }), 0);
});

check('a schedule capacity override beats the product default', () => {
    const schedules = [{ kind: 'weekly', times: ['06:00'], capacity_override: 2, active: true }];
    const day = core.availabilityForDate({
        product: CHARTER, schedules: schedules, claims: [], date: SOON, now: NOW,
    });
    eq(day.slots[0].capacity, 2);
});

/* ── pricing ────────────────────────────────────────────────────────── */

function quoteCharter(cart, overrides) {
    return core.quote({
        product: Object.assign({}, CHARTER, overrides || {}),
        rates: CHARTER_RATES,
        extras: CHARTER_EXTRAS,
        cart: Object.assign({ date: SOON }, cart),
    });
}

check('per-person tiers add up', () => {
    const q = quoteCharter({ items: [{ rate_id: 'r-adult', qty: 4 }, { rate_id: 'r-child', qty: 2 }] });
    ok(q.ok, q.error);
    eq(q.subtotal, 800, '4 × 150 + 2 × 100');
    eq(q.total, 800);
    eq(q.party_size, 6);
    eq(q.capacity_used, 6);
});

check('a per-group rate is one line whatever the party', () => {
    const q = quoteCharter({ items: [{ rate_id: 'r-private', qty: 1 }] });
    ok(q.ok, q.error);
    eq(q.total, 900);
    eq(q.capacity_used, 6, 'it weighs six seats even though it is one line');
});

check('per-person extras multiply by the party', () => {
    const q = quoteCharter({
        items: [{ rate_id: 'r-adult', qty: 4 }],
        extras: [{ extra_id: 'x-rod', qty: 1 }, { extra_id: 'x-clean', qty: 1 }],
    });
    ok(q.ok, q.error);
    eq(q.subtotal, 685, '600 + (15 × 4) + 25');
});

check('per-hour rates use the product duration', () => {
    const hourly = { id: 'r-hour', label: 'Per hour', pricing_mode: 'per_hour', amount: 100, active: true };
    const q = core.quote({
        product: Object.assign({}, CHARTER, { duration_minutes: 90 }),
        rates: [hourly], extras: [],
        cart: { date: SOON, items: [{ rate_id: 'r-hour', qty: 2 }] },
    });
    eq(q.total, 300, '2 units × 1.5 hours × $100');
});

check('per-day rates use the length of the stay', () => {
    const daily = { id: 'r-day', label: 'Per day', pricing_mode: 'per_day', amount: 35, active: true };
    const q = core.quote({
        product: Object.assign({}, CHARTER, { schedule_mode: 'date_range', min_party: 1 }),
        rates: [daily], extras: [],
        cart: { date: '2030-07-04', end_date: '2030-07-06', items: [{ rate_id: 'r-day', qty: 2 }] },
    });
    eq(q.days, 3);
    eq(q.total, 210, '2 chairs × 3 days × $35');
});

check('a percentage promo comes off the subtotal', () => {
    const q = core.quote({
        product: CHARTER, rates: CHARTER_RATES, extras: CHARTER_EXTRAS,
        promo: { code: 'SUMMER', type: 'percent', amount: 10 },
        cart: { date: SOON, items: [{ rate_id: 'r-adult', qty: 4 }] },
    });
    eq(q.discount, 60);
    eq(q.total, 540);
});

check('a flat promo never exceeds the subtotal', () => {
    const q = core.quote({
        product: CHARTER, rates: CHARTER_RATES, extras: [],
        promo: { code: 'BIG', type: 'amount', amount: 5000 },
        cart: { date: SOON, items: [{ rate_id: 'r-adult', qty: 1 }] },
    });
    eq(q.discount, 150);
    eq(q.total, 0, 'free, never negative');
});

check('tax lands on the discounted amount', () => {
    const q = core.quote({
        product: Object.assign({}, CHARTER, { tax_percent: 10 }),
        rates: CHARTER_RATES, extras: [],
        promo: { code: 'TEN', type: 'percent', amount: 10 },
        cart: { date: SOON, items: [{ rate_id: 'r-adult', qty: 4 }] },
    });
    eq(q.discount, 60);
    eq(q.tax, 54, '10% of 540, not of 600');
    eq(q.total, 594);
});

check('a required extra is added even when not asked for', () => {
    const extras = CHARTER_EXTRAS.concat([
        { id: 'x-fuel', name: 'Fuel surcharge', price: 40, pricing_mode: 'per_booking', required: true, max_qty: 1, active: true },
    ]);
    const q = core.quote({
        product: CHARTER, rates: CHARTER_RATES, extras: extras,
        cart: { date: SOON, items: [{ rate_id: 'r-adult', qty: 1 }] },
    });
    eq(q.total, 190, '150 + the 40 they could not opt out of');
});

check('deposit modes each do what they say', () => {
    const cart = { items: [{ rate_id: 'r-adult', qty: 4 }] }; // $600

    eq(quoteCharter(cart, { deposit_mode: 'full' }).deposit_due, 600);
    eq(quoteCharter(cart, { deposit_mode: 'percent', deposit_value: 25 }).deposit_due, 150);
    eq(quoteCharter(cart, { deposit_mode: 'amount', deposit_value: 200 }).deposit_due, 200);
    eq(quoteCharter(cart, { deposit_mode: 'none' }).deposit_due, 0);

    const partial = quoteCharter(cart, { deposit_mode: 'percent', deposit_value: 25 });
    eq(partial.balance_due, 450, 'the rest is owed on the day');

    // A flat deposit larger than the trip must not overcharge.
    eq(quoteCharter({ items: [{ rate_id: 'r-adult', qty: 1 }] }, { deposit_mode: 'amount', deposit_value: 500 }).deposit_due, 150);
});

check('a deposit percentage rounds to whole cents', () => {
    const odd = { id: 'r-odd', label: 'Odd', pricing_mode: 'per_person', amount: 33.33, active: true };
    const q = core.quote({
        product: Object.assign({}, CHARTER, { deposit_mode: 'percent', deposit_value: 33 }),
        rates: [odd], extras: [],
        cart: { date: SOON, items: [{ rate_id: 'r-odd', qty: 3 }] },
    });
    eq(q.total, 99.99);
    eq(q.deposit_due_cents, 3300, '33% of 9999 cents, rounded, not a fraction of a cent');
});

check('party limits are enforced', () => {
    const tooMany = quoteCharter({ items: [{ rate_id: 'r-adult', qty: 9 }] });
    eq(tooMany.ok, false);
    ok(/at most 6/.test(tooMany.error), tooMany.error);

    const tooFew = core.quote({
        product: Object.assign({}, CHARTER, { min_party: 4 }),
        rates: CHARTER_RATES, extras: [],
        cart: { date: SOON, items: [{ rate_id: 'r-adult', qty: 2 }] },
    });
    eq(tooFew.ok, false);
    ok(/at least 4/.test(tooFew.error), tooFew.error);
});

check('an unknown rate id is refused, not ignored', () => {
    const q = quoteCharter({ items: [{ rate_id: 'r-does-not-exist', qty: 1 }] });
    eq(q.ok, false, 'a made-up id must never price as zero');
});

check('an empty cart is refused', () => {
    eq(quoteCharter({ items: [] }).ok, false);
    eq(quoteCharter({ items: [{ rate_id: 'r-adult', qty: 0 }] }).ok, false);
});

check('a rate out of season is refused for that date', () => {
    const seasonal = [{ id: 'r-summer', label: 'Summer', pricing_mode: 'per_person', amount: 200, active: true, season_start: '2030-06-01', season_end: '2030-08-31' }];
    const inside = core.quote({ product: CHARTER, rates: seasonal, extras: [], cart: { date: '2030-07-04', items: [{ rate_id: 'r-summer', qty: 1 }] } });
    const outside = core.quote({ product: CHARTER, rates: seasonal, extras: [], cart: { date: '2030-10-04', items: [{ rate_id: 'r-summer', qty: 1 }] } });
    ok(inside.ok, inside.error);
    eq(outside.ok, false);
});

check('a rate limited to certain weekdays holds to them', () => {
    const weekend = [{ id: 'r-we', label: 'Weekend', pricing_mode: 'per_person', amount: 200, active: true, days_of_week: [0, 6] }];
    ok(core.quote({ product: CHARTER, rates: weekend, extras: [], cart: { date: '2030-07-07', items: [{ rate_id: 'r-we', qty: 1 }] } }).ok, 'Sunday');
    eq(core.quote({ product: CHARTER, rates: weekend, extras: [], cart: { date: '2030-07-04', items: [{ rate_id: 'r-we', qty: 1 }] } }).ok, false, 'Thursday');
});

check('a max_qty on a rate is enforced', () => {
    const capped = [{ id: 'r-cap', label: 'Capped', pricing_mode: 'per_person', amount: 10, max_qty: 2, active: true }];
    eq(core.quote({ product: CHARTER, rates: capped, extras: [], cart: { date: SOON, items: [{ rate_id: 'r-cap', qty: 3 }] } }).ok, false);
});

check('a free tier that takes no seat costs nothing and fills nothing', () => {
    const rates = [
        { id: 'r-a', label: 'Adult', pricing_mode: 'per_person', amount: 35, occupies_capacity: true, capacity_weight: 1, active: true },
        { id: 'r-i', label: 'Infant', pricing_mode: 'per_person', amount: 0, occupies_capacity: false, capacity_weight: 0, active: true },
    ];
    const q = core.quote({ product: CHARTER, rates: rates, extras: [], cart: { date: SOON, items: [{ rate_id: 'r-a', qty: 2 }, { rate_id: 'r-i', qty: 1 }] } });
    eq(q.total, 70);
    eq(q.party_size, 3, 'the infant is a person on board');
    eq(q.capacity_used, 2, 'but not a seat sold');
});

check('the line items explain the total', () => {
    const q = quoteCharter({
        items: [{ rate_id: 'r-adult', qty: 2 }],
        extras: [{ extra_id: 'x-clean', qty: 1 }],
    });
    const sum = q.lines.reduce((total, line) => total + line.amount_cents, 0);
    eq(sum, q.total_cents, 'every line adds up to the charge');
});

/* ── refunds ────────────────────────────────────────────────────────── */

check('the cancellation policy decides the refund', () => {
    const paidCents = 15000;
    const trip = { date: '2030-07-04', time: '06:00' };

    const early = core.refundFor({ product: CHARTER, paidCents, ...trip, now: new Date('2030-07-01T06:00:00Z') });
    eq(early.refund_cents, 15000, 'three days out: free');

    const mid = core.refundFor({ product: CHARTER, paidCents, ...trip, now: new Date('2030-07-03T06:00:00Z') });
    eq(mid.refund_cents, 7500, 'one day out: half');

    const late = core.refundFor({ product: CHARTER, paidCents, ...trip, now: new Date('2030-07-04T02:00:00Z') });
    eq(late.refund_cents, 0, 'four hours out: nothing');
});

check('a product with no policy refunds nothing automatically', () => {
    // Deliberate: with no policy configured, no automatic refund is issued
    // and the owner decides. The alternative — refunding by default — gives
    // away a business's money because they left a field blank.
    const r = core.refundFor({ product: {}, paidCents: 10000, date: '2030-07-04', time: '06:00', now: new Date('2030-07-04T05:00:00Z') });
    eq(r.refund_cents, 0);
    eq(r.reason, 'no_refund_window');
});

/* ── the platform's cut ─────────────────────────────────────────────── */

check('fee rules resolve most-specific-first', () => {
    const rules = [
        { scope: 'global', percent: 3, active: true },
        { scope: 'template', template_id: 'fishing_charter', percent: 2, active: true },
        { scope: 'entity', entity_slug: 'test-charters', percent: 0, active: true },
    ];
    eq(core.applicationFee({ rules, entitySlug: 'test-charters', templateId: 'fishing_charter', amountCents: 10000 }), 0,
        'the business-specific rule wins');
    eq(core.applicationFee({ rules, entitySlug: 'other', templateId: 'fishing_charter', amountCents: 10000 }), 200,
        'then the template rule');
    eq(core.applicationFee({ rules, entitySlug: 'other', templateId: 'parasailing', amountCents: 10000 }), 300,
        'then the global one');
});

check('with no rules at all the env fallback applies', () => {
    eq(core.applicationFee({ rules: [], entitySlug: 'x', amountCents: 10000, fallbackPercent: 1.5 }), 150);
    eq(core.applicationFee({ rules: [], entitySlug: 'x', amountCents: 10000 }), 0, 'and zero when nothing is set');
});

check('a fee is clamped to its floor, ceiling and the charge', () => {
    eq(core.applicationFee({ rules: [{ scope: 'global', percent: 1, min_cents: 100, active: true }], amountCents: 1000 }), 100);
    eq(core.applicationFee({ rules: [{ scope: 'global', percent: 50, max_cents: 500, active: true }], amountCents: 10000 }), 500);
    eq(core.applicationFee({ rules: [{ scope: 'global', percent: 200, active: true }], amountCents: 1000 }), 1000,
        'Stripe rejects a fee bigger than the charge, and so do we');
});

check('a fixed fee adds on top of the percentage', () => {
    eq(core.applicationFee({ rules: [{ scope: 'global', percent: 2, fixed_cents: 30, active: true }], amountCents: 10000 }), 230);
});

check('an inactive rule is not a rule', () => {
    const rules = [{ scope: 'entity', entity_slug: 'test-charters', percent: 0, active: false }, { scope: 'global', percent: 5, active: true }];
    eq(core.applicationFee({ rules, entitySlug: 'test-charters', amountCents: 10000 }), 500);
});

/* ── templates ──────────────────────────────────────────────────────── */

check('a template becomes a working product', () => {
    const template = {
        id: 'parasailing',
        name: 'Parasailing',
        schedule_mode: 'fixed_times',
        defaults: {
            capacity_mode: 'seats', capacity: 12, duration_minutes: 90, max_party: 12,
            lead_time_minutes: 180, deposit_mode: 'full', requires_waiver: true,
            schedule: { kind: 'weekly', days_of_week: [0, 1, 2, 3, 4, 5, 6], times: ['08:00', '10:00'] },
        },
        rate_template: [{ label: 'Single flyer', pricing_mode: 'per_person', amount: 85, weight_max_lb: 275 }],
        addon_template: [{ name: 'Photo package', price: 40, pricing_mode: 'per_booking' }],
        question_template: [{ key: 'weights', label: 'Flyer weights', type: 'text', required: true }],
    };

    const built = core.productFromTemplate(template, 'test-parasail');
    eq(built.product.entity_slug, 'test-parasail');
    eq(built.product.template_id, 'parasailing');
    eq(built.product.capacity, 12);
    eq(built.product.requires_waiver, true);
    eq(built.rates.length, 1);
    eq(built.rates[0].amount, 85);
    eq(built.extras.length, 1);
    eq(built.schedules.length, 1);
    eq(built.schedules[0].times, ['08:00', '10:00']);
    eq(built.product.questions.length, 1);

    // And the product it produced actually works end to end.
    const rates = built.rates.map((r, i) => Object.assign({ id: 'gen-' + i }, r));
    const q = core.quote({ product: built.product, rates: rates, extras: [], cart: { date: SOON, items: [{ rate_id: 'gen-0', qty: 2 }] } });
    ok(q.ok, q.error);
    eq(q.total, 170);
});

check('an override beats the template default', () => {
    const template = { id: 't', name: 'T', schedule_mode: 'fixed_times', defaults: { capacity: 6 }, rate_template: [], addon_template: [] };
    const built = core.productFromTemplate(template, 'slug', { name: 'My Trip', capacity: 20 });
    eq(built.product.name, 'My Trip');
    eq(built.product.capacity, 20);
});

check('every template the database ships parses into a product', () => {
    // The shapes seeded by sql/booking_platform.sql, in miniature: if any of
    // them cannot be instantiated, the App Store offers a broken button.
    const modes = ['fixed_times', 'duration_slots', 'date_range', 'open_date', 'request'];
    for (const mode of modes) {
        const built = core.productFromTemplate(
            { id: mode, name: mode, schedule_mode: mode, defaults: { capacity: 4 }, rate_template: [{ label: 'A', amount: 10 }], addon_template: [] },
            'slug',
        );
        eq(built.product.schedule_mode, mode);
        ok(built.product.capacity === 4, mode);
    }
});

/* ── report ─────────────────────────────────────────────────────────── */

if (failures.length) {
    console.error('\nBooking engine: ' + failures.length + ' failure' + (failures.length === 1 ? '' : 's') + '\n');
    failures.forEach((f) => console.error('  ✗ ' + f));
    console.error('');
    process.exit(1);
}

console.log('Booking engine: ' + passed + ' checks passed — pricing, availability, refunds, fees, templates.');
