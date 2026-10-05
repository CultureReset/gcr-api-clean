#!/usr/bin/env node
// ============================================================
// App-engine apps: install manifest, own records, settings, public block
// ============================================================
//
//     npm run test:app-data
//
// Boots routes/nextgent.js and routes/app-data.js against the in-memory
// database. Real signatures, real install tokens (long-lived and session),
// real manifest guards (lib/businessTables.js). No credentials, no network.
// The projection is an entity_modules row per install (managed_by =
// 'paperclip', sql/nextgent_entity_modules.sql).

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc-secret';
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: SECRET,
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    INTAKE_EMAIL_DOMAIN: 'parse.example.test',
    APP_DATA_MAX_ROWS_PER_TABLE: '3',
});

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'Shop', entity_type: 'cafe', social_instagram: 'https://instagram.com/shop', email: 'o@shop.test' }, { slug: 'other', name: 'Other', entity_type: 'bar' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }, { company_id: 'co-2', entity_slug: 'other' }],
    business_mcp_tokens: [],
    nextgent_installs: [],
    entity_modules: [],
    app_records: [],
    billing_item_prices: [],
    billing_plan: [{ key: 'base', is_default: true }],
    billing_subscription: [],
    store_plan_items: [],
    store_grants: [],
    menu_items: [
        { id: 1, entity_slug: 'shop', name: 'Toast', shown: true, cost_note: 'x' },
        { id: 2, entity_slug: 'shop', name: 'Off menu', shown: false },
        { id: 3, entity_slug: 'other', name: 'Not ours', shown: true },
    ],
    bookings: [{ id: 1, entity_slug: 'shop', customer_name: 'A Person' }],
    entity_leads: [],
    offerings: [
        { id: 1, entity_slug: 'shop', kind: 'product', name: 'Mug' },
        { id: 2, entity_slug: 'shop', kind: 'service', name: 'Catering' },
        { id: 3, entity_slug: 'other', kind: 'product', name: 'Not ours' },
    ],
} });
inject(path.join(ROOT, 'db.js'), db);
// The automation engine, recording what the app routes emit (DECISIONS #47).
const events = [];
inject(path.join(ROOT, 'lib/automationEngine.js'), {
    emitEvent: async (event, slug, payload) => { events.push({ event, slug, payload }); return { ran: 0 }; },
    newHookToken: () => 'b'.repeat(48),
    tick: async () => ({}),
    catalogue: () => ({ steps: [], events: [] }),
    EVENTS: [],
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.test/rest/v1/')) {
        const def = (cols) => ({ properties: Object.fromEntries(cols.map((c) => [c, { type: 'string' }])) });
        return { ok: true, status: 200, json: async () => ({ definitions: {
            menu_items: def(['id', 'entity_slug', 'name', 'shown', 'cost_note']),
            bookings: def(['id', 'entity_slug', 'customer_name']),
            offerings: def(['id', 'entity_slug', 'kind', 'name']),
            entity_leads: def(['id', 'entity_slug', 'name', 'email', 'phone', 'message', 'source', 'status']),
            entity: def(['id', 'slug', 'name', 'email', 'social_instagram', 'website_url']),
            app_records: def(['id', 'entity_slug', 'data']),
        } }) };
    }
    return realFetch(url, init);
};

