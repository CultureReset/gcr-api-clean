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
        update: (v) => { rec.update = v; return self; },
        delete: () => self,
        eq: (k, v) => { rec.eq[k] = v; return self; },
        or: (v) => { rec.or = v; return self; },
        order: (...a) => { rec.order = a; return self; },
        range: (...a) => { rec.range = a; return self; },
        limit: (n) => { rec.limit = n; return self; },
        not: () => self,
        in: () => self,
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
let entityExists = true;

function result(rec) {
    if (rec.table === 'business_mcp_tokens') {
        if (rec.update) return { data: [{ id: 'tok-1' }], error: null };
        return { data: { ...TOKEN_ROW, scope: tokenScope }, error: null };
    }
    if (rec.table === 'entity') {
        // entityExists false stands in for a slug nobody has, or a delisted one.
        if (!entityExists) return { data: null, error: null };
        return {
            data: { slug: 'flora-bama', name: 'Flora-Bama', entity_type: 'restaurant', city: 'Perdido Key', phone: '555-0100', is_active: true },
            error: null,
        };
    }
    if (rec.table === 'menu_items') {
        if (rec.insert) return { data: { id: 1, ...rec.insert }, error: null };
        if (rec.update) return { data: [{ id: 8821, ...rec.update }], error: null };
        return { data: [{ id: 8821, name: 'Bushwacker', price: 12 }], error: null, count: 1 };
    }
    return { data: [], error: null, count: 0 };
}

const dbStub = {
    from: (t) => ({
        select: (...a) => builder(t, 'select').select(...a),
        insert: (v) => builder(t, 'insert').insert(v),
        update: (v) => builder(t, 'update').update(v),
        delete: () => builder(t, 'delete').delete(),
    }),
    auth: { getUser: async () => ({ data: null, error: new Error('no') }) },
};

const schemaStub = {
    SYSTEM_COLUMNS: new Set(['id', 'entity_slug']),
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
    ],
    CONCIERGE_TOOL_NAMES: new Set(['search_businesses', 'get_business_details', 'check_availability', 'find_item_prices', 'compare_businesses', 'whats_on', 'list_categories']),
    asInputSchemaTools: () => [],
    runConciergeTool: async (name, input) => {
        conciergeCalls.push({ name, input });
        if (name === 'search_businesses') return { count: 1, results: [{ name: 'Flora-Bama', slug: 'flora-bama' }] };
        if (name === 'find_item_prices') return { results: [{ item: 'crab legs', price: 29, business: 'Flora-Bama' }] };
        return null;
    },
};

inject(path.join(ROOT, 'db.js'), dbStub);
inject(path.join(ROOT, 'lib/businessTables.js'), schemaStub);
inject(path.join(ROOT, 'lib/conciergeTools.js'), conciergeStub);

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
    check('ten directory tools', anon.body.result.tools.length === 10, String(anon.body.result?.tools?.length));

    const pubInit = await pubRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    check('instructions carry the never-guess rule', /never state a price/i.test(pubInit.body.result.instructions));

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

    const pubInfo = await fetch(`${PUB()}/info`).then((r) => r.json());
    check('info says it is public', pubInfo.authentication === 'none — public');

    // A token sent to the public server must not grant anything extra, and
    // must not be rejected either — an agent configured once may send one.
    const withToken = await pubRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${AUTH}` });
    check('a stray token neither helps nor hurts', withToken.body.result.tools.length === 10);

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
    check('and its own phone number', /555-0100/.test(pinInit.body.result.instructions));

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
