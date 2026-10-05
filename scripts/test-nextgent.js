#!/usr/bin/env node
// ============================================================
// NEXT GENT — the Paperclip-facing endpoints, claims, notifications, billing
// ============================================================
//
//     npm run test:nextgent
//
// Boots routes/nextgent.js, routes/claims.js and routes/business-data.js
// against an in-memory stand-in for the database, a recording Stripe, a stubbed
// carrier and stubbed email. Real signatures, real JWTs, real permission
// checks. No credentials, no network.

const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc-secret';
const ISSUER = 'https://paperclip.test';
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: SECRET,
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    PAPERCLIP_ISSUER: ISSUER,
    PAPERCLIP_JWKS_URL: 'https://paperclip.test/.well-known/jwks.json',
    INTAKE_EMAIL_DOMAIN: 'parse.example.test',
    TELNYX_API_KEY: 'KEY_test',
    TELNYX_CONNECTION_ID: 'conn-1',
    PLATFORM_NUMBER: '+15550000001',
    API_BASE_URL: 'https://api.example.test',
    USAGE_CREDITS_PER_USD: '100',
    EXPORT_BUCKET: 'exports',
    EXPORT_URL_TTL_SECONDS: '600',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.STRIPE_USAGE_METER_EVENT;

/* ── an in-memory database ────────────────────────────────────────────── */
const T = {
    entity: [
        { slug: 'listed-cafe', name: 'Listed Cafe', entity_type: 'restaurant', phone: '+15550102030', email: 'cafe@example.test', is_active: true },
        { slug: 'landline-inn', name: 'Landline Inn', phone: '+15550102040', is_active: true },
        { slug: 'owned-bar', name: 'Owned Bar', phone: '+15550102050', is_active: true },
    ],
    entity_owners: [{ entity_slug: 'owned-bar', user_id: 'u-1' }],
    company_links: [],
    business_mcp_tokens: [],
    nextgent_installs: [],
    store_items: [
        { id: 'i-free', key: 'qr-menu', status: 'published', access: 'free', price_cents: 0 },
        { id: 'i-paid', key: 'review-agent', status: 'published', access: 'free', price_cents: 1500, price_interval: 'month', stripe_price_id: 'price_rev' },
        { id: 'i-once', key: 'setup-pack', status: 'published', access: 'free', price_cents: 5000, price_interval: 'one_time', stripe_price_id: 'price_setup' },
        { id: 'i-plan', key: 'pro-only', status: 'published', access: 'plan', price_cents: 0 },
    ],
    billing_plan: [{ key: 'base', name: 'Base', is_default: true }],
    billing_subscription: [],
    billing_usage: [],
    billing_item_charges: [],
    billing_usage_credits: [],
    // What sql/nextgent_prices_fold.sql leaves: the store_items prices above,
    // copied here. itemByKey reads only this table.
    billing_item_prices: [
        { item_key: 'review-agent', amount_cents: 1500, currency: 'usd', interval: 'month', stripe_price_id: 'price_rev' },
        { item_key: 'setup-pack', amount_cents: 5000, currency: 'usd', interval: 'one_time', stripe_price_id: 'price_setup' },
    ],
    store_plan_items: [],
    store_grants: [],
    claim_codes: [],
    business_claims: [],
    owner_notify_settings: [],
    owner_notifications: [],
    menu_items: [{ id: 1, entity_slug: 'listed-cafe', name: 'Toast' }, { id: 3, entity_slug: 'new-taco-shop', name: 'Taco' }],
    faqs: [{ id: 2, entity_slug: 'listed-cafe', q: 'Open?' }],
    // The catalogue: one table, the kind is data (products.items = kind product).
    // People who asked: private as a raw table (a lead is a record of a person), reached by contract.
    entity_leads: [{ id: 'l-1', entity_slug: 'new-taco-shop', name: 'Asker', email: 'a@example.test', status: 'new' }, { id: 'l-2', entity_slug: 'listed-cafe', name: 'Theirs' }],
    offerings: [
        { id: 10, entity_slug: 'new-taco-shop', kind: 'product', name: 'Salsa jar' },
        { id: 11, entity_slug: 'new-taco-shop', kind: 'service', name: 'Catering' },
        { id: 12, entity_slug: 'listed-cafe', kind: 'product', name: 'Beans' },
    ],
    // An automation built in the admin builder; its key is the store item key.
    automations: [{ id: 'auto-1', key: 'review-request', name: 'Review request', version: 2, status: 'published', trigger: { type: 'manual' }, steps: [] }],
    automation_versions: [{ automation_id: 'auto-1', version: 1 }, { automation_id: 'auto-1', version: 2 }],
    entity_automations: [],
};
let seq = 0;
const like = (v, pat) => new RegExp(`^${String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`).test(String(v));

