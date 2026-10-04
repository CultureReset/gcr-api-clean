#!/usr/bin/env node
// ============================================================
// One copy each: the duplicates the audit found, folded into the kept copy
// ============================================================
//
//     npm run test:dedup
//
// Each section proves that callers of the copy that was removed still get the
// same answers from the copy that was kept. In-memory database, stubbed
// Paperclip and carrier. No credentials, no network.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    JWT_SECRET: 'console-secret',
    NEXTGENT_SERVICE_SECRET: 'svc-secret',
    TELNYX_API_KEY: 'KEY_test',
    PLATFORM_NUMBER: '+15550000001',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;

const { T, db } = createMemDb({ tables: {
    entity: [
        { slug: 'shop', name: 'The Shop', email: 'owner@shop.test', phone: '+15550100000' },
        { slug: 'other', name: 'Other', phone: '+15550300000' },
    ],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    entity_owners: [{ user_id: 'sb-owner', entity_slug: 'shop', role: 'owner' }],
    platform_admins: [{ user_id: 'sb-admin', paperclip_user_id: 'pc-admin' }],
} });

/* Supabase sessions: token -> user. */
const SB = { 'sb-owner-token': { id: 'sb-owner' }, 'sb-admin-token': { id: 'sb-admin' }, 'sb-nobody-token': { id: 'sb-nobody' } };
db.auth.getUser = async (token) => (SB[token] ? { data: { user: SB[token] }, error: null } : { data: null, error: new Error('bad') });
inject(path.join(ROOT, 'db.js'), db);

/* Paperclip tokens: "pc.<json claims>" stands in for a verified JWT. */
inject(path.join(ROOT, 'lib/paperclipAuth.js'), {
    isPaperclipToken: (t) => String(t).startsWith('pc.'),
    verifyToken: async (t) => {
        if (t === 'pc.bad') throw Object.assign(new Error('Token signature is not valid.'), { status: 401 });
        return JSON.parse(t.slice(3));
    },
});
const pc = (claims) => `pc.${JSON.stringify({ sub: 'pc-user', company_id: 'co-1', role: 'owner', ...claims })}`;

const { check, done } = checker();

