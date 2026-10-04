#!/usr/bin/env node
// ============================================================
// Phone Agent install: a number bought, recorded, billed and released;
// forwarding codes as data; texting registration only moved by a signed call
// ============================================================
//
//     npm run test:phone-agent

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc';
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: SECRET,
    TELNYX_API_KEY: 'KEY_test',
    TELNYX_CONNECTION_ID: 'conn-1',
    TELNYX_MESSAGING_PROFILE_ID: 'mp-1',
    PLATFORM_NUMBER: '+15550000001',
    PHONE_AGENT_NUMBER_ITEM_KEY: 'phone-number',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    INTAKE_EMAIL_DOMAIN: 'intake.example.test',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.TELEPHONY_DEFAULT_COUNTRY_CODE;

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', phone: '(251) 555-0100' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    business_mcp_tokens: [],
    nextgent_installs: [],
    business_phone_numbers: [],
    forwarding_codes: [
        { key: 'gsm-unanswered', label: 'Forward calls you do not answer', network: 'gsm', when_forwarded: 'no_answer', enable_template: '**61*{e164}#', disable_template: '##61#', sort_order: 10 },
        { key: 'star72-all', label: 'Forward every call', network: 'star', when_forwarded: 'always', enable_template: '*72{national}', disable_template: '*73', sort_order: 50 },
    ],
    store_items: [
        { id: 'i-agent', key: 'phone-agent', status: 'published', access: 'free', price_cents: 0 },
        { id: 'i-num', key: 'phone-number', status: 'published', access: 'free', price_cents: 900, price_interval: 'month', stripe_price_id: 'price_num' },
    ],
    billing_plan: [{ key: 'base', is_default: true }],
    billing_subscription: [],
    billing_item_charges: [],
    billing_item_prices: [{ item_key: 'phone-number', amount_cents: 900, currency: 'usd', interval: 'month', stripe_price_id: 'price_num' }],
    store_plan_items: [],
    store_grants: [],
} });
inject(path.join(ROOT, 'db.js'), db);

const carrier = [];
let failOrder = false;
require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
    const u = String(url);
    carrier.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
    if (u.includes('/available_phone_numbers')) return json(200, { data: [{ phone_number: '+12515550199' }] });
    if (u.endsWith('/number_orders')) return failOrder ? json(422, { errors: [{ detail: 'no inventory' }] }) : json(200, { data: { id: 'ord-1', status: 'pending' } });
    if (u.includes('/phone_numbers?')) return json(200, { data: [{ id: 'pn-1' }] });
    if (u.includes('/phone_numbers/')) return json(200, { data: {} });
    return json(200, { data: {} });
});
const stripeCalls = [];
require(path.join(ROOT, 'lib/billingStripe.js'))._setStripe({
    customers: { create: async () => ({ id: 'cus_1' }) },
    subscriptions: { create: async (a) => { stripeCalls.push(['sub', a]); return { id: 'sub_1', items: { data: [{ id: 'si_1' }] } }; } },
    subscriptionItems: { create: async (a) => { stripeCalls.push(['si', a]); return { id: 'si_2' }; }, del: async (id) => { stripeCalls.push(['si.del', id]); return {}; } },
    invoiceItems: { create: async () => ({ id: 'ii' }) },
});

const { check, done } = checker();
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/nextgent', require(path.join(ROOT, 'routes/nextgent.js')));
const server = app.listen(0, run);
async function signed(method, url, body) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method, body: body === undefined ? undefined : raw,
        headers: { 'Content-Type': 'application/json', 'x-nextgent-timestamp': ts, 'x-nextgent-signature': crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex') },
    });
    return { status: res.status, body: await res.json() };
}