function table(name) {
    const st = { name, filters: [], verb: 'select', values: null, onConflict: null, range: null, limitN: null };
    const rows = () => (T[name] ||= []);
    const match = (r) => st.filters.every((f) => f(r));
    function run() {
        const all = rows();
        if (st.verb === 'insert') {
            const list = Array.isArray(st.values) ? st.values : [st.values];
            for (const v of list) {
                if (name === 'company_links' && all.some((r) => r.company_id === v.company_id || r.entity_slug === v.entity_slug)) {
                    return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
                }
            }
            const made = list.map((v) => ({ id: v.id || `id-${++seq}`, created_at: new Date().toISOString(), revoked_at: null, attempts: 0, ...v }));
            all.push(...made);
            return { data: made, error: null };
        }
        if (st.verb === 'upsert') {
            const keys = (st.onConflict || 'id').split(',');
            const v = st.values;
            const hit = all.find((r) => keys.every((k) => r[k] === v[k]));
            if (hit) { Object.assign(hit, v); return { data: [hit], error: null }; }
            const made = { id: `id-${++seq}`, ...v };
            all.push(made);
            return { data: [made], error: null };
        }
        const hits = all.filter(match);
        if (st.verb === 'update') { hits.forEach((r) => Object.assign(r, st.values)); return { data: hits, error: null }; }
        if (st.verb === 'delete') { T[name] = all.filter((r) => !match(r)); return { data: hits, error: null }; }
        let out = hits;
        if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
        if (st.limitN) out = out.slice(0, st.limitN);
        return { data: out, error: null, count: hits.length };
    }
    const self = {
        select: () => self,
        insert: (v) => { st.verb = 'insert'; st.values = v; return self; },
        upsert: (v, o) => { st.verb = 'upsert'; st.values = v; st.onConflict = o?.onConflict; return self; },
        update: (v) => { st.verb = 'update'; st.values = v; return self; },
        delete: () => { st.verb = 'delete'; return self; },
        eq: (k, v) => { st.filters.push((r) => r[k] === v); return self; },
        is: (k, v) => { st.filters.push((r) => (r[k] ?? null) === v); return self; },
        gte: (k, v) => { st.filters.push((r) => String(r[k]) >= String(v)); return self; },
        in: (k, vs) => { st.filters.push((r) => vs.includes(r[k])); return self; },
        not: () => self,
        order: () => self,
        or: (expr) => {
            const parts = expr.split(',').map((p) => p.split('.'));
            st.filters.push((r) => parts.some(([col, op, ...rest]) => {
                const val = rest.join('.');
                return op === 'eq' ? String(r[col]) === val : op === 'like' ? like(r[col], val) : false;
            }));
            return self;
        },
        range: (a, b) => { st.range = [a, b]; return self; },
        limit: (n) => { st.limitN = n; return self; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] || null, error: r.error }; },
        single: async () => { const r = run(); return { data: r.data?.[0] || null, error: r.error || (r.data?.length ? null : { message: 'no rows' }) }; },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return self;
}
const uploads = [];
const dbStub = {
    from: table,
    rpc: async (fn, args) => {
        if (fn === 'find_existing_entity') return { data: T.entity.filter((e) => e.phone === args.p_phone), error: null };
        return { data: null, error: { message: 'no rpc' } };
    },
    auth: { getUser: async () => ({ data: null, error: new Error('not supabase') }) },
    storage: {
        from: (bucket) => ({
            upload: async (p, body) => { uploads.push({ bucket, path: p, body: JSON.parse(body.toString()) }); return { error: null }; },
            createSignedUrl: async (p, ttl) => ({ data: { signedUrl: `https://storage.example.test/${bucket}/${p}?ttl=${ttl}` }, error: null }),
        }),
    },
};

function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.join(ROOT, 'db.js'), dbStub);
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true }; } });

/* ── the carrier and the schema read go through fetch ─────────────────── */
const carrier = [];
let lineType = 'mobile';
const telnyx = require(path.join(ROOT, 'lib/telephony/telnyx.js'));
telnyx._setFetch(async (url, init) => {
    carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (String(url).includes('/number_lookup/')) return json({ data: { carrier: { type: lineType } } });
    if (String(url).endsWith('/calls')) return json({ data: { call_control_id: 'cc-1' } });
    return json({ data: { id: 'msg-1' } });
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.test/rest/v1/')) {
        const def = (cols) => ({ properties: Object.fromEntries(cols.map((c) => [c, { type: 'string' }])) });
        const spec = { definitions: {
            menu_items: def(['id', 'entity_slug', 'name']),
            faqs: def(['id', 'entity_slug', 'q']),
            offerings: def(['id', 'entity_slug', 'kind', 'name']),
            entity_leads: def(['id', 'entity_slug', 'name', 'email', 'phone', 'message', 'source', 'status']),
            // The business record: keyed by slug, so not a section; its columns back business.* contracts.
            entity: def(['id', 'slug', 'name', 'phone', 'website_url', 'social_instagram', 'stripe_customer_id', 'currency']),
            business_mcp_tokens: def(['id', 'entity_slug', 'token_hash']),
        } };
        return { ok: true, status: 200, json: async () => spec };
    }
    return realFetch(url, init);
};

