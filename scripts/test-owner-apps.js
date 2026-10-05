#!/usr/bin/env node
// ============================================================
// Installed apps in entity_modules: Paperclip's projection, the public list,
// the owner's switches, and the legacy dashboard leaving them alone
// ============================================================
//
//     npm run test:owner-apps
//
// Boots routes/nextgent.js (signed), routes/app-data.js (public), routes/owner.js
// (ownerAuth stubbed to one business), routes/platform.js (the legacy
// dashboard's /state) and routes/gcr.js against the in-memory database.
// No credentials, no network.

const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc-secret';
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: SECRET,
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    GCR_SUPABASE_URL: 'https://db.example.test',
    GCR_SUPABASE_SERVICE_KEY: 'service',
    INTAKE_EMAIL_DOMAIN: 'parse.example.test',
});

// The legacy dashboard's own rows: a block app (settings.manifest) and a plain
// GCR module switch (no manifest). Neither is Paperclip's.
const legacyRow = { id: 'legacy-1', entity_slug: 'shop', module_key: 'menu', enabled: true, settings: { manifest: { block: 'menu' }, config: {}, showOnPublic: true }, sort_order: 0 };
const plainRow = { id: 'plain-1', entity_slug: 'shop', module_key: 'events', enabled: true, settings: {}, sort_order: 1 };

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'Shop', entity_type: 'cafe', is_active: true }, { slug: 'other', name: 'Other', entity_type: 'bar', is_active: true }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }, { company_id: 'co-2', entity_slug: 'other' }],
    entity_owners: [{ user_id: 'owner-1', entity_slug: 'shop' }],
    business_mcp_tokens: [],
    nextgent_installs: [],
    entity_modules: [legacyRow, plainRow],
    app_records: [],
    billing_item_prices: [],
    billing_plan: [{ key: 'base', is_default: true }],
    billing_subscription: [],
    store_plan_items: [],
    store_grants: [],
} });
inject(path.join(ROOT, 'db.js'), db);
inject(require.resolve('@supabase/supabase-js'), { createClient: () => db });
let session = { entitySlug: 'shop', authVia: 'paperclip', paperclip: { userId: 'pc-1', companyId: 'co-1' }, ownerUserId: null };
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, res, next) => (session ? (Object.assign(req, session), next()) : res.status(401).json({ error: 'no' })),
    sessionRequired: (req, res, next) => next(),
    resolveSessionSlug: async () => ({ reason: 'no sessions here' }),
});
// The legacy dashboard signs in through middleware/auth.js; its owner is
// entity_owners.user_id = req.siteId (routes/platform.js ownedSlug).
const pass = (req, _res, next) => { req.siteId = 'owner-1'; req.userId = 'owner-1'; next(); };
inject(path.join(ROOT, 'middleware/auth.js'), { authRequired: pass, adminRequired: pass, paperclipAdminGate: pass, consoleAdminClaims: () => null });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.test/rest/v1/')) {
        return { ok: true, status: 200, json: async () => ({ definitions: { app_records: { properties: { id: { type: 'string' }, entity_slug: { type: 'string' }, data: { type: 'string' } } } } }) };
    }
    return realFetch(url, init);
};

function manifest(id, version, over = {}) {
    return {
        schema_version: 1, id, name: id, version, publisher: 'test',
        runtime: { type: 'engine', engine: '1' },
        surfaces: [{ id: 'owner', kind: 'dashboard', path: '/owner' }, { id: 'public', kind: 'public', path: '/public' }],
        permissions: [],
        data: { namespace: id, tables: { notes: { public: 'read', columns: { title: { type: 'text' } } } } },
        config: [{ key: 'intro', type: 'text', default: 'Hello' }, { key: 'owner_email', type: 'text' }, { key: 'api_key', type: 'secret' }],
        ui: {
            sources: { notes: { from: 'app', table: 'notes', fields: [{ key: 'title', type: 'text' }], title: 'title' } },
            views: { owner: [{ type: 'collection', source: 'notes' }], public: [{ type: 'list', source: 'notes', intro: { setting: 'intro' } }] },
        },
        ...over,
    };
}

