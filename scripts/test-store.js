#!/usr/bin/env node
// The store, end to end, against an in-memory database: the operator adds an
// item, publishes, chooses who may have it and pushes; businesses see only
// what they are entitled to, accept new access before they get it, and are
// never moved onto a version that widens access without saying yes.
// No credentials, no network.
'use strict';
const path = require('path');
const http = require('http');
const Module = require('module');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';

/* ── an in-memory PostgREST, just enough for these routes ─────────────── */
const db = {
    entity: [
        { slug: 'flora-bama', is_active: true, entity_type: 'bar' },
        { slug: 'lulus', is_active: true, entity_type: 'restaurant' },
        { slug: 'pier', is_active: true, entity_type: 'bar' },
    ],
    entity_owners: [
        { user_id: 'u-fb', entity_slug: 'flora-bama', role: 'owner' },
        { user_id: 'u-lulu', entity_slug: 'lulus', role: 'owner' },
        { user_id: 'u-pier', entity_slug: 'pier', role: 'owner' },
    ],
    platform_admins: [],
    billing_plan: [
        { key: 'free', name: 'Free', is_default: true, sort_order: 0 },
        { key: 'pro', name: 'Pro', is_default: false, sort_order: 1 },
    ],
    billing_subscription: [{ entity_slug: 'lulus', plan_key: 'pro', status: 'active' }],
    store_items: [], store_versions: [], store_plan_items: [], store_grants: [],
    store_installs: [], store_deployments: [],
};
const UNIQUE = {
    store_items: [['key']],
    store_versions: [['item_id', 'version'], ['item_id', 'semver']],
    store_installs: [['entity_slug', 'item_id']],
    billing_plan: [['key']],
};
const writes = [];

function query(table) {
    const q = { table, filters: [], op: 'select', one: false };
    const rows = () => (db[table] || []).filter((r) => q.filters.every((f) => f(r)));
    const run = () => {
        if (!db[table]) return { data: null, error: { message: `relation "${table}" does not exist` } };
        if (q.op === 'insert') {
            const list = (Array.isArray(q.value) ? q.value : [q.value]).map((v) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...v }));
            for (const r of list) {
                for (const cols of UNIQUE[table] || []) {
                    if (db[table].some((x) => cols.every((c) => x[c] === r[c]))) return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
                }
            }
            db[table].push(...list);
            writes.push({ table, op: 'insert', rows: list });
            return { data: q.one ? list[0] : list, error: null };
        }
        if (q.op === 'upsert') {
            const cols = q.onConflict.split(',');
            const v = q.value;
            const hit = db[table].find((x) => cols.every((c) => x[c] === v[c]));
            if (hit) Object.assign(hit, v); else db[table].push({ ...v });
            writes.push({ table, op: 'upsert', row: v });
            return { data: v, error: null };
        }
        if (q.op === 'update') {
            const hit = rows();
            hit.forEach((r) => Object.assign(r, q.value));
            writes.push({ table, op: 'update', value: q.value, n: hit.length });
            return { data: q.one ? hit[0] || null : hit, error: null };
        }
        if (q.op === 'delete') {
            const hit = new Set(rows());
            db[table] = db[table].filter((r) => !hit.has(r));
            return { data: null, error: null };
        }
        let out = rows();
        if (q.order) out = [...out].sort((a, b) => (a[q.order.col] > b[q.order.col] ? 1 : -1) * (q.order.asc ? 1 : -1));
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        if (q.limit) out = out.slice(0, q.limit);
        return { data: q.one ? out[0] || null : out, error: null };
    };
    const self = {
        select() { return self; },
        insert(v) { q.op = 'insert'; q.value = v; return self; },
        upsert(v, o) { q.op = 'upsert'; q.value = v; q.onConflict = o?.onConflict || 'id'; return self; },
        update(v) { q.op = 'update'; q.value = v; return self; },
        delete() { q.op = 'delete'; return self; },
        eq(k, v) { q.filters.push((r) => r[k] === v); return self; },
        neq(k, v) { q.filters.push((r) => r[k] !== v); return self; },
        is(k, v) { q.filters.push((r) => (r[k] ?? null) === v); return self; },
        in(k, vs) { q.filters.push((r) => vs.includes(r[k])); return self; },
        not() { return self; },
        order(col, o) { q.order = { col, asc: o?.ascending !== false }; return self; },
        range(a, b) { q.range = [a, b]; return self; },
        limit(n) { q.limit = n; return self; },
        maybeSingle() { q.one = true; return Promise.resolve(run()); },
        single() { q.one = true; return Promise.resolve(run()); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return self;
}
const dbStub = {
    from: (t) => query(t),
    auth: { getUser: async (token) => (token && token.startsWith('owner:') ? { data: { user: { id: token.slice(6) } }, error: null } : { data: null, error: new Error('no') }) },
};
function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.resolve(__dirname, '..', 'db.js'), dbStub);

