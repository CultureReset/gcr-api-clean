#!/usr/bin/env node
// ============================================================
// Guards: owner data behind ownership, cron behind its secret, one Stripe
// event once, a block cancel that is scoped and heard, a hook URL that is ours
// ============================================================
//
//     npm run test:guards
//
// In-memory database, real ownerAuth over stubbed sessions, a stubbed
// automation engine so events can be counted. No credentials, no network.

const path = require('path');
const fs = require('fs');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    JWT_SECRET: 'console-secret',
    API_BASE_URL: 'https://api.example.test',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.CRON_SECRET;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_SECRET_KEY;

const { T, db } = createMemDb({
    tables: {
        entity: [{ slug: 'shop', name: 'The Shop' }, { slug: 'other', name: 'Other' }],
        entity_owners: [{ user_id: 'sb-owner', entity_slug: 'shop', role: 'owner' }],
        platform_admins: [],
        company_links: [],
        users: [],
        bookable_resources: [
            { id: 'r-1', slug: 'unit-1', entity_slug: 'shop', is_active: true, resource_type: 'condo' },
            { id: 'r-2', slug: 'unit-2', entity_slug: 'other', is_active: true, resource_type: 'service' },
        ],
        booking_events: [
            { id: 'be-1', resource_id: 'r-1', guest_name: 'Ana', guest_phone: '+12515550101', booking_status: 'pending', check_in_date: '2026-11-01' },
            { id: 'be-2', resource_id: 'r-2', guest_name: 'Bo', guest_phone: '+12515550102', booking_status: 'pending', check_in_date: '2026-11-02' },
        ],
        booking_calendar: [
            { id: 'bc-1', entity_slug: 'shop', kind: 'booking', status: 'active', date: '2026-11-01', details: { customer_name: 'Ana' } },
            { id: 'bc-2', entity_slug: 'other', kind: 'booking', status: 'active', date: '2026-11-02', details: {} },
            { id: 'bc-3', entity_slug: 'shop', kind: 'block', status: 'active', date: '2026-11-03', title: 'Closed' },
        ],
        entity_automations: [{ id: 'ea-1', entity_slug: 'shop', automation_id: 'auto-1', version: 1, enabled: true, config: {}, hook_token: 'a'.repeat(48) }],
        automations: [],
        automation_waits: [],
        scheduler_state: [],
        bookings: [{ id: 'bk-1', entity_slug: 'shop', payment_status: 'unpaid', status: 'pending' }],
        entity_reviews: [],
        stripe_webhook_events: [],
        payments_detected: [],
        entity_external_calendars: [],
    },
    unique: { stripe_webhook_events: ['event_id'] },
});
const SB = { 'owner-token': { id: 'sb-owner' }, 'tourist-token': { id: 'sb-tourist', email: 'tourist@example.test' } };
db.auth.getUser = async (token) => (SB[token] ? { data: { user: SB[token] }, error: null } : { data: null, error: new Error('bad') });
inject(path.join(ROOT, 'db.js'), db);
const events = [];
inject(path.join(ROOT, 'lib/automationEngine.js'), {
    emitEvent: async (event, slug, payload) => { events.push({ event, slug, payload }); return { ran: 0 }; },
    tick: async () => ({ ticked: true }),
    newHookToken: () => 'b'.repeat(48),
    catalogue: () => ({ steps: [], events: [] }),
});

// The live schema read (lib/businessTables.js), for the business data routes.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.test/rest/v1/')) {
        const def = (cols) => ({ properties: Object.fromEntries(cols.map((c) => [c, { type: 'string' }])) });
        return { ok: true, status: 200, json: async () => ({ definitions: {
            bookings: def(['id', 'entity_slug', 'customer_name', 'phone', 'email', 'date', 'start_time', 'party_size', 'status', 'source', 'details']),
            booking_calendar: def(['id', 'entity_slug', 'date', 'kind', 'status', 'title', 'details']),
            entity_reviews: def(['id', 'entity_slug', 'reviewer_name', 'rating', 'body', 'verified_purchase', 'approved']),
        } }) };
    }
    return realFetch(url, init);
};

