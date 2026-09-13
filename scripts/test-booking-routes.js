#!/usr/bin/env node
/**
 * The booking routes, checked against a fake database.
 *
 * scripts/test-booking.js proves the arithmetic. This proves the things
 * that arithmetic cannot: that a request cannot reach a business it does
 * not own, cannot set its own price, and cannot write a column it was
 * never offered.
 *
 * The trick is a stand-in for ../db that records every query the handlers
 * build. So rather than asserting "the response looked right" — which a
 * handler filtering on the wrong slug would also satisfy — this asserts
 * on the FILTERS THEMSELVES: that the update carried
 * eq('entity_slug', <the session's slug>) and not the attacker's.
 *
 * No credentials, no network, no Supabase.
 *
 *   node scripts/test-booking-routes.js
 */

'use strict';

const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');

/* ── the fake database ──────────────────────────────────────────────── */

const db = {
    queries: [],   // every query built, in order
    tables: {},    // table -> rows the fake should return
    reset() { this.queries = []; this.tables = {}; },
};

/** Rows for a table after the query's eq/in filters are applied. */
function rowsFor(state) {
    let rows = (db.tables[state.table] || []).slice();
    for (const [op, column, value] of state.filters) {
        if (op === 'eq') rows = rows.filter((r) => String(r[column]) === String(value));
        if (op === 'in') rows = rows.filter((r) => value.map(String).includes(String(r[column])));
    }
    return rows;
}

/** `.limit(n)` really truncates — that is the whole point of adding one. */
function capped(rows, state) {
    return state.limit == null ? rows : rows.slice(0, state.limit);
}

function result(state) {
    if (state.op === 'insert' || state.op === 'upsert') {
        const payload = Array.isArray(state.payload) ? state.payload : [state.payload];
        const written = payload.map((row, i) => Object.assign({ id: `new-${state.table}-${i}` }, row));
        return { data: state.wantsOne ? written[0] : written, error: null, count: written.length };
    }
    if (state.op === 'update' || state.op === 'delete') {
        const rows = capped(rowsFor(state).map((r) => Object.assign({}, r, state.payload || {})), state);
        if (state.wantsOne) return Object.assign(singleRow(rows, state), { count: rows.length });
        return { data: rows, error: null, count: rows.length };
    }
    const rows = capped(rowsFor(state), state);
    if (state.wantsOne) return Object.assign(singleRow(rows, state), { count: rows.length });
    return { data: rows, error: null, count: rows.length };
}

/**
 * PostgREST's single-row behaviour, reproduced faithfully.
 *
 * `.single()` errors on none OR many; `.maybeSingle()` tolerates none but
 * still errors on many. That second case is the one worth imitating: a
 * handler that asks for one row where two can legitimately exist looks
 * fine in every test until real data has two, and then fails on exactly
 * the records that matter most. A fake that quietly returned the first row
 * would hide that class of bug rather than catch it.
 */
function singleRow(rows, state) {
    if (rows.length > 1) {
        return {
            data: null,
            error: {
                code: 'PGRST116',
                message: `JSON object requested, multiple (or no) rows returned (${rows.length} in ${state.table})`,
            },
        };
    }
    if (!rows.length && state.strictSingle) {
        return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } };
    }
    return { data: rows[0] || null, error: null };
}

function builder(table) {
    const state = { table, op: 'select', filters: [], payload: null, wantsOne: false };
    db.queries.push(state);

    const chain = {
        select(columns, options) {
            state.select = columns;
            if (options && options.head) state.wantsOne = false;
            return chain;
        },
        insert(payload) { state.op = 'insert'; state.payload = payload; return chain; },
        update(payload) { state.op = 'update'; state.payload = payload; return chain; },
        upsert(payload, options) { state.op = 'upsert'; state.payload = payload; state.onConflict = options; return chain; },
        delete() { state.op = 'delete'; return chain; },
        single() { state.wantsOne = true; state.strictSingle = true; return chain; },
        maybeSingle() { state.wantsOne = true; return chain; },
    };

    // Every filter and modifier the handlers use, recorded the same way.
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'like', 'ilike']) {
        chain[op] = function (column, value) {
            state.filters.push(op === 'or' ? ['or', column, null] : [op, column, value]);
            return chain;
        };
    }
    chain.limit = function (n) { state.limit = n; return chain; };
    for (const op of ['order', 'range']) {
        chain[op] = function () { return chain; };
    }

    // Thenable, so `await supabase.from(…)…` resolves without a .then().
    chain.then = function (resolve) { return Promise.resolve(result(state)).then(resolve); };
    chain.catch = function () { return chain; };

    return chain;
}

const fakeSupabase = {
    from: builder,
    auth: {
        getUser: async (token) => (token === 'good-token'
            ? { data: { user: { id: 'user-1', email: 'owner@example.com' } }, error: null }
            : { data: null, error: { message: 'bad token' } }),
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'x' } }) }) },
};

// Put the fake in the module cache under the exact path ../db resolves to,
// before anything requires it. middleware/ownerAuth.js, routes/booking.js
// and lib/stripeConnect.js all share that one module, so one stub covers
// the lot.
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = new Module(dbPath, null);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeSupabase;

/* ── the app under test ─────────────────────────────────────────────── */

const express = require('express');
const app = express();
app.use('/api/booking/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/booking', require('../routes/booking'));

let server;
let base;

