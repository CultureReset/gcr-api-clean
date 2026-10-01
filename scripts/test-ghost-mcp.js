// Focused tests for the owner-scoped Ghost MCP relay.
// Run with: node scripts/test-ghost-mcp.js

const path = require('path');
const http = require('http');
const Module = require('module');
const crypto = require('crypto');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const NODE_ID = 'node-owner-a';
const OTHER_NODE_ID = 'node-owner-b';
const ENTITY = 'flora-bama';
const TOKEN = 'gcr_ghostmcp_' + 'a'.repeat(64);
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const tokenRow = {
    id: 'token-1',
    node_id: NODE_ID,
    entity_slug: ENTITY,
    label: 'Paperclip',
    created_by: 'owner-1',
    revoked_at: null,
};
const nodes = {
    [NODE_ID]: { id: NODE_ID, entity_slug: ENTITY, revoked_at: null },
    [OTHER_NODE_ID]: { id: OTHER_NODE_ID, entity_slug: 'other-business', revoked_at: null },
};
const requests = [{
    id: OTHER_REQUEST_ID,
    node_id: OTHER_NODE_ID,
    method: 'POST',
    path: '/intent',
    body: { text: 'private request' },
    status: 'done',
}];
const queries = [];
let requestSequence = 0;
let failures = 0;

function result(query) {
    if (query.table === 'ghost_mcp_tokens') {
        if (query.update) return { data: [{ id: tokenRow.id }], error: null };
        return { data: query.eq.token_hash === sha(TOKEN) ? tokenRow : null, error: null };
    }
    if (query.table === 'ghost_nodes') {
        return { data: nodes[query.eq.id] || null, error: null };
    }
    if (query.table === 'ghost_node_requests') {
        if (query.insert) {
            const input = query.insert;
            const duplicate = input.idempotency_key
                ? requests.find((r) => r.node_id === input.node_id && r.idempotency_key === input.idempotency_key)
                : null;
            if (duplicate) return { data: null, error: { code: '23505' } };
            const row = {
                ...input,
                id: REQUEST_ID,
                status: 'queued',
                created_at: new Date(0).toISOString(),
            };
            requests.push(row);
            return { data: { id: row.id, status: row.status, created_at: row.created_at }, error: null };
        }
        let rows = requests;
        for (const [key, value] of Object.entries(query.eq)) rows = rows.filter((row) => row[key] === value);
        return { data: rows[0] || null, error: null };
    }
    return { data: null, error: null };
}

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function builder(table) {
    const query = { table, eq: {} };
    queries.push(query);
    const self = {
        select: () => self,
        insert: (value) => { query.insert = value; return self; },
        update: (value) => { query.update = value; return self; },
        eq: (key, value) => { query.eq[key] = value; return self; },
        order: () => self,
        maybeSingle: async () => result(query),
        single: async () => result(query),
        then: (resolve, reject) => Promise.resolve(result(query)).then(resolve, reject),
    };
    return self;
}

const dbStub = {
    from: (table) => builder(table),
};

function inject(file, exports) {
    const full = require.resolve(file);
    const mod = new Module(full, null);
    mod.filename = full;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[full] = mod;
}

inject(path.resolve(ROOT, 'db.js'), dbStub);
const router = require('../routes/mcp-ghost');
const app = express();
app.use(express.json());
app.use('/api/mcp/ghost', router);

function check(name, ok, detail = '') {
    console.log((ok ? 'ok  ' : 'FAIL ') + name + (ok ? '' : ' — ' + detail));
    if (!ok) failures += 1;
}

async function request(server, method, args, bearer = TOKEN) {
    const headers = { 'content-type': 'application/json' };
    if (bearer) headers.authorization = 'Bearer ' + bearer;
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/mcp/ghost', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'rpc-' + (++requestSequence),
            method: 'tools/call',
            params: { name: method, arguments: args },
        }),
    });
    return { status: response.status, body: await response.json() };
}

(async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        let response = await request(server, 'nextgent_ghost_capabilities', {}, null);
        check('rejects missing credentials', response.status === 401);

        response = await request(server, 'nextgent_ghost_submit_intent', {
            text: 'send the agreed test message',
            idempotency_key: 'paperclip-action-0001',
        });
        const first = response.body?.result?.structuredContent;
        check('queues the physical action request', first?.queued === true && first?.status === 'queued');
        check('pins queued work to the credential node', requests.some((row) =>
            row.node_id === NODE_ID && row.entity_slug === ENTITY && row.path === '/intent'));
        const intentRow = requests.find((row) => row.idempotency_key === 'paperclip-action-0001');
        check('stores idempotency key and keeps owner identity out of model payload',
            intentRow?.idempotency_key === 'paperclip-action-0001' &&
            intentRow?.body?.requested_by === 'paperclip' &&
            !Object.prototype.hasOwnProperty.call(intentRow?.body || {}, 'owner_id'));

        response = await request(server, 'nextgent_ghost_submit_intent', {
            text: 'send the agreed test message',
            idempotency_key: 'paperclip-action-0001',
        });
        const duplicate = response.body?.result?.structuredContent;
        check('same key and same request return the original relay ID',
            duplicate?.id === first?.id && requests.filter((row) => row.idempotency_key === 'paperclip-action-0001').length === 1);

        response = await request(server, 'nextgent_ghost_submit_intent', {
            text: 'a different action',
            idempotency_key: 'paperclip-action-0001',
        });
        check('same key cannot be reused for a different action', response.body?.result?.isError === true);

        response = await request(server, 'nextgent_ghost_request_status', { request_id: OTHER_REQUEST_ID });
        check('cannot read another node request', response.body?.result?.isError === true);

        const foreignLookup = queries.find((q) =>
            q.table === 'ghost_node_requests' && q.eq.id === OTHER_REQUEST_ID);
        check('status lookup always includes this credential node',
            foreignLookup?.eq.node_id === NODE_ID);

        const priorCount = requests.length;
        response = await request(server, 'nextgent_ghost_action_receipt', { action_id: '../../other-node' });
        check('rejects path-shaped action IDs without queuing', response.body?.result?.isError === true && requests.length === priorCount);

        response = await request(server, 'nextgent_ghost_capabilities', {});
        const capRow = requests.find((row) => row.path === '/capabilities');
        check('capability discovery uses only the fixed local path', capRow?.method === 'GET' && capRow?.node_id === NODE_ID);

        const toolResponse = await request(server, 'nextgent_ghost_submit_intent', {});
        check('missing idempotency key is rejected', toolResponse.body?.result?.isError === true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    process.exitCode = failures ? 1 : 0;
})();