function manifest(over = {}) {
    return {
        schema_version: 1, id: 'notes-app', name: 'Notes', version: '1.0.0', publisher: 'test',
        runtime: { type: 'engine', engine: '1' },
        surfaces: [{ id: 'owner', kind: 'dashboard', path: '/owner' }, { id: 'public', kind: 'public', path: '/public' }],
        permissions: [{ id: 'menu:read', reason: 'Shows the menu.' }],
        // <manifest id>.<event> (DECISIONS #55): one segment after the id fires for every new record;
        // a table-qualified one (<id>.<table>.<verb>) only for that table.
        events: { emits: ['notes-app.submitted', 'notes-app.internal.noted'] },
        data: {
            namespace: 'notes',
            tables: {
                // Public content, not a message to the owner: inbox false (the default for an append table is true).
                notes: { public: 'read-append', inbox: false, columns: {
                    title: { type: 'text', required: true, max_length: 20 },
                    count: { type: 'integer' },
                    shown: { type: 'boolean', default: true },
                    flag: { type: 'text', default: 'new' },
                } },
                internal: { columns: { memo: { type: 'text' } } },
                // Write-only for visitors: a submission to the business (DECISIONS #48).
                enquiries: { public: 'append', columns: {
                    name: { type: 'text', required: true }, email: { type: 'text' }, phone: { type: 'text' }, message: { type: 'text' }, rating: { type: 'integer' },
                } },
            },
        },
        config: [
            { key: 'intro', type: 'text', default: 'Hello' },
            { key: 'open', type: 'boolean', default: true },
            { key: 'owner_email', type: 'text' },
            { key: 'api_key', type: 'secret' },
        ],
        ui: {
            sources: {
                notes: { from: 'app', table: 'notes', fields: [
                    { key: 'title', type: 'text' }, { key: 'count', type: 'number' }, { key: 'shown', type: 'boolean' },
                    { key: 'flag', type: 'text', ownerOnly: true },
                ], title: 'title', visibleWhen: 'shown' },
                menu: { from: 'business', section: 'menu_items', resource: 'menu', fields: [{ key: 'name', type: 'text' }, { key: 'cost_note', type: 'text', ownerOnly: true }], title: 'name', visibleWhen: 'shown' },
                people: { from: 'business', section: 'bookings', resource: 'bookings', fields: [{ key: 'customer_name', type: 'text' }], title: 'customer_name' },
                memos: { from: 'app', table: 'internal', fields: [{ key: 'memo', type: 'text' }], title: 'memo' },
                enquiries: { from: 'app', table: 'enquiries', fields: [{ key: 'name', type: 'text' }, { key: 'email', type: 'text' }, { key: 'message', type: 'text' }], title: 'message' },
                // Bound by contract (DECISIONS #45): the registry names the table and the filter.
                products: { from: 'business', contract: 'products.items', resource: 'business', fields: [{ key: 'name', type: 'text' }], title: 'name' },
                records: { from: 'business', contract: 'booking.records', resource: 'bookings', fields: [{ key: 'customer_name', type: 'text' }], title: 'customer_name' },
                links: { from: 'business', contract: 'business.links', resource: 'business', fields: [{ key: 'network', type: 'text' }, { key: 'url', type: 'url' }], title: 'network' },
            },
            views: {
                owner: [{ type: 'collection', source: 'notes' }, { type: 'collection', source: 'memos' }],
                public: [
                    { type: 'list', source: 'notes', fields: { title: 'title' } },
                    { type: 'list', source: 'menu', fields: { title: 'name' } },
                    { type: 'list', source: 'people', fields: { title: 'customer_name' } },
                    { type: 'list', source: 'memos', fields: { title: 'memo' } },
                    { type: 'list', source: 'products', fields: { title: 'name' } },
                    { type: 'list', source: 'records', fields: { title: 'customer_name' } },
                    { type: 'links', source: 'links', fields: { title: 'network', url: 'url' } },
                    { type: 'form', source: 'notes', intro: { setting: 'intro' }, openWhen: { setting: 'open' } },
                    { type: 'form', source: 'enquiries' },
                ],
            },
        },
        ...over,
    };
}

const { dataRouter, installRouter, publicRouter } = require(path.join(ROOT, 'routes/app-data.js'));
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/nextgent', require(path.join(ROOT, 'routes/nextgent.js')));
app.use('/api/app-data', dataRouter);
app.use('/api/app-install', installRouter);
app.use('/api/public/apps', publicRouter);
const server = app.listen(0, run);
const base = () => `http://127.0.0.1:${server.address().port}`;

