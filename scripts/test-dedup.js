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

