#!/usr/bin/env node
// The billing grace period, tested without waiting seven days.
//
// lib/billing.js is pure and takes `now` as an argument, which is the only
// reason this file can exist. No database, no network, no clock.

const assert = require('node:assert/strict');
const b = require('../lib/billing');

let passed = 0;
const failures = [];
const check = (name, fn) => {
    try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-08-01T00:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);

check('under the limit is ok', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: { listings: 3 }, limitsExceededSince: null, now: T0 });
    assert.equal(e.mode, 'ok');
    assert.deepEqual(e.exceeded, []);
    assert.equal(e.persist.limits_exceeded_since, null);
});

check('null max means unlimited', () => {
    const e = b.evaluate({ plan: { key: 'pro' }, limits: { listings: null }, usage: { listings: 9_999_999 }, limitsExceededSince: null, now: T0 });
    assert.equal(e.mode, 'ok');
});

check('a max of 0 is a real limit, not unlimited', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { device_pushes: 0 }, usage: { device_pushes: 1 }, limitsExceededSince: null, now: T0 });
    assert.equal(e.exceeded.length, 1);
    assert.equal(e.exceeded[0].dimension, 'device_pushes');
});

check('going over starts the clock but does not restrict', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: { listings: 6 }, limitsExceededSince: null, now: T0 });
    assert.equal(e.mode, 'warning', 'the first observation must never restrict');
    assert.equal(e.persist.limits_exceeded_since.getTime(), T0.getTime());
});

check('still warning inside the grace period', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: { listings: 6 }, limitsExceededSince: T0, now: at(6.9) });
    assert.equal(e.mode, 'warning');
    assert.equal(e.gracePeriodEndsAt.getTime(), T0.getTime() + 7 * DAY);
});

check('restricted once the grace period ends', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: { listings: 6 }, limitsExceededSince: T0, now: at(7.1) });
    assert.equal(e.mode, 'restricted');
});

check('coming back under stops the clock', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: { listings: 4 }, limitsExceededSince: T0, now: at(30) });
    assert.equal(e.mode, 'ok');
    assert.equal(e.persist.limits_exceeded_since, null, 'the stored clock must be cleared');
});

check('a dimension the plan never heard of is allowed', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: {}, limitsExceededSince: null, now: T0 });
    assert.equal(b.allows(e, 'a_feature_shipped_next_year'), true);
});

check('allows() refuses the request that would cross the line', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5 }, usage: { listings: 5 }, limitsExceededSince: null, now: T0 });
    assert.equal(b.allows(e, 'listings', 1), false);
    assert.equal(b.allows(e, 'listings', 0), true);
});

check('nothing is allowed once restricted', () => {
    const e = b.evaluate({ plan: { key: 'free' }, limits: { listings: 5, photos: 100 }, usage: { listings: 6, photos: 1 }, limitsExceededSince: T0, now: at(8) });
    assert.equal(e.mode, 'restricted');
    assert.equal(b.allows(e, 'photos', 1), false, 'restriction is account-wide, not per dimension');
});

check('an unparseable timestamp fails open', () => {
    const s = b.restrictionState('not a date', T0);
    assert.equal(s.mode, 'ok', 'a bad row must never restrict a paying business');
});

check('dimensions are not hardcoded anywhere', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/billing.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const bad of ['storage', 'traffic', 'listings', 'photos', 'fileUpload']) {
        assert.ok(!new RegExp(`['"]${bad}['"]`).test(code), `lib/billing.js names the dimension "${bad}"`);
    }
});

if (failures.length) {
    console.error(`\n${failures.length} failed:\n`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
}
console.log(`${passed} checks passed - grace period, limits and restriction, no database`);