/* ── a recording Stripe ───────────────────────────────────────────────── */
const stripeCalls = [];
const fakeStripe = {
    customers: { create: async (a) => { stripeCalls.push(['customers.create', a]); return { id: 'cus_1' }; } },
    subscriptions: {
        create: async (a, o) => { stripeCalls.push(['subscriptions.create', a, o]); return { id: 'sub_1', items: { data: [{ id: 'si_1' }] } }; },
        update: async (id, a) => { stripeCalls.push(['subscriptions.update', id, a]); return {}; },
    },
    subscriptionItems: {
        create: async (a, o) => { stripeCalls.push(['subscriptionItems.create', a, o]); return { id: 'si_2' }; },
        del: async (id) => { stripeCalls.push(['subscriptionItems.del', id]); return {}; },
    },
    invoiceItems: { create: async (a, o) => { stripeCalls.push(['invoiceItems.create', a, o]); return { id: 'ii_1' }; } },
    products: { create: async (a) => { stripeCalls.push(['products.create', a]); return { id: 'prod_1' }; } },
    prices: { create: async (a) => { stripeCalls.push(['prices.create', a]); return { id: `price_new_${stripeCalls.length}` }; } },
    billing: { meterEvents: { create: async (a) => { stripeCalls.push(['meterEvents.create', a]); return {}; } } },
};
const billingStripe = require(path.join(ROOT, 'lib/billingStripe.js'));
billingStripe._setStripe(fakeStripe);

/* ── Paperclip keys ───────────────────────────────────────────────────── */
const ed = crypto.generateKeyPairSync('ed25519');
const paperclip = require(path.join(ROOT, 'lib/paperclipAuth.js'));
paperclip._setFetch(async () => ({ ok: true, json: async () => ({ keys: [{ ...ed.publicKey.export({ format: 'jwk' }), kid: 'k1' }] }) }));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function pcToken(claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'EdDSA', kid: 'k1' });
    const p = b64({ iss: ISSUER, aud: 'gcr-api-clean', sub: 'pc-user', company_id: 'co-claim', role: 'owner', iat: now, exp: now + 300, ...claims });
    return `${h}.${p}.${crypto.sign(null, Buffer.from(`${h}.${p}`), ed.privateKey).toString('base64url')}`;
}

