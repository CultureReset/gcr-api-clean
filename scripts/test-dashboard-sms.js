#!/usr/bin/env node
// ============================================================
// The dashboard says sms_sent only when a text actually went
// ============================================================
//
//     npm run test:dashboard-sms
//
// Waiver links and review requests are transactional texts: they go without
// a consent row, and a STOP stops them. Whatever happened, the response's
// sms_sent must say what happened. In-memory database, a recording carrier.
// No credentials, no network.

const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    JWT_SECRET: 'console-secret',
    TELNYX_API_KEY: 'KEY_test',
    PLATFORM_NUMBER: '+15550000001',
    PUBLIC_SITE_BASE_URL: 'https://site.example.test',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;

const STOPPED = '+12515550166';
const QUIET = '+12515550177';   // never said yes, never said stop

const { T, db } = createMemDb({ tables: {
    businesses: [{ id: 'site-1', site_id: 'site-1', entity_slug: 'shop', name: 'The Shop', subdomain: 'shop' }],
    bookings: [
        { id: 'b-stopped', site_id: 'site-1', customer_name: 'Ana Stop', customer_phone: STOPPED },
        { id: 'b-quiet', site_id: 'site-1', customer_name: 'Bo Quiet', customer_phone: QUIET },
        { id: 'b-stopped-2', site_id: 'site-1', customer_name: 'Ana Stop', customer_phone: STOPPED },
        { id: 'b-quiet-2', site_id: 'site-1', customer_name: 'Bo Quiet', customer_phone: QUIET },
    ],
    waivers: [], reviews: [],
    message_consent: [],
    sms_opt_outs: [{ phone: STOPPED }],
    sms_log: [],
} });
inject(path.join(ROOT, 'db.js'), db);

const carrier = [];
require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
    carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'msg-1' } }) };
});

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/dashboard', require(path.join(ROOT, 'routes/dashboard.js')));
const server = app.listen(0, run);
const owner = jwt.sign({ userId: 'u-1', siteId: 'site-1', role: 'owner' }, process.env.JWT_SECRET);
async function call(method, p, body) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const textsTo = (phone) => carrier.filter((c) => c.url.endsWith('/messages') && c.body?.to === phone);

async function run() {
    try {
        console.log('\n── waiver links ──');
        const w1 = await call('GET', '/api/dashboard/waivers/link?booking_id=b-stopped');
        check('a waiver link is made for a customer who said STOP', w1.status === 200 && /\/waiver\?token=/.test(w1.body.link || ''), JSON.stringify(w1.body));
        check('but the text is not sent, and sms_sent says so', w1.body.sms_sent === false && !textsTo(STOPPED).length, JSON.stringify({ sms_sent: w1.body.sms_sent, texts: textsTo(STOPPED).length }));
        check('the refusal is in the log with its reason', T.sms_log.some((l) => l.to_phone === STOPPED && l.type === 'waiver_link' && l.status === 'opted_out'));
        const w2 = await call('POST', '/api/dashboard/waivers/link', { booking_id: 'b-quiet' });
        check('a customer with no consent row is texted the waiver (transactional)', w2.body.sms_sent === true && textsTo(QUIET).length === 1 && /Please sign your waiver/.test(textsTo(QUIET)[0].body.text), JSON.stringify(w2.body));

        console.log('\n── review requests ──');
        const r1 = await call('POST', '/api/dashboard/reviews/send-request', { booking_id: 'b-stopped-2' });
        check('a review request to a customer who said STOP reports sms_sent false', r1.status === 200 && r1.body.sms_sent === false, JSON.stringify(r1.body));
        const r2 = await call('POST', '/api/dashboard/reviews/send-request', { booking_id: 'b-quiet-2' });
        check('and to one with no consent row it is texted and reported', r2.body.sms_sent === true && textsTo(QUIET).length === 2, JSON.stringify(r2.body));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('dashboard-sms');
}