async function run() {
    try {
        console.log('\n── installing a Phone Agent ──');
        const inst = await signed('POST', '/api/nextgent/installs', {
            companyId: 'co-1', installId: 'in-phone', itemKey: 'phone-agent', kind: 'agent', version: '1.0.0',
            permissions: ['business:read', 'availability:read', 'messages:send'], capabilities: ['telephony'],
            instructions: 'You answer the phone for this business.',
        });
        check('identified by its telephony capability, not its name', inst.status === 201 && inst.body.phone?.number === '+12515550199', JSON.stringify(inst.body));
        const order = carrier.find((c) => c.url.endsWith('/number_orders'));
        check('searched in the business\'s own area code', carrier.some((c) => c.url.includes('national_destination_code%5D=251') || c.url.includes('national_destination_code]=251')));
        check('bought with the voice connection and messaging profile attached', order.body.connection_id === 'conn-1' && order.body.messaging_profile_id === 'mp-1');
        const row = T.business_phone_numbers[0];
        check('recorded for the business and install', row.entity_slug === 'shop' && row.install_id === 'in-phone' && row.status === 'active');
        check('texting registration is not assumed', row.registration_status === 'not_started' && inst.body.phone.registrationStatus === 'not_started');
        check('the number\'s monthly charge is added', stripeCalls.some((c) => c[1]?.items?.[0]?.price === 'price_num' || c[1]?.price === 'price_num') && T.billing_item_charges.some((c) => c.install_id === 'phone-number:+12515550199'));
        const fwd = inst.body.phone.forwarding;
        check('forwarding codes come from the rows, filled with the number', fwd.length === 2 && fwd[0].enable === '**61*+12515550199#' && fwd[1].enable === '*722515550199' && fwd[1].disable === '*73');
        check('the agent\'s instructions are kept for the live handlers', T.nextgent_installs[0].instructions === 'You answer the phone for this business.' && T.nextgent_installs[0].capabilities.includes('telephony'));

        console.log('\n── registration is an outside process ──');
        const bad = await signed('PUT', '/api/nextgent/numbers/+12515550199/registration', { status: 'done' });
        check('an unknown status is refused', bad.status === 400);
        const ok = await signed('PUT', `/api/nextgent/numbers/${encodeURIComponent('+12515550199')}/registration`, { status: 'pending', ref: 'campaign-1' });
        check('a signed update moves it', ok.status === 200 && T.business_phone_numbers[0].registration_status === 'pending' && T.business_phone_numbers[0].registration_ref === 'campaign-1');

        console.log('\n── uninstall ──');
        carrier.length = 0;
        const del = await signed('DELETE', '/api/nextgent/installs/in-phone');
        check('uninstall releases the number', del.body.numbersReleased?.[0] === '+12515550199' && carrier.some((c) => c.method === 'DELETE' && c.url.includes('/phone_numbers/pn-1')));
        check('and its charge', T.billing_item_charges.find((c) => c.install_id === 'phone-number:+12515550199').status === 'removed' && T.business_phone_numbers[0].status === 'released');

        console.log('\n── a number that cannot be bought ──');
        failOrder = true;
        const nope = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'in-phone-2', itemKey: 'phone-agent', kind: 'agent', permissions: [], telephony: { areaCode: '305' } });
        check('the install is refused and nothing is left behind', nope.status === 502 && !T.nextgent_installs.some((i) => i.install_id === 'in-phone-2') && T.business_phone_numbers.length === 1, JSON.stringify(nope.body));
        failOrder = false;
        const byKey = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'in-num', itemKey: 'phone-number', kind: 'app', permissions: [] });
        check('the number item itself is billed once, as the install', byKey.status === 201 && T.billing_item_charges.filter((c) => c.status === 'active').length === 1
            && T.billing_item_charges.some((c) => c.install_id === 'in-num' && c.status === 'active'), JSON.stringify(T.billing_item_charges));
        const plain = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'in-plain', itemKey: 'phone-agent', kind: 'agent', permissions: ['business:read'] });
        check('an install that asks for no telephony gets no number', plain.status === 201 && !plain.body.phone);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('phone-agent');
}