const ent = require('../lib/entitlements');
const { prepareVersion } = require('../lib/storeManifest');
const store = require('../routes/store');
const app = express();
app.use(express.json());
app.use('/api/admin/store', store);
app.use('/api/store', store.ownerRouter);

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || detail === undefined ? '' : `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    if (!ok) failures += 1;
}
const ADMIN = `Bearer ${jwt.sign({ userId: 'op', role: 'admin' }, 'test-secret')}`;
const OWNER = (u) => `Bearer owner:${u}`;
function call(server, method, url, auth, body) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method,
            headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
            let text = ''; res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch (_) { /* empty */ } resolve({ status: res.statusCode, json }); });
        });
        if (data) req.write(data);
        req.end();
    });
}
const seen = (list, key) => list.find((i) => i.key === key);

(async () => {
    console.log('Pure rules');
    const now = new Date('2026-09-29T12:00:00Z');
    const item = { id: 'i1', status: 'published', access: 'plan' };
    check('unpublished is never reachable', !ent.decide({ item: { ...item, status: 'draft' }, planItemIds: new Set(['i1']) }).ok);
    check('free reaches everyone', ent.decide({ item: { ...item, access: 'free' } }).reason === 'free');
    check('plan reaches a plan that includes it', ent.decide({ item, planItemIds: new Set(['i1']) }).reason === 'plan');
    check('plan does not reach a plan without it', !ent.decide({ item, planItemIds: new Set() }).ok);
    check('grant-only is not reached by a plan', !ent.decide({ item: { ...item, access: 'grant' }, planItemIds: new Set(['i1']) }).ok);
    check('a live grant reaches anything', ent.decide({ item: { ...item, access: 'grant' }, grant: { expires_at: null }, now }).reason === 'grant');
    check('an expired grant does not', !ent.decide({ item: { ...item, access: 'grant' }, grant: { expires_at: '2026-09-01T00:00:00Z' }, now }).ok);
    check('a revoked grant does not', !ent.decide({ item: { ...item, access: 'grant' }, grant: { revoked_at: '2026-09-02' }, now }).ok);
    check('available = newer of released and offered', ent.availableVersion({ released_version: 2 }, { offered_version: 3 }) === 3 && ent.availableVersion({ released_version: 2 }, null) === 2 && ent.availableVersion({}, null) === null);
    check('new permissions are the ones not yet accepted', JSON.stringify(ent.newPermissions(['a'], ['a', 'b'])) === '["b"]');
    check('an app manifest needs a runtime', !prepareVersion({ kind: 'app', key: 'x', name: 'X', publisher: 'op' }, { semver: '1.0.0', manifest: {} }).ok);
    check('the store fills id, name, publisher, version', prepareVersion({ kind: 'app', key: 'x', name: 'X', publisher: 'op' }, { semver: '1.0.0', manifest: { runtime: { kind: 'iframe' } } }).manifest.id === 'x');
    check('bad semver refused', !prepareVersion({ kind: 'map' }, { semver: 'v1' }).ok);

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        console.log('\nOperator');
        let r = await call(server, 'GET', '/api/admin/store/items', OWNER('u-fb'));
        check('an owner session cannot reach the operator store', r.status === 401 || r.status === 403);

        r = await call(server, 'POST', '/api/admin/store/items', ADMIN, { key: 'song-requests', kind: 'app', name: 'Song Requests', access: 'plan' });
        check('add an item', r.status === 201);
        const songs = r.json.item.id;
        r = await call(server, 'POST', '/api/admin/store/items', ADMIN, { key: 'reviews', kind: 'app', name: 'Authentic Reviews', access: 'free' });
        const reviews = r.json.item.id;
        r = await call(server, 'POST', '/api/admin/store/items', ADMIN, { key: 'pilot-map', kind: 'map', name: 'Pilot map', access: 'grant' });
        const pilot = r.json.item.id;

        r = await call(server, 'POST', `/api/admin/store/items/${songs}/versions`, ADMIN, { semver: '1.0.0', manifest: { runtime: { kind: 'iframe' }, permissions: ['payment.read'] } });
        check('publish 1.0.0', r.status === 201 && r.json.version.version === 1);
        r = await call(server, 'POST', `/api/admin/store/items/${songs}/versions`, ADMIN, { semver: '1.0.0', manifest: { runtime: { kind: 'iframe' } } });
        check('the same semver twice is refused', r.status === 409);
        await call(server, 'POST', `/api/admin/store/items/${reviews}/versions`, ADMIN, { semver: '1.0.0', manifest: { runtime: { kind: 'iframe' } } });
        await call(server, 'POST', `/api/admin/store/items/${pilot}/versions`, ADMIN, { semver: '0.1.0', manifest: {} });

        r = await call(server, 'GET', '/api/store', OWNER('u-lulu'));
        check('published but not released: nobody sees it', r.status === 200 && !seen(r.json.items, 'song-requests'));

        r = await call(server, 'PUT', '/api/admin/store/plans/pro', ADMIN, { item_ids: [songs] });
        check('put Song Requests in the Pro plan', r.status === 200 && db.store_plan_items.length === 1);
        await call(server, 'POST', `/api/admin/store/items/${songs}/deploy`, ADMIN, { action: 'release', version: 1 });
        await call(server, 'POST', `/api/admin/store/items/${reviews}/deploy`, ADMIN, { action: 'release', version: 1 });
        await call(server, 'POST', `/api/admin/store/items/${pilot}/deploy`, ADMIN, { action: 'release', version: 1 });

        console.log('\nWho sees what');
        const lulu = (await call(server, 'GET', '/api/store', OWNER('u-lulu'))).json.items;
        const fb = (await call(server, 'GET', '/api/store', OWNER('u-fb'))).json.items;
        check('Pro business sees Song Requests', !!seen(lulu, 'song-requests') && seen(lulu, 'song-requests').reason === 'plan');
        check('Free business does not', !seen(fb, 'song-requests'));
        check('everyone sees the free app', !!seen(fb, 'reviews') && !!seen(lulu, 'reviews'));
        check('nobody sees a grant-only item without a grant', !seen(fb, 'pilot-map') && !seen(lulu, 'pilot-map'));

        r = await call(server, 'POST', `/api/store/${songs}/install`, OWNER('u-fb'), { slug: 'lulus', accept_permissions: true });
        check('a business outside the plan cannot install it, even naming another slug', r.status === 403);

        r = await call(server, 'POST', '/api/admin/store/grants', ADMIN, { item_id: pilot, slugs: ['flora-bama'], note: 'pilot' });
        check('grant the pilot map to one business', r.status === 201 && r.json.granted === 1);
        check('it now sees it; the others still do not',
            !!seen((await call(server, 'GET', '/api/store', OWNER('u-fb'))).json.items, 'pilot-map')
            && !seen((await call(server, 'GET', '/api/store', OWNER('u-pier'))).json.items, 'pilot-map'));

        console.log('\nInstall and consent');
        r = await call(server, 'POST', `/api/store/${songs}/install`, OWNER('u-lulu'), {});
        check('install asks before giving access', r.status === 409 && JSON.stringify(r.json.permissions) === '["payment.read"]');
        r = await call(server, 'POST', `/api/store/${songs}/install`, OWNER('u-lulu'), { accept_permissions: true });
        check('install after saying yes', r.status === 200 && r.json.install.version === 1);
        const inst = db.store_installs.find((x) => x.entity_slug === 'lulus' && x.item_id === songs);
        check('the install is on the session business with what it accepted', inst && JSON.stringify(inst.granted_permissions) === '["payment.read"]');

        console.log('\nPushing updates');
        await call(server, 'POST', `/api/admin/store/items/${songs}/versions`, ADMIN, { semver: '1.1.0', manifest: { runtime: { kind: 'iframe' }, permissions: ['payment.read'] }, changelog: 'faster' });
        const before = writes.length;
        r = await call(server, 'POST', `/api/admin/store/items/${songs}/deploy/preview`, ADMIN, { action: 'force', version: 2, audience: { mode: 'all' } });
        check('preview: one install moves, two skipped as not entitled', r.json.apply === 1 && r.json.reasons.not_entitled === 2, r.json);
        check('preview writes nothing', writes.length === before, writes.slice(before));
        r = await call(server, 'POST', `/api/admin/store/items/${songs}/deploy`, ADMIN, { action: 'force', version: 2, audience: { mode: 'all' } });
        check('force 1.1.0 (same access): moved', r.status === 200 && inst.version === 2 && r.json.deployment.applied === 1);

        await call(server, 'POST', `/api/admin/store/items/${songs}/versions`, ADMIN, { semver: '2.0.0', manifest: { runtime: { kind: 'iframe' }, permissions: ['payment.read', 'customer.phone'] } });
        r = await call(server, 'POST', `/api/admin/store/items/${songs}/deploy`, ADMIN, { action: 'force', version: 3, audience: { mode: 'all' } });
        check('force a version that asks for more: not moved, offered instead', inst.version === 2 && inst.offered_version === 3 && r.json.needs_consent === 1, { inst, r: r.json });
        let mine = seen((await call(server, 'GET', '/api/store', OWNER('u-lulu'))).json.items, 'song-requests');
        check('the business sees the update and the new access it asks for', mine.update_available && JSON.stringify(mine.new_permissions) === '["customer.phone"]');
        r = await call(server, 'POST', `/api/store/${songs}/update`, OWNER('u-lulu'), {});
        check('update without saying yes is refused', r.status === 409 && inst.version === 2);
        r = await call(server, 'POST', `/api/store/${songs}/update`, OWNER('u-lulu'), { accept_permissions: true });
        check('update after yes', r.status === 200 && inst.version === 3 && inst.granted_permissions.includes('customer.phone'));

        r = await call(server, 'POST', `/api/admin/store/items/${songs}/deploy`, ADMIN, { action: 'force', version: 2, audience: { mode: 'slugs', slugs: ['lulus'] } });
        check('rollback: force the older version', inst.version === 2 && r.json.deployment.applied === 1);

        console.log('\nStaged rollout');
        await call(server, 'POST', `/api/admin/store/items/${reviews}/versions`, ADMIN, { semver: '1.1.0', manifest: { runtime: { kind: 'iframe' } } });
        await call(server, 'POST', `/api/store/${reviews}/install`, OWNER('u-fb'), {});
        await call(server, 'POST', `/api/store/${reviews}/install`, OWNER('u-pier'), {});
        await call(server, 'POST', `/api/admin/store/items/${reviews}/deploy`, ADMIN, { action: 'offer', version: 2, audience: { mode: 'slugs', slugs: ['flora-bama'] } });
        const fbReviews = seen((await call(server, 'GET', '/api/store', OWNER('u-fb'))).json.items, 'reviews');
        const pierReviews = seen((await call(server, 'GET', '/api/store', OWNER('u-pier'))).json.items, 'reviews');
        check('offered early to one business', fbReviews.update_available && fbReviews.available.semver === '1.1.0');
        check('the rest still on the released version, no update shown', !pierReviews.update_available && pierReviews.available.semver === '1.0.0');
        await call(server, 'POST', `/api/admin/store/items/${reviews}/deploy`, ADMIN, { action: 'release', version: 2 });
        check('release to all: now everyone sees it', seen((await call(server, 'GET', '/api/store', OWNER('u-pier'))).json.items, 'reviews').update_available);

        console.log('\nOperator installs, plans, business view');
        r = await call(server, 'POST', `/api/admin/store/items/${reviews}/deploy`, ADMIN, { action: 'install', version: 2, audience: { mode: 'slugs', slugs: ['lulus', 'flora-bama'] } });
        check('install for a business that lacks it; skip one that has it', r.json.deployment.applied === 1 && r.json.reasons.already_installed === 1, r.json);
        r = await call(server, 'PUT', '/api/admin/store/businesses/flora-bama/plan', ADMIN, { plan_key: 'pro' });
        check('move a business to Pro', r.status === 200);
        check('and it now sees the Pro app', !!seen((await call(server, 'GET', '/api/store', OWNER('u-fb'))).json.items, 'song-requests'));
        r = await call(server, 'GET', '/api/admin/store/businesses/pier', ADMIN);
        check('operator sees one business\'s plan and entitlements', r.json.plan === 'free' && r.json.items.find((i) => i.key === 'song-requests').entitlement.reason === 'not_entitled');

        console.log('\nSettings, disable, uninstall');
        db.store_versions.find((v) => v.item_id === reviews && v.version === 2).manifest.config = [{ key: 'min_stars' }];
        r = await call(server, 'PATCH', `/api/store/${reviews}/config`, OWNER('u-pier'), { config: { min_stars: 4, sneaky: true } });
        check('on a version that declares no settings, nothing is saved', r.status === 200 && Object.keys(r.json.config).length === 0, r.json);
        await call(server, 'POST', `/api/store/${reviews}/update`, OWNER('u-pier'), {});
        r = await call(server, 'PATCH', `/api/store/${reviews}/config`, OWNER('u-pier'), { config: { min_stars: 4, sneaky: true } });
        check('declared setting saved, undeclared dropped', r.json.config.min_stars === 4 && !('sneaky' in r.json.config), r.json);
        r = await call(server, 'POST', `/api/store/${reviews}/disable`, OWNER('u-pier'));
        check('disable', r.json.status === 'disabled');
        r = await call(server, 'DELETE', `/api/store/${reviews}`, OWNER('u-pier'));
        check('uninstall keeps the row, marks it', r.json.status === 'uninstalled' && db.store_installs.some((x) => x.entity_slug === 'pier' && x.item_id === reviews));

        r = await call(server, 'GET', '/api/store');
        check('the business store needs a session', r.status === 401);
    } finally {
        server.close();
    }
    console.log(failures ? `\nstore: ${failures} check(s) failed` : '\nstore: all checks passed');
    process.exit(failures ? 1 : 0);
})();