/* A tiny app that echoes what a guard decided. */
function guardApp(guard, handler) {
    const app = express();
    app.use(express.json());
    app.all('/t/:slug?', guard, handler || ((req, res) => res.json({
        isAdmin: !!req.isAdmin, scopeSlug: req.scopeSlug ?? null, entitySlug: req.entitySlug ?? null,
        actingAsAdmin: !!req.actingAsAdmin, authVia: req.authVia || null, userId: req.userId || null,
    })));
    return app;
}
async function listen(app) {
    return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
async function hit(server, { token, method = 'GET', p = '/t', body } = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const sections = [];
const section = (name, fn) => sections.push([name, fn]);

/* ── 1. business access: one resolver (middleware/ownerAuth.js) ─────────── */

section('1. businessOrAdminRequired answers as businessAccess did', async () => {
    const auth = require(path.join(ROOT, 'middleware/ownerAuth.js'));
    const server = await listen(guardApp(auth.businessOrAdminRequired));
    try {
        const none = await hit(server, {});
        check('no token is 401 with the same words', none.status === 401 && none.body.error === 'Sign in to do that.');

        const consoleTok = jwt.sign({ userId: 'u-1', role: 'admin' }, process.env.JWT_SECRET);
        const cAdmin = await hit(server, { token: consoleTok });
        check('the admin console JWT is an admin of any business', cAdmin.status === 200 && cAdmin.body.isAdmin && cAdmin.body.scopeSlug === null && cAdmin.body.userId === 'u-1');

        const consoleUser = jwt.sign({ userId: 'u-2', role: 'owner' }, process.env.JWT_SECRET);
        check('a console JWT without role admin is not let through', (await hit(server, { token: consoleUser })).status === 401);

        const owner = await hit(server, { token: pc({}) });
        check('a Paperclip owner gets their linked business', owner.status === 200 && owner.body.scopeSlug === 'shop' && !owner.body.isAdmin && owner.body.authVia === 'paperclip');

        const unlinked = await hit(server, { token: pc({ company_id: 'co-9' }) });
        check('an unlinked company is 403', unlinked.status === 403 && unlinked.body.error === 'This company is not linked to a business.');

        const pAdmin = await hit(server, { token: pc({ sub: 'pc-admin', role: 'instance_admin', company_id: null }) });
        check('a listed instance admin is an admin of any business', pAdmin.status === 200 && pAdmin.body.isAdmin && pAdmin.body.scopeSlug === null);

        const fakeAdmin = await hit(server, { token: pc({ sub: 'pc-someone', role: 'instance_admin' }) });
        check('an unlisted instance_admin claim is only its company', fakeAdmin.status === 200 && !fakeAdmin.body.isAdmin && fakeAdmin.body.scopeSlug === 'shop');

        const bad = await hit(server, { token: 'pc.bad' });
        check('a bad Paperclip token is 401 with its reason', bad.status === 401 && /signature/.test(bad.body.error));

        const sOwner = await hit(server, { token: 'sb-owner-token' });
        check('a Supabase owner gets entity_owners\' business', sOwner.status === 200 && sOwner.body.scopeSlug === 'shop' && sOwner.body.authVia === 'supabase');

        const sAdmin = await hit(server, { token: 'sb-admin-token' });
        check('a platform_admins account is an admin', sAdmin.status === 200 && sAdmin.body.isAdmin && sAdmin.body.scopeSlug === null);

        const nobody = await hit(server, { token: 'sb-nobody-token' });
        check('an account with no business is 403', nobody.status === 403 && nobody.body.error === 'This account is not linked to a business.');

        check('an unknown token is 401', (await hit(server, { token: 'garbage' })).status === 401);
    } finally { server.close(); }

    const fakeReq = (o) => ({ ...o });
    check('assertSlug: an owner naming another business gets nothing', auth.scopedSlug(fakeReq({ scopeSlug: 'shop' }), 'other') === null);
    check('assertSlug: an owner naming nothing gets their own', auth.scopedSlug(fakeReq({ scopeSlug: 'shop' }), '') === 'shop');
    check('assertSlug: an admin gets what they named', auth.scopedSlug(fakeReq({ isAdmin: true }), 'other') === 'other');

    // ownerRequired and resolveSessionSlug run on the same resolver.
    const ownerServer = await listen(guardApp(auth.ownerRequired));
    try {
        const o = await hit(ownerServer, { token: 'sb-owner-token', p: '/t?business=other' });
        check('ownerRequired: an owner cannot name another business', o.status === 200 && o.body.entitySlug === 'shop');
        const a = await hit(ownerServer, { token: 'sb-admin-token', p: '/t?business=other' });
        check('ownerRequired: an admin names one explicitly', a.status === 200 && a.body.entitySlug === 'other' && a.body.actingAsAdmin);
        const a0 = await hit(ownerServer, { token: 'sb-admin-token' });
        check('ownerRequired: an admin naming none is 403', a0.status === 403);
        const pa = await hit(ownerServer, { token: pc({ sub: 'pc-admin', role: 'instance_admin' }), p: '/t/other' });
        check('ownerRequired: a Paperclip admin names one explicitly', pa.status === 200 && pa.body.entitySlug === 'other' && pa.body.actingAsAdmin);
    } finally { ownerServer.close(); }
    check('resolveSessionSlug: Supabase owner', (await auth.resolveSessionSlug('sb-owner-token')).slug === 'shop');
    check('resolveSessionSlug: Paperclip owner', (await auth.resolveSessionSlug(pc({}))).via === 'paperclip');
    check('resolveSessionSlug: no business', /not linked/.test((await auth.resolveSessionSlug('sb-nobody-token')).reason));

    // The email parser's routes are behind it.
    const ep = express();
    ep.use(express.json());
    ep.use('/api/email-parser', require(path.join(ROOT, 'routes/email-parser.js')));
    const eps = await listen(ep);
    try {
        const r = await hit(eps, { token: pc({}), method: 'POST', p: '/api/email-parser/setup/other', body: {} });
        check('email-parser: an owner setting up another business is 403', r.status === 403 && r.body.error === 'Not your business.');
        const anon = await hit(eps, { method: 'POST', p: '/api/email-parser/bulk-import', body: {} });
        check('email-parser: no token is 401', anon.status === 401);
    } finally { eps.close(); }
    check('middleware/businessAccess.js is gone', !require('fs').existsSync(path.join(ROOT, 'middleware/businessAccess.js')));
});


/* ── 2. automations: one install path ───────────────────────────────────── */

section('2. an admin rollout and a store install use one install path', async () => {
    const fs = require('fs');
    T.automations = [{ id: 'auto-r', key: 'nightly-report', name: 'Nightly', version: 3, status: 'published', trigger: { type: 'manual' }, steps: [] }];
    T.automation_versions = [1, 2, 3].map((v) => ({ automation_id: 'auto-r', version: v, definition: {} }));
    T.automation_deployments = [];
    // A business that already has it, switched off and configured by its owner.
    T.entity_automations = [{ id: 'ea-1', entity_slug: 'shop', automation_id: 'auto-r', version: 1, enabled: false, config: { hour: 9 }, hook_token: 'a'.repeat(48) }];

    const app = express();
    app.use(express.json());
    app.use('/api/admin/automations', require(path.join(ROOT, 'routes/automations.js')));
    const server = await listen(app);
    try {
        const admin = jwt.sign({ userId: 'op-1', role: 'admin' }, process.env.JWT_SECRET);
        const r = await hit(server, { token: admin, method: 'POST', p: '/api/admin/automations/auto-r/deploy', body: { version: 2, audience: { mode: 'slugs', slugs: ['shop', 'other'] } } });
        const dep = r.body?.deployment;
        check('the rollout reports the same counts', r.status === 200 && dep.installed === 1 && dep.updated === 1 && dep.failed === 0 && dep.status === 'done', JSON.stringify(r.body));
        const kept = T.entity_automations.find((e) => e.entity_slug === 'shop');
        check('an existing install keeps its settings and stays off; only the version moves', kept.version === 2 && kept.enabled === false && kept.config.hour === 9 && kept.hook_token === 'a'.repeat(48) && kept.deployment_id === dep.id);
        const added = T.entity_automations.find((e) => e.entity_slug === 'other');
        check('a new install is on, at that version, with a fresh hook token and the deployment', added.version === 2 && added.enabled === true && /^[a-f0-9]{48}$/.test(added.hook_token) && added.deployment_id === dep.id);
    } finally { server.close(); }

    const installs = require(path.join(ROOT, 'lib/automationInstalls.js'));
    const store = await installs.installFromStore({ itemKey: 'nightly-report', slug: 'shop', version: null });
    const kept = T.entity_automations.find((e) => e.entity_slug === 'shop');
    check('a store install of the same automation moves it to the latest and switches it on, keeping settings', store.version === 3 && kept.version === 3 && kept.enabled === true && kept.config.hour === 9);
    check('uninstalling from the store switches it off and keeps the row', (await installs.uninstallFromStore({ itemKey: 'nightly-report', slug: 'shop' })) === 1 && kept.enabled === false && T.entity_automations.length === 2);

    for (const f of ['routes/automations.js', 'routes/nextgent.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        check(`${f} does not insert installs itself`, !/from\('entity_automations'\)\.insert/.test(src));
    }
});

/* ── 3. item prices: billing_item_prices only ───────────────────────────── */

section('3. item prices live in billing_item_prices', async () => {
    const fs = require('fs');
    T.store_items = [
        { id: 'i-a', key: 'priced-both', access: 'free', status: 'published', price_cents: 999, price_interval: 'year', stripe_price_id: 'price_old' },
        { id: 'i-b', key: 'old-price-only', access: 'plan', status: 'published', price_cents: 700, price_interval: 'month', stripe_price_id: 'price_stale' },
    ];
    T.billing_item_prices = [
        { item_key: 'priced-both', amount_cents: 1500, currency: 'usd', interval: 'month', model: 'flat', stripe_price_id: 'price_new' },
        { item_key: 'paperclip-only', amount_cents: 300, currency: 'usd', interval: 'one_time', stripe_price_id: 'price_p' },
    ];
    const stripe = require(path.join(ROOT, 'lib/billingStripe.js'));
    const both = await stripe.itemByKey('priced-both');
    check('the price row wins, and the store row keeps its access and id', both.price_cents === 1500 && both.price_interval === 'month' && both.stripe_price_id === 'price_new' && both.id === 'i-a' && both.access === 'free');
    const stale = await stripe.itemByKey('old-price-only');
    check('a price left only on store_items is no longer read', stale.price_cents === 0 && stale.stripe_price_id === null && stale.access === 'plan');
    check('so priceOf calls it free', stripe.priceOf(stale).priceCents === 0 && stripe.priceOf(stale).interval === null);
    const pOnly = await stripe.itemByKey('paperclip-only');
    check('an item priced only by Paperclip is still billable', pOnly.id === null && pOnly.price_cents === 300 && pOnly.access === 'free');
    check('an item in neither is unknown', (await stripe.itemByKey('nothing')) === null);

    const sql = fs.readFileSync(path.join(ROOT, 'sql/nextgent_prices_fold.sql'), 'utf8');
    check('the fold copies all three store_items price columns', /si\.price_cents/.test(sql) && /si\.price_interval/.test(sql) && /si\.stripe_price_id/.test(sql));
    check('into billing_item_prices without overwriting a price Paperclip set', /insert into public\.billing_item_prices/.test(sql) && /on conflict \(item_key\) do nothing/.test(sql));
    check('with the currency taken from the default plan row, not a literal', /bp\.currency from public\.billing_plan bp where bp\.is_default/.test(sql) && !/'usd'/i.test(sql));
    const order = fs.readFileSync(path.join(ROOT, 'sql/ORDER.md'), 'utf8');
    check('ORDER.md lists the fold and the later column drop', /nextgent_prices_fold\.sql/.test(order) && /price_cents/.test(order));
});

/* ── 4. phone codes: lib/phoneVerification.js ───────────────────────────── */

section('4. claims and business sign-up use lib/phoneVerification.js', async () => {
    const fs = require('fs');
    const telephony = require(path.join(ROOT, 'lib/telephony'));
    const saved = { isConfigured: telephony.isConfigured, lookupNumber: telephony.lookupNumber, placeCall: telephony.placeCall, sendSms: telephony.sendSms };
    const calls = [];
    const texts = [];
    let canText = false;
    Object.assign(telephony, {
        isConfigured: () => true,
        lookupNumber: async () => ({ canText }),
        placeCall: async (a) => { calls.push(a); return { id: 'call-1' }; },
        sendSms: async (a) => { texts.push(a); return { id: `m-${texts.length}`, provider: 'stub' }; },
    });
    T.entity.push({ slug: 'listing', name: 'The Listing', phone: '+15550400000' }, { slug: 'listing-2', name: 'Second', phone: '+15550500000' });
    T.claim_codes = [];
    T.phone_verification_codes = [];
    T.business_claims = [];
    T.business_signups = [];

    const app = express();
    app.use(express.json());
    app.use('/api/claims', require(path.join(ROOT, 'routes/claims.js')));
    app.use('/api/business-auth', require(path.join(ROOT, 'routes/business-auth.js')));
    const server = await listen(app);
    try {
        const me = pc({ company_id: 'co-claim', sub: 'pc-claimer' });
        const start = await hit(server, { token: me, method: 'POST', p: '/api/claims/start', body: { entitySlug: 'listing' } });
        check('a landline claim is a call', start.status === 201 && start.body.channel === 'voice', JSON.stringify(start.body));
        const say = calls.at(-1)?.say || '';
        const digits = (say.match(/is ((?:\d ){5,8}\d)\./) || [])[1] || '';
        const code = digits.replace(/ /g, '');
        check('that reads the code digit by digit, twice', /^\d{6}$/.test(code) && say.split(digits).length === 3 && calls.at(-1).to === '+15550400000', say);
        const claim = T.claim_codes.find((c) => c.id === start.body.claimId);
        check('the claim row holds no code', claim && !claim.code_hash && claim.channel === 'voice');
        const pv = T.phone_verification_codes.find((r) => r.purpose === `claim:${claim.id}`);
        check('the code is a phone code for this claim, hashed', pv && pv.phone === '+15550400000' && !JSON.stringify(pv).includes(code));

        const wrong = await hit(server, { token: me, method: 'POST', p: '/api/claims/verify', body: { claimId: claim.id, code: code === '000000' ? '111111' : '000000' } });
        check('a wrong code: 400 with attempts left', wrong.status === 400 && wrong.body.error === 'That code is not right.' && wrong.body.attemptsLeft === 4, JSON.stringify(wrong.body));

        // A second claim's code does not open the first.
        canText = true;
        const other = await hit(server, { token: pc({ company_id: 'co-other' }), method: 'POST', p: '/api/claims/start', body: { entitySlug: 'listing-2' } });
        const otherCode = (texts.at(-1)?.text.match(/^(\d+) is the code to claim Second/) || [])[1];
        check('a mobile claim is a text with its own wording', other.body.channel === 'sms' && !!otherCode && texts.at(-1).from === '+15550000001');
        const crossed = await hit(server, { token: me, method: 'POST', p: '/api/claims/verify', body: { claimId: claim.id, code: otherCode } });
        check('another claim\'s code does not work', crossed.status === 400 || otherCode === code);

        const right = await hit(server, { token: me, method: 'POST', p: '/api/claims/verify', body: { claimId: claim.id, code } });
        check('the right code links the company', right.status === 200 && right.body.linked && T.company_links.some((l) => l.company_id === 'co-claim' && l.entity_slug === 'listing'));
        const again = await hit(server, { token: me, method: 'POST', p: '/api/claims/verify', body: { claimId: claim.id, code } });
        check('and is not accepted twice', again.status === 409);

        const tooMany = pc({ company_id: 'co-other' });
        for (let i = 0; i < 5; i += 1) await hit(server, { token: tooMany, method: 'POST', p: '/api/claims/verify', body: { claimId: other.body.claimId, code: otherCode === '000000' ? '111111' : '000000' } });
        const locked = await hit(server, { token: tooMany, method: 'POST', p: '/api/claims/verify', body: { claimId: other.body.claimId, code: otherCode } });
        check('too many tries: 429', locked.status === 429 && locked.body.error === 'Too many tries. Ask for a new code.');

        // Business sign-up and sign-in.
        texts.length = 0;
        const sent = await hit(server, { method: 'POST', p: '/api/business-auth/phone', body: { phone: '(251) 555-0123' } });
        const signupCode = (texts.at(-1)?.text.match(/(\d{6})/) || [])[1];
        check('sign-up texts our own code', sent.status === 200 && texts.at(-1)?.to === '+12515550123' && !!signupCode);
        const peek = await hit(server, { method: 'POST', p: '/api/business-auth/verify', body: { phone: '2515550123', code: signupCode } });
        const peek2 = await hit(server, { method: 'POST', p: '/api/business-auth/verify', body: { phone: '2515550123', code: signupCode } });
        check('/verify confirms it without using it up (register checks it again)', peek.status === 200 && peek2.status === 200);
        const live = T.phone_verification_codes.find((r) => r.phone === '+12515550123' && r.purpose === 'business_signup' && !r.consumed_at);
        check('and a right peek spends no try', live && live.attempts === 0);
        const bad = await hit(server, { method: 'POST', p: '/api/business-auth/verify', body: { phone: '2515550123', code: signupCode === '000000' ? '111111' : '000000' } });
        check('a wrong code reads as before', bad.status === 400 && bad.body.error === 'That code is not right.');
        const crossPurpose = await hit(server, { method: 'POST', p: '/api/business-auth/signin-verify', body: { phone: '2515550123', code: signupCode } });
        check('a sign-up code cannot sign in', crossPurpose.status === 400);
        await hit(server, { method: 'POST', p: '/api/business-auth/signin', body: { phone: '2515550123' } });
        const signinCode = (texts.at(-1)?.text.match(/(\d{6})/) || [])[1];
        const signin = await hit(server, { method: 'POST', p: '/api/business-auth/signin-verify', body: { phone: '2515550123', code: signinCode } });
        check('a sign-in code is accepted (then no account is found)', signin.status === 404 && /No business/.test(signin.body.error));
    } finally {
        server.close();
        Object.assign(telephony, saved);
    }
    for (const f of ['routes/claims.js', 'routes/business-auth.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        check(`${f} keeps no code hashing or Twilio client of its own`, !/createHmac|timingSafeEqual|require\('twilio'\)|verificationChecks/.test(src));
    }
});

/* ── 5. the automation text step is for the business, not customers ─────── */

section('5. sms.send goes only to the business\'s own numbers', async () => {
    const engine = require(path.join(ROOT, 'lib/automationEngine.js'));
    T.owner_notify_settings = [{ entity_slug: 'shop', phone: '251-555-0142' }];
    T.business_phone_numbers = [{ entity_slug: 'shop', phone_number: '+15550200000', status: 'active' }, { entity_slug: 'shop', phone_number: '+15550299999', status: 'released' }];
    const step = engine.STEP_TYPES['sms.send'];
    const run = (to) => step.run({ config: { to, body: 'Nightly report ready' }, slug: 'shop', dryRun: true, ctx: {} }).then((r) => r, (e) => ({ error: e.message }));
    check('to the listing\'s phone', !(await run('+15550100000')).error);
    check('to the owner\'s notification phone', !(await run('(251) 555-0142')).error);
    check('to a number the business owns', !(await run('+15550200000')).error);
    check('not to a released number', /own numbers/.test((await run('+15550299999')).error || ''));
    check('not to a customer', /Message a customer/.test((await run('+12515550177')).error || ''));
    check('not to another business\'s phone', /own numbers/.test((await run('+15550300000')).error || ''));
    const fs = require('fs');
    const seeds = fs.readdirSync(path.join(ROOT, 'sql')).filter((f) => /sms\.send/.test(fs.readFileSync(path.join(ROOT, 'sql', f), 'utf8')));
    check('no seed in sql/ uses sms.send (nothing to migrate there)', !seeds.length, seeds.join(', '));
});

/* ── 6. consent: one check, one record ──────────────────────────────────── */

section('6. hasSmsConsent is the only consent check; message_consent the only record', async () => {
    const fs = require('fs');
    const carrier = [];
    require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
        carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, status: 200, json: async () => ({ data: { id: `tx-${carrier.length}` } }), text: async () => '{}' };
    });
    T.message_consent = [];
    T.sms_opt_outs = [{ phone: '+12515550166' }];
    T.booking_opt_ins = [{ id: 'opt-old', entity_slug: 'shop', phone: '251-555-0155', sms_consent: true }];
    T.sms_log = [];
    T.businesses = [{ id: 'site-1', entity_slug: 'shop' }, { id: 'site-2', entity_slug: null }];
    const messages = require(path.join(ROOT, 'lib/messages.js'));

    check('an opt-in row alone is not read any more (the fold moves it)', (await messages.hasSmsConsent('shop', '251-555-0155')).reason === 'no_consent');
    await messages.recordConsent('shop', '251-555-0155', { source: 'booking_opt_in' });
    check('once in message_consent it counts', (await messages.hasSmsConsent('shop', '+12515550155')).ok);
    check('an opt-out wins', (await messages.hasSmsConsent('shop', '251-555-0166')).reason === 'opted_out');
    await messages.recordConsent('shop', '251-555-0155', { granted: false, source: 'sms_keyword' });
    check('a revoked yes is a no', (await messages.hasSmsConsent('shop', '251-555-0155')).reason === 'consent_revoked');
    await messages.recordConsent('shop', '251-555-0155', { source: 'booking_opt_in' });

    carrier.length = 0;
    const ok = await messages.textCustomer({ slug: 'shop', to: '251-555-0155', body: 'Your table is ready', type: 'test' });
    check('textCustomer sends to a customer who said yes', ok.success && carrier.some((c) => c.body?.to === '+12515550155'));
    const no = await messages.textCustomer({ slug: 'shop', to: '251-555-0177', body: 'Promo', type: 'test' });
    check('and not to one who did not, logged with the reason', !no.success && no.reason === 'no_consent' && T.sms_log.some((l) => l.to_phone === '+12515550177' && l.status === 'no_consent'));
    const asked = await messages.textCustomer({ slug: 'shop', to: '251-555-0177', body: 'Your code', type: 'test', reply: true });
    check('a text the customer asked for needs no separate yes', asked.success);
    const stop = await messages.textCustomer({ slug: 'shop', to: '251-555-0166', body: 'Your code', type: 'test', reply: true });
    check('but an opt-out still stops it', !stop.success && stop.reason === 'opted_out');

    await messages.recordConsent('shop', '251-555-0188', { source: 'booking_form' });
    const viaSite = await messages.textCustomer({ siteId: 'site-1', to: '251-555-0188', body: 'Booked', type: 'test' });
    check('an older site flow is checked under its business\'s slug', viaSite.success && (await messages.businessKeyForSite('site-1')) === 'shop');
    check('a site with no linked business keys on its own id', (await messages.businessKeyForSite('site-2')) === 'site-2');

    // The opt-in step records the yes where it is read.
    const app = express();
    app.use(express.json());
    app.use('/api/embed', require(path.join(ROOT, 'routes/embed.js')));
    T.entity.find((e) => e.slug === 'shop').is_active = true;
    T.tourist_click_events = [];
    const server = await listen(app);
    try {
        const lead = await hit(server, { method: 'POST', p: '/api/embed/lead/shop', body: { name: 'Ana', phone: '251-555-0199', sms_consent: true, consent_text: 'Text me' } });
        check('the embed opt-in records the yes in message_consent', lead.status === 200 && (await messages.hasSmsConsent('shop', '2515550199')).ok, JSON.stringify(lead.body));
        await hit(server, { method: 'POST', p: '/api/embed/lead/shop', body: { name: 'Bo', phone: '251-555-0198', sms_consent: false } });
        check('a box left empty records nothing', !(await messages.hasSmsConsent('shop', '2515550198')).ok);
    } finally { server.close(); }

    const sql = fs.readFileSync(path.join(ROOT, 'sql/nextgent_consent_fold.sql'), 'utf8');
    check('the fold reads booking_opt_ins.sms_consent and bookings.sms_consent', /from public\.booking_opt_ins/.test(sql) && /from public\.bookings/.test(sql) && /sms_consent is true/.test(sql));
    check('into message_consent, never over a newer row', /insert into public\.message_consent/.test(sql) && /on conflict \(entity_slug, channel, phone\) do nothing/.test(sql));

    // Every customer-texting sender goes through the one check.
    const senders = ['routes/email-parser.js', 'routes/public.js', 'routes/square.js', 'routes/stripe.js', 'routes/dashboard.js', 'routes/platform.js', 'routes/live-photo.js', 'routes/transportation.js'];
    const missing = senders.filter((f) => !/textCustomer/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('every customer-texting route uses textCustomer', !missing.length, missing.join(', '));
    const other = ['routes', 'lib', 'utils'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`))
        .filter((f) => f !== 'lib/messages.js' && /booking_opt_ins[^\n]*sms_consent[^\n]*\)\s*$|select\('sms_consent/m.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no other file reads a consent flag to decide a text', !other.length, other.join(', '));
});

/* ── 7. every text through utils/sms -> lib/telephony ───────────────────── */

section('7. no provider SDK or provider credentials outside lib/telephony', async () => {
    const fs = require('fs');
    const files = [];
    const walk = (d) => {
        for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
            const rel = `${d}/${f.name}`;
            if (f.isDirectory()) { if (!['node_modules', 'scripts', 'lib/telephony', '.git'].includes(rel) && !rel.startsWith('node_modules')) walk(rel); continue; }
            if (f.name.endsWith('.js')) files.push(rel);
        }
    };
    for (const d of ['routes', 'lib', 'utils', 'middleware']) walk(d);
    files.push('server.js');
    const sdk = files.filter((f) => /require\(['"]twilio['"]\)|require\(['"]telnyx['"]\)|api\.twilio\.com|api\.telnyx\.com|transactionalSMS/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no Twilio/Telnyx SDK or SMS API call outside lib/telephony', !sdk.length, sdk.join(', '));
    const creds = files.filter((f) => /process\.env\.(TWILIO_|TELNYX_API_KEY)|'TWILIO_[A-Z_]+'/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no carrier credentials read outside lib/telephony', !creds.length, creds.join(', '));
    const literal = ['routes/admin.js', 'routes/dashboard.js', 'routes/live-photo.js'].filter((f) => /'\+1' \+ cleanPhone|\+12513135464/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no hard-coded number or country code in the sends that moved', !literal.length, literal.join(', '));

    // The admin console's provider list asks lib/telephony.
    const tel = require(path.join(ROOT, 'lib/telephony')).status();
    check('telephony.status names the live carrier without the key', tel.provider === 'telnyx' && tel.configured && tel.keyEnv === 'TELNYX_API_KEY' && tel.fingerprint === '…test');
});

/* ── 10. helpers: one copy each ─────────────────────────────────────────── */

section('10. routine signing, envInt, defaultPlanKey, Google token encryption', async () => {
    const engine = require(path.join(ROOT, 'lib/automationEngine.js'));
    const now = 1_790_000_000_000;
    const raw = JSON.stringify({ hello: 'routine' });
    // The formula the engine used to carry itself.
    const ts = String(Math.floor(now / 1000));
    const old = crypto.createHmac('sha256', 'whsec').update(`${ts}.`).update(raw).digest('hex');
    const h = engine.paperclipRoutineHeaders('whsec', raw, now);
    check('routine headers: same timestamp and signature as before', h['X-Paperclip-Timestamp'] === ts && h['X-Paperclip-Signature'] === `sha256=${old}`);

    const { envInt } = require(path.join(ROOT, 'lib/env.js'));
    process.env.DEDUP_N = '0';
    check('envInt: 0 is below the default minimum', envInt('DEDUP_N', 7) === 7);
    check('envInt: 0 is kept when the minimum is 0', envInt('DEDUP_N', 7, { min: 0 }) === 0);
    process.env.DEDUP_N = ' ';
    check('envInt: blank is unset', envInt('DEDUP_N', 7, { min: 0 }) === 7);
    process.env.DEDUP_N = '12';
    check('envInt: a number is read', envInt('DEDUP_N', 7) === 12);
    delete process.env.DEDUP_N;
    const fs = require('fs');
    for (const f of ['routes/claims.js', 'lib/paperclipAuth.js']) {
        check(`${f} has no envInt copy of its own`, !/const (envInt|num) = \(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    }

    T.billing_plan = [{ key: 'starter', is_default: true }, { key: 'pro' }];
    T.billing_subscription = [];
    const ent = require(path.join(ROOT, 'lib/entitlements.js'));
    check('defaultPlanKey is exported once, from lib/entitlements.js', (await ent.defaultPlanKey()) === 'starter');
    for (const f of ['lib/billingStripe.js', 'routes/billing.js']) {
        check(`${f} has no defaultPlanKey copy`, !/async function defaultPlanKey|eq\('is_default', true\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    }
    check('planKeysFor falls back to the default plan', (await ent.planKeysFor(['shop'])).get('shop') === 'starter');

    // Google tokens: the old format still opens; new ones are sealed.
    const legacyKey = crypto.randomBytes(32).toString('hex');
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = legacyKey;
    const legacyEncrypt = (plaintext) => {
        const iv = crypto.randomBytes(16);
        const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(legacyKey, 'hex'), iv);
        const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
        return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
    };
    const gbp = require(path.join(ROOT, 'lib/googleBusinessApi.js'));
    check('a token stored in the old format still decrypts', gbp.decryptToken(legacyEncrypt('ya29.old-token')) === 'ya29.old-token');
    check('an empty old-format refresh token still decrypts', gbp.decryptToken(legacyEncrypt('')) === '');
    const sealed = gbp.encryptToken('ya29.new-token');
    check('new tokens are sealed by secretBox', /^v1\./.test(sealed) && gbp.decryptToken(sealed) === 'ya29.new-token');
    check('an empty token round-trips sealed', gbp.decryptToken(gbp.encryptToken('')) === '');
    check('googleBusinessApi does no crypto of its own', !/require\('crypto'\)|createCipheriv|createDecipheriv/.test(fs.readFileSync(path.join(ROOT, 'lib/googleBusinessApi.js'), 'utf8')));

    // A refresh moves both stored tokens to the sealed format.
    T.oauth_tokens = [{ entity_slug: 'shop', provider: 'google_business', access_token: legacyEncrypt('at-old'), refresh_token: legacyEncrypt('rt-old'), expires_at: new Date(Date.now() - 1000).toISOString(), extra: {} }];
    gbp._setFetch(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at-new', expires_in: 3600 }) }));
    const tok = await gbp.getValidAccessToken('shop');
    const row = T.oauth_tokens[0];
    check('refresh used the old-format refresh token', tok === 'at-new');
    check('and re-stored both tokens sealed', /^v1\./.test(row.access_token) && /^v1\./.test(row.refresh_token) && gbp.decryptToken(row.refresh_token) === 'rt-old');
});

/* ── run ─────────────────────────────────────────────────────────────── */

(async () => {
    try {
        for (const [name, fn] of sections) {
            console.log(`\n── ${name} ──`);
            await fn();
        }
    } catch (err) {
        check(`no exception (${err.message})`, false, err.stack);
    }
    done('dedup');
})();

