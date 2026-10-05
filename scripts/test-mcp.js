// ============================================================
// MCP — protocol and scoping tests
// ============================================================
//
//     npm run test:mcp
//
// Boots routes/mcp.js against a recording stub of ../db, so the JSON-RPC layer,
// the scope filtering and — the part that matters — the slug scoping can be
// checked with no credentials, no network and no database.
//
// The stub records every query the router builds instead of running it, which
// is what lets the assertions below read "the update filtered on the token's
// slug" rather than "the update returned something". A regression that let a
// caller name a business would still return a plausible row; it would not
// build the same query.

const path = require('path');
const Module = require('module');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const calls = [];

/* ── a thenable query builder that records what was asked ────────────── */
function builder(table, verb) {
    const rec = { table, verb, eq: {}, args: [] };
    calls.push(rec);
    const self = {
        select: (...a) => { rec.args.push(['select', ...a]); return self; },
        insert: (v) => { rec.insert = v; return self; },
        upsert: (v) => { rec.upsert = v; return self; },
        update: (v) => { rec.update = v; return self; },
        delete: () => self,
        eq: (k, v) => { rec.eq[k] = v; return self; },
        or: (v) => { rec.or = v; return self; },
        order: (...a) => { rec.order = a; return self; },
        range: (...a) => { rec.range = a; return self; },
        limit: (n) => { rec.limit = n; return self; },
        not: () => self,
        in: () => self,
        is: (k, v) => { rec.is = [k, v]; return self; },
        maybeSingle: () => Promise.resolve(result(rec)),
        single: () => Promise.resolve(result(rec)),
        then: (res, rej) => Promise.resolve(result(rec)).then(res, rej),
    };
    return self;
}

const TOKEN_ROW = {
    id: 'tok-1', entity_slug: 'flora-bama', label: 'Grok', scope: 'write', revoked_at: null,
};
let tokenScope = 'write';
let tokenPermissions = null; // null = a legacy token
let entityExists = true;
let appsInstalled = false; // the agent face: installed apps' declared actions (DECISIONS #46)

// Two installed apps (lib/appInstances.js projection rows) with declared actions.
const APP_ROWS = [
    {
        id: 1, entity_slug: 'flora-bama', module_key: 'song-requests', managed_by: 'paperclip', install_id: 'in-song', enabled: true, sort_order: 0,
        settings: { showOnPublic: true, config: {}, manifest: {
            name: 'Song Requests',
            data: { tables: { requests: { public: 'append', columns: { song: { type: 'text', required: true }, from_name: { type: 'text' } } } } },
            actions: [
                { id: 'list_requests', summary: 'The songs guests asked for tonight.', table: 'requests', kind: 'read' },
                { id: 'add_request', summary: 'Put a song on the list.', table: 'requests', kind: 'create' },
                { id: 'mark_played', summary: 'Mark a request played.', table: 'requests', kind: 'update' },
                { id: 'ghost', summary: 'Names a table the app never declared.', table: 'nope', kind: 'read' },
                { id: 'Bad Id', summary: 'Not a usable id.', table: 'requests', kind: 'read' },
                { id: 'wipe', summary: 'Not a kind that exists.', table: 'requests', kind: 'delete' },
            ],
        } },
    },
    {
        id: 2, entity_slug: 'flora-bama', module_key: 'qr-menu', managed_by: 'paperclip', install_id: 'in-menu', enabled: true, sort_order: 1,
        settings: { showOnPublic: true, config: {}, manifest: {
            name: 'QR Menu',
            // The engine's shape: an action names a binding, the binding names the contract.
            bindings: { menu: { contract: 'menu.items', access: 'read-write' }, faqs: { contract: 'faqs.items', access: 'read' }, nope: { contract: 'nope.items', access: 'read' } },
            actions: [
                { id: 'list_menu', summary: 'What is on the menu.', binding: 'menu', kind: 'read' },
                { id: 'add_item', summary: 'Add a dish.', binding: 'menu', kind: 'create' },
                { id: 'list_faqs', summary: 'Needs business:read, which this install was not granted.', binding: 'faqs', kind: 'read' },
                { id: 'edit_faq', summary: 'Writes through a read-only binding.', binding: 'faqs', kind: 'update' },
                { id: 'unknown', summary: 'Not a contract.', binding: 'nope', kind: 'read' },
                { id: 'nowhere', summary: 'Names a binding the manifest lacks.', binding: 'missing', kind: 'read' },
            ],
        } },
    },
    { id: 3, entity_slug: 'flora-bama', module_key: 'off-app', managed_by: 'paperclip', install_id: 'in-off', enabled: false, sort_order: 2, settings: { manifest: { name: 'Off', actions: [{ id: 'x', summary: 'x', table: 't', kind: 'read' }] } } },
    { id: 4, entity_slug: 'flora-bama', module_key: 'legacy', managed_by: null, enabled: true, sort_order: 3, settings: { manifest: { name: 'Legacy', actions: [{ id: 'y', summary: 'y', table: 't', kind: 'read' }] } } },
];
const INSTALL_ROWS = [
    { install_id: 'in-song', company_id: 'co-1', entity_slug: 'flora-bama', item_key: 'song-requests', kind: 'app', version: '1.0.0', permissions: [], status: 'active' },
    { install_id: 'in-menu', company_id: 'co-1', entity_slug: 'flora-bama', item_key: 'qr-menu', kind: 'app', version: '1.0.0', permissions: ['menu:read', 'menu:write'], status: 'active' },
];

