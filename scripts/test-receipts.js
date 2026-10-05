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
        check('a receipt without a capability posts none', !('capability' in body), JSON.stringify(body));
        check('marked posted, never twice', !!T.ghost_node_requests[1].receipt_posted_at);
        await call('POST', `/api/nodes/requests/${req2.id}/response`, { status: 200, body: { action: 'sms.send', verified: true } }, NODE_TOKEN);
        check('a repeated answer does not post again', posted.length === 1);

        T.company_links.length = 0;
        await call('POST', '/api/mcp/ghost', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nextgent_ghost_submit_intent', arguments: { text: 'x', idempotency_key: 'key-00002' } } }, MCP_TOKEN);
        const req3 = T.ghost_node_requests[2];
        await call('POST', `/api/nodes/requests/${req3.id}/response`, { status: 200, body: { receipt: { action: 'x', verified: false } } }, NODE_TOKEN);
        check('an unlinked business: not posted, the reason kept', posted.length === 1 && T.ghost_node_requests[2].receipt_error === 'not_linked');
        T.company_links.push({ company_id: 'co-1', entity_slug: 'shop' });

        console.log('\n── receipts produced later are pushed by the computer (DECISIONS #80, #79) ──');
        // The box's late push: core's receipt shape in relay form, no target.
        const late = { action_id: 'act-9', capability: 'maps.update_hours', environment: 'android', map_id: 'gmb.hours', map_version: '3', requested_state: { hours: 'closes 22:00' }, observed_state: { hours: 'closes 22:00' }, result: 'VERIFIED', evidence: ['after.png'], created_at: '2026-10-04T13:00:00Z', task_id: 'task-77', action: 'maps.update_hours', verified: true, at: '2026-10-04T13:00:00Z', new_value: { hours: 'closes 22:00' } };
        const noToken = await realFetch(`http://127.0.0.1:${server.address().port}/api/nodes/receipts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipts: [late] }) });
        check('a push needs a node token', noToken.status === 401);
        const rows = T.ghost_node_requests.length;
        const pushed = await call('POST', '/api/nodes/receipts', { receipts: [late, { capability: 'no.action.id', result: 'VERIFIED' }] }, NODE_TOKEN);
        check('the push is accepted (2xx; 404/405/501 would pause the box)', pushed.status === 200 && pushed.body.accepted === 1 && pushed.body.posted === 1 && pushed.body.skipped === 1, JSON.stringify(pushed.body));
        const synthetic = T.ghost_node_requests[rows];
        check('each receipt becomes a done GET /actions/<id>/receipt row of the node\'s business, with its task id',
            T.ghost_node_requests.length === rows + 1 && synthetic?.method === 'GET' && synthetic.path === '/actions/act-9/receipt' && synthetic.status === 'done'
            && synthetic.response_status === 200 && synthetic.response_body === late || JSON.stringify(synthetic?.response_body) === JSON.stringify(late),
            JSON.stringify(synthetic));
        check('scoped by the node token, never the body', synthetic?.entity_slug === 'shop' && synthetic.node_id === 'node-1' && synthetic.paperclip_task_id === 'task-77');
        const lateBody = JSON.parse(posted[1]?.body || '{}');
        check('posted to Paperclip against its task', posted.length === 2 && lateBody.companyId === 'co-1' && lateBody.taskId === 'task-77' && lateBody.verified === true && lateBody.action === 'maps.update_hours', JSON.stringify(lateBody));
        check('a receipt with no target falls back to its capability (DECISIONS #79)', lateBody.target === 'maps.update_hours' && !!synthetic.receipt_posted_at);
        check('the capability is forwarded as its own field', lateBody.capability === 'maps.update_hours', JSON.stringify(lateBody));
        const again = await call('POST', '/api/nodes/receipts', { receipts: [late] }, NODE_TOKEN);
        check('the same action pushed again is a duplicate: no new row, nothing posted', again.status === 200 && again.body.duplicates === 1 && T.ghost_node_requests.length === rows + 1 && posted.length === 2, JSON.stringify(again.body));
        const carried = await call('POST', '/api/nodes/receipts', { receipts: [{ action_id: 'act-7', action: 'sms.send', verified: true }] }, NODE_TOKEN);
        check('a receipt already carried in an answer is not posted twice', carried.body.duplicates === 1 && posted.length === 2, JSON.stringify(carried.body));
        const bare = await call('POST', '/api/nodes/receipts', { receipts: [{ action_id: 'act-10', result: 'FAILED' }] }, NODE_TOKEN);
        const bareBody = JSON.parse(posted[2]?.body || '{}');
        check('with neither target nor capability the action id stands in', bare.body.posted === 1 && bareBody.target === 'act-10' && bareBody.verified === false, JSON.stringify(bareBody));
        check('not a list: refused', (await call('POST', '/api/nodes/receipts', { receipts: 'x' }, NODE_TOKEN)).status === 400);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('receipts');
}