/* ── the app ──────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/nextgent', require(path.join(ROOT, 'routes/nextgent.js')));
app.use('/api/claims', require(path.join(ROOT, 'routes/claims.js')));
app.use('/api/business', require(path.join(ROOT, 'routes/business-data.js')));
const server = app.listen(0, run);
const base = () => `http://127.0.0.1:${server.address().port}`;

async function signed(method, url, body, { sign = true } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'Content-Type': 'application/json' };
    if (sign) {
        // CONTRACT §3: ts, nonce, METHOD, path, query and the body's sha256, newline-joined.
        const nonce = crypto.randomBytes(16).toString('hex');
        const u = new URL(url, 'http://localhost');
        const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
        headers['x-nextgent-timestamp'] = ts;
        headers['x-nextgent-nonce'] = nonce;
        headers['x-nextgent-signature'] = crypto.createHmac('sha256', SECRET)
            .update(`${ts}\n${nonce}\n${method.toUpperCase()}\n${u.pathname}\n${u.search.replace(/^\?/, '')}\n${bodyHash}`).digest('hex');
    }
    const res = await realFetch(`${base()}${url}`, { method, headers, body: body === undefined ? undefined : raw });
    return { status: res.status, body: await res.json() };
}
async function asUser(method, url, body, token) {
    const res = await realFetch(`${base()}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function run() {
    try {
        console.log('\n── signing ──');
        const unsigned = await signed('POST', '/api/nextgent/link', { companyId: 'co-1' }, { sign: false });
        check('an unsigned call is refused', unsigned.status === 401);
        const tampered = await (async () => {
            const headers = require(path.join(ROOT, 'lib/serviceSigning.js')).signHeaders({ method: 'POST', url: '/api/nextgent/link', rawBody: '{"companyId":"co-1"}' }, { key: SECRET });
            const res = await realFetch(`${base()}/api/nextgent/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: '{"companyId":"co-2"}',
            });
            return res.status;
        })();
        check('a body that does not match its signature is refused', tampered === 401);

        console.log('\n── link ──');
        const made = await signed('POST', '/api/nextgent/link', { companyId: 'co-new', create: { name: 'New Taco Shop', kind: 'restaurant', phone: '555-777-8888' } });
        check('create makes a business and links it', made.status === 201 && made.body.entitySlug === 'new-taco-shop', JSON.stringify(made.body));
        check('with a forwarding address from the intake mechanism', made.body.forwardingAddress === 'gcr-new-taco-shop@parse.example.test');
        check('and a business token, once', /^gcr_mcp_/.test(made.body.businessToken || ''));
        const ent = T.entity.find((e) => e.slug === 'new-taco-shop');
        check('the business kind comes back (Paperclip store audiences)', made.body.kind === 'restaurant', JSON.stringify(made.body));
        check('the new business is hidden until reviewed', ent && ent.is_active === false && ent.entity_type === 'restaurant');
        check('the link is recorded', T.company_links.some((l) => l.company_id === 'co-new' && l.entity_slug === 'new-taco-shop'));
        const tokRow = T.business_mcp_tokens.find((t) => t.token_hash === sha(made.body.businessToken));
        check('the token is stored as a hash only', !!tokRow && !JSON.stringify(T.business_mcp_tokens).includes(made.body.businessToken));
        check('it is the company-level token: company_id, no install', tokRow.company_id === 'co-new' && !tokRow.install_id);
        check('with read and write on every resource', tokRow.permissions.includes('menu:write') && tokRow.permissions.includes('bookings:read') && tokRow.scope === 'write');

        const again = await signed('POST', '/api/nextgent/link', { companyId: 'co-new', create: { name: 'New Taco Shop', kind: 'restaurant' } });
        check('a repeat is idempotent: same business', again.status === 200 && again.body.entitySlug === 'new-taco-shop');
        check('and no second token', again.body.businessToken === null && again.body.businessTokenIssued === true);
        const rotated = await signed('POST', '/api/nextgent/link', { companyId: 'co-new', rotateToken: true });
        check('rotateToken issues a new one', /^gcr_mcp_/.test(rotated.body.businessToken || ''), JSON.stringify(rotated));
        check('and revokes the old', !!T.business_mcp_tokens.find((t) => t.token_hash === sha(made.body.businessToken)).revoked_at);

        const unclaimed = await signed('POST', '/api/nextgent/link', { companyId: 'co-x', entitySlug: 'listed-cafe' });
        check('linking an existing listing needs a claim first', unclaimed.status === 409 && unclaimed.body.claimRequired === true);
        const dupPhone = await signed('POST', '/api/nextgent/link', { companyId: 'co-y', create: { name: 'Copy Cafe', kind: 'cafe', phone: '+15550102030' } });
        check('creating with a listed phone points at the claim instead', dupPhone.status === 409 && dupPhone.body.claimInstead?.slug === 'listed-cafe');

        console.log('\n── entitlement ──');
        const q = (item) => signed('GET', `/api/nextgent/entitlement?companyId=co-new&itemKey=${item}`);
        const unknown = await q('not-in-billing');
        check('an item billing has never heard of is allowed, unpriced', unknown.body.allowed === true && unknown.body.reason === 'unpriced' && unknown.body.priceCents === 0);
        const paid = await q('review-agent');
        check('a priced item is allowed with its price', paid.body.allowed === true && paid.body.priceCents === 1500 && paid.body.interval === 'month', JSON.stringify(paid.body));
        const planOnly = await q('pro-only');
        check('a plan item not in this plan is refused', planOnly.body.allowed === false && planOnly.body.reason === 'not_entitled');
        const notLinked = await signed('GET', '/api/nextgent/entitlement?companyId=co-none&itemKey=qr-menu');
        check('an unlinked company is refused', notLinked.body.allowed === false && notLinked.body.reason === 'not_linked');

        console.log('\n── item prices from Paperclip (CONTRACT §12) ──');
        const unsignedPrice = await signed('PUT', '/api/nextgent/items/brand-new-agent/price', { amountCents: 2500, currency: 'usd', interval: 'month' }, { sign: false });
        check('setting a price must be signed', unsignedPrice.status === 401);
        const badPrice = await signed('PUT', '/api/nextgent/items/brand-new-agent/price', { amountCents: -1, currency: 'usd', interval: 'month' });
        check('a negative price is refused', badPrice.status === 400);
        const badIv = await signed('PUT', '/api/nextgent/items/brand-new-agent/price', { amountCents: 100, currency: 'usd', interval: 'fortnight' });
        check('an unknown interval is refused', badIv.status === 400);
        stripeCalls.length = 0;
        const setP = await signed('PUT', '/api/nextgent/items/brand-new-agent/price', { amountCents: 2500, currency: 'USD', interval: 'month', model: 'flat' });
        check('a price is stored', setP.status === 200 && setP.body.amountCents === 2500 && setP.body.currency === 'usd' && setP.body.model === 'flat', JSON.stringify(setP.body));
        check('a Stripe product and recurring price are made for it', stripeCalls.some((c) => c[0] === 'products.create') && stripeCalls.some((c) => c[0] === 'prices.create' && c[1].unit_amount === 2500 && c[1].recurring?.interval === 'month'));
        const priced = await q('brand-new-agent');
        check('entitlement now reports that price', priced.body.allowed === true && priced.body.priceCents === 2500 && priced.body.interval === 'month', JSON.stringify(priced.body));
        stripeCalls.length = 0;
        await signed('PUT', '/api/nextgent/items/brand-new-agent/price', { amountCents: 2500, currency: 'usd', interval: 'month', model: 'flat' });
        check('the same price again makes no new Stripe price', !stripeCalls.some((c) => c[0] === 'prices.create'));
        await signed('PUT', '/api/nextgent/items/review-agent/price', { amountCents: 1900, currency: 'usd', interval: 'month' });
        const repriced = await q('review-agent');
        check('a store item takes the price Paperclip set', repriced.body.priceCents === 1900, JSON.stringify(repriced.body));
        check('and keeps its own row otherwise', T.store_items.find((i) => i.key === 'review-agent').price_cents === 1500);
        // Put review-agent back to the price the rest of this test expects.
        await signed('PUT', '/api/nextgent/items/review-agent/price', { amountCents: 1500, currency: 'usd', interval: 'month' });
        T.billing_item_prices.find((p) => p.item_key === 'review-agent').stripe_price_id = 'price_rev';

        console.log('\n── installs ──');
        const badPerm = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-0', itemKey: 'qr-menu', kind: 'app', permissions: ['menu:delete'] });
        check('an unknown permission is refused', badPerm.status === 400);
        const appInst = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-1', itemKey: 'qr-menu', kind: 'app', version: '1.0.0', permissions: ['menu:read'] });
        check('an app install returns a token', appInst.status === 201 && /^gcr_mcp_/.test(appInst.body.token || ''), JSON.stringify(appInst.body));
        const appRow = T.business_mcp_tokens.find((t) => t.install_id === 'in-1');
        check('limited to what was approved', JSON.stringify(appRow.permissions) === '["menu:read"]' && appRow.scope === 'read');
        check('the install is recorded', T.nextgent_installs.some((i) => i.install_id === 'in-1' && i.status === 'active'));

        console.log('\n── that token, at the business data routes ──');
        const appTok = appInst.body.token;
        const menu = await asUser('GET', '/api/business/menu_items', undefined, appTok);
        check('menu:read reads menu_items', menu.status === 200 && menu.body.rows?.length === 1, JSON.stringify(menu.body));
        check('only this business\'s rows', menu.body.rows.every((r) => r.entity_slug === 'new-taco-shop'));
        const faqs = await asUser('GET', '/api/business/faqs', undefined, appTok);
        check('menu:read is refused faqs', faqs.status === 403, JSON.stringify(faqs.body));
        const write = await asUser('POST', '/api/business/menu_items', { name: 'Hack' }, appTok);
        check('menu:read may not write', write.status === 403);
        const schema = await asUser('GET', '/api/business/schema', undefined, appTok);
        check('the schema lists only readable sections', JSON.stringify(schema.body.tables) === '["menu_items"]', JSON.stringify(schema.body.tables));
        check('credential tables are never sections', !schema.body.tables.includes('business_mcp_tokens'));

        console.log('\n── contracts at the business data routes (DECISIONS #45) ──');
        const prodInst = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-c', itemKey: 'shop-app', kind: 'app', version: '1.0.0', permissions: ['business:read', 'business:write'] });
        const prodTok = prodInst.body.token;
        const products = await asUser('GET', '/api/business/products.items', undefined, prodTok);
        check('products.items reads offerings kind=product, this business only', products.status === 200 && products.body.rows.length === 1 && products.body.rows[0].name === 'Salsa jar' && products.body.table === 'offerings' && products.body.contract === 'products.items', JSON.stringify(products.body));
        const madeProd = await asUser('POST', '/api/business/products.items', { name: 'Hot sauce', kind: 'service', entity_slug: 'listed-cafe' }, prodTok);
        const prodRow = T.offerings.find((o) => o.name === 'Hot sauce');
        check('a write through the contract stamps the filter and the slug, whatever the body says', madeProd.status === 201 && prodRow?.kind === 'product' && prodRow.entity_slug === 'new-taco-shop', JSON.stringify(madeProd.body));
        const notProd = await asUser('PATCH', '/api/business/products.items/11', { name: 'Renamed' }, prodTok);
        check('a row of another kind is out of reach through the contract', notProd.status === 404 && T.offerings.find((o) => o.id === 11).name === 'Catering', JSON.stringify(notProd.body));
        check('the raw table still works', (await asUser('GET', '/api/business/offerings', undefined, prodTok)).body.rows?.length === 3);
        check('menu.items needs menu, not business', (await asUser('GET', '/api/business/menu.items', undefined, prodTok)).status === 403);
        const viaMenu = await asUser('GET', '/api/business/menu.items', undefined, appTok);
        check('menu:read reads menu.items', viaMenu.status === 200 && viaMenu.body.rows.length === 1 && viaMenu.body.table === 'menu_items', JSON.stringify(viaMenu.body));
        check('and not products.items', (await asUser('GET', '/api/business/products.items', undefined, appTok)).status === 403);
        check('an unknown contract is not a section', (await asUser('GET', '/api/business/nope.items', undefined, prodTok)).status === 400);
        check('a contract whose table this database lacks is not a section either', (await asUser('GET', '/api/business/media.images', undefined, prodTok)).status === 400);
        check('the business record is read-only through contracts', (await asUser('POST', '/api/business/business.profile', { name: 'X' }, prodTok)).status === 403);
        const leads = await asUser('GET', '/api/business/leads.items', undefined, prodTok);
        check('leads.items is the permissioned door to it: this business\'s leads', leads.status === 200 && leads.body.rows.length === 1 && leads.body.rows[0].name === 'Asker', JSON.stringify(leads.body));
        const lead = await asUser('POST', '/api/business/leads.items', { name: 'New asker', email: 'n@example.test', message: 'Hi', source: 'shop-app' }, prodTok);
        check('an app with business:write records a lead for its business', lead.status === 201 && T.entity_leads.find((l) => l.name === 'New asker')?.entity_slug === 'new-taco-shop', JSON.stringify(lead.body));
        process.env.DEFAULT_CURRENCY = 'usd';
        const cur = await asUser('GET', '/api/business/business.currency', undefined, prodTok);
        check('business.currency is a scalar: { value }, the environment default when the business set none (DECISIONS #56)', cur.status === 200 && cur.body.value === 'usd' && cur.body.contract === 'business.currency' && !('rows' in cur.body), JSON.stringify(cur.body));
        T.entity.find((e) => e.slug === 'new-taco-shop').currency = 'eur';
        check('a set currency wins', (await asUser('GET', '/api/business/business.currency', undefined, prodTok)).body.value === 'eur');
        delete process.env.DEFAULT_CURRENCY;
        check('the dotted name arrives as one path segment, URL-encoded or not', (await asUser('GET', '/api/business/' + encodeURIComponent('business.currency'), undefined, prodTok)).body.value === 'eur');
        const links = await asUser('GET', '/api/business/business.links', undefined, prodTok);
        check('business.links reads the business record by its slug', links.status === 200 && links.body.table === 'entity' && links.body.rows.length === 1 && links.body.rows[0].slug === 'new-taco-shop', JSON.stringify(links.body));

        console.log('\n── short-lived install tokens ──');
        const unsignedSess = await signed('POST', '/api/nextgent/installs/in-1/session', {}, { sign: false });
        check('a session token must be asked for with a signature', unsignedSess.status === 401);
        const sess = await signed('POST', '/api/nextgent/installs/in-1/session', { companyId: 'co-new' });
        const ttl = (Date.parse(sess.body.expiresAt) - Date.now()) / 1000;
        check('it returns { token, expiresAt } within 300 s', sess.status === 201 && /^gcr_mcp_ist\./.test(sess.body.token || '') && ttl > 0 && ttl <= 300, JSON.stringify(sess.body));
        check('nothing about it is stored', !T.business_mcp_tokens.some((t) => t.token_hash === sha(sess.body.token)));
        const sessMenu = await asUser('GET', '/api/business/menu_items', undefined, sess.body.token);
        check('it reads what the install may read', sessMenu.status === 200 && sessMenu.body.rows.every((r) => r.entity_slug === 'new-taco-shop'), JSON.stringify(sessMenu.body));
        const sessFaq = await asUser('GET', '/api/business/faqs', undefined, sess.body.token);
        check('and nothing else', sessFaq.status === 403);
        const forged = sess.body.token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
        check('a tampered one is refused', (await asUser('GET', '/api/business/menu_items', undefined, forged)).status === 401);
        const otherCo = await signed('POST', '/api/nextgent/installs/in-1/session', { companyId: 'co-other' });
        check('another company cannot get one for this install', otherCo.status === 404);
        process.env.INSTALL_SESSION_TTL_SECONDS = '9999';
        const capped = await signed('POST', '/api/nextgent/installs/in-1/session', {});
        check('a TTL set above 300 s is held to 300', (Date.parse(capped.body.expiresAt) - Date.now()) / 1000 <= 300);
        process.env.INSTALL_SESSION_TTL_SECONDS = '1';
        const shortSess = await signed('POST', '/api/nextgent/installs/in-1/session', {});
        delete process.env.INSTALL_SESSION_TTL_SECONDS;
        await new Promise((r) => setTimeout(r, 1100));
        const expired = await asUser('GET', '/api/business/menu_items', undefined, shortSess.body.token);
        check('an expired one is refused', expired.status === 401 && /expired/.test(expired.body.error), JSON.stringify(expired.body));
        const keptSession = sess.body.token;

        const upd = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-1', itemKey: 'qr-menu', kind: 'app', version: '1.1.0', permissions: ['menu:read', 'menu:write'] });
        check('a repeat install updates permissions', upd.body.updated === true && appRow.permissions.includes('menu:write') && appRow.scope === 'write');

        stripeCalls.length = 0;
        const paidInst = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-2', itemKey: 'review-agent', kind: 'agent', permissions: ['reviews:read'] });
        check('a priced agent install is charged', paidInst.status === 201 && paidInst.body.charged === true && paidInst.body.priceCents === 1500);
        const charge = stripeCalls.find(([n]) => n === 'subscriptions.create' || n === 'subscriptionItems.create');
        check('the Stripe call carries an idempotency key for this install, so a retry cannot bill twice',
            !!charge && typeof charge[2]?.idempotencyKey === 'string' && /in-2/.test(charge[2].idempotencyKey) && /review-agent/.test(charge[2].idempotencyKey), JSON.stringify(charge));
        check('a Stripe customer is made for the business', stripeCalls.some(([n, a]) => n === 'customers.create' && a.metadata.entity_slug === 'new-taco-shop'));
        check('and a subscription with the item\'s price', stripeCalls.some(([n, a]) => n === 'subscriptions.create' && a.items[0].price === 'price_rev'));
        check('the charge is recorded', T.billing_item_charges.some((c) => c.install_id === 'in-2' && c.price_cents === 1500 && c.status === 'active'));
        stripeCalls.length = 0;
        await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-3', itemKey: 'setup-pack', kind: 'app', permissions: [] });
        check('a one-time price becomes an invoice item', stripeCalls.some(([n, a]) => n === 'invoiceItems.create' && a.price === 'price_setup'));

        const noSuch = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-x', itemKey: 'no-such-automation', kind: 'automation', permissions: [] });
        check('an automation install with no automation behind it is refused, nothing recorded', noSuch.status === 409 && !T.nextgent_installs.some((i) => i.install_id === 'in-x'));
        const auto = await signed('POST', '/api/nextgent/installs', {
            companyId: 'co-new', installId: 'in-4', itemKey: 'review-request', kind: 'automation', version: '1', permissions: [],
            routine: { webhookUrl: 'https://paperclip.test/routines/r1', webhookSecret: 'whsec-plain' },
        });
        check('an automation install has no token', auto.status === 201 && !auto.body.token, JSON.stringify(auto.body));
        const ea = T.entity_automations.find((r) => r.automation_id === 'auto-1' && r.entity_slug === 'new-taco-shop');
        check('it puts that automation version on the business, switched on', ea && ea.version === 1 && ea.enabled === true && /^[a-f0-9]{48}$/.test(ea.hook_token), JSON.stringify(ea));
        const autoUpd = await signed('POST', '/api/nextgent/installs', { companyId: 'co-new', installId: 'in-4', itemKey: 'review-request', kind: 'automation', version: '2', permissions: [] });
        check('an update moves it to the new version, keeping its settings', autoUpd.status === 200 && ea.version === 2 && T.entity_automations.length === 1);
        const autoRow = T.nextgent_installs.find((i) => i.install_id === 'in-4');
        check('its routine secret is not stored in the clear', autoRow.routine_webhook_secret && !autoRow.routine_webhook_secret.includes('whsec-plain'));
        const routine = await require(path.join(ROOT, 'routes/nextgent.js')).routineFor('in-4');
        check('and part 2 can read it back', routine.webhookSecret === 'whsec-plain' && routine.webhookUrl.endsWith('/r1'));

        stripeCalls.length = 0;
        const del = await signed('DELETE', '/api/nextgent/installs/in-2');
        check('DELETE revokes the install token', del.body.tokensRevoked === 1 && !!T.business_mcp_tokens.find((t) => t.install_id === 'in-2').revoked_at);
        check('marks it removed', T.nextgent_installs.find((i) => i.install_id === 'in-2').status === 'removed');
        check('and stops its charge', stripeCalls.some(([n, id]) => n === 'subscriptionItems.del' && id === 'si_1')
            && T.billing_item_charges.find((c) => c.install_id === 'in-2').status === 'removed');

        const autoSess = await signed('POST', '/api/nextgent/installs/in-4/session', {});
        check('an automation install has no session token', autoSess.status === 409);
        const delAuto = await signed('DELETE', '/api/nextgent/installs/in-4');
        check('removing an automation install switches it off', delAuto.body.automationsDisabled === 1 && ea.enabled === false && T.entity_automations.length === 1);

        console.log('\n── usage from LiteLLM ──');
        delete process.env.LITELLM_USAGE_PULL;
        const pushedWhilePull = await signed('POST', '/api/nextgent/usage', { companyId: 'co-new', periodStart: new Date(Date.now() - 3600e3).toISOString(), periodEnd: new Date().toISOString(), spendUsd: 1.25 });
        check('the pull is on by default, so pushed usage is refused (no double billing)', pushedWhilePull.status === 409 && pushedWhilePull.body.code === 'usage_pull_on' && !T.billing_usage_credits.length, JSON.stringify(pushedWhilePull.body));
        process.env.LITELLM_USAGE_PULL = 'false';
        const usage = await signed('POST', '/api/nextgent/usage', { companyId: 'co-new', periodStart: new Date(Date.now() - 3600e3).toISOString(), periodEnd: new Date().toISOString(), spendUsd: 1.25 });
        check('spend becomes credits', usage.body.recorded && usage.body.credits === 125, JSON.stringify(usage.body));
        check('and the month total feeds billing_usage', T.billing_usage.some((u) => u.entity_slug === 'new-taco-shop' && u.dimension === 'ai_credits' && u.value === 125));

        console.log('\n── non-payment pauses, never deletes ──');
        const sub = T.billing_subscription.find((s) => s.entity_slug === 'new-taco-shop');
        await billingStripe.applyStripeEvent({ type: 'invoice.payment_failed', data: { object: { id: 'in_1', customer: 'cus_1' } } },
            { now: new Date(Date.now() - 8 * 864e5) });
        check('a failed payment starts the clock', sub.status === 'past_due' && !!sub.payment_failed_since);
        const paused = await q('review-agent');
        check('past the grace period, paid items are refused as paused', paused.body.allowed === false && paused.body.reason === 'paused');
        const free = await q('qr-menu');
        check('free items still install', free.body.allowed === true);
        await billingStripe.applyStripeEvent({ type: 'invoice.paid', data: { object: { customer: 'cus_1' } } });
        check('a paid invoice clears it', sub.status === 'active' && sub.payment_failed_since === null);

        console.log('\n── claims ──');
        const tok = pcToken();
        lineType = 'mobile';
        carrier.length = 0;
        const start = await asUser('POST', '/api/claims/start', { entitySlug: 'listed-cafe' }, tok);
        check('a code goes out by text to a mobile', start.status === 201 && start.body.channel === 'sms', JSON.stringify(start.body));
        const textSent = carrier.find((c) => c.url.endsWith('/messages'));
        check('to the phone on the listing, from the platform number', textSent?.body.to === '+15550102030' && textSent.body.from === '+15550000001');
        const code = textSent.body.text.match(/^(\d+)/)[1];
        check('the code is not stored', !JSON.stringify(T.claim_codes).includes(`"${code}"`));
        const wrong = await asUser('POST', '/api/claims/verify', { claimId: start.body.claimId, code: code === '000000' ? '111111' : '000000' }, tok);
        check('a wrong code is refused with attempts left', wrong.status === 400 && wrong.body.attemptsLeft === 4, JSON.stringify(wrong));
        const other = await asUser('POST', '/api/claims/verify', { claimId: start.body.claimId, code }, pcToken({ company_id: 'co-thief' }));
        check('another company cannot use the claim', other.status === 404);
        const right = await asUser('POST', '/api/claims/verify', { claimId: start.body.claimId, code }, tok);
        check('the right code links the company', right.body.linked === true && T.company_links.some((l) => l.company_id === 'co-claim' && l.entity_slug === 'listed-cafe'));
        const reuse = await asUser('POST', '/api/claims/verify', { claimId: start.body.claimId, code }, tok);
        check('a used code cannot be used again', reuse.status === 409);
        const linkedNow = await signed('POST', '/api/nextgent/link', { companyId: 'co-claim', entitySlug: 'listed-cafe' });
        check('after the claim, link completes setup for that business', linkedNow.status === 200 && /^gcr_mcp_/.test(linkedNow.body.businessToken || ''));
        const twice = await asUser('POST', '/api/claims/start', { entitySlug: 'landline-inn' }, tok);
        check('a linked company cannot claim a second business', twice.status === 409);

        lineType = 'fixed line';
        carrier.length = 0;
        const land = await asUser('POST', '/api/claims/start', { entitySlug: 'landline-inn' }, pcToken({ company_id: 'co-land' }));
        check('a landline gets a call instead', land.body.channel === 'voice');
        const call = carrier.find((c) => c.url.endsWith('/calls'));
        check('placed through the say webhook', call?.body.webhook_url === 'https://api.example.test/api/telephony/telnyx/say');

        const owned = await asUser('POST', '/api/claims/start', { entitySlug: 'owned-bar' }, pcToken({ company_id: 'co-owned' }));
        check('a listing that already has an owner goes to review', owned.status === 202 && owned.body.status === 'review');
        const reviewRow = T.business_claims.find((c) => c.entity_slug === 'owned-bar');
        check('filed in business_claims with who asked', reviewRow?.paperclip_company_id === 'co-owned' && reviewRow.status === 'new');

        console.log('\n── business kinds (store audiences, DECISIONS #32) ──');
        // Linked now: co-new -> new-taco-shop (restaurant), co-claim -> listed-cafe
        // (restaurant). A link to a business with no kind is left out.
        const untyped = { company_id: 'co-untyped', entity_slug: 'landline-inn' };
        T.company_links.push(untyped);
        const unsignedKinds = await signed('GET', '/api/nextgent/business-kinds', undefined, { sign: false });
        check('business kinds must be asked for with a signature', unsignedKinds.status === 401);
        const kinds = await signed('GET', '/api/nextgent/business-kinds');
        check('linked companies are grouped by their business\'s entity_type, with their ids',
            kinds.status === 200 && JSON.stringify(kinds.body) === JSON.stringify([{ key: 'restaurant', count: 2, companyIds: ['co-claim', 'co-new'] }]), JSON.stringify(kinds.body));
        check('a linked business with no kind is left out', !JSON.stringify(kinds.body).includes('co-untyped'));
        T.company_links.splice(T.company_links.indexOf(untyped), 1);

        console.log('\n── owner notifications ──');
        const { notifyOwner } = require(path.join(ROOT, 'lib/notify.js'));
        const skip = await notifyOwner('landline-inn', { kind: 'review', title: 'x' });
        check('an unclaimed business is not notified', skip.skipped === 'not_claimed');
        emails.length = 0; carrier.length = 0;
        const sent = await notifyOwner('listed-cafe', { kind: 'review', title: 'A forwarded email needs a look', ref: 'log-1' });
        check('a claimed business is emailed', sent.sent && emails[0]?.to === 'cafe@example.test');
        check('and texted from the platform number', carrier.some((c) => c.url.endsWith('/messages') && c.body.from === '+15550000001'));
        const dup = await notifyOwner('listed-cafe', { kind: 'review', title: 'again', ref: 'log-1' });
        check('the same item is not announced twice', dup.skipped === 'duplicate');
        const badKind = await notifyOwner('listed-cafe', { kind: 'marketing', title: 'x' });
        check('only the four kinds exist', badKind.skipped === 'unknown_kind');

        console.log('\n── unlink ──');
        uploads.length = 0;
        const gone = await signed('POST', '/api/nextgent/unlink', { companyId: 'co-new', export: true });
        check('unlink with export returns a link', gone.body.unlinked === true && /storage\.example\.test\/exports\/new-taco-shop\//.test(gone.body.exportUrl || ''), JSON.stringify(gone.body));
        check('the export holds the business\'s rows', uploads[0]?.body.entity?.slug === 'new-taco-shop');
        check('every company token is revoked', T.business_mcp_tokens.filter((t) => t.company_id === 'co-new').every((t) => t.revoked_at));
        check('every install is removed', T.nextgent_installs.filter((i) => i.company_id === 'co-new').every((i) => i.status === 'removed'));
        check('the link is gone, the business is not', !T.company_links.some((l) => l.company_id === 'co-new') && T.entity.some((e) => e.slug === 'new-taco-shop'));
        const stale = await asUser('GET', '/api/business/menu_items', undefined, appTok);
        check('an unlinked install token stops working', stale.status === 401);
        const staleSess = await asUser('GET', '/api/business/menu_items', undefined, keptSession);
        check('and so does a live session token of that install', staleSess.status === 401, JSON.stringify(staleSess.body));
        const again2 = await signed('POST', '/api/nextgent/unlink', { companyId: 'co-new' });
        check('unlinking twice is harmless', again2.body.alreadyUnlinked === true);
    } catch (e) {
        fail++;
        console.log('  FAIL threw:', e.stack);
    }

    console.log(`\n${pass} passed, ${fail} failed\n`);
    server.close();
    process.exit(fail ? 1 : 0);
}