function result(rec) {
    if (rec.table === 'business_mcp_tokens') {
        if (rec.update) return { data: [{ id: 'tok-1' }], error: null };
        return { data: { ...TOKEN_ROW, scope: tokenScope, permissions: tokenPermissions }, error: null };
    }
    if (rec.table === 'entity') {
        // entityExists false stands in for a slug nobody has, or a delisted one.
        if (!entityExists) return { data: null, error: null };
        return {
            data: { slug: 'flora-bama', name: 'Flora-Bama', entity_type: 'restaurant', city: 'Perdido Key', phone: '555-0100', is_active: true },
            error: null,
        };
    }
    if (rec.table === 'tourist_memories') {
        if (rec.upsert) return { data: null, error: null };
        return { data: [{ category: 'preference', key: 'dietary', value: 'no seafood', confidence: 'high' },
                         { category: 'fact', key: 'party', value: 'two kids' }], error: null };
    }
    if (rec.table === 'menu_items') {
        if (rec.insert) return { data: { id: 1, ...rec.insert }, error: null };
        if (rec.update) return { data: [{ id: 8821, ...rec.update }], error: null };
        return { data: [{ id: 8821, name: 'Bushwacker', price: 12 }], error: null, count: 1 };
    }
    if (rec.table === 'entity_modules') {
        if (!appsInstalled) return { data: [], error: null };
        const rows = APP_ROWS.filter((r) => (!rec.eq.entity_slug || r.entity_slug === rec.eq.entity_slug) && (!rec.eq.managed_by || r.managed_by === rec.eq.managed_by) && (!rec.eq.install_id || r.install_id === rec.eq.install_id));
        return { data: rec.eq.install_id ? rows[0] || null : rows, error: null };
    }
    if (rec.table === 'nextgent_installs') {
        if (!appsInstalled) return { data: rec.eq.install_id ? null : [], error: null };
        const rows = INSTALL_ROWS.filter((r) => !rec.eq.install_id || r.install_id === rec.eq.install_id);
        return { data: rec.eq.install_id ? rows[0] || null : rows, error: null };
    }
    // Rows a recipient reference resolves to (lib/recipientRef.js): the address
    // stays in here and must never reach the tool result.
    if (rec.table === 'bookings') {
        if (rec.eq.id === 'bk-1' && rec.eq.entity_slug === 'flora-bama') return { data: { id: 'bk-1', entity_slug: 'flora-bama', customer_name: 'Ana', email: 'ana@example.test', phone: '+15550001111', details: {} }, error: null };
        return { data: rec.eq.id ? null : [], error: null };
    }
    if (rec.table === 'entity_customers') {
        if (rec.eq.id === 'cu-1' && rec.eq.entity_slug === 'flora-bama') return { data: { id: 'cu-1', entity_slug: 'flora-bama', name: 'Cus', email: 'cu@example.test', phone: null }, error: null };
        return { data: rec.eq.id ? null : [], error: null };
    }
    if (rec.table === 'app_records') {
        if (rec.insert) return { data: { id: 'r-2', created_at: '2026-01-01T00:00:00Z', ...rec.insert }, error: null };
        if (rec.update) return { data: [{ id: 'r-1', install_id: 'in-song', entity_slug: 'flora-bama', app_table: 'requests', data: { song: 'Margaritaville', from_name: 'Al', ...rec.update.data }, created_at: '2026-01-01T00:00:00Z' }], error: null };
        const row = { id: 'r-1', install_id: 'in-song', entity_slug: 'flora-bama', app_table: 'requests', data: { song: 'Margaritaville', from_name: 'Al' }, created_at: '2026-01-01T00:00:00Z' };
        if (rec.args.some((a) => a[2]?.head)) return { data: null, error: null, count: 1 };
        return { data: rec.eq.id ? row : [row], error: null, count: 1 };
    }
    return { data: [], error: null, count: 0 };
}

const dbStub = {
    from: (t) => ({
        select: (...a) => builder(t, 'select').select(...a),
        insert: (v) => builder(t, 'insert').insert(v),
        upsert: (v, o) => builder(t, 'upsert').upsert(v, o),
        update: (v) => builder(t, 'update').update(v),
        delete: () => builder(t, 'delete').delete(),
    }),
    auth: {
        getUser: async (token) => (token === 'tourist-token'
            ? { data: { user: { id: 'user-77', email: 't@example.com' } }, error: null }
            : { data: null, error: new Error('no') }),
    },
};

// The permission rules are the real ones — only the schema read is stubbed —
// so these tests exercise the one copy routes/business-data.js uses too.
const realTables = require(path.join(ROOT, 'lib/businessTables.js'));
const STUB_TABLES = ['menu_items', 'faqs'];
const stubSchema = async () => schemaStub.getSchema();

