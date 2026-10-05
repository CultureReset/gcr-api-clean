#!/usr/bin/env node
// ============================================================
// Device status reaches the registry from the heartbeat (DECISIONS #73)
// ============================================================
//
//     npm run test:device-sync
//
// A computer heartbeats to routes/nodes.js; lib/deviceSync.js pushes
// { companyId, nodeId, version, capabilities, phones, lastSeenAt } to
// Paperclip, signed, when something changed or the last push is older than
// DEVICE_STATUS_PUSH_SECONDS. Never fails the heartbeat. In-memory database,
// a recording Paperclip. No credentials, no network.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc-secret';
Object.assign(process.env, { NEXTGENT_SERVICE_SECRET: SECRET, NEXTGENT_SECRETS_KEY: 'box-key', PAPERCLIP_API_URL: 'https://paperclip.test', DEVICE_STATUS_PUSH_SECONDS: '60' });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const NODE_TOKEN = 'gcr_node_' + 'e'.repeat(48);

const { T, db } = createMemDb({ tables: {
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    ghost_nodes: [{ id: 'node-1', entity_slug: 'shop', name: 'Front desk', token_hash: sha(NODE_TOKEN), revoked_at: null, registry_state: null, registry_synced_at: null }],
    ghost_node_requests: [],
} });
inject(path.join(ROOT, 'db.js'), db);
inject(path.join(ROOT, 'middleware/ownerAuth.js'), { ownerRequired: (q, r) => r.status(401).json({}) });

