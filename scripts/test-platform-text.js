#!/usr/bin/env node
// ============================================================
// PLATFORM TEXT — Paperclip sends a text from the platform number (DECISIONS #85)
// ============================================================
//
//     npm run test:platform-text
//
// POST /api/nextgent/platform-text { companyId, to, body, kind } (signed):
// one telephony integration, in gcr, sending from PLATFORM_NUMBER through
// lib/telephony; sms_opt_outs honoured; logged to sms_log the way owner
// notifications are (utils/sms.js). No platform-email twin: Paperclip has its
// own mailer. In-memory database, a recording carrier, real signatures.

const path = require('path');
const fs = require('fs');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: 'svc-secret',
    TELNYX_API_KEY: 'KEY_test',
    TELNYX_MESSAGING_PROFILE_ID: 'mp-1',
    PLATFORM_NUMBER: '+15550000001',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    sms_opt_outs: [{ phone: '+12515550166' }],
    sms_log: [],
} });
inject(path.join(ROOT, 'db.js'), db);

const carrier = [];
let carrierOk = true;
const telnyx = require(path.join(ROOT, 'lib/telephony/telnyx.js'));
telnyx._setFetch(async (url, init) => {
    carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (!carrierOk) return { ok: false, status: 502, text: async () => JSON.stringify({ errors: [{ detail: 'carrier down' }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'msg-1' } }) };
});

const { serviceSigned, signHeaders } = require(path.join(ROOT, 'lib/serviceSigning.js'));
const platformText = require(path.join(ROOT, 'routes/nextgent-platform-text.js'));

const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
// Mounted the way routes/nextgent.js mounts it: behind the service signature.
app.use('/api/nextgent', serviceSigned, platformText);
// And a wrong mount, with no signature check in front: the router must refuse on its own.
app.use('/bare', platformText);
const server = app.listen(0, run);
const base = () => `http://127.0.0.1:${server.address().port}`;

async function post(url, body, { sign = true } = {}) {
    const raw = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', ...(sign ? signHeaders({ method: 'POST', url: `${base()}${url}`, rawBody: raw }) : {}) };
    const res = await fetch(`${base()}${url}`, { method: 'POST', headers, body: raw });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const { check, done } = checker();

async function run() {
    try {
        console.log('\n── the door ──');
        const unsigned = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550177', body: 'Hi', kind: 'notice' }, { sign: false });
        check('an unsigned request is refused', unsigned.status === 401 && !carrier.length);
        const bare = await post('/bare/platform-text', { companyId: 'co-1', to: '+12515550177', body: 'Hi', kind: 'notice' });
        check('mounted without the signature check in front, the router refuses on its own', bare.status === 401 && !carrier.length, JSON.stringify(bare.body));

        console.log('\n── validation ──');
        const noCompany = await post('/api/nextgent/platform-text', { to: '+12515550177', body: 'Hi', kind: 'notice' });
        check('companyId, to and body are required', noCompany.status === 400 && /companyId/.test(noCompany.body.error));
        const unlinked = await post('/api/nextgent/platform-text', { companyId: 'co-none', to: '+12515550177', body: 'Hi', kind: 'notice' });
        check('a company that is not linked is 409', unlinked.status === 409);
        const badPhone = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: 'not-a-number', body: 'Hi', kind: 'notice' });
        check('a value that is not a phone number is 400', badPhone.status === 400 && /phone/i.test(badPhone.body.error), JSON.stringify(badPhone.body));
        const badKind = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550177', body: 'Hi', kind: 'Not A Kind!' });
        check('kind is a short lower-case label', badKind.status === 400 && /kind/.test(badKind.body.error));
        const empty = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550177', body: '   ', kind: 'notice' });
        check('an empty body is 400', empty.status === 400);
        check('nothing reached the carrier', !carrier.length);

        console.log('\n── a text from the platform number ──');
        const sent = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '(251) 555-0177', body: 'Your invoice is ready.', kind: 'billing' });
        check('sent: 200 with the carrier id, never the number back', sent.status === 200 && sent.body.sent === true && sent.body.id === 'msg-1' && !JSON.stringify(sent.body).includes('0177'), JSON.stringify(sent.body));
        const c = carrier[0];
        check('from PLATFORM_NUMBER, to the normalised number, the text as given', c && c.body.from === '+15550000001' && c.body.to === '+12515550177' && c.body.text === 'Your invoice is ready.', JSON.stringify(c?.body));
        const log = T.sms_log[0];
        check('logged like an owner notification: the business, a platform_<kind> type, status sent', log && log.site_id === 'shop' && log.type === 'platform_billing' && log.status === 'sent' && log.to_phone === '+12515550177', JSON.stringify(log));
        check('a ref is kept on the log when given', (await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550177', body: 'x', kind: 'billing', ref: 'invoice:in_1' })).status === 200
            && T.sms_log[1].related_id === 'invoice:in_1', JSON.stringify(T.sms_log[1]));
        const defaultKind = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550177', body: 'x' });
        check('kind defaults to platform', defaultKind.status === 200 && T.sms_log[2].type === 'platform_platform', JSON.stringify(T.sms_log[2]));

        console.log('\n── STOP is honoured ──');
        carrier.length = 0;
        const optedOut = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550166', body: 'Hello', kind: 'notice' });
        check('an opted-out number is not texted; the answer says why', optedOut.status === 200 && optedOut.body.sent === false && optedOut.body.reason === 'opted_out' && !carrier.length, JSON.stringify(optedOut.body));
        check('and the skipped attempt is logged', T.sms_log.some((l) => l.to_phone === '+12515550166' && l.status === 'opted_out'));

        console.log('\n── the carrier failing ──');
        carrierOk = false;
        const down = await post('/api/nextgent/platform-text', { companyId: 'co-1', to: '+12515550177', body: 'Hello', kind: 'notice' });
        check('a carrier failure is 502 with the reason, logged as failed', down.status === 502 && down.body.sent === false && down.body.reason && T.sms_log.some((l) => l.status === 'failed'), JSON.stringify(down.body));
        carrierOk = true;

        console.log('\n── one door, no twin ──');
        const nextgent = fs.readFileSync(path.join(ROOT, 'routes/nextgent.js'), 'utf8');
        check('routes/nextgent.js mounts the platform-text router behind its signature check', /require\('\.\/nextgent-platform-text'\)/.test(nextgent) && nextgent.indexOf('router.use(serviceSigned)') < nextgent.indexOf("require('./nextgent-platform-text')"));
        check('there is no /platform-email route (Paperclip has its own mailer)', !/platform-email/.test(nextgent) && !/platform-email/.test(fs.readFileSync(path.join(ROOT, 'routes/nextgent-platform-text.js'), 'utf8').replace(/\/\/.*$/gm, '')));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('platform-text');
}