const dataContracts = require(path.join(ROOT, 'lib/dataContracts.js'));
const schemaStub = {
    SYSTEM_COLUMNS: new Set(['id', 'entity_slug']),
    RESOURCES: realTables.RESOURCES,
    ACTIONS: realTables.ACTIONS,
    permits: realTables.permits,
    permitsResource: realTables.permitsResource,
    canAny: realTables.canAny,
    mayUse: realTables.mayUse,
    resourceForTable: realTables.resourceForTable,
    normalizePermissions: realTables.normalizePermissions,
    scopeForPermissions: realTables.scopeForPermissions,
    // Sections (a table or a data contract), as lib/businessTables.js resolves them, over the stub schema.
    sectionNamed: async (name) => {
        const { tables, columns } = await stubSchema();
        if (dataContracts.isContractName(name)) {
            const entry = dataContracts.contractFor(name);
            return entry && tables.includes(entry.table) ? { name, ...entry } : null;
        }
        return tables.includes(name) ? { name, table: name, contract: null, resource: realTables.resourceForTable(name, columns[name]), filter: {}, fieldMap: null, idColumn: 'id', slugColumn: 'entity_slug', columns: null, readOnly: false, single: false, derived: null, exclusive: [] } : null;
    },
    sectionPermitted: async (caller, section, action) => {
        if (!section || (section.readOnly && action !== 'read')) return false;
        if (section.contract) return realTables.permitsResource(caller, section.resource, action);
        const { columns } = await stubSchema();
        return realTables.permits(caller, section.table, columns[section.table], action);
    },
    sectionSelect: async () => '*',
    applySection: realTables.applySection,
    sectionRow: realTables.sectionRow,
    sectionRows: async (section, rows) => (rows || []).map((r) => realTables.sectionRow(section, r)),
    sectionValues: realTables.sectionValues,
    settleExclusive: realTables.settleExclusive,
    sectionInsertValues: async (section, body) => ({ values: realTables.sectionValues(section, await schemaStub.cleanBody(section.table, realTables.sectionValues(section, body))), refused: [] }),
    sectionPatchValues: async (section, body) => {
        const values = await schemaStub.cleanBody(section.table, realTables.sectionValues(section, body));
        for (const column of Object.keys(section.filter || {})) delete values[column];
        return { values, refused: [] };
    },
    // The app data space is the manifest's, not the schema's: the real rules apply as they are.
    appTables: realTables.appTables,
    appTableFor: realTables.appTableFor,
    cleanAppRecord: realTables.cleanAppRecord,
    appRecordRow: realTables.appRecordRow,
    ownerOnlyColumns: realTables.ownerOnlyColumns,
    tablesFor: async (caller, action = 'read') => {
        const { tables, columns } = await stubSchema();
        return tables.filter((t) => realTables.permits(caller, t, columns[t], action));
    },
    allowTableFor: async (caller, name, action) => {
        const { columns } = await stubSchema();
        return STUB_TABLES.includes(name) && realTables.permits(caller, name, columns[name], action) ? name : null;
    },
    getSchema: async () => ({
        tables: ['menu_items', 'faqs'],
        columns: {
            menu_items: [
                { name: 'id', type: 'integer', editable: false },
                { name: 'entity_slug', type: 'string', editable: false },
                { name: 'name', type: 'string', editable: true },
                { name: 'price', type: 'number', editable: true },
                { name: 'created_at', type: 'string', editable: false },
            ],
            faqs: [{ name: 'id', type: 'integer', editable: false }],
        },
        at: Date.now(),
    }),
    allowTable: async (n) => (['menu_items', 'faqs'].includes(n) ? n : null),
    cleanBody: async (t, body) => {
        const out = {};
        for (const [k, v] of Object.entries(body || {})) {
            if (['id', 'entity_slug', 'created_at'].includes(k)) continue;
            if (!['name', 'price'].includes(k)) continue;
            out[k] = v;
        }
        return out;
    },
    textColumns: async () => ['name'],
    // The public boundary, stubbed to the same shape the real one has.
    publicTables: async () => ['menu_items', 'faqs', 'bookings'],
    allowPublicTable: async (n) => (['menu_items', 'faqs', 'bookings'].includes(n) ? n : null),
    publicReason: async () => null,   // switch off: nothing is held back
    HIDE_PERSONAL: false,
    scrubRow: (row) => {
        const out = {};
        for (const [k, v] of Object.entries(row || {})) {
            if (/email|phone_number|token/i.test(k)) continue;
            out[k] = v;
        }
        return out;
    },
};