const posted = [];
let paperclipStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://paperclip.test')) {
        posted.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return { ok: paperclipStatus < 400, status: paperclipStatus, text: async () => '{"ok":true}' };
    }
    return realFetch(url, init);
};

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/nodes', require(path.join(ROOT, 'routes/nodes.js')));
const server = app.listen(0, run);
async function heartbeat(body) {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/nodes/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${NODE_TOKEN}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const health = (phone, extra = {}) => ({ core: 'ok', capabilities: ['sms.send', 'maps.update'], phone, reported_at: 'x', ...extra });

async function run() {
    try {
        const node = T.ghost_nodes[0];
        let r = await heartbeat({ version: '1.0.0', health: health({ device_id: 'and-1', sim: 'ready', online: true, adb: 'device' }) });
        check('the heartbeat is accepted and the first status pushed', r.status === 200 && r.body.ok === true && r.body.registry_pushed === true && posted.length === 1, JSON.stringify(r.body));
        const p = posted[0];
        check('to Paperclip POST /api/nextgent/devices/status, signed per CONTRACT §3', p?.url === 'https://paperclip.test/api/nextgent/devices/status'
            && p.headers['x-nextgent-signature'] === crypto.createHmac('sha256', SECRET).update(`${p.headers['x-nextgent-timestamp']}\n${p.headers['x-nextgent-nonce']}\nPOST\n/api/nextgent/devices/status\n\n${sha(JSON.stringify(p.body))}`).digest('hex'));
        check('the body: companyId from company_links, nodeId, version, capabilities, phones [{deviceId, sim, online}], lastSeenAt',
            p?.body.companyId === 'co-1' && p.body.nodeId === 'node-1' && p.body.version === '1.0.0'
            && JSON.stringify(p.body.capabilities) === '["sms.send","maps.update"]'
            && JSON.stringify(p.body.phones) === JSON.stringify([{ deviceId: 'and-1', sim: 'ready', online: true }])
            && p.body.lastSeenAt === node.last_seen_at && !('health' in p.body), JSON.stringify(p.body));
        check('the pushed state and its time are kept on the node', !!node.registry_synced_at && node.registry_state?.version === '1.0.0' && node.registry_state.phones[0].deviceId === 'and-1', JSON.stringify(node));
        console.log('  status push body:', JSON.stringify(p.body));

        r = await heartbeat({ version: '1.0.0', health: health({ device_id: 'and-1', sim: 'ready', online: true, adb: 'device', screen: 'off' }) });
        check('the same state again (other health fields may differ) is not pushed', r.status === 200 && r.body.registry_pushed === false && posted.length === 1, JSON.stringify(r.body));

        await heartbeat({ version: '1.0.0', health: health({ device_id: 'and-1', sim: 'absent', online: false }) });
        check('a phone change is pushed', posted.length === 2 && posted[1].body.phones[0].online === false && posted[1].body.phones[0].sim === 'absent');
        await heartbeat({ version: '1.1.0', health: health({ device_id: 'and-1', sim: 'absent', online: false }) });
        check('a version change is pushed', posted.length === 3 && posted[2].body.version === '1.1.0');
        await heartbeat({ version: '1.1.0', health: health({ device_id: 'and-1', sim: 'absent', online: false }, { capabilities: ['sms.send'] }) });
        check('a capabilities change is pushed', posted.length === 4 && JSON.stringify(posted[3].body.capabilities) === '["sms.send"]');
        await heartbeat({ version: '1.1.0', health: { core: 'ok', capabilities: ['sms.send'], phones: [{ device_id: 'and-1', sim: 'absent', online: false }, { deviceId: 'and-2', sim: 'ready', online: true }] } });
        check('a computer may report several phones', posted.length === 5 && posted[4].body.phones.length === 2 && posted[4].body.phones[1].deviceId === 'and-2', JSON.stringify(posted[4]?.body.phones));

        node.registry_synced_at = new Date(Date.now() - 61 * 1000).toISOString();
        r = await heartbeat({ version: '1.1.0', health: { core: 'ok', capabilities: ['sms.send'], phones: [{ device_id: 'and-1', sim: 'absent', online: false }, { deviceId: 'and-2', sim: 'ready', online: true }] } });
        check('an unchanged state is still pushed once the last push is older than DEVICE_STATUS_PUSH_SECONDS', r.body.registry_pushed === true && posted.length === 6);
        check('with a fresh lastSeenAt', posted[5].body.lastSeenAt === node.last_seen_at && posted[5].body.lastSeenAt > posted[0].body.lastSeenAt);

        paperclipStatus = 500;
        const syncedBefore = node.registry_synced_at;
        r = await heartbeat({ version: '2.0.0', health: health({ device_id: 'and-1', sim: 'ready', online: true }) });
        check('Paperclip down: the heartbeat still succeeds', r.status === 200 && r.body.ok === true && r.body.registry_pushed === false && node.version === '2.0.0', JSON.stringify(r.body));
        check('and the push is not marked done, so it is retried next time', node.registry_synced_at === syncedBefore);
        paperclipStatus = 200;
        r = await heartbeat({ version: '2.0.0', health: health({ device_id: 'and-1', sim: 'ready', online: true }) });
        check('the next heartbeat pushes it', r.body.registry_pushed === true && posted[posted.length - 1].body.version === '2.0.0');

        delete process.env.PAPERCLIP_API_URL;
        r = await heartbeat({ version: '2.0.1', health: health({ device_id: 'and-1', sim: 'ready', online: true }) });
        check('Paperclip not configured: the heartbeat still succeeds', r.status === 200 && r.body.ok === true && r.body.registry_pushed === false);
        process.env.PAPERCLIP_API_URL = 'https://paperclip.test';

        const n = posted.length;
        T.company_links.length = 0;
        r = await heartbeat({ version: '2.0.2', health: health({ device_id: 'and-1', sim: 'ready', online: true }) });
        check('an unlinked business: nothing pushed, the heartbeat still succeeds', r.status === 200 && r.body.ok === true && posted.length === n);
        T.company_links.push({ company_id: 'co-1', entity_slug: 'shop' });

        // sql/nextgent_nodes_registry.sql not applied: the registry columns are missing.
        const realFrom = db.from;
        db.from = (t) => {
            const q = realFrom(t);
            if (t !== 'ghost_nodes') return q;
            const select = q.select;
            q.select = (cols, o) => (String(cols).includes('registry_state')
                ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column ghost_nodes.registry_state does not exist' } }) }) }
                : select(cols, o));
            return q;
        };
        r = await heartbeat({ version: '2.0.3', health: health({ device_id: 'and-1', sim: 'ready', online: true }) });
        check('without the registry columns the heartbeat still succeeds and nothing is pushed', r.status === 200 && r.body.ok === true && r.body.registry_pushed === false && posted.length === n && node.version === '2.0.3', JSON.stringify(r.body));
        db.from = realFrom;

        const { statusFrom } = require(path.join(ROOT, 'lib/deviceSync.js'));
        const s = statusFrom({ nodeId: 'n', version: null, health: null, lastSeenAt: 't' });
        check('no health: empty capabilities and phones, never undefined', JSON.stringify(s) === JSON.stringify({ nodeId: 'n', version: null, capabilities: [], phones: [], lastSeenAt: 't' }), JSON.stringify(s));
        const s2 = statusFrom({ nodeId: 'n', version: '1', health: { phone: { serial_hint: 'ab12', sim: 'ready', online: 'yes' } }, lastSeenAt: 't' });
        check('a phone without a device id falls back to its serial hint; online is a boolean', s2.phones[0].deviceId === 'ab12' && s2.phones[0].online === false, JSON.stringify(s2));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('device-sync');
}