const appData = require(path.join(ROOT, 'routes/app-data.js'));
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/nextgent', require(path.join(ROOT, 'routes/nextgent.js')));
app.use('/api/public/apps', appData.publicRouter);
app.use('/api/public/business', appData.businessRouter);
app.use('/api/owner', require(path.join(ROOT, 'routes/owner.js')));
app.use('/api/platform', require(path.join(ROOT, 'routes/platform.js')));
app.use('/api/gcr', require(path.join(ROOT, 'routes/gcr.js')));
const server = app.listen(0, run);
const base = () => `http://127.0.0.1:${server.address().port}`;

async function call(method, url, body, headers = {}) {
    const res = await realFetch(`${base()}${url}`, {
        method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
}
function signed(method, url, body) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return call(method, url, body, require(path.join(ROOT, 'lib/serviceSigning.js')).signHeaders({ method, url, rawBody: raw }, { key: SECRET }));
}
const rowOf = (installId) => T.entity_modules.find((r) => r.install_id === installId);
const SHAPE = ['installId', 'appKey', 'version', 'renderMode', 'publicLabel', 'position', 'enabled', 'publicEnabled', 'config', 'manifest'];
const hasShape = (row) => row && SHAPE.every((k) => k in row);

const { check, done } = checker();

async function run() {
    try {
        console.log('\n── install projects an entity_modules row ──');
        const a = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-1', itemKey: 'notes-app', kind: 'app', version: '1.0.0', permissions: [], app: manifest('notes-app', '1.0.0'), enabled: true });
        const b = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-b', itemKey: 'board-app', kind: 'app', version: '2.0.0', permissions: [], app: manifest('board-app', '2.0.0') });
        const x = await signed('POST', '/api/nextgent/installs', { companyId: 'co-2', installId: 'app-x', itemKey: 'notes-app', kind: 'app', version: '1.0.0', permissions: [], app: manifest('notes-app', '1.0.0') });
        check('installs are accepted', a.status === 201 && b.status === 201 && x.status === 201, JSON.stringify([a.body, b.body, x.body]));
        const r1 = rowOf('app-1');
        check('one row per install: module_key = app key, managed_by paperclip, install and company ids', r1 && r1.entity_slug === 'shop' && r1.module_key === 'notes-app' && r1.managed_by === 'paperclip' && r1.company_id === 'co-1' && r1.version === '1.0.0', JSON.stringify(r1));
        check('settings hold the manifest, the config and the public flag', r1?.settings?.manifest?.id === 'notes-app' && JSON.stringify(r1.settings.config) === '{}' && r1.settings.showOnPublic === true && r1.enabled === true);
        check('the legacy rows are untouched by an install', T.entity_modules.includes(legacyRow) && T.entity_modules.includes(plainRow) && legacyRow.sort_order === 0);
        const noManifest = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-n', itemKey: 'plain-app', kind: 'app', version: '1.0.0', permissions: [] });
        check('an app sent without a manifest still projects (manifest null)', noManifest.status === 201 && rowOf('app-n')?.managed_by === 'paperclip' && !rowOf('app-n').settings.manifest, JSON.stringify(rowOf('app-n')));

        console.log('\n── PATCH /api/nextgent/installs/:id ──');
        const moved = await signed('PATCH', '/api/nextgent/installs/app-1', { version: '1.2.0', app: manifest('notes-app', '1.2.0'), enabled: false });
        check('version, manifest and enabled are re-projected', moved.status === 200 && r1.version === '1.2.0' && r1.settings.manifest.version === '1.2.0' && r1.enabled === false, JSON.stringify([moved.body, r1]));
        check('the install row moves to the version too', T.nextgent_installs.find((i) => i.install_id === 'app-1').version === '1.2.0');
        check('settings not sent are kept', r1.settings.showOnPublic === true && JSON.stringify(r1.settings.config) === '{}');
        const on = await signed('PATCH', '/api/nextgent/installs/app-1', { enabled: true });
        check('{ enabled } alone switches it back on and changes nothing else', on.status === 200 && r1.enabled === true && r1.version === '1.2.0' && r1.settings.manifest.version === '1.2.0');
        check('enabled must be a boolean', (await signed('PATCH', '/api/nextgent/installs/app-1', { enabled: 'yes' })).status === 400);
        check('a bad manifest is refused', (await signed('PATCH', '/api/nextgent/installs/app-1', { app: manifest('notes-app', '1.3.0', { data: { tables: { 'Bad Name': { columns: {} } } } }) })).status === 400 && r1.settings.manifest.version === '1.2.0');
        check('nothing to change is 400', (await signed('PATCH', '/api/nextgent/installs/app-1', {})).status === 400);
        check('an unknown install is 404', (await signed('PATCH', '/api/nextgent/installs/nope', { enabled: true })).status === 404);
        check('unsigned is refused', (await call('PATCH', '/api/nextgent/installs/app-1', { enabled: false })).status === 401 && r1.enabled === true);

        console.log('\n── GET /api/public/business/:slug/apps ──');
        rowOf('app-b').sort_order = 0;
        r1.sort_order = 1;
        rowOf('app-n').sort_order = 2;
        let pub = await call('GET', '/api/public/business/shop/apps');
        check('an array of the enabled, public paperclip rows in sort order', pub.status === 200 && Array.isArray(pub.body) && pub.body.map((r) => r.installId).join(',') === 'app-b,app-1,app-n', JSON.stringify(pub.body));
        check('each row has the contract shape', pub.body.every(hasShape), JSON.stringify(Object.keys(pub.body[0] || {})));
        const row1 = pub.body.find((r) => r.installId === 'app-1');
        check('the manifest and the keys are there', row1.appKey === 'notes-app' && row1.version === '1.2.0' && row1.manifest?.ui && row1.renderMode === 'inline' && row1.publicLabel === null && row1.position === 1 && row1.enabled === true && row1.publicEnabled === true, JSON.stringify(row1));
        check('config is what the public views read: defaults, never a secret or owner-only setting', row1.config.intro === 'Hello' && !('owner_email' in row1.config) && !('api_key' in row1.config), JSON.stringify(row1.config));
        check('the legacy rows are not in it', !pub.body.some((r) => r.appKey === 'menu' || r.appKey === 'events'));
        check('another business\'s apps are not in it', !pub.body.some((r) => r.installId === 'app-x'));
        const unknown = await call('GET', '/api/public/business/nobody-here/apps');
        check('an unknown business is 404 with a JSON { error } body', unknown.status === 404 && typeof unknown.body?.error === 'string', JSON.stringify(unknown.body));
        check('a business with no apps is an empty array, not 404', JSON.stringify((await call('GET', '/api/public/business/other/apps')).body.filter((r) => r.installId !== 'app-x')) === '[]');

        console.log('\n── owner: GET /api/owner/apps ──');
        const mine = await call('GET', '/api/owner/apps');
        check('every paperclip row of the session\'s business, same shape, in order', mine.status === 200 && mine.body.map((r) => r.installId).join(',') === 'app-b,app-1,app-n' && mine.body.every(hasShape), JSON.stringify(mine.body));
        check('owner config carries declared settings but never a secret', mine.body[1].config.intro === 'Hello' && !('api_key' in mine.body[1].config));
        session = { ...session, entitySlug: 'other' };
        check('the business is the session\'s, never the request\'s', (await call('GET', '/api/owner/apps?slug=shop')).body.map((r) => r.installId).join(',') === 'app-x');
        session = { ...session, entitySlug: 'shop' };

        console.log('\n── owner: PATCH /api/owner/apps/:installId ──');
        const patched = await call('PATCH', '/api/owner/apps/app-1', { renderMode: 'action', publicLabel: 'Notes', position: 7, publicEnabled: false, enabled: false });
        check('render mode, label, position and the public flag are written', patched.status === 200 && r1.render_mode === 'action' && r1.public_label === 'Notes' && r1.sort_order === 7 && r1.settings.showOnPublic === false, JSON.stringify([patched.body, r1]));
        check('enabled is not the owner\'s to write (Paperclip owns it)', r1.enabled === true);
        check('the answer is the row in the contract shape', hasShape(patched.body) && patched.body.renderMode === 'action' && patched.body.publicEnabled === false && patched.body.position === 7);
        check('the manifest and config are kept', r1.settings.manifest.version === '1.2.0' && JSON.stringify(r1.settings.config) === '{}');
        pub = await call('GET', '/api/public/business/shop/apps');
        check('hidden from the public list; the others stay', pub.body.map((r) => r.installId).join(',') === 'app-b,app-n', JSON.stringify(pub.body.map((r) => r.installId)));
        check('still in the owner\'s list, publicEnabled false', (await call('GET', '/api/owner/apps')).body.find((r) => r.installId === 'app-1')?.publicEnabled === false);
        const back = await call('PATCH', '/api/owner/apps/app-1', { publicEnabled: true });
        check('switched back on it is public again', back.status === 200 && r1.settings.showOnPublic === true && (await call('GET', '/api/public/business/shop/apps')).body.some((r) => r.installId === 'app-1'));
        check('a render mode outside inline|button|page|action is refused', (await call('PATCH', '/api/owner/apps/app-1', { renderMode: 'popup' })).status === 400 && r1.render_mode === 'action');
        check('position must be an integer', (await call('PATCH', '/api/owner/apps/app-1', { position: 'first' })).status === 400);
        check('publicLabel must be a string (or null to clear)', (await call('PATCH', '/api/owner/apps/app-1', { publicLabel: 5 })).status === 400 && (await call('PATCH', '/api/owner/apps/app-1', { publicLabel: null })).status === 200 && r1.public_label === null);
        check('nothing to change is 400', (await call('PATCH', '/api/owner/apps/app-1', {})).status === 400);
        check('another business\'s install is 404', (await call('PATCH', '/api/owner/apps/app-x', { publicEnabled: false })).status === 404 && rowOf('app-x').settings.showOnPublic === true);
        check('a legacy row cannot be reached by its key', (await call('PATCH', '/api/owner/apps/menu', { publicEnabled: false })).status === 404 && legacyRow.settings.showOnPublic === true);

        console.log('\n── owner: PUT /api/owner/apps/order ──');
        const ordered = await call('PUT', '/api/owner/apps/order', ['app-n', 'app-1', 'app-b']);
        check('sort_order follows the index', ordered.status === 200 && rowOf('app-n').sort_order === 0 && r1.sort_order === 1 && rowOf('app-b').sort_order === 2, JSON.stringify([ordered.body, T.entity_modules.map((r) => [r.install_id, r.sort_order])]));
        check('the answer lists the rows in the new order', Array.isArray(ordered.body) && ordered.body.map((r) => r.installId).join(',') === 'app-n,app-1,app-b');
        check('the public list follows', (await call('GET', '/api/public/business/shop/apps')).body.map((r) => r.installId).join(',') === 'app-n,app-1,app-b');
        check('an id that is not this business\'s is refused and nothing moves', (await call('PUT', '/api/owner/apps/order', ['app-x', 'app-1'])).status === 400 && rowOf('app-n').sort_order === 0 && r1.sort_order === 1);
        check('not an array is 400', (await call('PUT', '/api/owner/apps/order', { order: ['app-1'] })).status === 400);
        check('legacy rows keep their order', legacyRow.sort_order === 0 && plainRow.sort_order === 1);

        console.log('\n── the legacy dashboard (/api/platform/state) ──');
        const state = await call('GET', '/api/platform/state');
        check('GET /state lists only its own installs', state.status === 200 && Object.keys(state.body.installed).join(',') === 'menu' && state.body.page_order.join(',') === 'menu', JSON.stringify(state.body));
        const before = T.entity_modules.filter((r) => r.managed_by === 'paperclip').map((r) => JSON.stringify(r));
        const saved = await call('POST', '/api/platform/state', { business: { name: 'Shop' }, installed: { menu: { enabled: true, manifest: { block: 'menu' }, config: { a: 1 }, showOnPublic: false }, specials: { enabled: true, manifest: { block: 'specials' }, config: {} } }, page_order: ['specials', 'menu'] });
        check('POST /state saves its own rows', saved.status === 200 && legacyRow.settings.config.a === 1 && legacyRow.settings.showOnPublic === false && T.entity_modules.some((r) => r.module_key === 'specials' && r.entity_slug === 'shop'), JSON.stringify([saved.body, legacyRow]));
        const after = T.entity_modules.filter((r) => r.managed_by === 'paperclip').map((r) => JSON.stringify(r));
        check('a paperclip row it was not sent survives, byte for byte', after.length === before.length && after.every((s, i) => s === before[i]) && rowOf('app-1') && rowOf('app-b') && rowOf('app-n') && rowOf('app-x'), JSON.stringify(after));
        const wipe = await call('POST', '/api/platform/state', { business: { name: 'Shop' }, installed: {}, page_order: [] });
        check('an empty save removes its own rows only', wipe.status === 200 && !T.entity_modules.some((r) => r.module_key === 'specials' && r.entity_slug === 'shop') && !T.entity_modules.includes(legacyRow) && T.entity_modules.includes(plainRow) && rowOf('app-1') && rowOf('app-b') && rowOf('app-n'), JSON.stringify(T.entity_modules.map((r) => r.module_key)));
        const sneak = await call('POST', '/api/platform/state', { business: { name: 'Shop' }, installed: { 'notes-app': { enabled: false, manifest: { block: 'x' }, showOnPublic: false } }, page_order: ['notes-app'] });
        check('a save naming a paperclip app\'s key does not touch its row', sneak.status === 200 && r1.enabled === true && r1.settings.showOnPublic === true && r1.settings.manifest.version === '1.2.0' && r1.managed_by === 'paperclip', JSON.stringify(r1));
        T.entity_modules = T.entity_modules.filter((r) => r.managed_by === 'paperclip' || r === plainRow);

        console.log('\n── GET /api/gcr/entity/:slug modules[] ──');
        const ent = await call('GET', '/api/gcr/entity/shop');
        const mods = ent.body?.modules || [];
        const m1 = mods.find((m) => m.install_id === 'app-1');
        check('every entity_modules row is still listed', ent.status === 200 && mods.some((m) => m.module_key === 'events') && mods.filter((m) => m.module_key === 'notes-app').length === 1, JSON.stringify(mods));
        check('with managed_by, render_mode, public_label, install_id and version', m1 && m1.managed_by === 'paperclip' && m1.render_mode === 'action' && m1.public_label === null && m1.version === '1.2.0' && m1.enabled === true && m1.settings?.manifest?.id === 'notes-app', JSON.stringify(m1));
        const mPlain = mods.find((m) => m.module_key === 'events');
        check('a legacy row reads null for them', mPlain && mPlain.managed_by === null && mPlain.install_id === null && mPlain.version === null && mPlain.render_mode === null && mPlain.public_label === null, JSON.stringify(mPlain));

        console.log('\n── uninstall ──');
        T.app_records.push({ id: 'rec-1', install_id: 'app-b', entity_slug: 'shop', app_table: 'notes', data: { title: 'Kept' }, source: 'owner' });
        const gone = await signed('DELETE', '/api/nextgent/installs/app-b');
        const rb = rowOf('app-b');
        check('uninstall disables the row and its public flag, and keeps it', gone.status === 200 && gone.body.app?.disabled === true && rb && rb.enabled === false && rb.settings.showOnPublic === false && rb.settings.manifest?.id === 'board-app', JSON.stringify([gone.body, rb]));
        check('app_records are kept', T.app_records.some((r) => r.id === 'rec-1'));
        check('out of the public list', !(await call('GET', '/api/public/business/shop/apps')).body.some((r) => r.installId === 'app-b'));
        check('still in the owner\'s list, enabled false', (await call('GET', '/api/owner/apps')).body.find((r) => r.installId === 'app-b')?.enabled === false);
        check('the owner cannot switch an uninstalled app back on by making it public', (await call('PATCH', '/api/owner/apps/app-b', { publicEnabled: true })).status === 200 && rb.enabled === false && !(await call('GET', '/api/public/business/shop/apps')).body.some((r) => r.installId === 'app-b'));

        console.log('\n── reinstall reuses the row (DECISIONS #28) ──');
        rb.settings.config = { intro: 'Old words' };
        rb.settings.showOnPublic = false;
        const again = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-b2', itemKey: 'board-app', kind: 'app', version: '2.1.0', permissions: [], app: manifest('board-app', '2.1.0') });
        const boards = T.entity_modules.filter((r) => r.entity_slug === 'shop' && r.module_key === 'board-app');
        check('one row for (shop, board-app), not two', again.status === 201 && boards.length === 1 && boards[0] === rb, JSON.stringify(boards));
        check('re-enabled with the new install id, version and manifest', rb.enabled === true && rb.install_id === 'app-b2' && rb.company_id === 'co-1' && rb.version === '2.1.0' && rb.settings.manifest.version === '2.1.0' && rb.managed_by === 'paperclip', JSON.stringify(rb));
        check('config reset and public again', JSON.stringify(rb.settings.config) === '{}' && rb.settings.showOnPublic === true);
        const appInstances = require(path.join(ROOT, 'lib/appInstances.js'));
        check('the old install id no longer resolves; the new one does', (await appInstances.liveInstance('app-b')) === null && (await appInstances.liveInstance('app-b2'))?.instance.install_id === 'app-b2');
        check('the new install is in the public list, once', (await call('GET', '/api/public/business/shop/apps')).body.filter((r) => r.appKey === 'board-app').map((r) => r.installId).join(',') === 'app-b2');

        console.log('\n── a legacy row under the same key is taken over, its config kept (DECISIONS #30) ──');
        const legacyApp = { id: 'legacy-2', entity_slug: 'shop', module_key: 'tips-app', enabled: true, settings: { manifest: { block: 'tips' }, config: { a: 1 }, showOnPublic: false }, sort_order: 4 };
        T.entity_modules.push(legacyApp);
        const over = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-t', itemKey: 'tips-app', kind: 'app', version: '1.0.0', permissions: [], app: manifest('tips-app', '1.0.0') });
        const tips = T.entity_modules.filter((r) => r.entity_slug === 'shop' && r.module_key === 'tips-app');
        check('one row for (shop, tips-app): the legacy one, now Paperclip\'s', over.status === 201 && tips.length === 1 && tips[0] === legacyApp && legacyApp.managed_by === 'paperclip' && legacyApp.install_id === 'app-t' && legacyApp.version === '1.0.0', JSON.stringify(tips));
        check('the owner\'s config is carried over, the manifest is the new one, public on', JSON.stringify(legacyApp.settings.config) === '{"a":1}' && legacyApp.settings.manifest.id === 'tips-app' && legacyApp.settings.manifest.ui && legacyApp.settings.showOnPublic === true && legacyApp.enabled === true, JSON.stringify(legacyApp.settings));

        console.log('\n── a layout install (DECISIONS #31) ──');
        const layoutBody = { companyId: 'co-1', installId: 'lay-1', itemKey: 'cafe-layout', kind: 'layout', version: '1.0.0', permissions: [], optionalPermissions: [], enabled: true };
        const lay = await signed('POST', '/api/nextgent/installs', layoutBody);
        const lr = rowOf('lay-1');
        check('kind layout is accepted, no token minted, nothing charged', lay.status === 201 && !lay.body.token && lay.body.charged === false && !T.business_mcp_tokens.some((t) => t.install_id === 'lay-1'), JSON.stringify(lay.body));
        check('projected: module_key = layout key, managed_by paperclip, install and company ids, version, enabled', lr && lr.module_key === 'cafe-layout' && lr.managed_by === 'paperclip' && lr.install_id === 'lay-1' && lr.company_id === 'co-1' && lr.version === '1.0.0' && lr.enabled === true, JSON.stringify(lr));
        check('settings.kind = layout, manifest null when none was sent, public on', lr?.settings?.kind === 'layout' && lr.settings.manifest === null && lr.settings.showOnPublic === true, JSON.stringify(lr?.settings));
        check('the install row records kind layout', T.nextgent_installs.find((i) => i.install_id === 'lay-1')?.kind === 'layout');
        check('a layout install has no session token', (await signed('POST', '/api/nextgent/installs/lay-1/session', {})).status === 409);
        const withLayout = await signed('POST', '/api/nextgent/installs', { ...layoutBody, installId: 'lay-2', itemKey: 'bar-layout', layout: { template: 'bar', sections: ['hero'] } });
        check('a layout object in the body is kept as settings.manifest', withLayout.status === 201 && rowOf('lay-2')?.settings.manifest?.template === 'bar' && rowOf('lay-2').settings.kind === 'layout', JSON.stringify(rowOf('lay-2')));
        check('layout must be an object', (await signed('POST', '/api/nextgent/installs', { ...layoutBody, installId: 'lay-3', itemKey: 'x-layout', layout: 'bar' })).status === 400 && !rowOf('lay-3'));
        check('excluded from the public apps list', !(await call('GET', '/api/public/business/shop/apps')).body.some((r) => r.installId === 'lay-1' || r.installId === 'lay-2' || r.appKey === 'cafe-layout'));
        check('excluded from the owner apps list', !(await call('GET', '/api/owner/apps')).body.some((r) => r.installId === 'lay-1' || r.installId === 'lay-2'));
        check('liveInstance does not treat a layout as an app', (await appInstances.liveInstance('lay-1')) === null && (await appInstances.liveInstance('lay-2')) === null);
        check('the layout has no public app page', (await call('GET', '/api/public/apps/lay-2')).status === 404);
        const layPatch = await signed('PATCH', '/api/nextgent/installs/lay-1', { version: '1.1.0', layout: { template: 'cafe-v2' }, enabled: false });
        check('PATCH re-projects version, layout and enabled', layPatch.status === 200 && layPatch.body.projected === true && lr.version === '1.1.0' && lr.settings.manifest?.template === 'cafe-v2' && lr.enabled === false && lr.settings.kind === 'layout', JSON.stringify([layPatch.body, lr]));
        check('the install row moves to the version too', T.nextgent_installs.find((i) => i.install_id === 'lay-1').version === '1.1.0');
        check('PATCH { layout } alone is enough', (await signed('PATCH', '/api/nextgent/installs/lay-1', { layout: { template: 'cafe-v3' } })).status === 200 && lr.settings.manifest.template === 'cafe-v3' && lr.enabled === false);
        check('PATCH layout must be an object', (await signed('PATCH', '/api/nextgent/installs/lay-1', { layout: [1] })).status === 400 && lr.settings.manifest.template === 'cafe-v3');
        const layGone = await signed('DELETE', '/api/nextgent/installs/lay-2');
        const l2 = rowOf('lay-2');
        check('DELETE disables the layout row and keeps it', layGone.status === 200 && layGone.body.app?.disabled === true && l2 && l2.enabled === false && l2.settings.showOnPublic === false && l2.settings.kind === 'layout' && l2.settings.manifest?.template === 'bar', JSON.stringify([layGone.body, l2]));
        check('the legacy and app rows are untouched by layouts', r1.settings.kind === undefined && T.entity_modules.includes(plainRow));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('owner-apps');
}
