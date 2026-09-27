#!/usr/bin/env node
// The operator's fleet view: admin only, read only, every business at once.
// Runs against a stub database; no credentials or network.
'use strict';
const Module = require('module');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
const calls = [];
const NOW = Date.now();
const NODES = [
    { id: 'n1', entity_slug: 'flora-bama', name: 'Bar box', version: 'abc123', health: { core: 'ok' }, last_seen_at: new Date(NOW - 30e3).toISOString(), revoked_at: null },
    { id: 'n2', entity_slug: 'lulus', name: 'Kitchen', version: 'abc123', health: { core: 'unreachable' }, last_seen_at: new Date(NOW - 3600e3).toISOString(), revoked_at: null },
    { id: 'n3', entity_slug: 'lulus', name: 'Old', version: 'old999', health: null, last_seen_at: null, revoked_at: new Date().toISOString() },
];

function builder(table) {
    const rec = { table, eq: {} };
    calls.push(rec);
    const self = {
        select() { return self; }, order() { return self; }, limit() { return self; },
        in(col, vals) { rec.in = { col, vals }; return self; },
        eq(k, v) { rec.eq[k] = v; return self; },
        then(resolve) { resolve(result(rec)); },
    };
    return self;
}
function result(rec) {
    if (rec.table === 'ghost_nodes') return { data: NODES.filter((n) => !rec.eq.entity_slug || n.entity_slug === rec.eq.entity_slug), error: null };
    if (rec.table === 'ghost_node_requests') return { data: rec.eq.node_id === 'n1' ? [{ id: 'r1', method: 'POST', path: '/intent', status: 'done', response_status: 200 }] : [], error: null };
    if (rec.table === 'entity') return { data: [{ slug: 'flora-bama', name: 'Flora-Bama' }, { slug: 'lulus', name: "Lulu's" }], error: null };
    return { data: [], error: null };
}
const dbStub = { from: (t) => builder(t), auth: { getUser: async () => ({ data: null, error: new Error('no') }) } };
function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.resolve(__dirname, '..', 'db.js'), dbStub);

const router = require('../routes/admin-ghost');
const app = express();
app.use(express.json());
app.use('/api/admin/ghost', router);

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
    if (!ok) failures += 1;
}
function call(server, url, token) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method: 'GET',
            headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
            let body = ''; res.on('data', (c) => { body += c; });
            res.on('end', () => { let json = {}; try { json = JSON.parse(body); } catch (_) { /* empty */ } resolve({ status: res.statusCode, json }); });
        });
        req.end();
    });
}
const admin = jwt.sign({ userId: 'u1', role: 'admin' }, 'test-secret');
const owner = jwt.sign({ userId: 'u2', role: 'owner' }, 'test-secret');

(async () => {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        let r = await call(server, '/api/admin/ghost/nodes');
        check('fleet needs a token', r.status === 401);
        r = await call(server, '/api/admin/ghost/nodes', owner);
        check('an owner token is refused', r.status === 403);
        r = await call(server, '/api/admin/ghost/nodes', admin);
        check('admin sees every business', r.status === 200 && r.json.nodes.length === 3 && new Set(r.json.nodes.map((n) => n.entity_slug)).size === 2);
        check('business names attached', r.json.nodes.find((n) => n.id === 'n1').business_name === 'Flora-Bama');
        check('online computed from heartbeat, revoked never online',
            r.json.nodes.find((n) => n.id === 'n1').online === true && r.json.nodes.find((n) => n.id === 'n2').online === false && r.json.nodes.find((n) => n.id === 'n3').online === false);
        r = await call(server, '/api/admin/ghost/nodes?slug=lulus', admin);
        check('slug is a filter', r.json.nodes.length === 2 && r.json.nodes.every((n) => n.entity_slug === 'lulus'));
        r = await call(server, '/api/admin/ghost/nodes?online=1', admin);
        check('online filter', r.json.nodes.length === 1 && r.json.nodes[0].id === 'n1');
        r = await call(server, '/api/admin/ghost/summary', admin);
        check('summary counts boxes, online, businesses, unhealthy, revoked',
            r.json.boxes === 2 && r.json.online === 1 && r.json.businesses === 2 && r.json.unhealthy === 1 && r.json.revoked === 1, JSON.stringify(r.json));
        check('summary lists releases for a rollout', r.json.releases.length === 1 && r.json.releases[0].version === 'abc123' && r.json.releases[0].boxes === 2 && r.json.releases[0].online === 1);
        r = await call(server, '/api/admin/ghost/nodes/n1/requests', admin);
        check('activity for one box, shape only', r.status === 200 && r.json.requests.length === 1 && !('body' in r.json.requests[0]) && !('response_body' in r.json.requests[0]));
        const wrote = calls.some((c) => c.insert || c.update);
        check('fleet view never writes', !wrote);
    } finally {
        server.close();
    }
    console.log(failures ? `\nghost-admin: ${failures} check(s) failed` : '\nghost-admin: all checks passed');
    process.exit(failures ? 1 : 0);
})();
