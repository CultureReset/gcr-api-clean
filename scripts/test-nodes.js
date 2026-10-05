// ============================================================
// NODES — relay scoping tests
// ============================================================
//
//     node scripts/test-nodes.js
//
// Boots routes/nodes.js against a recording stub of ../db, the same way
// test-mcp.js does, so the two things that matter can be checked with no
// credentials, no network and no database:
//
//   1. the business a request acts on always comes from the session or from
//      the node's token, never from the request;
//   2. a box can only be asked for paths on the allow-list, and can only
//      answer requests that belong to it.

const path = require('path');
const http = require('http');
const Module = require('module');
const crypto = require('crypto');
const express = require('express');

const calls = [];
const NODE_TOKEN = 'gcr_node_' + 'a'.repeat(48);
const NODE_ROW = { id: 'node-1', entity_slug: 'flora-bama', name: 'Ghost', revoked_at: null };

function builder(table, verb) {
    const rec = { table, verb, eq: {}, args: [] };
    calls.push(rec);
    const self = {
        select: (...a) => { rec.args.push(['select', ...a]); return self; },
        insert: (v) => { rec.insert = v; return self; },
        update: (v) => { rec.update = v; return self; },
        eq: (k, v) => { rec.eq[k] = v; return self; },
        lt: (k, v) => { rec.lt = [k, v]; return self; },
        in: (k, v) => { rec.in = [k, v]; return self; },
        is: (k, v) => { rec.is = [k, v]; return self; },
        not: (...a) => { rec.not = a; return self; },
        order: (...a) => { rec.order = a; return self; },
        limit: (n) => { rec.limit = n; return self; },
        maybeSingle: () => Promise.resolve(result(rec)),
        single: () => Promise.resolve(result(rec)),
        then: (res, rej) => Promise.resolve(result(rec)).then(res, rej),
    };
    return self;
}

function result(rec) {
    if (rec.table === 'ghost_nodes') {
        if (rec.insert) return { data: { id: 'node-9', name: rec.insert.name, token_hint: rec.insert.token_hint, created_at: 'now' }, error: null };
        if (rec.update) return { data: [{ id: rec.eq.id }], error: null };
        if (rec.eq.token_hash) {
            return { data: rec.eq.token_hash === sha(NODE_TOKEN) ? NODE_ROW : null, error: null };
        }
        if (rec.eq.id) return { data: rec.eq.entity_slug === 'flora-bama' ? { id: rec.eq.id, revoked_at: null } : null, error: null };
        return { data: [NODE_ROW], error: null };
    }
    if (rec.table === 'ghost_node_requests') {
        if (rec.insert) return { data: { id: 'req-1', status: 'queued', created_at: 'now' }, error: null };
        if (rec.update) return { data: rec.eq.node_id === 'node-1' ? [{ id: rec.eq.id || 'req-1' }] : [], error: null };
        if (rec.eq.id && rec.eq.node_id === 'node-1') return { data: { id: rec.eq.id, path: '/intent' }, error: null };
        if (rec.eq.status === 'queued') return { data: [{ id: 'req-1', method: 'POST', path: '/intent', body: { text: 'hi' } }], error: null };
        return { data: rec.eq.entity_slug === 'flora-bama' ? { id: 'req-1', status: 'done' } : null, error: null };
    }
    return { data: [], error: null };
}

const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

const dbStub = {
    from: (t) => ({
        select: (...a) => builder(t, 'select').select(...a),
        insert: (v) => builder(t, 'insert').insert(v),
        update: (v) => builder(t, 'update').update(v),
    }),
    auth: { getUser: async (token) => (token === 'owner-token'
        ? { data: { user: { id: 'user-1' } }, error: null }
        : { data: null, error: new Error('no') }) },
};

function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.resolve(__dirname, '..', 'db.js'), dbStub);

// ownerAuth reads entity_owners through the stub; give it an answer.
const realResult = result;
function ownerRows(rec) {
    if (rec.table === 'entity_owners') return { data: [{ entity_slug: 'flora-bama', role: 'owner' }], error: null };
    return realResult(rec);
}
// eslint-disable-next-line no-func-assign
result = ownerRows;

const router = require('../routes/nodes');
const app = express();
app.use(express.json());
app.use('/api/nodes', router);

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
    if (!ok) failures += 1;
}

async function call(server, method, url, { token, body } = {}) {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
}

