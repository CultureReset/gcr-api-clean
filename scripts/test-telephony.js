#!/usr/bin/env node
// ============================================================
// Telephony — Telnyx (default) and Twilio (legacy) behind one interface
// ============================================================
//
//     npm run test:telephony
//
// fetch is stubbed and records every request, so these read "the text went to
// /messages with this body" rather than "something returned 200". No
// credentials, no network.

const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');

process.env.TELNYX_API_KEY = 'KEY_test';
process.env.TELNYX_MESSAGING_PROFILE_ID = 'mp-1';
process.env.TELNYX_CONNECTION_ID = 'conn-1';
process.env.PLATFORM_NUMBER = '+15550000001';
process.env.API_BASE_URL = 'https://api.example.test';
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'tw_token';
process.env.TWILIO_PHONE_NUMBER = '+15550000002';
process.env.TWILIO_WEBHOOK_BASE_URL = 'https://api.example.test';
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;

const ed = crypto.generateKeyPairSync('ed25519');
// The raw 32 bytes, base64 — the shape Telnyx's portal shows.
process.env.TELNYX_PUBLIC_KEY = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

/* ── fetch stub ───────────────────────────────────────────────────────── */
const sent = [];
let lineType = 'mobile';
async function fakeFetch(url, init = {}) {
    const rec = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    sent.push(rec);
    const json = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data });
    const u = rec.url;
    if (u.includes('/messages')) return json(200, { data: { id: 'msg-1', to: [{ status: 'queued' }] } });
    if (/\/calls\/[^/]+\/actions\//.test(u)) return json(200, { data: { result: 'ok' } });
    if (u.endsWith('/calls')) return json(200, { data: { call_control_id: 'cc-1', call_leg_id: 'leg-1' } });
    if (u.includes('/available_phone_numbers')) return json(200, { data: [{ phone_number: '+15550001111', features: [{ name: 'sms' }] }] });
    if (u.includes('/number_orders')) return json(200, { data: { id: 'order-1', status: 'pending' } });
    if (u.includes('/phone_numbers?')) return json(200, { data: [{ id: 'pn-9' }] });
    if (u.includes('/phone_numbers/')) return json(200, { data: { id: 'pn-9' } });
    if (u.includes('/number_lookup/')) return json(200, { data: { carrier: { type: lineType } } });
    if (u.includes('Messages.json')) return json(201, { sid: 'SM1', status: 'queued' });
    if (u.includes('Calls.json')) return json(201, { sid: 'CA1' });
    if (u.includes('lookups')) return json(200, { line_type_intelligence: { type: lineType } });
    return json(404, { errors: [{ detail: 'not stubbed' }] });
}

const telnyx = require(path.join(ROOT, 'lib/telephony/telnyx.js'));
const twilio = require(path.join(ROOT, 'lib/telephony/twilio.js'));
telnyx._setFetch(fakeFetch);
twilio._setFetch(fakeFetch);
const telephony = require(path.join(ROOT, 'lib/telephony'));

/* ── a database stub for utils/sms.js ─────────────────────────────────── */
const logged = [];
const q = () => {
    const self = { select: () => self, or: () => self, limit: () => self, maybeSingle: async () => ({ data: null }) };
    return self;
};
function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.join(ROOT, 'db.js'), {
    from: (t) => (t === 'sms_log' ? { insert: async (row) => { logged.push(row); return {}; } } : q()),
});
const sms = require(path.join(ROOT, 'utils/sms.js'));

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}
const last = () => sent[sent.length - 1];
const bodyOf = (r) => JSON.parse(r.body);

