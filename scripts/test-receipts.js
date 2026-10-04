#!/usr/bin/env node
// ============================================================
// Ghost receipts: the task id rides the instruction; the computer's receipt
// goes to Paperclip, signed (plan §11, CONTRACT §5)
// ============================================================
//
//     npm run test:receipts

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc-secret';
Object.assign(process.env, { NEXTGENT_SERVICE_SECRET: SECRET, NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key', PAPERCLIP_API_URL: 'https://paperclip.test' });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const NODE_TOKEN = 'gcr_node_' + 'c'.repeat(48);
const MCP_TOKEN = 'gcr_ghostmcp_' + 'd'.repeat(64);

const { T, db } = createMemDb({ tables: {
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    ghost_nodes: [{ id: 'node-1', entity_slug: 'shop', name: 'Front desk', token_hash: sha(NODE_TOKEN), revoked_at: null }],
    ghost_mcp_tokens: [{ id: 'gm-1', node_id: 'node-1', entity_slug: 'shop', token_hash: sha(MCP_TOKEN), revoked_at: null }],
    ghost_node_requests: [],
} });
inject(path.join(ROOT, 'db.js'), db);
inject(path.join(ROOT, 'middleware/ownerAuth.js'), { ownerRequired: (q, r) => r.status(401).json({}) });

const posted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://paperclip.test')) {
        posted.push({ url: String(url), headers: init.headers, body: init.body });
        return { ok: true, status: 201, text: async () => '{"ok":true}' };
    }
    return realFetch(url, init);
};

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/nodes', require(path.join(ROOT, 'routes/nodes.js')));
app.use('/api/mcp/ghost', require(path.join(ROOT, 'routes/mcp-ghost.js')));
const server = app.listen(0, run);
async function call(method, p, body, token) {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function run() {
    try {
        const submit = await call('POST', '/api/mcp/ghost', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nextgent_ghost_submit_intent', arguments: { text: 'Text Ana: table ready', idempotency_key: 'key-00001', task_id: 'task-42' } } }, MCP_TOKEN);
        const req1 = T.ghost_node_requests[0];
        check('the instruction carries the Paperclip task id', submit.status === 200 && req1?.paperclip_task_id === 'task-42' && req1.body.task_id === 'task-42', JSON.stringify(submit.body));

        // The computer answers the intent: an action id, verification pending.
        await call('POST', `/api/nodes/requests/${req1.id}/response`, { status: 200, body: { action: { id: 'act-7', status: 'PENDING_APPROVAL' } } }, NODE_TOKEN);
        check('no receipt, nothing posted', !posted.length);

        // The agent asks for the receipt (no task id given).
        await call('POST', '/api/mcp/ghost', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nextgent_ghost_action_receipt', arguments: { action_id: 'act-7' } } }, MCP_TOKEN);
        const req2 = T.ghost_node_requests[1];
        const r = await call('POST', `/api/nodes/requests/${req2.id}/response`, { status: 200, body: {
            action: 'sms.send', target: '+15550001111', new_value: 'table ready', verified: true, at: '2026-10-04T12:00:00Z', evidence: { screenshot: 'sha256:abc' },
        } }, NODE_TOKEN);
        check('the box hears the receipt went up', r.body.receipt_posted === true, JSON.stringify(r.body));
        const p = posted[0];
        const body = JSON.parse(p?.body || '{}');
        check('posted to Paperclip /api/nextgent/receipts', p?.url === 'https://paperclip.test/api/nextgent/receipts');
        const ts = p.headers['x-nextgent-timestamp'];
        const nonce = p.headers['x-nextgent-nonce'];
        const bodyHash = crypto.createHash('sha256').update(p.body).digest('hex');
        check('signed per CONTRACT §3: ts, nonce, METHOD, path, query, sha256(body)', /^[0-9a-f]{32,}$/.test(nonce || '')
            && p.headers['x-nextgent-signature'] === crypto.createHmac('sha256', SECRET).update(`${ts}\n${nonce}\nPOST\n/api/nextgent/receipts\n\n${bodyHash}`).digest('hex'));
        check('against the instruction\'s task, with the receipt fields', body.companyId === 'co-1' && body.taskId === 'task-42' && body.action === 'sms.send'
            && body.target === '+15550001111' && body.newValue === 'table ready' && body.verified === true && body.device === 'Front desk' && body.evidence.screenshot === 'sha256:abc', JSON.stringify(body));
        check('marked posted, never twice', !!T.ghost_node_requests[1].receipt_posted_at);
        await call('POST', `/api/nodes/requests/${req2.id}/response`, { status: 200, body: { action: 'sms.send', verified: true } }, NODE_TOKEN);
        check('a repeated answer does not post again', posted.length === 1);

        T.company_links.length = 0;
        await call('POST', '/api/mcp/ghost', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nextgent_ghost_submit_intent', arguments: { text: 'x', idempotency_key: 'key-00002' } } }, MCP_TOKEN);
        const req3 = T.ghost_node_requests[2];
        await call('POST', `/api/nodes/requests/${req3.id}/response`, { status: 200, body: { receipt: { action: 'x', verified: false } } }, NODE_TOKEN);
        check('an unlinked business: not posted, the reason kept', posted.length === 1 && T.ghost_node_requests[2].receipt_error === 'not_linked');
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('receipts');
}
