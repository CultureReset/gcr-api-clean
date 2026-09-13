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

function result(state) {
    if (state.op === 'insert' || state.op === 'upsert') {
        const payload = Array.isArray(state.payload) ? state.payload : [state.payload];
        const written = payload.map((row, i) => Object.assign({ id: `new-${state.table}-${i}` }, row));
        return { data: state.wantsOne ? written[0] : written, error: null, count: written.length };
    }
    if (state.op === 'update' || state.op === 'delete') {
        const rows = rowsFor(state).map((r) => Object.assign({}, r, state.payload || {}));
        return { data: state.wantsOne ? (rows[0] || null) : rows, error: null, count: rows.length };
    }
    const rows = rowsFor(state);
    return { data: state.wantsOne ? (rows[0] || null) : rows, error: null, count: rows.length };
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
        single() { state.wantsOne = true; return chain; },
        maybeSingle() { state.wantsOne = true; return chain; },
    };

    // Every filter and modifier the handlers use, recorded the same way.
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'or', 'like', 'ilike']) {
        chain[op] = function (column, value) {
            state.filters.push(op === 'or' ? ['or', column, null] : [op, column, value]);
            return chain;
        };
    }
    for (const op of ['order', 'limit', 'range']) {
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