async function call(method, url, body, headers = {}) {
    const res = await realFetch(`${base()}${url}`, {
        method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}
function signed(method, url, body) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return call(method, url, body, require(path.join(ROOT, 'lib/serviceSigning.js')).signHeaders({ method, url, rawBody: raw }, { key: SECRET }));
}
const as = (token) => (method, url, body) => call(method, url, body, { Authorization: `Bearer ${token}` });

const { check, done } = checker();

async function run() {
    try {
        console.log('\n── install with the app manifest ──');
        const bad = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'bad-1', itemKey: 'notes-app', kind: 'app', permissions: [], app: manifest({ data: { tables: { 'Bad Name': { columns: {} } } } }) });
        check('a manifest with a bad table is refused', bad.status === 400 && !T.nextgent_installs.some((i) => i.install_id === 'bad-1'), JSON.stringify(bad.body));
        const inst = await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-1', itemKey: 'notes-app', kind: 'app', version: '1.0.0', permissions: ['menu:read'], app: manifest() });
        check('the install answers with its token', inst.status === 201 && /^gcr_mcp_/.test(inst.body.token || ''), JSON.stringify(inst.body));
        const projected = T.entity_modules.find((r) => r.install_id === 'app-1');
        check('the manifest is kept in the entity_modules projection', projected?.settings?.manifest?.id === 'notes-app' && projected.entity_slug === 'shop' && projected.module_key === 'notes-app' && projected.enabled === true && projected.version === '1.0.0', JSON.stringify(projected));
        check('marked as Paperclip\'s, with the install and company', projected?.managed_by === 'paperclip' && projected.company_id === 'co-1' && projected.settings.showOnPublic === true && JSON.stringify(projected.settings.config) === '{}');
        check('and not on the install row', !('manifest' in T.nextgent_installs.find((i) => i.install_id === 'app-1')));
        const own = as(inst.body.token);

        const other = await signed('POST', '/api/nextgent/installs', { companyId: 'co-2', installId: 'app-2', itemKey: 'notes-app', kind: 'app', version: '1.0.0', permissions: [], app: manifest() });
        const theirs = as(other.body.token);

        console.log('\n── /api/app-install ──');
        const me = await own('GET', '/api/app-install');
        check('{ installId, itemKey, version, settings, granted }', me.status === 200 && me.body.installId === 'app-1' && me.body.itemKey === 'notes-app' && me.body.version === '1.0.0' && JSON.stringify(me.body.granted) === '["menu:read"]', JSON.stringify(me.body));
        check('settings carry the declared defaults', me.body.settings.intro === 'Hello' && me.body.settings.open === true);
        const saved = await own('PUT', '/api/app-install/settings', { settings: { intro: 'Hi there', owner_email: 'me@example.test', api_key: 'sk-1', not_declared: 1 } });
        check('saving keeps declared keys only', saved.status === 200 && saved.body.settings.intro === 'Hi there' && !('not_declared' in saved.body.settings), JSON.stringify(saved.body));
        check('a secret is never returned', !('api_key' in saved.body.settings));
        check('and is stored sealed, in settings.config', /^v1\./.test(projected.settings.config.api_key) && !JSON.stringify(projected.settings.config).includes('sk-1'));
        check('saving settings keeps the manifest and the public flag', projected.settings.manifest?.id === 'notes-app' && projected.settings.showOnPublic === true);
        const company = await signed('POST', '/api/nextgent/link', { companyId: 'co-1', rotateToken: true });
        check('/api/nextgent/link says the business kind', company.body.kind === 'cafe', JSON.stringify(company.body));
        const companyTok = as(company.body.businessToken);
        check('a company token (no install) is refused', (await companyTok('GET', '/api/app-install')).status === 403);
        check('no token is refused', (await call('GET', '/api/app-install')).status === 401);

        console.log('\n── /api/app-data ──');
        events.length = 0;
        const made = await own('POST', '/api/app-data/notes', { title: 'First', count: '3', sneaky: 'x', entity_slug: 'other' });
        check('a record is created with declared columns only', made.status === 201 && made.body.row.title === 'First' && made.body.row.count === 3 && !('sneaky' in made.body.row) && made.body.row.shown === true, JSON.stringify(made.body));
        check('an owner insert emits the declared event, exactly as declared, for the install\'s business', events.length === 1 && events[0].event === 'notes-app.submitted' && events[0].slug === 'shop' && events[0].payload.table === 'notes' && events[0].payload.record.title === 'First' && events[0].payload.source === 'owner' && events[0].payload.installId === 'app-1', JSON.stringify(events));
        const rec = T.app_records.find((r) => r.id === made.body.row.id);
        check('scoped to the install and the business from the token', rec.install_id === 'app-1' && rec.entity_slug === 'shop' && rec.app_table === 'notes');
        check('a missing required column is refused', (await own('POST', '/api/app-data/notes', { count: 1 })).status === 422);
        const wrong = await own('POST', '/api/app-data/notes', { title: 'x', count: 'many' });
        check('a value of the wrong type is refused, naming the column', wrong.status === 422 && wrong.body.errors.count, JSON.stringify(wrong.body));
        check('too long for max_length is refused', (await own('POST', '/api/app-data/notes', { title: 'x'.repeat(21) })).status === 422);
        check('an undeclared table is refused', (await own('GET', '/api/app-data/menu_items')).status === 404);
        await own('POST', '/api/app-data/notes', { title: 'Hidden', shown: false, flag: 'secret' });
        await own('POST', '/api/app-data/internal', { memo: 'owner only' });
        const list = await own('GET', '/api/app-data/notes');
        check('the list returns this install\'s rows', list.status === 200 && list.body.rows.length === 2 && list.body.total === 2, JSON.stringify(list.body));
        const patched = await own('PATCH', `/api/app-data/notes/${made.body.row.id}`, { title: 'Renamed' });
        check('PATCH changes only what was sent', patched.status === 200 && patched.body.row.title === 'Renamed' && patched.body.row.count === 3, JSON.stringify(patched.body));
        check('PATCH cannot blank a required column', (await own('PATCH', `/api/app-data/notes/${made.body.row.id}`, { title: '' })).status === 422);
        check('another business\'s install cannot read it', (await theirs('GET', '/api/app-data/notes')).body.rows.length === 0);
        check('nor change it', (await theirs('PATCH', `/api/app-data/notes/${made.body.row.id}`, { title: 'Hack' })).status === 404);
        check('nor delete it', (await theirs('DELETE', `/api/app-data/notes/${made.body.row.id}`)).status === 404);

        const sess = await signed('POST', '/api/nextgent/installs/app-1/session', { companyId: 'co-1' });
        check('a short-lived session token works on the app routes too', (await as(sess.body.token)('GET', '/api/app-data/notes')).body.rows?.length === 2);

        console.log('\n── /api/public/apps ──');
        const pub = await call('GET', '/api/public/apps/app-1');
        check('a visitor reads the public block', pub.status === 200 && pub.body.data && pub.body.settings, JSON.stringify(pub.body));
        check('and the manifest comes with it', pub.body.manifest?.id === 'notes-app' && pub.body.manifest.ui, JSON.stringify(Object.keys(pub.body)));
        check('settings: only those public views use, never a secret or the owner\'s', pub.body.settings.intro === 'Hi there' && pub.body.settings.open === true && !('owner_email' in pub.body.settings) && !('api_key' in pub.body.settings), JSON.stringify(pub.body.settings));
        check('app rows: hidden ones dropped', pub.body.data.notes.length === 1 && pub.body.data.notes[0].title === 'Renamed');
        check('owner-only columns removed', !('flag' in pub.body.data.notes[0]));
        check('business rows the install may read, this business only, visible ones', pub.body.data.menu.length === 1 && pub.body.data.menu[0].name === 'Toast' && !('cost_note' in pub.body.data.menu[0]), JSON.stringify(pub.body.data.menu));
        check('a table of people is never public', !('people' in pub.body.data));
        check('an app table not declared public is not read', !('memos' in pub.body.data));
        const theirPub = await call('GET', '/api/public/apps/app-2');
        check('without menu:read the business source is left out', theirPub.status === 200 && !('menu' in theirPub.body.data));
        check('a contract source needs its resource too', !('products' in pub.body.data));
        // Its own item key: a second install of the same key would reuse app-1's row (DECISIONS #28).
        await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-3', itemKey: 'contract-app', kind: 'app', version: '1.0.0', permissions: ['business:read', 'bookings:read'], app: manifest({ id: 'contract-app' }) });
        const contractPub = await call('GET', '/api/public/apps/app-3');
        check('a public contract source: the registry\'s table and filter, this business only', contractPub.status === 200 && contractPub.body.data.products?.length === 1 && contractPub.body.data.products[0].name === 'Mug', JSON.stringify(contractPub.body.data));
        check('a contract over a table of people is never public, whatever the permission', !('records' in contractPub.body.data));
        check('business.links on a public page: rows { id, network, url } from the record\'s link columns (DECISIONS #63)', contractPub.body.data.links?.length === 1 && contractPub.body.data.links[0].network === 'instagram' && contractPub.body.data.links[0].url === 'https://instagram.com/shop' && !('email' in contractPub.body.data.links[0]), JSON.stringify(contractPub.body.data.links));

        events.length = 0;
        const sub = await call('POST', '/api/public/apps/app-1/notes', { title: 'From a visitor', flag: 'set-by-visitor' });
        check('a visitor can append to a public append table', sub.status === 201 && sub.body.row.id && !('title' in sub.body.row), JSON.stringify(sub.body));
        check('a read-append table marked inbox false is public content, not a message to the owner', !T.business_messages?.length, JSON.stringify(T.business_messages));
        check('a visitor\'s insert emits the same declared event, source visitor', events.length === 1 && events[0].event === 'notes-app.submitted' && events[0].payload.source === 'visitor' && events[0].payload.record.title === 'From a visitor', JSON.stringify(events));
        events.length = 0;
        await own('POST', '/api/app-data/internal', { memo: 'quiet' });
        check('a table-qualified event fires only for its table; the app-level one fires for every table', events.map((e) => e.event).sort().join(',') === 'notes-app.internal.noted,notes-app.submitted', JSON.stringify(events));
        events.length = 0;
        const vrec = T.app_records.find((r) => r.id === sub.body.row.id);
        check('owner-only columns take their default, not the visitor\'s value', vrec.data.flag === 'new' && vrec.source === 'visitor' && vrec.entity_slug === 'shop');
        check('a table not open to visitors is refused', (await call('POST', '/api/public/apps/app-1/internal', { memo: 'x' })).status === 404);

        console.log('\n── a submission lands in the one Messages inbox (DECISIONS #48) ──');
        events.length = 0;
        const enq = await call('POST', '/api/public/apps/app-1/enquiries', { name: 'Pat', email: 'Pat@Example.test', message: 'Do you cater?', rating: 4 });
        check('the submission is stored as the app\'s record', enq.status === 201 && T.app_records.some((r) => r.app_table === 'enquiries' && r.data.name === 'Pat'), JSON.stringify(enq.body));
        const inbound = (T.business_messages || []).filter((m) => m.channel === 'app');
        check('and as one inbound message: channel app, this install, this business', inbound.length === 1 && inbound[0].direction === 'in' && inbound[0].status === 'received' && inbound[0].install_id === 'app-1' && inbound[0].entity_slug === 'shop' && inbound[0].author === 'customer', JSON.stringify(inbound));
        check('addressed by the visitor\'s email', inbound[0]?.customer_address === 'pat@example.test');
        check('the body is the record, led by the manifest\'s title field', /^Do you cater\?/.test(inbound[0]?.body || '') && /name: Pat/.test(inbound[0].body) && /rating: 4/.test(inbound[0].body), inbound[0]?.body);
        const thread = T.message_threads.find((t) => t.id === inbound[0]?.thread_id);
        check('on an app thread of this business', thread?.channel === 'app' && thread.entity_slug === 'shop' && thread.customer_address === 'pat@example.test' && thread.mode === 'agent', JSON.stringify(thread));
        check('the declared event fired as well', events.some((e) => e.event === 'notes-app.submitted' && e.payload.table === 'enquiries'));
        await call('POST', '/api/public/apps/app-1/enquiries', { name: 'Quinn', phone: '(251) 555-0123', message: 'Hours?' });
        check('no email: the phone is the address', (T.business_messages || []).some((m) => m.channel === 'app' && m.customer_address === '+12515550123'), JSON.stringify((T.business_messages || []).map((m) => m.customer_address)));
        await call('POST', '/api/public/apps/app-1/enquiries', { name: 'Rae', message: 'Just saying hi' });
        check('no email or phone: the first text field', (T.business_messages || []).some((m) => m.channel === 'app' && m.customer_address === 'Rae'), JSON.stringify((T.business_messages || []).map((m) => m.customer_address)));
        T.app_records = T.app_records.filter((r) => r.app_table !== 'enquiries');

        console.log('\n── a visitor submits into the business through a read-write binding (DECISIONS #57) ──');
        const leadApp = {
            schema_version: 1, id: 'lead-app', name: 'Enquiry Form', version: '1.0.0', publisher: 'test', runtime: { type: 'engine', engine: '1' },
            surfaces: [{ id: 'public', kind: 'public', path: '/public' }],
            permissions: [{ id: 'contacts:read', reason: 'r' }, { id: 'contacts:write', reason: 'w' }, { id: 'business:read', reason: 'p' }],
            bindings: { leads: { contract: 'leads.items', access: 'read-write', inbox: true }, who: { contract: 'business.profile', access: 'read' } },
            events: { emits: ['lead-app.submitted'] },
            config: [{ key: 'accepting', type: 'boolean', default: true }],
            ui: {
                sources: {
                    enquiries: { from: 'business', binding: 'leads', fields: [{ key: 'name', type: 'text', required: true }, { key: 'email', type: 'email' }, { key: 'message', type: 'longtext' }, { key: 'status', type: 'select', ownerOnly: true }], title: 'name' },
                    profile: { from: 'business', binding: 'who', fields: [{ key: 'name', type: 'text' }], title: 'name' },
                },
                views: { public: [{ type: 'form', source: 'enquiries', openWhen: { setting: 'accepting' } }] },
            },
        };
        await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-4', itemKey: 'lead-app', kind: 'app', version: '1.0.0', permissions: ['contacts:read', 'contacts:write', 'business:read'], app: leadApp });
        events.length = 0;
        const boundSub = await call('POST', '/api/public/apps/app-4/enquiries', { name: 'Sam', email: 'sam@example.test', message: 'Call me', status: 'won', entity_slug: 'other' });
        const lead = (T.entity_leads || []).find((l) => l.name === 'Sam');
        check('the source key resolves through the manifest to its binding: the lead is in entity_leads, for the install\'s business', boundSub.status === 201 && boundSub.body.table === 'enquiries' && lead?.entity_slug === 'shop' && lead.email === 'sam@example.test', JSON.stringify({ body: boundSub.body, lead }));
        check('an owner-only field is dropped; the visitor cannot set the status', lead && lead.status !== 'won', JSON.stringify(lead));
        check('nothing in app_records', !T.app_records.some((r) => r.install_id === 'app-4'));
        const leadMsg = (T.business_messages || []).find((m) => m.install_id === 'app-4');
        check('the inbox row follows (binding inbox true)', leadMsg?.channel === 'app' && leadMsg.customer_address === 'sam@example.test' && /^Sam/.test(leadMsg.body), JSON.stringify(leadMsg));
        check('and the declared event, as declared', events.some((e) => e.event === 'lead-app.submitted' && e.payload.record.name === 'Sam' && e.payload.table === 'enquiries'), JSON.stringify(events));
        check('a read-only binding takes no submission', (await call('POST', '/api/public/apps/app-4/profile', { name: 'Hack' })).status === 404);
        await signed('POST', '/api/nextgent/installs', { companyId: 'co-1', installId: 'app-4', itemKey: 'lead-app', kind: 'app', version: '1.0.0', permissions: ['contacts:read', 'business:read'], app: leadApp });
        check('without the install\'s contacts:write the submission is refused', (await call('POST', '/api/public/apps/app-4/enquiries', { name: 'Tess' })).status === 403 && !(T.entity_leads || []).some((l) => l.name === 'Tess'));
        check('bad visitor input is refused', (await call('POST', '/api/public/apps/app-1/notes', {})).status === 422);
        const full = await call('POST', '/api/public/apps/app-1/notes', { title: 'Too many' });
        check('a table at APP_DATA_MAX_ROWS_PER_TABLE takes no more', full.status === 409, JSON.stringify(full.body));
        T.app_records = T.app_records.filter((r) => r.source !== 'visitor');
        await own('PUT', '/api/app-install/settings', { settings: { open: false } });
        check('a form the owner closed takes nothing', (await call('POST', '/api/public/apps/app-1/notes', { title: 'Late' })).status === 403);
        projected.settings.showOnPublic = false;
        check('public switched off (settings.showOnPublic): no public block', (await call('GET', '/api/public/apps/app-1')).status === 404);
        projected.settings.showOnPublic = true;
        check('an unknown install is 404', (await call('GET', '/api/public/apps/nope')).status === 404);

        console.log('\n── uninstall ──');
        const gone = await signed('DELETE', '/api/nextgent/installs/app-1');
        check('uninstall switches the projection off', gone.status === 200 && gone.body.app?.disabled === true && projected.enabled === false && projected.settings.showOnPublic === false, JSON.stringify(gone.body));
        check('the row is kept, not deleted', T.entity_modules.some((r) => r.install_id === 'app-1' && r.settings.manifest?.id === 'notes-app'));
        check('the owner side is gone', (await own('GET', '/api/app-install')).status === 401 && (await as(sess.body.token)('GET', '/api/app-data/notes')).status === 401);
        check('and the public side', (await call('GET', '/api/public/apps/app-1')).status === 404);
        check('records are kept', T.app_records.some((r) => r.install_id === 'app-1'));
        const m2 = manifest();
        m2.data.delete_on_uninstall = true;
        await signed('POST', '/api/nextgent/installs', { companyId: 'co-2', installId: 'app-2', itemKey: 'notes-app', kind: 'app', version: '1.1.0', permissions: [], app: m2 });
        const p2 = T.entity_modules.find((r) => r.install_id === 'app-2');
        check('an update replaces the projected manifest and version', p2.version === '1.1.0' && p2.settings.manifest.data.delete_on_uninstall === true, JSON.stringify(p2));
        check('one row per install, still', T.entity_modules.filter((r) => r.install_id === 'app-2').length === 1);
        await theirs('POST', '/api/app-data/notes', { title: 'Theirs' });
        const gone2 = await signed('DELETE', '/api/nextgent/installs/app-2');
        check('uninstall never deletes app_records, whatever the manifest says (DECISIONS #22)', gone2.body.app?.disabled === true && !('recordsDeleted' in gone2.body.app) && T.app_records.some((r) => r.install_id === 'app-2'), JSON.stringify(gone2.body));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('app-data');
}
