#!/usr/bin/env node
// ============================================================
// Public routes never record consent or text a caller's own words
// ============================================================
//
//     npm run test:consent-routes
//
// POST /api/live-photo, /api/public/contact and /api/gcr/opt-in take no
// credential. A yes they carry is the caller's claim about somebody else's
// phone, so none of them may write message_consent; and a text they cause
// must not carry text the caller typed. In-memory database, a recording
// carrier. No credentials, no network.

const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    TELNYX_API_KEY: 'KEY_test',
    PLATFORM_NUMBER: '+15550000001',
    LINKS_BASE_URL: 'https://links.example.test',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    GCR_SUPABASE_URL: 'https://db.example.test',
    GCR_SUPABASE_SERVICE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ADMIN_SMS_NUMBER;

const CONSENTED = '+12515550101';
const STRANGER = '+12515550102';

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', is_active: true }],
    businesses: [{ id: 'site-1', site_id: 'site-1', entity_slug: 'shop', name: 'Shop Biz', email: 'owner@shop.test', status: 'active' }],
    message_consent: [{ entity_slug: 'shop', channel: 'sms', phone: CONSENTED, status: 'granted', source: 'booking_opt_in' }],
    sms_opt_outs: [],
    sms_log: [],
    customer_live_photos: [],
    customers: [],
    booking_opt_ins: [],
    notifications: [],
    messaging_settings: [],
    site_content: [],
} });
db.storage = {
    from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://photos.example.test/p.jpg' } }),
    }),
    createBucket: async () => ({}),
};
inject(path.join(ROOT, 'db.js'), db);
// routes/gcr.js makes its own client; it gets the same stub.
inject(require.resolve('@supabase/supabase-js'), { createClient: () => db });
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true }; } });

const carrier = [];
require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
    carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: { id: `tx-${carrier.length}` } }), text: async () => JSON.stringify({ data: { id: `tx-${carrier.length}` } }) };
});

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/live-photo', require(path.join(ROOT, 'routes/live-photo.js')));
app.use('/api/public', require(path.join(ROOT, 'routes/public.js')));
app.use('/api/gcr', require(path.join(ROOT, 'routes/gcr.js')));
const server = app.listen(0, run);
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
const settle = () => new Promise((r) => setTimeout(r, 80));
async function post(p, body) {
    const res = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}
async function photo(fields) {
    const form = new FormData();
    form.append('photo', new Blob([Buffer.from('not really a jpeg')], { type: 'image/jpeg' }), 'p.jpg');
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    const res = await fetch(url('/api/live-photo'), { method: 'POST', body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const consentRows = (phone) => T.message_consent.filter((c) => c.phone === phone);
const textsTo = (phone) => carrier.filter((c) => c.body?.to === phone);
const ATTACK = 'ATTACKER-TEXT-9f3a';

async function run() {
    try {
        console.log('\n── POST /api/live-photo ──');
        let r = await photo({ site_id: 'site-1', phone: STRANGER, sms_consent: 'true', sms_consent_text: ATTACK, send_review: 'true', business_name: ATTACK, review_delay_minutes: '0' });
        await settle();
        check('the upload is accepted', r.status === 200, JSON.stringify(r.body));
        check('a ticked box on an anonymous upload records no consent', !consentRows(STRANGER).length, JSON.stringify(consentRows(STRANGER)));
        // A review request is transactional (DECISIONS.md #6): it goes without a
        // consent row, and carries nothing the caller typed.
        check('the review request is texted without a consent row', textsTo(STRANGER).length === 1 && !textsTo(STRANGER)[0].body.text.includes(ATTACK), JSON.stringify(textsTo(STRANGER)));
        r = await photo({ site_id: 'site-1', phone: CONSENTED, send_review: 'true', business_name: ATTACK, review_delay_minutes: '0' });
        await settle();
        const sent = textsTo(CONSENTED);
        check('a customer who agreed is texted the review request', sent.length === 1, JSON.stringify(sent));
        check('the text never carries words the caller typed', sent.length && !sent[0].body.text.includes(ATTACK), sent[0]?.body?.text);
        check('it names the business from the database', sent.length && /The Shop/.test(sent[0].body.text), sent[0]?.body?.text);

        console.log('\n── POST /api/public/contact ──');
        carrier.length = 0;
        r = await post('/api/public/contact?site_id=site-1', { name: ATTACK, message: 'hello', phone: STRANGER, sms_consent: true, sms_consent_text: ATTACK });
        await settle();
        check('the form is accepted', r.status === 200, JSON.stringify(r.body));
        check('a ticked box on the contact form records no consent', !consentRows(STRANGER).length, JSON.stringify(consentRows(STRANGER)));
        check('the confirmation is texted without a consent row, carrying nothing the caller typed', textsTo(STRANGER).length === 1 && !textsTo(STRANGER)[0].body.text.includes(ATTACK), JSON.stringify(textsTo(STRANGER)));
        r = await post('/api/public/contact?site_id=site-1', { name: ATTACK, message: 'hello', phone: CONSENTED, sms_consent: true });
        await settle();
        const confirm = textsTo(CONSENTED);
        check('a customer who agreed gets the confirmation text', confirm.length === 1, JSON.stringify(confirm));
        check('without the caller\'s words in it', confirm.length && !confirm[0].body.text.includes(ATTACK), confirm[0]?.body?.text);

        console.log('\n── POST /api/gcr/opt-in ──');
        r = await post('/api/gcr/opt-in', { entity_slug: 'shop', phone: STRANGER, name: 'Bo', sms_consent: true, consent_text: ATTACK });
        check('the opt-in row is still kept for the business', r.status === 200 && T.booking_opt_ins.some((o) => o.phone === STRANGER && o.sms_consent === true), JSON.stringify(r.body));
        check('but an anonymous opt-in records no consent', !consentRows(STRANGER).length, JSON.stringify(consentRows(STRANGER)));
        check('consent rows are untouched throughout', T.message_consent.length === 1 && T.message_consent[0].phone === CONSENTED);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('consent-routes');
}