const { check, done } = checker();
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/business/availability', require(path.join(ROOT, 'routes/owner-availability.js')));
app.use('/api/rentals', require(path.join(ROOT, 'routes/rentals.js')));
app.use('/api/services', require(path.join(ROOT, 'routes/services.js')));
const automations = require(path.join(ROOT, 'routes/automations.js'));
app.use('/api/business/automations', automations.ownerRouter);
app.use('/api/automations', automations.publicRouter);
// Mounted last of the /api/business routers: it ends in /:table.
app.use('/api/business', require(path.join(ROOT, 'routes/business-data.js')));
app.use('/api/email-parser', require(path.join(ROOT, 'routes/email-parser.js')));
app.use('/api/stripe', require(path.join(ROOT, 'routes/stripe.js')));
app.use('/api/webhooks', require(path.join(ROOT, 'routes/webhooks.js')));
const server = app.listen(0, run);
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
async function call(method, p, { token, body, headers = {} } = {}) {
    const res = await fetch(url(p), {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function run() {
    try {
        console.log('\n── rentals and services: owner data needs ownership ──');
        for (const base of ['/api/rentals', '/api/services']) {
            let r = await call('GET', `${base}/unit-1/bookings`, { token: 'tourist-token' });
            check(`${base}: a tourist session cannot list a business's bookings`, r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
            r = await call('GET', `${base}/unit-1/bookings/be-1`, { token: 'tourist-token' });
            check(`${base}: nor read one`, r.status === 403, `${r.status}`);
            r = await call('GET', `${base}/unit-1/bookings`, { token: 'owner-token' });
            check(`${base}: the owner lists their own`, r.status === 200 && r.body.length === 1 && r.body[0].id === 'be-1', `${r.status} ${JSON.stringify(r.body)}`);
            r = await call('GET', `${base}/unit-2/bookings`, { token: 'owner-token' });
            check(`${base}: but not another business's`, r.status === 403, `${r.status}`);
            r = await call('PATCH', `${base}/unit-2/bookings/be-2`, { token: 'owner-token', body: { booking_status: 'confirmed' } });
            check(`${base}: and cannot change another business's booking`, r.status === 403 && T.booking_events.find((b) => b.id === 'be-2').booking_status === 'pending', `${r.status}`);
            r = await call('PATCH', `${base}/unit-1/bookings/be-1`, { token: 'owner-token', body: { booking_status: 'confirmed' } });
            check(`${base}: the owner changes their own`, r.status === 200 && T.booking_events.find((b) => b.id === 'be-1').booking_status === 'confirmed', `${r.status} ${JSON.stringify(r.body)}`);
            T.booking_events.find((b) => b.id === 'be-1').booking_status = 'pending';
            r = await call('GET', `${base}/unit-1/bookings`);
            check(`${base}: no token is refused`, r.status === 401);
        }

        console.log('\n── DELETE /api/business/availability/block/:id ──');
        let r = await call('DELETE', '/api/business/availability/block/bc-2', { token: 'owner-token' });
        check('another business\'s row cannot be cancelled', r.status >= 400 && T.booking_calendar.find((b) => b.id === 'bc-2').status === 'active', `${r.status}`);
        events.length = 0;
        r = await call('DELETE', '/api/business/availability/block/bc-1', { token: 'owner-token' });
        check('the owner cancels their own booking row', r.status === 200 && T.booking_calendar.find((b) => b.id === 'bc-1').status === 'cancelled', `${r.status}`);
        check('and booking.cancelled fires, as the normal cancel path fires it', events.length === 1 && events[0].event === 'booking.cancelled' && events[0].slug === 'shop'
            && events[0].payload.booking.booking_id === 'bc-1' && events[0].payload.booking.customer_name === 'Ana', JSON.stringify(events));
        events.length = 0;
        r = await call('DELETE', '/api/business/availability/block/bc-3', { token: 'owner-token' });
        check('a block is cancelled with no booking event', r.status === 200 && T.booking_calendar.find((b) => b.id === 'bc-3').status === 'cancelled' && !events.length);

        console.log('\n── writes through /api/business emit what the dashboard emits (DECISIONS #47) ──');
        events.length = 0;
        r = await call('POST', '/api/business/booking.records', { token: 'owner-token', body: { customer_name: 'Cy', phone: '+12515550199', date: '2026-12-01', status: 'pending' } });
        check('a booking written through its contract fires booking.created', r.status === 201 && events.length === 1 && events[0].event === 'booking.created' && events[0].slug === 'shop', `${r.status} ${JSON.stringify(events)}`);
        check('with the booking as every other path shapes it', events[0]?.payload.booking.customer_name === 'Cy' && events[0].payload.booking.customer_phone === '+12515550199' && events[0].payload.booking.booking_id === r.body.row.id && events[0].payload.booking.date === '2026-12-01', JSON.stringify(events[0]?.payload));
        events.length = 0;
        r = await call('PATCH', `/api/business/booking.records/${r.body.row.id}`, { token: 'owner-token', body: { status: 'cancelled' } });
        check('cancelling it fires booking.cancelled', r.status === 200 && events.length === 1 && events[0].event === 'booking.cancelled', `${r.status} ${JSON.stringify(events)}`);
        events.length = 0;
        r = await call('POST', '/api/business/bookings', { token: 'owner-token', body: { customer_name: 'Di', date: '2026-12-02' } });
        check('the raw table name is the same door: booking.created', events.length === 1 && events[0].event === 'booking.created' && events[0].payload.booking.customer_name === 'Di', JSON.stringify(events));
        events.length = 0;
        r = await call('POST', '/api/business/reviews.items', { token: 'owner-token', body: { reviewer_name: 'Em', rating: 5, body: 'Great' } });
        check('a review written through its contract fires review.received', r.status === 201 && events.length === 1 && events[0].event === 'review.received' && events[0].payload.review.reviewer_name === 'Em' && events[0].payload.review.rating === 5 && events[0].payload.review.text === 'Great', `${r.status} ${JSON.stringify(events)}`);
        events.length = 0;
        r = await call('PATCH', `/api/business/reviews.items/${r.body.row.id}`, { token: 'owner-token', body: { body: 'Great!' } });
        check('editing a review fires nothing (only a new one is received)', r.status === 200 && events.length === 0, JSON.stringify(events));
        r = await call('POST', '/api/business/availability.claims', { token: 'owner-token', body: { date: '2026-12-03', kind: 'block', title: 'Closed' } });
        check('a block on the calendar is not a booking event', r.status === 201 && events.length === 0, JSON.stringify(events));

        console.log('\n── cron endpoints ──');
        delete process.env.CRON_SECRET;
        r = await call('GET', '/api/automations/cron/tick');
        check('without CRON_SECRET a cron endpoint refuses', r.status === 503, `${r.status} ${JSON.stringify(r.body)}`);
        process.env.CRON_SECRET = 's3cret';
        r = await call('GET', '/api/automations/cron/tick');
        check('with no secret presented it refuses', r.status === 401, `${r.status}`);
        r = await call('GET', '/api/automations/cron/tick?secret=s3cret');
        check('the secret in the URL is not accepted', r.status === 401, `${r.status}`);
        r = await call('GET', '/api/automations/cron/tick', { headers: { authorization: 'Bearer wrong' } });
        check('a wrong secret refuses', r.status === 401, `${r.status}`);
        r = await call('GET', '/api/automations/cron/tick', { headers: { authorization: 'Bearer s3cret' } });
        check('Authorization: Bearer <secret> passes', r.status === 200 && r.body.ticked === true, `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('GET', '/api/automations/cron/tick', { headers: { 'x-cron-secret': 's3cret' } });
        check('x-cron-secret passes too', r.status === 200, `${r.status}`);
        r = await call('GET', '/api/email-parser/ical-import/run', { headers: { 'x-cron-secret': 's3cret' } });
        check('every cron route takes the header (ical import)', r.status === 200, `${r.status}`);
        delete process.env.CRON_SECRET;
        r = await call('GET', '/api/email-parser/ical-import/run');
        check('and is closed without the secret', r.status === 503, `${r.status}`);
        const readers = [];
        const walk = (d) => {
            for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
                if (f.isDirectory()) { walk(`${d}/${f.name}`); continue; }
                if (f.name.endsWith('.js') && /process\.env\.CRON_SECRET/.test(fs.readFileSync(path.join(ROOT, d, f.name), 'utf8'))) readers.push(`${d}/${f.name}`);
            }
        };
        walk('routes');
        check('no route reads CRON_SECRET itself; all go through lib/cronAuth.js', !readers.length, readers.join(', '));

        console.log('\n── one Stripe event, processed once ──');
        const event = { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 1000, currency: 'usd', metadata: { booking_id: 'bk-1' } } } };
        r = await call('POST', '/api/stripe/webhook', { body: event });
        check('missing verification config refuses without mutating or claiming', r.status === 503 && T.bookings[0].payment_status === 'unpaid' && T.stripe_webhook_events.length === 0);
        process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const signed = (body) => ({ 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(body), secret: process.env.STRIPE_WEBHOOK_SECRET }) });
        r = await call('POST', '/api/stripe/webhook', { body: event, headers: { 'stripe-signature': 'invalid' } });
        check('invalid signature cannot mutate or claim', r.status === 400 && T.bookings[0].payment_status === 'unpaid' && T.stripe_webhook_events.length === 0);
        r = await call('POST', '/api/stripe/webhook', { body: event, headers: signed(event) });
        check('the first delivery marks the booking paid', r.status === 200 && T.bookings[0].payment_status === 'paid', `${r.status} ${JSON.stringify(r.body)}`);
        T.bookings[0].payment_status = 'unpaid';
        r = await call('POST', '/api/webhooks/stripe', { body: event, headers: signed(event) });
        check('the same event on the other route is not processed again', r.status === 200 && r.body.duplicate === true && T.bookings[0].payment_status === 'unpaid', `${r.status} ${JSON.stringify(r.body)}`);
        check('the event id was recorded once', T.stripe_webhook_events.length === 1 && T.stripe_webhook_events[0].event_id === 'evt_1');
        r = await call('POST', '/api/webhooks/stripe', { body: { ...event, id: 'evt_2' }, headers: signed({ ...event, id: 'evt_2' }) });
        check('a new event id is processed', r.status === 200 && T.bookings[0].payment_status === 'paid');

        console.log('\n── the webhook URL is this API\'s own address ──');
        r = await call('POST', '/api/business/automations/auto-1/hook/rotate', { token: 'owner-token', headers: { 'x-forwarded-host': 'play-user.example', 'x-forwarded-proto': 'https', host: 'play-user.example' } });
        check('hook_url is built from API_BASE_URL, not the proxy\'s host header', r.status === 200 && r.body.hook_url === `https://api.example.test/api/automations/hook/${'b'.repeat(48)}`, `${r.status} ${JSON.stringify(r.body)}`);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('guards');
}
