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