function signTelnyx(raw, ts = Math.floor(Date.now() / 1000)) {
    const sig = crypto.sign(null, Buffer.from(`${ts}|${raw}`), ed.privateKey).toString('base64');
    return { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': String(ts) };
}

(async () => {
    console.log('\n── Telnyx is the default ──');
    check('provider defaults to telnyx', telephony.providerName() === 'telnyx');

    sent.length = 0;
    const msg = await telephony.sendSms({ to: '(555) 010-2030', text: 'hello' });
    const m = bodyOf(last());
    check('a text goes to /messages', last().url.endsWith('/messages') && last().method === 'POST');
    check('with the API key as a bearer', last().headers.Authorization === 'Bearer KEY_test');
    check('to is normalised to E.164', m.to === '+15550102030', m.to);
    check('from defaults to PLATFORM_NUMBER', m.from === '+15550000001');
    check('the messaging profile rides along', m.messaging_profile_id === 'mp-1');
    check('the message id comes back', msg.id === 'msg-1' && msg.provider === 'telnyx');

    let threw = null;
    try { await telephony.sendSms({ to: '12', text: 'x' }); } catch (e) { threw = e; }
    check('a non-number is refused before any request', threw?.code === 'invalid_phone');

    sent.length = 0;
    const call = await telephony.placeCall({ to: '+15550102030', say: 'Your code is 1 2 3' });
    const c = bodyOf(last());
    check('a spoken call dials /calls on the voice connection', last().url.endsWith('/calls') && c.connection_id === 'conn-1');
    check('its events go to the say webhook', c.webhook_url === 'https://api.example.test/api/telephony/telnyx/say', c.webhook_url);
    check('the message rides in client_state', telephony.decodeClientState(c.client_state)?.say === 'Your code is 1 2 3');
    check('the call control id comes back', call.id === 'cc-1');

    sent.length = 0;
    await telephony.speak({ callId: 'cc-1', text: 'hi' });
    check('speak is a Call Control action', /\/calls\/cc-1\/actions\/speak$/.test(last().url));
    await telephony.hangup({ callId: 'cc-1' });
    check('hangup is a Call Control action', /\/calls\/cc-1\/actions\/hangup$/.test(last().url));

    sent.length = 0;
    const bought = await telephony.buyNumber({ areaCode: '555' });
    check('buying without a number searches first', sent[0].url.includes('/available_phone_numbers') && sent[0].url.includes('national_destination_code%5D=555'));
    check('then orders what it found', sent[1].url.endsWith('/number_orders') && bodyOf(sent[1]).phone_numbers[0].phone_number === '+15550001111');
    check('on the voice connection and messaging profile', bodyOf(sent[1]).connection_id === 'conn-1' && bodyOf(sent[1]).messaging_profile_id === 'mp-1');
    check('and says which number it bought', bought.phoneNumber === '+15550001111');

    sent.length = 0;
    await telephony.releaseNumber({ phoneNumber: '+15550001111' });
    check('release finds the number id', sent[0].url.includes('/phone_numbers?'));
    check('then deletes it', sent[1].method === 'DELETE' && sent[1].url.endsWith('/phone_numbers/pn-9'));

    lineType = 'mobile';
    check('a mobile line can take texts', (await telephony.lookupNumber('+15550102030')).canText === true);
    lineType = 'fixed line';
    check('a landline cannot', (await telephony.lookupNumber('+15550102030')).canText === false);

    console.log('\n── Telnyx webhook signatures ──');
    const raw = JSON.stringify({ data: { event_type: 'message.received' } });
    check('a signed webhook verifies', telephony.verifyWebhook({ headers: signTelnyx(raw), rawBody: Buffer.from(raw) }).ok);
    check('a changed body does not', !telephony.verifyWebhook({ headers: signTelnyx(raw), rawBody: Buffer.from(raw + 'x') }).ok);
    check('an old timestamp does not', !telephony.verifyWebhook({ headers: signTelnyx(raw, 1000), rawBody: Buffer.from(raw) }).ok);
    check('no signature does not', !telephony.verifyWebhook({ headers: {}, rawBody: Buffer.from(raw) }).ok);

    console.log('\n── the say webhook ──');
    const say = require(path.join(ROOT, 'routes/telephony-say.js'));
    const app = express();
    app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
    app.use('/api/telephony/telnyx/say', say);
    const server = app.listen(0);
    const url = `http://127.0.0.1:${server.address().port}/api/telephony/telnyx/say`;
    const post = async (payload, headers) => {
        const body = JSON.stringify(payload);
        const res = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || signTelnyx(body)) }, body });
        await new Promise((r) => setTimeout(r, 20)); // the handler acts after answering
        return res.status;
    };
    const state = Buffer.from(JSON.stringify({ say: 'Code 4 5 6' })).toString('base64');
    sent.length = 0;
    check('an unsigned event is refused', (await post({ data: {} }, { 'telnyx-timestamp': '1' })) === 401);
    await post({ data: { event_type: 'call.answered', payload: { call_control_id: 'cc-7', client_state: state } } });
    const spoken = sent.find((r) => r.url.endsWith('/calls/cc-7/actions/speak'));
    check('answered → the message is spoken', spoken && bodyOf(spoken).payload === 'Code 4 5 6');
    const nState = bodyOf(spoken).client_state;
    sent.length = 0;
    await post({ data: { event_type: 'call.speak.ended', payload: { call_control_id: 'cc-7', client_state: nState } } });
    check('first read ended → read again', sent.some((r) => r.url.endsWith('/calls/cc-7/actions/speak')));
    const n2 = bodyOf(sent.find((r) => r.url.endsWith('/actions/speak'))).client_state;
    sent.length = 0;
    await post({ data: { event_type: 'call.speak.ended', payload: { call_control_id: 'cc-7', client_state: n2 } } });
    check('second read ended → hang up', sent.some((r) => r.url.endsWith('/calls/cc-7/actions/hangup')));
    server.close();

    console.log('\n── utils/sms.js routes through it ──');
    sent.length = 0; logged.length = 0;
    const r = await sms.sendSms('5550102030', 'Your booking is confirmed', 'biz-one', 'booking_confirmation');
    check('a booking text goes out through Telnyx', r.success && sent.some((x) => x.url.endsWith('/messages')));
    check('and is logged with the provider', logged[0]?.status === 'sent' && logged[0]?.metadata?.provider === 'telnyx');

    console.log('\n── Twilio, when chosen ──');
    process.env.TELEPHONY_PROVIDER = 'twilio';
    sent.length = 0;
    const tw = await telephony.sendSms({ to: '+15550102030', text: 'legacy' });
    check('a text goes to Messages.json', last().url.includes('/Accounts/AC_test/Messages.json'));
    const form = new URLSearchParams(last().body);
    check('form-encoded, from TWILIO_PHONE_NUMBER', form.get('From') === '+15550000002' && form.get('Body') === 'legacy');
    check('basic auth with the account sid', last().headers.Authorization === `Basic ${Buffer.from('AC_test:tw_token').toString('base64')}`);
    check('the sid comes back', tw.id === 'SM1' && tw.provider === 'twilio');
    await telephony.placeCall({ to: '+15550102030', say: 'Code 7 & 8' });
    const twiml = new URLSearchParams(last().body).get('Twiml');
    check('a spoken call carries TwiML, escaped', /<Say>Code 7 &amp; 8<\/Say>/.test(twiml), twiml);

    const params = { From: '+15550102030', Body: 'hi' };
    const signed = crypto.createHmac('sha1', 'tw_token')
        .update('https://api.example.test/api/sms/inbound' + 'Body' + 'hi' + 'From' + '+15550102030').digest('base64');
    check('a Twilio webhook signature verifies',
        telephony.verifyWebhook({ headers: { 'x-twilio-signature': signed }, originalUrl: '/api/sms/inbound', body: params }).ok);
    check('a wrong one does not',
        !telephony.verifyWebhook({ headers: { 'x-twilio-signature': 'nope' }, originalUrl: '/api/sms/inbound', body: params }).ok);
    let unsupported = null;
    try { telephony.callAction('x', 'speak', {}); } catch (e) { unsupported = e; }
    check('Call Control actions say plainly they are Telnyx-only', unsupported?.code === 'unsupported');
    delete process.env.TELEPHONY_PROVIDER;

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