/* ── the harness ────────────────────────────────────────────────────── */

let passed = 0;
const failures = [];

async function check(name, fn) {
    db.reset();
    // A signed-in owner of "my-charters", unless a test says otherwise.
    db.tables.entity_owners = [{ user_id: 'user-1', entity_slug: 'my-charters', role: 'owner' }];
    try {
        await fn();
        passed += 1;
    } catch (err) {
        failures.push(`${name} — ${err.message}`);
    }
}

function eq(actual, expected, note) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${note ? note + ': ' : ''}expected ${b}, got ${a}`);
}
function ok(value, note) {
    if (!value) throw new Error(note || 'expected a truthy value');
}

async function call(method, path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers);
    if (options.token !== null) headers.Authorization = `Bearer ${options.token || 'good-token'}`;
    const res = await fetch(base + path, {
        method,
        headers,
        body: options.body === undefined ? undefined
            : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
    });
    let json = null;
    try { json = await res.json() } catch { /* not every response is JSON */ }
    return { status: res.status, body: json };
}

/** The queries this request built against one table, by operation. */
function queries(table, op) {
    return db.queries.filter((q) => q.table === table && (!op || q.op === op));
}

/** Did this query filter on entity_slug, and to what? */
function slugFilter(query) {
    const hit = (query.filters || []).find(([op, column]) => op === 'eq' && column === 'entity_slug');
    return hit ? hit[2] : null;
}

/* ── the tests ──────────────────────────────────────────────────────── */

async function run() {
    /* ── authentication ── */

    await check('an owner route refuses a request with no token', async () => {
        const res = await call('GET', '/api/booking/products', { token: null });
        eq(res.status, 401);
    });

    await check('an owner route refuses a token the session store rejects', async () => {
        const res = await call('GET', '/api/booking/products', { token: 'forged' });
        eq(res.status, 401);
    });

    await check('an account linked to no business is refused, not defaulted', async () => {
        db.tables.entity_owners = [];
        db.tables.platform_admins = [];
        const res = await call('GET', '/api/booking/products');
        eq(res.status, 403, 'no ownership row must never fall through to some other slug');
    });

    /* ── the slug comes from the session, never the request ── */

    await check('reads are scoped to the session\'s slug', async () => {
        db.tables.booking_products = [
            { id: 'p1', entity_slug: 'my-charters', name: 'Mine' },
            { id: 'p2', entity_slug: 'someone-else', name: 'Theirs' },
        ];
        const res = await call('GET', '/api/booking/products');
        eq(res.status, 200);
        eq(res.body.products.map((p) => p.name), ['Mine']);
        eq(slugFilter(queries('booking_products', 'select')[0]), 'my-charters');
    });

    await check('a slug in the query string cannot redirect a read', async () => {
        db.tables.booking_products = [{ id: 'p2', entity_slug: 'someone-else', name: 'Theirs' }];
        const res = await call('GET', '/api/booking/products?entity_slug=someone-else&business=someone-else');
        eq(res.status, 200);
        eq(res.body.products, [], 'the query string is not where the slug comes from');
        eq(slugFilter(queries('booking_products', 'select')[0]), 'my-charters');
    });

    await check('a slug in the body cannot redirect a write', async () => {
        db.tables.booking_products = [{ id: 'p1', entity_slug: 'my-charters', name: 'Mine' }];
        const res = await call('PATCH', '/api/booking/products/p1', {
            body: { name: 'Renamed', entity_slug: 'someone-else' },
        });
        eq(res.status, 200);
        const update = queries('booking_products', 'update')[0];
        eq(slugFilter(update), 'my-charters', 'the update must still be fenced to the caller');
        eq(update.payload.entity_slug, undefined, 'and must not carry the slug they sent');
    });

    await check('another business\'s product cannot be patched', async () => {
        db.tables.booking_products = [{ id: 'p2', entity_slug: 'someone-else', name: 'Theirs' }];
        const res = await call('PATCH', '/api/booking/products/p2', { body: { name: 'Hijacked' } });
        eq(res.status, 404, 'not found, because as far as this caller is concerned it is not');
    });

    await check('a created product is stamped with the session\'s slug', async () => {
        const res = await call('POST', '/api/booking/products', {
            body: { name: 'New trip', entity_slug: 'someone-else', id: 'chosen-by-me' },
        });
        eq(res.status, 201);
        const insert = queries('booking_products', 'insert')[0];
        eq(insert.payload.entity_slug, 'my-charters');
        eq(insert.payload.id, undefined, 'a caller does not get to choose the primary key');
    });

    await check('unknown columns are dropped rather than written', async () => {
        await call('POST', '/api/booking/products', {
            body: { name: 'Trip', total_amount: 999, is_admin: true, created_at: '1999-01-01' },
        });
        const payload = queries('booking_products', 'insert')[0].payload;
        eq(payload.total_amount, undefined);
        eq(payload.is_admin, undefined);
        eq(payload.created_at, undefined);
        eq(payload.name, 'Trip', 'while the field that IS offered still lands');
    });

    await check('a rate cannot be hung off a product the caller does not own', async () => {
        db.tables.booking_products = [{ id: 'p2', entity_slug: 'someone-else' }];
        const res = await call('POST', '/api/booking/rates', {
            body: { product_id: 'p2', label: 'Cheap', amount: 0 },
        });
        eq(res.status, 404);
        eq(queries('booking_rates', 'insert').length, 0, 'and nothing was written');
    });

    await check('every child collection is fenced the same way', async () => {
        for (const collection of ['rates', 'schedules', 'extras', 'resources']) {
            db.reset();
            db.tables.entity_owners = [{ user_id: 'user-1', entity_slug: 'my-charters' }];
            db.tables[`booking_${collection}`] = [{ id: 'x1', entity_slug: 'someone-else' }];
            const res = await call('DELETE', `/api/booking/${collection}/x1`);
            eq(res.status, 200, collection);
            const del = queries(`booking_${collection}`, 'delete')[0];
            eq(slugFilter(del), 'my-charters', `${collection}: the delete is fenced to the caller`);
        }
    });

    await check('the order book is scoped too', async () => {
        db.tables.bookings = [
            { id: 'b1', entity_slug: 'my-charters', customer_name: 'Mine' },
            { id: 'b2', entity_slug: 'someone-else', customer_name: 'Theirs' },
        ];
        const res = await call('GET', '/api/booking/orders');
        eq(res.body.orders.map((o) => o.customer_name), ['Mine']);
    });

    await check('another business\'s booking cannot be refunded', async () => {
        db.tables.bookings = [{ id: 'b2', entity_slug: 'someone-else', amount_paid: 500 }];
        const res = await call('POST', '/api/booking/orders/b2/refund', { body: { amount: 500 } });
        eq(res.status, 404);
    });

    /* ── the public surface ── */

    await check('the public page needs no token and reads only what is published', async () => {
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters', theme: {} }];
        db.tables.booking_products = [
            { id: 'p1', entity_slug: 'my-charters', name: 'Live one', active: true, currency: 'usd' },
        ];
        const res = await call('GET', '/api/booking/public/my-charters', { token: null });
        eq(res.status, 200);
        eq(res.body.products.length, 1);
        // The allow-list, not "the row minus a few fields".
        const product = res.body.products[0];
        eq(product.entity_slug, undefined, 'internal columns must not leak into a public payload');
        eq(product.settings, undefined);
        eq(product.name, 'Live one');
    });

    await check('a public caller cannot create a product', async () => {
        const res = await call('POST', '/api/booking/products', {
            token: null, body: { name: 'Free trips' },
        });
        eq(res.status, 401);
    });

    await check('a quote for a product that is switched off is refused', async () => {
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        db.tables.booking_products = [
            { id: '11111111-1111-4111-8111-111111111111', entity_slug: 'my-charters', name: 'Retired', active: false },
        ];
        const res = await call('POST', '/api/booking/public/my-charters/quote', {
            token: null,
            body: { product_id: '11111111-1111-4111-8111-111111111111', items: [{ rate_id: 'r1', qty: 1 }] },
        });
        eq(res.status, 404);
    });

    await check('a product id that is not a uuid never reaches a filter string', async () => {
        db.tables.entity = [{ id: 'e1', slug: 'my-charters' }];
        const res = await call('POST', '/api/booking/public/my-charters/quote', {
            token: null,
            body: { product_id: 'p1,product_id.is.null', items: [] },
        });
        eq(res.status, 404);
        eq(queries('booking_products').length, 0, 'rejected before any query was built');
    });

    await check('checkout refuses a booking with no name or a bad email', async () => {
        db.tables.entity = [{ id: 'e1', slug: 'my-charters' }];
        const noName = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null, body: { product_id: 'x', customer_email: 'a@b.co' },
        });
        eq(noName.status, 400);

        const badEmail = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null, body: { product_id: 'x', customer_name: 'A', customer_email: 'not-an-email' },
        });
        eq(badEmail.status, 400);
    });

    await check('a customer cannot name their own price', async () => {
        const productId = '11111111-1111-4111-8111-111111111111';
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        db.tables.booking_products = [{
            id: productId, entity_slug: 'my-charters', name: 'Trip', active: true,
            schedule_mode: 'open_date', capacity_mode: 'seats', capacity: 10,
            min_party: 1, currency: 'usd', deposit_mode: 'none', questions: [],
        }];
        db.tables.booking_rates = [{
            id: '22222222-2222-4222-8222-222222222222', entity_slug: 'my-charters', product_id: productId,
            label: 'Adult', pricing_mode: 'per_person', amount: 150, active: true, occupies_capacity: true,
        }];

        const res = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: productId,
                date: '2030-07-04',
                items: [{ rate_id: '22222222-2222-4222-8222-222222222222', qty: 2 }],
                customer_name: 'A Customer',
                customer_email: 'customer@example.com',
                // Everything below is a customer trying to set their own total.
                total_amount: 1,
                subtotal: 1,
                amount_paid: 999,
                total_price: 1,
                status: 'confirmed',
                payment_status: 'paid',
            },
        });

        eq(res.status, 200, res.body && res.body.error);
        const insert = queries('bookings', 'insert')[0];
        ok(insert, 'a booking was written');
        eq(insert.payload.total_amount, 300, 'the server\'s price, not theirs');
        eq(insert.payload.subtotal, 300);
        eq(insert.payload.amount_paid, 0, 'nobody marks themselves paid');
        eq(insert.payload.payment_status, 'unpaid');
        eq(insert.payload.entity_slug, 'my-charters');
    });

    await check('a booking with nothing to pay is not sent to Stripe', async () => {
        const productId = '11111111-1111-4111-8111-111111111111';
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        db.tables.booking_products = [{
            id: productId, entity_slug: 'my-charters', name: 'Trip', active: true,
            schedule_mode: 'open_date', capacity_mode: 'seats', capacity: 10,
            min_party: 1, currency: 'usd', deposit_mode: 'none', questions: [],
        }];
        db.tables.booking_rates = [{
            id: '22222222-2222-4222-8222-222222222222', entity_slug: 'my-charters', product_id: productId,
            label: 'Adult', pricing_mode: 'per_person', amount: 150, active: true, occupies_capacity: true,
        }];

        const res = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: productId, date: '2030-07-04',
                items: [{ rate_id: '22222222-2222-4222-8222-222222222222', qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
            },
        });
        eq(res.status, 200, res.body && res.body.error);
        eq(res.body.payment_required, false);
        ok(res.body.confirmation_code, 'they still get a reference');
        ok(!res.body.checkout_url, 'and no payment page');
    });

    await check('a refund finds the latest payment when there is more than one', async () => {
        // A deposit and then a balance is two succeeded payments on one
        // booking. Asking for a single row without a limit errors on exactly
        // the bookings most likely to need refunding.
        db.tables.bookings = [{
            id: 'b1', entity_slug: 'my-charters', amount_paid: 500, refunded_amount: 0,
            product_id: null, date: '2030-07-04', start_time: '06:00',
        }];
        db.tables.booking_payments = [
            { id: 'pay1', booking_id: 'b1', kind: 'payment', status: 'succeeded', provider_object_id: 'pi_deposit' },
            { id: 'pay2', booking_id: 'b1', kind: 'payment', status: 'succeeded', provider_object_id: 'pi_balance' },
        ];
        const res = await call('POST', '/api/booking/orders/b1/refund', { body: { amount: 100 } });
        // Stripe is not configured in the harness, so the refund itself
        // cannot succeed — but it must get as far as trying, rather than
        // falling over on the lookup.
        ok(res.status !== 404, 'the booking was found');
        ok(!/no stripe payment is recorded/i.test((res.body && res.body.error) || ''),
            'the payment lookup survived two rows: ' + ((res.body && res.body.error) || res.status));
    });

    await check('a return URL from the browser cannot become an open redirect', async () => {
        const productId = '11111111-1111-4111-8111-111111111111';
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        db.tables.booking_products = [{
            id: productId, entity_slug: 'my-charters', name: 'Trip', active: true,
            schedule_mode: 'open_date', capacity_mode: 'seats', capacity: 10,
            min_party: 1, currency: 'usd', deposit_mode: 'none', questions: [],
        }];
        db.tables.booking_rates = [{
            id: '22222222-2222-4222-8222-222222222222', entity_slug: 'my-charters', product_id: productId,
            label: 'Adult', pricing_mode: 'per_person', amount: 150, active: true, occupies_capacity: true,
        }];

        // deposit_mode 'none' means no Stripe call, so this exercises the
        // sanitiser rather than the checkout session. The unit below covers
        // the values themselves.
        const res = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: productId, date: '2030-07-04',
                items: [{ rate_id: '22222222-2222-4222-8222-222222222222', qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
                success_url: 'javascript:alert(document.cookie)',
            },
        });
        eq(res.status, 200, 'a bad return URL must not fail the booking');

        const { safeReturnUrl } = require('../routes/booking');
        eq(safeReturnUrl('javascript:alert(1)', 'https://safe.example'), 'https://safe.example');
        eq(safeReturnUrl('data:text/html,<script>', 'https://safe.example'), 'https://safe.example');
        eq(safeReturnUrl('', 'https://safe.example'), 'https://safe.example');
        eq(safeReturnUrl('not a url at all', 'https://safe.example'), 'https://safe.example');
        eq(safeReturnUrl('x'.repeat(600), 'https://safe.example'), 'https://safe.example');
        eq(safeReturnUrl('https://their-site.example/thanks', 'https://safe.example'),
            'https://their-site.example/thanks', 'a real page on their own site still works');
    });

    await check('a manage link without the right token is refused', async () => {
        db.tables.bookings = [{ id: 'b1', entity_slug: 'my-charters', confirmation_code: 'BK-1' }];
        const noToken = await call('GET', '/api/booking/public/booking/b1', { token: null });
        eq(noToken.status, 403);
        const wrongToken = await call('GET', '/api/booking/public/booking/b1?t=deadbeef', { token: null });
        eq(wrongToken.status, 403);
    });

    await check('a manage link with the right token opens', async () => {
        const { manageToken } = require('../routes/booking');
        db.tables.bookings = [{
            id: 'b1', entity_slug: 'my-charters', confirmation_code: 'BK-1',
            status: 'confirmed', amount_paid: 100, total_amount: 100,
        }];
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        const res = await call('GET', `/api/booking/public/booking/b1?t=${manageToken('b1')}`, { token: null });
        eq(res.status, 200);
        eq(res.body.booking.confirmation_code, 'BK-1');
    });

    /* ── stays, channels and the admin surface ── */

    const STAY_PRODUCT = '33333333-3333-4333-8333-333333333333';
    const STAY_RATE = '44444444-4444-4444-8444-444444444444';

    function seedRental() {
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        db.tables.booking_products = [{
            id: STAY_PRODUCT, entity_slug: 'my-charters', name: 'Beach House', active: true,
            schedule_mode: 'date_range', capacity_mode: 'exclusive', capacity: 1,
            min_party: 1, min_nights: 2, currency: 'usd', deposit_mode: 'none', questions: [],
        }];
        db.tables.booking_rates = [{
            id: STAY_RATE, entity_slug: 'my-charters', product_id: STAY_PRODUCT,
            label: 'Nightly', pricing_mode: 'per_night', amount: 250, active: true, occupies_capacity: true,
        }];
    }

    await check('checkout refuses a stay that spans an occupied night', async () => {
        seedRental();
        // Someone already has the 6th and 7th.
        db.tables.booking_calendar = [{
            id: 'c1', entity_slug: 'my-charters', date: '2030-07-06', end_date: '2030-07-08',
            status: 'active', kind: 'booking', party: 1, product_id: STAY_PRODUCT,
        }];
        return call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: STAY_PRODUCT, date: '2030-07-04', end_date: '2030-07-09',
                items: [{ rate_id: STAY_RATE, qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
            },
        }).then((res) => {
            eq(res.status, 409, 'a five-night stay over a taken night must be refused');
            ok(/already taken/.test(res.body.error || ''), res.body.error);
            eq(queries('bookings', 'insert').length, 0, 'and nothing was written');
        });
    });

    await check('checkout allows a stay that is clear, and prices every night', async () => {
        seedRental();
        db.tables.booking_calendar = [];
        return call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: STAY_PRODUCT, date: '2030-07-04', end_date: '2030-07-07',
                items: [{ rate_id: STAY_RATE, qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
            },
        }).then((res) => {
            eq(res.status, 200, res.body && res.body.error);
            const insert = queries('bookings', 'insert')[0];
            eq(insert.payload.total_amount, 750, '3 nights × $250');
            eq(insert.payload.end_date, '2030-07-07');
        });
    });

    await check('a stay shorter than the minimum is refused', async () => {
        seedRental();
        db.tables.booking_calendar = [];
        return call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: STAY_PRODUCT, date: '2030-07-04', end_date: '2030-07-05',
                items: [{ rate_id: STAY_RATE, qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
            },
        }).then((res) => {
            eq(res.status, 400);
            ok(/minimum of 2 nights/.test(res.body.error || ''), res.body.error);
        });
    });

    await check('a stay with no departure date is refused', async () => {
        seedRental();
        return call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: STAY_PRODUCT, date: '2030-07-04',
                items: [{ rate_id: STAY_RATE, qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
            },
        }).then((res) => eq(res.status, 400));
    });

    await check('the rate calendar can only be set on your own product', async () => {
        db.tables.booking_products = [{ id: STAY_PRODUCT, entity_slug: 'someone-else' }];
        const res = await call('PUT', `/api/booking/products/${STAY_PRODUCT}/calendar`, {
            body: { from: '2030-08-01', to: '2030-08-31', price: 1 },
        });
        eq(res.status, 404);
        eq(queries('booking_rate_calendar', 'upsert').length, 0);
    });

    await check('a season of nightly prices is set in one call', async () => {
        db.tables.booking_products = [{ id: STAY_PRODUCT, entity_slug: 'my-charters' }];
        const res = await call('PUT', `/api/booking/products/${STAY_PRODUCT}/calendar`, {
            body: { from: '2030-08-01', to: '2030-08-07', price: 320, min_nights: 3 },
        });
        eq(res.status, 200);
        eq(res.body.dates, 7);
        const rows = queries('booking_rate_calendar', 'upsert')[0].payload;
        eq(rows.length, 7);
        eq(rows[0].entity_slug, 'my-charters');
        eq(rows[0].price, 320);
        eq(rows[0].date, '2030-08-01');
    });

    await check('a weekend rate hits only the weekends in the span', async () => {
        db.tables.booking_products = [{ id: STAY_PRODUCT, entity_slug: 'my-charters' }];
        const res = await call('PUT', `/api/booking/products/${STAY_PRODUCT}/calendar`, {
            body: { from: '2030-08-01', to: '2030-08-31', price: 400, days_of_week: [5, 6] },
        });
        eq(res.status, 200);
        const rows = queries('booking_rate_calendar', 'upsert')[0].payload;
        ok(rows.length > 0 && rows.length < 31, 'only some dates: got ' + rows.length);
        ok(rows.every((r) => [5, 6].includes(new Date(r.date + 'T00:00:00Z').getUTCDay())),
            'every date written is a Friday or a Saturday');
    });

    await check('a calendar write is capped so one call cannot set a decade', async () => {
        db.tables.booking_products = [{ id: STAY_PRODUCT, entity_slug: 'my-charters' }];
        const res = await call('PUT', `/api/booking/products/${STAY_PRODUCT}/calendar`, {
            body: { from: '2030-01-01', to: '2035-01-01', price: 1 },
        });
        eq(res.status, 400);
    });

    await check('a channel needs a calendar link to import from', async () => {
        const res = await call('POST', '/api/booking/channels', { body: { name: 'Airbnb', direction: 'import' } });
        eq(res.status, 400);
        ok(/calendar link/.test(res.body.error || ''), res.body.error);
    });

    await check('another business\'s channel cannot be synced or deleted', () => {
        db.tables.booking_channels = [{ id: 'ch1', entity_slug: 'someone-else', name: 'Airbnb', direction: 'import' }];
        return call('POST', '/api/booking/channels/ch1/sync').then((res) => {
            eq(res.status, 404);
            return call('DELETE', '/api/booking/channels/ch1');
        }).then((res) => eq(res.status, 404));
    });

    await check('an export feed is refused for an unknown or malformed token', async () => {
        db.tables.booking_channels = [];
        return fetch(base + '/api/booking/ical/notahexstring.ics')
            .then((res) => {
                eq(res.status, 404, 'malformed');
                return fetch(base + '/api/booking/ical/' + 'a'.repeat(32) + '.ics');
            })
            .then((res) => eq(res.status, 404, 'well-formed but unknown'));
    });

    await check('the export feed names no guest', async () => {
        db.tables.booking_channels = [{
            id: 'ch1', entity_slug: 'my-charters', name: 'Airbnb',
            direction: 'export', export_token: 'b'.repeat(32), active: true,
        }];
        db.tables.booking_calendar = [{
            id: 'cal1', entity_slug: 'my-charters', date: '2030-07-04', end_date: '2030-07-08',
            status: 'active', kind: 'booking', source: 'direct', product_id: null,
        }];
        return fetch(base + '/api/booking/ical/' + 'b'.repeat(32) + '.ics')
            .then((res) => {
                eq(res.status, 200);
                ok(/text\/calendar/.test(res.headers.get('content-type')), 'content type');
                return res.text();
            })
            .then((body) => {
                ok(body.includes('BEGIN:VCALENDAR'), 'is a calendar');
                ok(body.includes('Reserved'), 'says the dates are gone');
                ok(!/customer|email|@|phone/i.test(body), 'and nothing about who booked');
            });
    });

    await check('the channel cron refuses without its secret', async () => {
        const res = await fetch(base + '/api/booking/cron/sync-channels');
        ok(res.status === 503 || res.status === 403, 'got ' + res.status);
    });

    await check('template management is admin-only', async () => {
        db.tables.platform_admins = [];
        return call('GET', '/api/booking/admin/templates').then((res) => {
            eq(res.status, 403, 'an ordinary owner is not an admin');
            return call('PUT', '/api/booking/admin/templates/horseback_rides', { body: { name: 'Horseback Rides' } });
        }).then((res) => {
            eq(res.status, 403);
            eq(queries('booking_templates', 'upsert').length, 0);
        });
    });

    await check('an admin can add a vertical, and it is proven before it saves', async () => {
        db.tables.platform_admins = [{ user_id: 'user-1' }];

        const bad = await call('PUT', '/api/booking/admin/templates/horseback_rides', {
            body: { name: 'Horseback Rides', schedule_mode: 'telepathy' },
        });
        eq(bad.status, 400, 'an invented schedule mode is refused');

        const badId = await call('PUT', '/api/booking/admin/templates/Horseback Rides!', {
            body: { name: 'Horseback Rides' },
        });
        eq(badId.status, 400, 'and so is an id that is not an id');

        const good = await call('PUT', '/api/booking/admin/templates/horseback_rides', {
            body: {
                name: 'Horseback Rides', category: 'land', icon: '🐴',
                schedule_mode: 'fixed_times',
                defaults: { capacity: 8, capacity_mode: 'seats', schedule: { kind: 'weekly', times: ['09:00'] } },
                rate_template: [{ label: 'Rider', pricing_mode: 'per_person', amount: 60 }],
            },
        });
        eq(good.status, 200, good.body && good.body.error);
        const written = queries('booking_templates', 'upsert')[0].payload;
        eq(written.id, 'horseback_rides');
        eq(written.name, 'Horseback Rides');
    });

    await check('retiring a vertical deactivates rather than deletes it', async () => {
        db.tables.platform_admins = [{ user_id: 'user-1' }];
        db.tables.booking_templates = [{ id: 'horseback_rides', name: 'Horseback Rides', active: true }];
        return call('DELETE', '/api/booking/admin/templates/horseback_rides').then((res) => {
            eq(res.status, 200);
            eq(queries('booking_templates', 'delete').length, 0, 'products made from it keep their template_id');
            eq(queries('booking_templates', 'update')[0].payload.active, false);
        });
    });

    /* ── the webhook ── */

    await check('an unsigned webhook is rejected', async () => {
        const res = await call('POST', '/api/booking/webhook/stripe', {
            token: null,
            body: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } }),
        });
        eq(res.status, 400, 'no signature, no trust — even with no Stripe key configured');
        eq(queries('bookings', 'update').length, 0, 'and nothing was confirmed');
    });

    await check('a forged signature is rejected', async () => {
        const res = await call('POST', '/api/booking/webhook/stripe', {
            token: null,
            headers: { 'stripe-signature': 't=1,v1=deadbeef' },
            body: JSON.stringify({ id: 'evt_2', type: 'checkout.session.completed', data: { object: {} } }),
        });
        eq(res.status, 400);
    });

    /* ── the widget ── */

    await check('the embed script is served as JavaScript', async () => {
        const res = await fetch(base + '/api/booking/embed.js');
        eq(res.status, 200);
        ok(/javascript/.test(res.headers.get('content-type')), 'content type');
        ok(res.headers.get('access-control-allow-origin') === '*', 'loadable from a business\'s own site');
        const body = await res.text();
        ok(body.includes('booking/public/'), 'and it calls the public routes');
    });

    await check('the hosted page points the widget at this deployment', async () => {
        const res = await fetch(base + '/api/booking/page/my-charters');
        eq(res.status, 200);
        const body = await res.text();
        ok(body.includes('data-slug="my-charters"'), 'carries the slug');
        ok(body.includes('/api/booking/embed.js'), 'loads the widget');
    });

    await check('a slug with markup in it cannot break out of the hosted page', async () => {
        const res = await fetch(base + '/api/booking/page/' + encodeURIComponent('x"><script>alert(1)</script>'));
        const body = await res.text();
        ok(!body.includes('<script>alert(1)'), 'the injected tag is gone');
        ok(body.includes('data-slug="xscriptalert1script"'), 'reduced to safe characters');
    });

    /* ── templates ── */

    await check('the template catalogue is public and needs no session', async () => {
        db.tables.booking_templates = [
            { id: 'fishing_charter', name: 'Fishing Charter', active: true },
            { id: 'retired_thing', name: 'Withdrawn', active: false },
        ];
        const res = await call('GET', '/api/booking/templates', { token: null });
        eq(res.status, 200);
        eq(res.body.templates.map((t) => t.id), ['fishing_charter'], 'and a withdrawn one is not offered');
    });

    await check('a template instantiates into product, rates, extras and hours', async () => {
        db.tables.booking_templates = [{
            id: 'parasailing', name: 'Parasailing', schedule_mode: 'fixed_times',
            defaults: { capacity: 12, capacity_mode: 'seats', schedule: { kind: 'weekly', times: ['08:00'] } },
            rate_template: [{ label: 'Flyer', pricing_mode: 'per_person', amount: 85 }],
            addon_template: [{ name: 'Photos', price: 40, pricing_mode: 'per_booking' }],
            question_template: [{ key: 'weights', label: 'Weights' }],
        }];
        const res = await call('POST', '/api/booking/products', { body: { template_id: 'parasailing' } });
        eq(res.status, 201);

        const product = queries('booking_products', 'insert')[0].payload;
        eq(product.entity_slug, 'my-charters');
        eq(product.template_id, 'parasailing');
        eq(product.capacity, 12);

        // Each child is stamped with both the slug and the new product id.
        for (const table of ['booking_rates', 'booking_extras', 'booking_schedules']) {
            const rows = queries(table, 'insert')[0].payload;
            ok(Array.isArray(rows) && rows.length, `${table} written`);
            eq(rows[0].entity_slug, 'my-charters', table);
            ok(rows[0].product_id, `${table} linked to the product`);
        }
    });

    /* ── the modularity claim, actually tested ── */

    await check('a vertical nobody wrote code for works end to end', async () => {
        // The whole architecture rests on "a vertical is a row, not a
        // branch". This drives an invented trade — one that exists nowhere
        // in this codebase, in any list, in any switch — from an admin
        // creating it, through an owner switching it on, to a customer
        // being quoted and booked. If any layer needed to know what a
        // llama is, this fails.
        db.tables.platform_admins = [{ user_id: 'user-1' }];

        const created = await call('PUT', '/api/booking/admin/templates/llama_trekking', {
            body: {
                name: 'Llama Trekking',
                category: 'wilderness',          // a category that is not in the UI's label map
                icon: '🦙',
                tagline: 'Guided treks, at a llama\'s pace.',
                schedule_mode: 'fixed_times',
                defaults: {
                    capacity_mode: 'seats', capacity: 5, duration_minutes: 180,
                    min_party: 2, max_party: 5, lead_time_minutes: 1440,
                    // A fixed far-future date keeps this test independent of
                    // the clock; the window has to reach it.
                    booking_window_days: 3650,
                    deposit_mode: 'percent', deposit_value: 20, requires_waiver: true,
                    cancellation_policy: { free_until_hours: 72 },
                    schedule: { kind: 'weekly', days_of_week: [5, 6, 0], times: ['08:00', '14:00'] },
                },
                rate_template: [
                    { label: 'Trekker', pricing_mode: 'per_person', amount: 95 },
                    { label: 'Child on a lead llama', pricing_mode: 'per_person', amount: 55, age_max: 12 },
                ],
                addon_template: [{ name: 'Packed lunch', price: 18, pricing_mode: 'per_person' }],
                question_template: [{ key: 'boots', label: 'Boot size', type: 'text', required: true }],
            },
        });
        eq(created.status, 200, created.body && created.body.error);
        const template = queries('booking_templates', 'upsert')[0].payload;

        // The owner switches it on. The API reads the template back from
        // the database, so the fake must now serve what was just written.
        db.reset();
        db.tables.entity_owners = [{ user_id: 'user-1', entity_slug: 'my-charters' }];
        db.tables.booking_templates = [template];

        const installed = await call('POST', '/api/booking/products', { body: { template_id: 'llama_trekking' } });
        eq(installed.status, 201, installed.body && installed.body.error);

        const product = queries('booking_products', 'insert')[0].payload;
        eq(product.capacity, 5, 'its capacity came from the row');
        eq(product.min_party, 2);
        eq(product.requires_waiver, true);
        eq(product.template_id, 'llama_trekking');

        const rateRows = queries('booking_rates', 'insert')[0].payload;
        eq(rateRows.length, 2, 'both price tiers were written');
        const scheduleRows = queries('booking_schedules', 'insert')[0].payload;
        eq(scheduleRows[0].times, ['08:00', '14:00'], 'and its departure times');

        // A customer prices it. Everything below is the ordinary public
        // path — no llama-shaped code anywhere in it.
        const PRODUCT_ID = '55555555-5555-4555-8555-555555555555';
        const ADULT = '66666666-6666-4666-8666-666666666666';
        const CHILD = '77777777-7777-4777-8777-777777777777';

        db.reset();
        db.tables.entity = [{ id: 'e1', slug: 'my-charters', name: 'My Charters' }];
        db.tables.booking_products = [Object.assign({}, product, {
            id: PRODUCT_ID, active: true, currency: 'usd', questions: template.question_template,
        })];
        // The written row first, then the ids it gets in the database —
        // the other way round, the template's own product_id wins and the
        // rates hang off a product that does not exist.
        db.tables.booking_rates = [
            Object.assign({}, rateRows[0], { id: ADULT, product_id: PRODUCT_ID, entity_slug: 'my-charters' }),
            Object.assign({}, rateRows[1], { id: CHILD, product_id: PRODUCT_ID, entity_slug: 'my-charters' }),
        ];
        db.tables.booking_schedules = [
            Object.assign({}, scheduleRows[0], { id: 's1', product_id: PRODUCT_ID, entity_slug: 'my-charters' }),
        ];
        db.tables.booking_extras = [];

        // 2030-08-03 is a Saturday, which this trade runs on.
        const quoted = await call('POST', '/api/booking/public/my-charters/quote', {
            token: null,
            body: {
                product_id: PRODUCT_ID, date: '2030-08-03',
                items: [{ rate_id: ADULT, qty: 2 }, { rate_id: CHILD, qty: 1 }],
            },
        });
        eq(quoted.status, 200, quoted.body && quoted.body.error);
        eq(quoted.body.total, 245, '2 × 95 + 1 × 55');
        eq(quoted.body.deposit_due, 49, '20% of 245');
        eq(quoted.body.party_size, 3);

        // And books it, answering the question the template invented.
        const booked = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: PRODUCT_ID, date: '2030-08-03', time: '08:00',
                items: [{ rate_id: ADULT, qty: 2 }, { rate_id: CHILD, qty: 1 }],
                customer_name: 'A Trekker', customer_email: 'trekker@example.com',
                answers: { boots: 'UK 9' },
            },
        });
        // deposit_mode percent means it wants a card, and Stripe is not
        // configured in the harness — so 503 is the correct refusal and
        // proves the whole path ran. Anything else means it broke earlier.
        eq(booked.status, 503, booked.body && booked.body.error);
        ok(/card payments yet/i.test(booked.body.error || ''), booked.body.error);

        // The same trade, paid on the day, goes all the way through.
        db.tables.booking_products = [Object.assign({}, db.tables.booking_products[0], { deposit_mode: 'none' })];
        const onTheDay = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: PRODUCT_ID, date: '2030-08-03', time: '08:00',
                items: [{ rate_id: ADULT, qty: 2 }, { rate_id: CHILD, qty: 1 }],
                customer_name: 'A Trekker', customer_email: 'trekker@example.com',
                answers: { boots: 'UK 9' },
            },
        });
        eq(onTheDay.status, 200, onTheDay.body && onTheDay.body.error);
        const booking = queries('bookings', 'insert')[0].payload;
        eq(booking.total_amount, 245, 'priced by the server, not the browser');
        eq(booking.party_size, 3);
        eq(booking.answers.boots, 'UK 9', 'the invented question was captured');
        eq(booking.template_id, 'llama_trekking');
    });

    await check('a required question invented by a template is enforced', async () => {
        const PRODUCT_ID = '55555555-5555-4555-8555-555555555555';
        const ADULT = '66666666-6666-4666-8666-666666666666';
        db.tables.entity = [{ id: 'e1', slug: 'my-charters' }];
        db.tables.booking_products = [{
            id: PRODUCT_ID, entity_slug: 'my-charters', name: 'Llama Trekking', active: true,
            schedule_mode: 'open_date', capacity_mode: 'seats', capacity: 5,
            min_party: 1, currency: 'usd', deposit_mode: 'none',
            questions: [{ key: 'boots', label: 'Boot size', type: 'text', required: true }],
        }];
        db.tables.booking_rates = [{
            id: ADULT, entity_slug: 'my-charters', product_id: PRODUCT_ID,
            label: 'Trekker', pricing_mode: 'per_person', amount: 95, active: true, occupies_capacity: true,
        }];

        const res = await call('POST', '/api/booking/public/my-charters/checkout', {
            token: null,
            body: {
                product_id: PRODUCT_ID, date: '2030-08-03',
                items: [{ rate_id: ADULT, qty: 1 }],
                customer_name: 'A', customer_email: 'a@example.com',
            },
        });
        eq(res.status, 400);
        ok(/Boot size is required/.test(res.body.error || ''), res.body.error);
    });

    /* ── report ── */

    if (failures.length) {
        console.error(`\nBooking routes: ${failures.length} failure${failures.length === 1 ? '' : 's'}\n`);
        failures.forEach((f) => console.error('  ✗ ' + f));
        console.error('');
        process.exitCode = 1;
        return;
    }
    console.log(`Booking routes: ${passed} checks passed — auth, slug scoping, price integrity, webhook trust, widget.`);
}

server = http.createServer(app);
server.listen(0, async () => {
    base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run();
    } catch (err) {
        console.error('Harness failed:', err);
        process.exitCode = 1;
    } finally {
        server.close();
    }
});