(async () => {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        // Owner side
        let r = await call(server, 'GET', '/api/nodes');
        check('owner list needs a session', r.status === 401);

        r = await call(server, 'POST', '/api/nodes', { token: 'owner-token', body: { name: 'Shop box', entity_slug: 'someone-else' } });
        check('enrol returns the token once', r.status === 201 && r.json.token.startsWith('gcr_node_'));
        const enrol = calls.find((c) => c.table === 'ghost_nodes' && c.insert);
        check('enrol scopes to the session slug, not the body', enrol.insert.entity_slug === 'flora-bama', JSON.stringify(enrol.insert));
        check('enrol stores only the hash', enrol.insert.token_hash === sha(r.json.token) && !('token' in enrol.insert));

        r = await call(server, 'POST', '/api/nodes/node-1/requests', { token: 'owner-token', body: { method: 'POST', path: '/sms/out' } });
        check('a path off the allow-list is refused', r.status === 400);
        r = await call(server, 'POST', '/api/nodes/node-1/requests', { token: 'owner-token', body: { method: 'POST', path: '/remote/session' } });
        check('the computer serves no /remote/ path, so the queue refuses it (DECISIONS #75)', r.status === 400);
        check('the allow-list is what the computer enforces: no /remote/', !router.forwardable('/remote/session') && router.forwardable('/actions/x/receipt'));

        // Remote view: the viewer gets the token; the queue and the session row hold only its hash.
        process.env.NODE_REMOTE_URL_TEMPLATE = 'https://view.example.test/{node}?t={token}';
        calls.length = 0;
        r = await call(server, 'GET', '/api/nodes/node-1/remote', { token: 'owner-token' });
        const viewerToken = r.status === 200 ? decodeURIComponent(new URL(r.json.url).searchParams.get('t')) : null;
        check('remote view returns a link carrying the token', r.status === 200 && !!viewerToken && viewerToken.length >= 24, JSON.stringify(r.json));
        const sessionRow = calls.find((c) => c.table === 'node_remote_sessions' && c.insert);
        check('the session row stores only the hash', sessionRow?.insert.token_hash === sha(viewerToken) && !('token' in sessionRow.insert));
        const remoteReq = calls.find((c) => c.table === 'ghost_node_requests' && c.insert);
        check('the queued request for the computer holds the hash, never the token',
            remoteReq?.insert.body?.token_hash === sha(viewerToken) && !JSON.stringify(remoteReq.insert).includes(viewerToken), JSON.stringify(remoteReq?.insert));
        delete process.env.NODE_REMOTE_URL_TEMPLATE;

        calls.length = 0;
        r = await call(server, 'POST', '/api/nodes/node-1/requests', { token: 'owner-token', body: { method: 'POST', path: '/intent', body: { text: 'open display settings' } } });
        check('an allowed request is queued', r.status === 202 && r.json.request.status === 'queued');
        const queued = calls.find((c) => c.table === 'ghost_node_requests' && c.insert);
        check('queued request carries the session slug', queued.insert.entity_slug === 'flora-bama');
        const listed = calls.filter((c) => c.table === 'ghost_nodes' && !c.insert && !c.update && !c.eq.token_hash);
        check('every owner lookup is scoped to the login, not just the business',
            listed.length > 0 && listed.every((c) => c.eq.created_by === 'user-1' && c.eq.entity_slug === 'flora-bama'),
            JSON.stringify(listed.map((c) => c.eq)));
        const answers = calls.filter((c) => c.table === 'ghost_node_requests' && !c.insert && !c.update && c.eq.status !== 'queued');
        check('reading an answer is scoped to the login', answers.every((c) => c.eq.created_by === 'user-1'));

        // Box side
        r = await call(server, 'GET', '/api/nodes/pull');
        check('box pull needs a node token', r.status === 401);
        r = await call(server, 'GET', '/api/nodes/pull', { token: 'gcr_node_' + 'b'.repeat(48) });
        check('an unknown node token is refused', r.status === 401);

        calls.length = 0;
        r = await call(server, 'GET', '/api/nodes/pull', { token: NODE_TOKEN });
        check('box pulls its queued requests', r.status === 200 && r.json.requests.length === 1);
        const mark = calls.find((c) => c.table === 'ghost_node_requests' && c.update?.status === 'dispatched');
        check('pulled requests are marked dispatched for this node only', mark.update.status === 'dispatched' && mark.eq.node_id === 'node-1');

        calls.length = 0;
        r = await call(server, 'POST', '/api/nodes/requests/req-1/response', { token: NODE_TOKEN, body: { status: 200, body: { resolved: true } } });
        check('box answers a request', r.status === 200);
        const answer = calls.find((c) => c.table === 'ghost_node_requests' && c.update);
        check('answer is scoped to the node that owns the request', answer.eq.node_id === 'node-1' && answer.update.status === 'done');

        r = await call(server, 'POST', '/api/nodes/heartbeat', { token: NODE_TOKEN, body: { version: '0.2.0', health: { core: 'ok' } } });
        check('heartbeat accepted', r.status === 200);

        // Late receipts pushed by the box (DECISIONS #80)
        r = await call(server, 'POST', '/api/nodes/receipts', { body: { receipts: [] } });
        check('a receipt push needs a node token', r.status === 401);
        calls.length = 0;
        r = await call(server, 'POST', '/api/nodes/receipts', { token: NODE_TOKEN, body: { receipts: [{ action_id: 'act-1', capability: 'sms.send', result: 'VERIFIED', task_id: 'task-1', entity_slug: 'someone-else' }] } });
        check('a pushed receipt is accepted', r.status === 200 && r.json.accepted === 1, JSON.stringify(r.json));
        const stored = calls.find((c) => c.table === 'ghost_node_requests' && c.insert);
        check('it is stored as a done receipt request of the token\'s business, never the body\'s',
            stored?.insert.entity_slug === 'flora-bama' && stored.insert.node_id === 'node-1' && stored.insert.path === '/actions/act-1/receipt'
            && stored.insert.method === 'GET' && stored.insert.status === 'done' && stored.insert.paperclip_task_id === 'task-1', JSON.stringify(stored?.insert));
        const dedupe = calls.find((c) => c.table === 'ghost_node_requests' && !c.insert && !c.update);
        check('duplicates are looked for among this node\'s requests only', dedupe?.eq.node_id === 'node-1');
    } finally {
        server.close();
    }
    console.log(failures ? `\n${failures} failing` : '\nnodes: all checks passed');
    process.exit(failures ? 1 : 0);
})();