function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
/* ── the public directory tools, stubbed to record their input ────────── */
const conciergeCalls = [];
const conciergeStub = {
    CONCIERGE_TOOLS: [
        { name: 'search_businesses', description: 's', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_business_details', description: 'd', inputSchema: { type: 'object', properties: {}, required: ['slug'] } },
        { name: 'check_availability', description: 'a', inputSchema: { type: 'object', properties: {}, required: ['slug'] } },
        { name: 'find_item_prices', description: 'p', inputSchema: { type: 'object', properties: {}, required: ['query'] } },
        { name: 'compare_businesses', description: 'c', inputSchema: { type: 'object', properties: {}, required: ['slugs'] } },
        { name: 'whats_on', description: 'w', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_categories', description: 'l', inputSchema: { type: 'object', properties: {} } },
        { name: 'find_available', description: 'v', inputSchema: { type: 'object', properties: {} } },
        { name: 'industry_sections', description: 'i', inputSchema: { type: 'object', properties: {} } },
    ],
    CONCIERGE_TOOL_NAMES: new Set(['search_businesses', 'get_business_details', 'check_availability', 'find_item_prices', 'compare_businesses', 'whats_on', 'list_categories', 'find_available', 'industry_sections']),
    asInputSchemaTools: () => [],
    runConciergeTool: async (name, input) => {
        conciergeCalls.push({ name, input });
        if (name === 'search_businesses') return { count: 1, results: [{ name: 'Flora-Bama', slug: 'flora-bama' }] };
        if (name === 'find_item_prices') return { results: [{ item: 'crab legs', price: 29, business: 'Flora-Bama' }] };
        return null;
    },
};

// routes/gcr.js owns the profile assembly (the joins a flat slug sweep cannot
// reach) and the Central clock. Stubbed so this needs no database.
inject(path.join(ROOT, 'routes/gcr.js'), {
    buildFullEntity: async (slug) => ({
        slug,
        name: 'Flora-Bama',
        menu_sections: [
            { section_name: 'Starters', items: [{ item_name: 'Snow Crab Legs', price: 34 }] },
        ],
    }),
    searchEntitySlugs: async () => ({ slugs: [] }),
    getCentralNow: () => ({ nowTime: '16:00', today: '2025-07-16', todayName: 'wednesday' }),
});

inject(path.join(ROOT, 'db.js'), dbStub);
inject(path.join(ROOT, 'lib/businessTables.js'), schemaStub);
inject(path.join(ROOT, 'lib/conciergeTools.js'), conciergeStub);

// messages.send, recording what it was asked to send (the address included,
// so the test can prove the result never carries it), and the business events
// an MCP write must fire like /api/business does (review 01 M12).
const sends = [];
inject(path.join(ROOT, 'lib/messages.js'), {
    CHANNELS: ['email', 'sms'],
    sendMessage: async (m) => { sends.push(m); return { id: 'msg-1', status: 'sent', customer_address: m.to }; },
});
const fired = [];
inject(path.join(ROOT, 'lib/businessEvents.js'), {
    sectionWritten: async (slug, table, before, after) => { fired.push({ slug, table, before, after }); return null; },
    appRecordCreated: async (slug, args) => { fired.push({ slug, app: args?.appKey, table: args?.table }); return []; },
});

const mcp = require(path.join(ROOT, 'routes/mcp.js'));
const mcpPublic = require(path.join(ROOT, 'routes/mcp-public.js'));
const app = express();
app.use(express.json());
app.use('/api/mcp/public', mcpPublic);
app.use('/api/mcp/business/:slug', mcpPublic.pinned);
app.use('/api/mcp', mcp);

const server = app.listen(0, run);

const BASE = () => `http://127.0.0.1:${server.address().port}/api/mcp`;
const AUTH = 'gcr_mcp_testtoken';

async function rpc(body, { auth = `Bearer ${AUTH}` } = {}) {
    const res = await fetch(BASE(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = (name, args) =>
    rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}

async function run() {
    console.log('\n── auth ──');
    check('no token → 401', (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: '' })).status === 401);
    const bare = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: AUTH });
    check('bare token (no Bearer) accepted', bare.status === 200);

    console.log('\n── protocol ──');
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    check('initialize echoes the asked version', init.body.result.protocolVersion === '2025-06-18');
    check('initialize advertises tools', !!init.body.result.capabilities.tools);
    const oldv = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'nonsense' } });
    check('unknown version → newest offered', oldv.body.result.protocolVersion === '2025-06-18');

    const notif = await fetch(BASE(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    check('notification → 202, no body', notif.status === 202);

    const bad = await rpc({ jsonrpc: '2.0', id: 9, method: 'nope' });
    check('unknown method → -32601', bad.body.error?.code === -32601);

    const batch = await rpc([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    check('batch → array of 2', Array.isArray(batch.body) && batch.body.length === 2);

    const getRes = await fetch(BASE(), { method: 'GET' });
    check('GET → 405 (no SSE channel)', getRes.status === 405);

    console.log('\n── scope ──');
    tokenScope = 'write';
    const wlist = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('write token sees 7 tools', wlist.body.result.tools.length === 7, `saw ${wlist.body.result.tools.length}`);

    tokenScope = 'read';
    const rlist = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = rlist.body.result.tools.map((t) => t.name);
    check('read token sees 4 tools', names.length === 4, names.join(','));
    check('read token is not shown delete_row', !names.includes('delete_row'));
    const denied = await call('delete_row', { section: 'menu_items', id: 1 });
    check('read token calling delete_row → refused', denied.body.error?.code === -32601 || denied.body.result?.isError);

    tokenScope = 'write';

    console.log('\n── permissions (resource:action) ──');
    tokenScope = 'read';
    tokenPermissions = ['menu:read'];
    const plist = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('menu:read token is not shown the writes',
        !plist.body.result.tools.some((t) => t.name === 'create_row'));
    const psecs = await call('list_sections', { include_empty: true });
    const pnames = psecs.body.result.structuredContent.sections.map((x) => x.section);
    check('menu:read lists menu sections only', pnames.includes('menu_items') && !pnames.includes('faqs'), pnames.join(','));
    const pread = await call('read_section', { section: 'menu_items' });
    check('menu:read may read menu_items', !pread.body.result?.isError);
    const pdenied = await call('read_section', { section: 'faqs' });
    check('menu:read may not read faqs (business)', pdenied.body.result?.isError === true
        && /not allowed to read business/.test(pdenied.body.result.content[0].text), JSON.stringify(pdenied.body).slice(0, 200));

    tokenScope = 'write';
    tokenPermissions = ['menu:write'];
    calls.length = 0;
    const pwrite = await call('update_row', { section: 'menu_items', id: 8821, values: { name: 'Y' } });
    check('menu:write may update menu_items', !pwrite.body.result?.isError);
    const pwriteFaq = await call('create_row', { section: 'faqs', values: { name: 'Q' } });
    check('menu:write may not write faqs', pwriteFaq.body.result?.isError === true);
    const pwriteRead = await call('read_section', { section: 'menu_items' });
    check('write does not imply read', pwriteRead.body.result?.isError === true);
    tokenPermissions = [];
    const none = await call('read_section', { section: 'menu_items' });
    check('an empty permission list reaches nothing', none.body.result?.isError === true);
    tokenPermissions = null;
    tokenScope = 'read';
    const legacy = await call('read_section', { section: 'faqs' });
    check('a legacy read token still reads every section', !legacy.body.result?.isError);
    tokenScope = 'write';

    console.log('\n── send_message by reference: the address never leaves gcr (DECISIONS #87) ──');
    tokenScope = 'write'; tokenPermissions = ['messages:send']; appsInstalled = false;
    const sendTool = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.find((t) => t.name === 'send_message');
    check('send_message takes to_ref and no longer requires to', sendTool && 'to_ref' in sendTool.inputSchema.properties && !sendTool.inputSchema.required.includes('to'), JSON.stringify(sendTool?.inputSchema));
    sends.length = 0; calls.length = 0;
    const byBooking = await call('send_message', { channel: 'sms', to_ref: { contract: 'booking.records', id: 'bk-1' }, body: 'How was it?' });
    check('a booking.records reference resolves to the booking\'s phone inside gcr', sends[0]?.to === '+15550001111' && sends[0].channel === 'sms' && sends[0].slug === 'flora-bama', JSON.stringify(sends[0]));
    const bookingRead = calls.find((c) => c.table === 'bookings');
    check('the lookup is filtered on the token\'s slug and the id', bookingRead && bookingRead.eq.entity_slug === 'flora-bama' && bookingRead.eq.id === 'bk-1', JSON.stringify(bookingRead?.eq));
    const outText = JSON.stringify(byBooking.body);
    check('the result reports the message, never the address', !byBooking.body.result?.isError && byBooking.body.result.structuredContent.message_id === 'msg-1'
        && !outText.includes('5550001111') && !outText.includes('ana@') && !('to' in byBooking.body.result.structuredContent), outText.slice(0, 300));
    sends.length = 0;
    const byCustomer = await call('send_message', { channel: 'email', to_ref: { customer_id: 'cu-1' }, body: 'Hello' });
    check('a customer_id reference resolves through customers.items to the email', sends[0]?.to === 'cu@example.test' && !JSON.stringify(byCustomer.body).includes('cu@example.test'), JSON.stringify({ sent: sends[0], body: byCustomer.body }).slice(0, 300));
    sends.length = 0;
    const noPhone = await call('send_message', { channel: 'sms', to_ref: { customer_id: 'cu-1' }, body: 'Hello' });
    check('a reference with no address for that channel is refused with the reason, nothing sent', noPhone.body.result?.isError === true && /no_address/.test(noPhone.body.result.content[0].text) && !sends.length, JSON.stringify(noPhone.body).slice(0, 200));
    const unknownRow = await call('send_message', { channel: 'sms', to_ref: { contract: 'booking.records', id: 'bk-404' }, body: 'x' });
    check('an unknown id is refused (not_found), nothing sent', unknownRow.body.result?.isError === true && /not_found/.test(unknownRow.body.result.content[0].text) && !sends.length);
    const unknownContract = await call('send_message', { channel: 'sms', to_ref: { contract: 'nope.items', id: '1' }, body: 'x' });
    check('a contract the registry lacks is refused (unknown_contract)', unknownContract.body.result?.isError === true && /unknown_contract/.test(unknownContract.body.result.content[0].text));
    const both = await call('send_message', { channel: 'sms', to: '+15550002222', to_ref: { customer_id: 'cu-1' }, body: 'x' });
    const neither = await call('send_message', { channel: 'sms', body: 'x' });
    check('to and to_ref together, or neither, is refused', both.body.result?.isError === true && neither.body.result?.isError === true && !sends.length);
    const plainTo = await call('send_message', { channel: 'sms', to: '+15550002222', body: 'x' });
    check('a plain to still works as before', !plainTo.body.result?.isError && sends[0]?.to === '+15550002222');
    tokenPermissions = null; appsInstalled = true;

    console.log('\n── MCP writes fire the same events /api/business fires (review 01 M12) ──');
    tokenScope = 'write'; fired.length = 0;
    await call('create_row', { section: 'menu_items', values: { name: 'New' } });
    check('create_row → sectionWritten(slug, table, null, row)', fired.length === 1 && fired[0].slug === 'flora-bama' && fired[0].table === 'menu_items' && fired[0].before === null && fired[0].after?.name === 'New', JSON.stringify(fired));
    fired.length = 0;
    await call('update_row', { section: 'menu_items', id: 8821, values: { name: 'Y' } });
    check('update_row → sectionWritten(slug, table, before, row)', fired.length === 1 && fired[0].table === 'menu_items' && fired[0].after?.id === 8821 && 'before' in fired[0], JSON.stringify(fired));

    console.log('\n── the slug is never taken from the request ──');
    calls.length = 0;
    await call('update_row', { section: 'menu_items', id: 8821, values: { name: 'X', entity_slug: 'somebody-else' } });
    const upd = calls.find((c) => c.table === 'menu_items' && c.update);
    check('update filters on the token slug', upd.eq.entity_slug === 'flora-bama', JSON.stringify(upd.eq));
    check('update filters on the id too', String(upd.eq.id) === '8821');
    check('entity_slug stripped from the values', !('entity_slug' in upd.update), JSON.stringify(upd.update));

    calls.length = 0;
    await call('create_row', { section: 'menu_items', values: { name: 'New', entity_slug: 'somebody-else', id: 5 } });
    const ins = calls.find((c) => c.insert);
    check('insert stamps the token slug', ins.insert.entity_slug === 'flora-bama', JSON.stringify(ins.insert));
    check('insert drops a caller-supplied id', !('id' in ins.insert));

    calls.length = 0;
    await call('delete_row', { section: 'menu_items', id: 8821 });
    const del = calls.find((c) => c.verb === 'delete');
    check('delete filters on the token slug', del.eq.entity_slug === 'flora-bama');

    calls.length = 0;
    await call('read_section', { section: 'menu_items' });
    const read = calls.find((c) => c.table === 'menu_items');
    check('read filters on the token slug', read.eq.entity_slug === 'flora-bama');

    console.log('\n── the table allow-list ──');
    const probe = await call('read_section', { section: 'users' });
    check('unknown section → tool error, not a query', probe.body.result?.isError === true,
        JSON.stringify(probe.body).slice(0, 160));
    const probe2 = await call('update_row', { section: 'auth.users', id: 1, values: { name: 'x' } });
    check('auth.users refused on write too', probe2.body.result?.isError === true);

    console.log('\n── search ──');
    calls.length = 0;
    await call('read_section', { section: 'menu_items', search: 'bush,wacker)*' });
    const searched = calls.find((c) => c.or);
    check('search builds an ilike across text columns', /name\.ilike\.%bush wacker/.test(searched.or), searched.or);

    console.log('\n── reads ──');
    const who = await call('whoami');
    check('whoami reports the business', who.body.result.structuredContent.slug === 'flora-bama');
    check('whoami reports write access', who.body.result.structuredContent.can_write === true);
    const desc = await call('describe_section', { section: 'menu_items' });
    check('describe_section lists columns', desc.body.result.structuredContent.columns.length === 5);
    const secs = await call('list_sections');
    check('list_sections returns sections', Array.isArray(secs.body.result.structuredContent.sections));

    console.log('\n── the agent face: installed apps\' actions as tools (DECISIONS #46) ──');
    tokenScope = 'write'; tokenPermissions = null; appsInstalled = false;
    const plain = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t) => t.name);
    check('no installed apps: the seven generic tools and nothing else', plain.length === 7 && !plain.some((n) => n.startsWith('app_')), plain.join(','));
    appsInstalled = true;
    const withApps = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools;
    const appNames = withApps.filter((t) => t.name.startsWith('app_')).map((t) => t.name);
    check('each declared action of each enabled installed app is a tool, app_<appKey>_<action>',
        ['app_song-requests_list_requests', 'app_song-requests_add_request', 'app_song-requests_mark_played', 'app_qr-menu_list_menu', 'app_qr-menu_add_item'].every((n) => appNames.includes(n)), appNames.join(','));
    check('an action on a table the app never declared is not', !appNames.includes('app_song-requests_ghost'));
    check('nor an unusable id, nor a kind that does not exist', !appNames.some((n) => /bad|wipe/i.test(n)));
    check('nor an action on a contract the registry lacks, nor on a binding the manifest lacks', !appNames.includes('app_qr-menu_unknown') && !appNames.includes('app_qr-menu_nowhere'));
    check('nor a write through a read-only binding', !appNames.includes('app_qr-menu_edit_faq'));
    check('nor a contract action the install was not granted (faqs.items needs business:read)', !appNames.includes('app_qr-menu_list_faqs'));
    check('a disabled install and a legacy dashboard row offer nothing', !appNames.some((n) => n.startsWith('app_off-app') || n.startsWith('app_legacy')));
    check('no tool anywhere takes a slug', withApps.every((t) => !('slug' in (t.inputSchema?.properties || {}))));
    const listTool = withApps.find((t) => t.name === 'app_song-requests_list_requests');
    check('a read action is marked read-only and says which app it is', listTool.annotations.readOnlyHint === true && /Song Requests/.test(listTool.description), JSON.stringify(listTool));
    const createTool = withApps.find((t) => t.name === 'app_song-requests_add_request');
    check('a create action takes values and is not read-only', createTool.inputSchema.required.includes('values') && createTool.annotations.readOnlyHint === false);

    calls.length = 0;
    const songs = await call('app_song-requests_list_requests', {});
    const songQuery = calls.find((c) => c.table === 'app_records' && c.verb === 'select');
    check('a table action reads the app\'s own records, scoped to the install and the token\'s business', !songs.body.result?.isError && songQuery?.eq.install_id === 'in-song' && songQuery.eq.entity_slug === 'flora-bama' && songQuery.eq.app_table === 'requests', JSON.stringify(songQuery?.eq));
    check('and returns them as the engine reads them', songs.body.result.structuredContent.rows[0]?.song === 'Margaritaville' && songs.body.result.structuredContent.app === 'song-requests', JSON.stringify(songs.body.result.structuredContent));
    calls.length = 0;
    const added = await call('app_song-requests_add_request', { values: { song: 'Sweet Caroline', from_name: 'Bo', entity_slug: 'somebody-else', install_id: 'in-other' } });
    const songInsert = calls.find((c) => c.table === 'app_records' && c.insert);
    check('a create action stamps the install and the business from the credential, keeps declared columns only',
        !added.body.result?.isError && songInsert?.insert.install_id === 'in-song' && songInsert.insert.entity_slug === 'flora-bama' && songInsert.insert.data.song === 'Sweet Caroline' && !('entity_slug' in songInsert.insert.data), JSON.stringify(songInsert?.insert));
    const badAdd = await call('app_song-requests_add_request', { values: { from_name: 'No song' } });
    check('the manifest\'s column rules apply (a required column missing is refused, naming it)', badAdd.body.result?.isError === true && /song/.test(badAdd.body.result.content[0].text), JSON.stringify(badAdd.body.result));
    calls.length = 0;
    const played = await call('app_song-requests_mark_played', { id: 'r-1', values: { from_name: 'Al (played)' } });
    const songUpdate = calls.find((c) => c.table === 'app_records' && c.update);
    check('an update action changes one of the install\'s records, scoped the same way', !played.body.result?.isError && songUpdate?.eq.install_id === 'in-song' && songUpdate.eq.entity_slug === 'flora-bama' && songUpdate.update.data.from_name === 'Al (played)', JSON.stringify(songUpdate));

    calls.length = 0;
    const menu = await call('app_qr-menu_list_menu', {});
    const menuQuery = calls.find((c) => c.table === 'menu_items');
    check('a contract action goes through the business door: the registry\'s table, the token\'s slug', !menu.body.result?.isError && menuQuery?.eq.entity_slug === 'flora-bama' && menu.body.result.structuredContent.section === 'menu_items', JSON.stringify(menu.body).slice(0, 200));
    calls.length = 0;
    await call('app_qr-menu_add_item', { values: { name: 'Gumbo', price: 9, entity_slug: 'somebody-else' } });
    const menuInsert = calls.find((c) => c.table === 'menu_items' && c.insert);
    check('a contract create stamps the token\'s slug, same as create_row', menuInsert?.insert.entity_slug === 'flora-bama' && menuInsert.insert.name === 'Gumbo', JSON.stringify(menuInsert?.insert));
    const unlisted = await call('app_song-requests_ghost', {});
    check('an action that is not listed cannot be called', unlisted.body.error?.code === -32601);

    tokenScope = 'read';
    const readOnlyNames = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t) => t.name);
    check('a read-only token is shown the read actions only', readOnlyNames.includes('app_song-requests_list_requests') && readOnlyNames.includes('app_qr-menu_list_menu') && !readOnlyNames.includes('app_song-requests_add_request') && !readOnlyNames.includes('app_qr-menu_add_item'), readOnlyNames.join(','));
    tokenScope = 'write'; tokenPermissions = ['menu:read'];
    const menuOnly = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t) => t.name);
    check('a contract action needs the caller\'s permission as well as the install\'s (menu:read sees list_menu, not add_item)', menuOnly.includes('app_qr-menu_list_menu') && !menuOnly.includes('app_qr-menu_add_item'), menuOnly.join(','));
    tokenPermissions = null;
    const sectionViaContract = await call('read_section', { section: 'menu.items' });
    check('the generic tools take a contract name too', !sectionViaContract.body.result?.isError && sectionViaContract.body.result.structuredContent.section === 'menu_items' && sectionViaContract.body.result.structuredContent.contract === 'menu.items', JSON.stringify(sectionViaContract.body).slice(0, 200));
    appsInstalled = false;

    console.log('\n── the public directory server ──');
    const PUB = () => `http://127.0.0.1:${server.address().port}/api/mcp/public`;
    const pubRpc = async (body, headers = {}) => {
        const res = await fetch(PUB(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    // The whole point of this one: an agent can connect with nothing.
    const anon = await pubRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('no token needed', anon.status === 200);
    check('twelve directory tools', anon.body.result.tools.length === 12, String(anon.body.result?.tools?.length));

    const pubInit = await pubRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('instructions carry the never-guess rule', /never state a price/i.test(pubInit.body.result.instructions));
    check('and forbid sending people to the website or a phone number',
        /never tell anyone to\s+ring the business, check its website/i.test(pubInit.body.result.instructions));
    check('unknown is a third answer, not a no',
        /never read it as a no/i.test(pubInit.body.result.instructions));
    check('a unit overriding its complex is called out',
        /the more specific one wins/i.test(pubInit.body.result.instructions));
    check('a missing figure is answered, not deflected',
        /have not published it/i.test(pubInit.body.result.instructions));

    conciergeCalls.length = 0;
    const found = await pubRpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'search_businesses', arguments: { query: 'crab legs', limit: 5 } },
    });
    check('arguments reach the tool', conciergeCalls[0]?.input?.query === 'crab legs');
    check('the result comes back as text', /Flora-Bama/.test(found.body.result.content[0].text));
    check('and as structured content', found.body.result.structuredContent.count === 1);

    const noSuch = await pubRpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_row', arguments: {} },
    });
    check('business write tools are not reachable here', noSuch.body.error?.code === -32601);

    conciergeCalls.length = 0;
    calls.length = 0;
    const anySections = await pubRpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_sections', arguments: { slug: 'any-business' } },
    });
    check('one agent can list any business\'s sections',
        anySections.body.result.structuredContent.slug === 'any-business');
    const anyRead = await pubRpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_section', arguments: { slug: 'other-business', section: 'menu_items' } },
    });
    check('and read any of their tables', anyRead.body.result.structuredContent.section === 'menu_items');
    check('scoped to the slug it was asked for',
        calls.filter((c) => c.table === 'menu_items').pop()?.eq.entity_slug === 'other-business');
    calls.length = 0;
    const whole = await pubRpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_business', arguments: { slug: 'flora-bama' } },
    });
    const swept = whole.body.result.structuredContent;
    check('one slug returns every section that has rows', swept.section_count > 0 && !!swept.sections.menu_items);
    check('the assembled profile comes back too', swept.profile?.name === 'Flora-Bama');
    check('and carries the menu items a flat sweep cannot reach',
        swept.profile.menu_sections[0].items[0].item_name === 'Snow Crab Legs');
    check('a section with no rows is absent, not empty', !('faqs' in swept.sections));
    check('nothing is truncated or told to call another tool',
        !JSON.stringify(swept).includes('for the rest'));
    check('the sweep pages with range() rather than a capped select',
        calls.filter((c) => c.table === 'menu_items').some((c) => Array.isArray(c.range)));
    check('every sweep query filtered on that slug',
        calls.filter((c) => c.eq.entity_slug).every((c) => c.eq.entity_slug === 'flora-bama'));

    const noSlug = await pubRpc({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_section', arguments: { section: 'menu_items' } },
    });
    check('a read with no slug is refused', noSlug.body.result?.isError === true);

    console.log('\n── it remembers the person asking ──');
    const anonTools = anon.body.result.tools.map((t) => t.name);
    check('an anonymous caller is not shown the memory tools',
        !anonTools.includes('remember') && !anonTools.includes('recall'));

    const asTourist = (body) => pubRpc(body, { Authorization: 'Bearer tourist-token' });
    const mine = await asTourist({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const myTools = mine.body.result.tools.map((t) => t.name);
    check('a signed-in traveller gets recall, remember and forget',
        ['recall', 'remember', 'forget'].every((n) => myTools.includes(n)));

    const hello = await asTourist({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('what is already known arrives on connect, not on request',
        /no seafood/.test(hello.body.result.instructions) && /two kids/.test(hello.body.result.instructions));
    check('and it is told not to ask again',
        /Do not ask them again/i.test(hello.body.result.instructions));

    calls.length = 0;
    const saved = await asTourist({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'remember', arguments: { category: 'fact', key: 'where_staying', value: 'Phoenix East' } },
    });
    const write = calls.find((c) => c.table === 'tourist_memories' && c.upsert);
    check('remember writes against the token holder, not an argument',
        write.upsert.user_id === 'user-77', JSON.stringify(write.upsert));
    check('and reports what it saved', saved.body.result.structuredContent.saved === 'where_staying');

    calls.length = 0;
    await asTourist({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'recall', arguments: {} },
    });
    check('recall reads only that person\'s memories',
        calls.find((c) => c.table === 'tourist_memories')?.eq.user_id === 'user-77');

    // A guest UUID is the id a signed-out visitor keeps until they sign up.
    const guest = await pubRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: 'Bearer 3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
    check('a guest id also earns memory', guest.body.result.tools.map((t) => t.name).includes('remember'));

    const pubInfo = await fetch(`${PUB()}/info`).then((r) => r.json());
    check('info says it is public', /^none — public/.test(pubInfo.authentication), pubInfo.authentication);
    check('and that a token buys memory', /remembered between conversations/.test(pubInfo.authentication));

    // A token sent to the public server must not grant anything extra, and
    // must not be rejected either — an agent configured once may send one.
    const withToken = await pubRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${AUTH}` });
    check('a stray token neither helps nor hurts', withToken.body.result.tools.length === 12);

    console.log('\n── attached to a slug (no token at all) ──');
    const PIN = (slug) => `http://127.0.0.1:${server.address().port}/api/mcp/business/${slug}`;
    const pinRpc = async (slug, body) => {
        const res = await fetch(PIN(slug), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    entityExists = true;
    const pinInit = await pinRpc('flora-bama', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('a slug in the URL is the whole setup', pinInit.status === 200);
    check('it knows which business it is', /You answer for Flora-Bama/.test(pinInit.body.result.instructions));
    check('the pinned agent is told it is the last stop, not a switchboard',
        /last stop, not a switchboard/i.test(pinInit.body.result.instructions));

    const pinTools = await pinRpc('flora-bama', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const detailTool = pinTools.body.result.tools.find((t) => t.name === 'get_business_details');
    check('slug is no longer required', !detailTool.inputSchema.required);
    check('but can still be passed', !!detailTool.inputSchema.properties.slug);
    check('the coast-wide tools stay', pinTools.body.result.tools.some((t) => t.name === 'search_businesses'));

    conciergeCalls.length = 0;
    await pinRpc('flora-bama', {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_business_details', arguments: {} },
    });
    check('a slugless call is filled in from the URL', conciergeCalls[0]?.input?.slug === 'flora-bama',
        JSON.stringify(conciergeCalls[0]));

    conciergeCalls.length = 0;
    await pinRpc('flora-bama', {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_business_details', arguments: { slug: 'somewhere-else' } },
    });
    check('an explicit slug still looks up another business — this is public data',
        conciergeCalls[0]?.input?.slug === 'somewhere-else');

    console.log('\n── the slug-attached agent can read any table the business uses ──');
    const discTools = pinTools.body.result.tools.map((t) => t.name);
    check('list_sections is offered', discTools.includes('list_sections'));
    check('read_section is offered', discTools.includes('read_section'));
    check('no write tool is', !discTools.some((n) => /create|update|delete/.test(n)));

    const sections = await pinRpc('flora-bama', {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sections', arguments: {} },
    });
    check('only sections with rows are listed',
        sections.body.result.structuredContent.sections.every((s) => s.rows > 0));

    calls.length = 0;
    const readOne = await pinRpc('flora-bama', {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_section', arguments: { section: 'menu_items' } },
    });
    const readQuery = calls.find((c) => c.table === 'menu_items');
    check('the read is scoped to the slug in the URL', readQuery.eq.entity_slug === 'flora-bama',
        JSON.stringify(readQuery.eq));
    check('rows come back', readOne.body.result.structuredContent.rows.length === 1);

    calls.length = 0;
    const anyTable = await pinRpc('flora-bama', {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_section', arguments: { section: 'bookings' } },
    });
    check('every slug table is readable by default', !anyTable.body.result?.isError,
        JSON.stringify(anyTable.body).slice(0, 140));
    check('and still only for the slug in the URL',
        calls.find((c) => c.table === 'bookings')?.eq.entity_slug === 'flora-bama');

    const audit = await fetch(`${PIN('flora-bama')}/sections`).then((r) => r.json());
    check('the boundary reports itself', Array.isArray(audit.readable_by_the_agent) && Array.isArray(audit.held_back));
    check('the audit ships names and counts, never rows', !JSON.stringify(audit).includes('Bushwacker'));

    entityExists = false;
    const missing = await pinRpc('not-a-business', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('an unknown slug is 404, not 401', missing.status === 404, String(missing.status));
    check('and says so plainly', /No business called/.test(missing.body.error.message));
    entityExists = true;

    console.log(`\n${pass} passed, ${fail} failed\n`);
    server.close();
    process.exit(fail ? 1 : 0);
}
