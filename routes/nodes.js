// ============================================================
// NODES — the relay between a business's dashboard and its Ghost box
// ============================================================
//
// Two callers, two guards:
//
//   The owner (business dashboard session, ownerRequired): enrols a box,
//   lists boxes, queues a request for one, reads the answer. The business is
//   req.entitySlug from the session; nothing in the request names it.
//
//   The box (bearer node token, nodeRequired): heartbeats, pulls queued
//   requests, posts answers. Which business a token belongs to comes from
//   ghost_nodes.token_hash, the same way business_mcp_tokens works.
//
// This API runs as serverless functions, so there is no push: the box polls.
// A request queued here is served the next time the box pulls (every few
// seconds) and the dashboard polls the answer.

const express = require('express');
const crypto = require('crypto');
const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const { envInt, envStr } = require('../lib/env');
const pairing = require('../lib/nodePairing');

const router = express.Router();

const { TOKEN_PREFIX, hashToken, normalizeUserCode } = pairing;
const nowIso = () => new Date().toISOString();

// Paths the dashboard may ask a box to serve. The box enforces the same list.
const FORWARDABLE = ['/health', '/capabilities', '/intent', '/approvals', '/actions/', '/remote/'];
const forwardable = (path) =>
    typeof path === 'string' && !path.includes('..') && FORWARDABLE.some((p) => path.startsWith(p));

const missingTable = (error) =>
    /ghost_node|ghost_mcp_tokens/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);
const tableError = (res, error) =>
    res.status(missingTable(error) ? 501 : 500).json({
        error: missingTable(error) ? (/ghost_mcp_tokens|ghost_node_requests.*idempotency_key/i.test(error.message) ? 'Ghost MCP integration is not set up yet (run sql/ghost_mcp_tokens.sql).' : 'Ghost nodes are not set up on this database yet (run sql/ghost_nodes.sql).') : error.message,
    });

// ── the box's guard ────────────────────────────────────────────────────────
async function nodeRequired(req, res, next) {
    const header = (req.headers.authorization || '').trim();
    const raw = (/^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : header).trim();
    if (!raw || !raw.startsWith(TOKEN_PREFIX)) return res.status(401).json({ error: 'No node token.' });

    const { data, error } = await supabase
        .from('ghost_nodes')
        .select('id, entity_slug, name, revoked_at')
        .eq('token_hash', hashToken(raw))
        .maybeSingle();
    if (error) return tableError(res, error);
    if (!data) return res.status(401).json({ error: 'That node token is not valid.' });
    if (data.revoked_at) return res.status(401).json({ error: 'That node token has been revoked.' });

    req.node = data;
    return next();
}

// ── owner side ─────────────────────────────────────────────────────────────

// Which boxes a caller sees.
//
//   Supabase dashboard login   one login, one box, one phone: a box belongs to
//                              the user who enrolled it, inside their business,
//                              so two logins at one business never drive each
//                              other's Android.
//   Paperclip business token   the company is the business (company_links ->
//                              entity_slug), and its computers belong to it,
//                              not to one person: Paperclip user ids are not
//                              uuids, so created_by cannot hold them, and the
//                              plan's "a company reaches its computer through
//                              its business link" is exactly this.
//   admin acting as a business all of that business's boxes.
const mine = (query, req) =>
    req.actingAsAdmin || req.authVia === 'paperclip'
        ? query.eq('entity_slug', req.entitySlug)
        : query.eq('entity_slug', req.entitySlug).eq('created_by', req.ownerUserId);


// ── pairing: the TV sign-in (OAuth device flow), plan §11 ──────────────────
//
//   1. The computer asks for a code: POST /pair/start → a short user_code to
//      show (and put in a QR) and a long device_code it keeps to itself.
//   2. The owner approves the user_code. Paperclip does this through the
//      signed POST /api/nextgent/nodes/pair (DECISIONS #69: the business is
//      the company's, through company_links); POST /pair { code } here, with
//      the owner's session, is kept until Play-user has switched. Both run
//      lib/nodePairing.approvePairing. The computer never chooses its business.
//   3. The computer polls POST /pair/poll { device_code } and, once, receives
//      its own node token (and the device token Paperclip minted for it, when
//      there is one). Codes expire (NODE_PAIR_TTL_MINUTES).
//
// Only hashes of both codes are stored; the tokens wait sealed
// (lib/secretBox.js) until the computer collects them, then are erased.

const PAIR_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pairTtlMinutes = () => envInt('NODE_PAIR_TTL_MINUTES', 10);
const pairPollSeconds = () => envInt('NODE_PAIR_POLL_SECONDS', 5);

function newUserCode() {
    const len = Math.min(Math.max(envInt('NODE_PAIR_CODE_LENGTH', 8), 6), 12);
    let out = '';
    for (let i = 0; i < len; i += 1) out += PAIR_CHARSET[crypto.randomInt(PAIR_CHARSET.length)];
    return out;
}
router.post('/pair/start', async (req, res) => {
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const userCode = newUserCode();
    const expiresAt = new Date(Date.now() + pairTtlMinutes() * 60 * 1000).toISOString();
    const { error } = await supabase.from('node_pairings').insert({
        device_code_hash: hashToken(deviceCode),
        user_code_hash: hashToken(userCode),
        name: String(req.body?.name || '').trim().slice(0, 80) || null,
        status: 'pending',
        expires_at: expiresAt,
    });
    if (error) return res.status(501).json({ error: `Pairing is not set up on this database yet: ${error.message}` });
    const verify = envStr('NODE_PAIR_URL');
    res.status(201).json({
        device_code: deviceCode,
        user_code: userCode,
        expires_in: pairTtlMinutes() * 60,
        interval: pairPollSeconds(),
        ...(verify ? { verification_uri: verify, verification_uri_complete: `${verify}${verify.includes('?') ? '&' : '?'}code=${userCode}` } : {}),
    });
});

router.post('/pair/poll', async (req, res) => {
    const deviceCode = String(req.body?.device_code || '');
    if (!deviceCode) return res.status(400).json({ error: 'device_code is required.' });
    const { data: row, error } = await supabase.from('node_pairings').select('*')
        .eq('device_code_hash', hashToken(deviceCode)).maybeSingle();
    if (error) return tableError(res, error);
    if (!row) return res.status(404).json({ error: 'Unknown pairing.' });
    if (row.status === 'collected') return res.status(410).json({ status: 'collected', error: 'This pairing was already collected.' });
    if (new Date(row.expires_at) < new Date() && row.status !== 'approved') return res.status(410).json({ status: 'expired' });
    if (row.status !== 'approved') return res.status(202).json({ status: 'pending', interval: pairPollSeconds() });

    // Hand the tokens over once, then forget them.
    const sealed = row.token_sealed;
    const nodeId = row.node_id;
    const { data: claimed } = await supabase.from('node_pairings')
        .update({ status: 'collected', token_sealed: null, collected_at: nowIso() })
        .eq('id', row.id).eq('status', 'approved').select('id');
    if (!claimed?.length) return res.status(410).json({ status: 'collected' });
    const { data: node } = await supabase.from('ghost_nodes').select('id, name, entity_slug').eq('id', nodeId).maybeSingle();
    const { token, deviceToken } = pairing.openSealed(sealed);
    res.json({ status: 'approved', token, ...(deviceToken ? { device_token: deviceToken } : {}), node: node ? { id: node.id, name: node.name } : null });
});

/** The answer to a lib/nodePairing error: a database error as tableError, the rest by status. */
const pairingError = (res, err) => (err.dbError ? tableError(res, err.dbError) : res.status(err.status || 500).json({ error: err.message }));

// Transitional (DECISIONS #69): the owner's session approves the code. The
// business is the session's; the same helper Paperclip's signed route uses.
router.post('/pair', ownerRequired, async (req, res) => {
    try {
        const { node } = await pairing.approvePairing({
            entitySlug: req.entitySlug,
            code: req.body?.code,
            name: req.body?.name,
            createdBy: req.ownerUserId || null,
            approvedBy: req.paperclip?.userId ? `paperclip:${req.paperclip.userId}` : req.ownerUserId || null,
        });
        res.status(201).json({ node });
    } catch (err) {
        pairingError(res, err);
    }
});

// ── remote view of a computer's screen ─────────────────────────────────────
//
// GET /:id/remote mints a short-lived session token, asks the computer to open
// a remote session for it (a relay request to /remote/session), and returns
// the viewer link: NODE_REMOTE_URL_TEMPLATE with {node} and {token} filled in.
// The viewer checks a token with POST /remote/verify. Only the token's hash is
// kept.

router.post('/remote/verify', async (req, res) => {
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).json({ error: 'token is required.' });
    const { data, error } = await supabase.from('node_remote_sessions').select('node_id, expires_at, revoked_at')
        .eq('token_hash', hashToken(token)).maybeSingle();
    if (error) return tableError(res, error);
    const valid = !!data && !data.revoked_at && new Date(data.expires_at) > new Date();
    res.status(valid ? 200 : 401).json({ valid, ...(valid ? { node_id: data.node_id, expires_at: data.expires_at } : {}) });
});

// GET /api/nodes — this user's boxes
router.get('/', ownerRequired, async (req, res) => {
    const { data, error } = await mine(supabase
        .from('ghost_nodes')
        .select('id, name, token_hint, version, health, created_at, last_seen_at, revoked_at'), req)
        .order('created_at', { ascending: true });
    if (error) return tableError(res, error);
    res.json({ nodes: data || [] });
});

// POST /api/nodes — enrol a box. The token is returned once and never stored.
router.post('/', ownerRequired, async (req, res) => {
    const name = String(req.body?.name || 'Ghost').trim().slice(0, 80) || 'Ghost';
    const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
    const { data, error } = await supabase
        .from('ghost_nodes')
        .insert({
            entity_slug: req.entitySlug,
            name,
            token_hash: hashToken(token),
            token_hint: token.slice(-6),
            created_by: req.ownerUserId || null,
        })
        .select('id, name, token_hint, created_at')
        .single();
    if (error) return tableError(res, error);
    res.status(201).json({ node: data, token });
});


// GET /api/nodes/:id/mcp-tokens — list metadata only; raw tokens are never recoverable.
router.get('/:id/mcp-tokens', ownerRequired, async (req, res) => {
    const { data: node, error: nodeError } = await mine(supabase
        .from('ghost_nodes')
        .select('id')
        .eq('id', req.params.id), req)
        .maybeSingle();
    if (nodeError) return tableError(res, nodeError);
    if (!node) return res.status(404).json({ error: 'No such Ghost.' });
    const { data, error } = await supabase
        .from('ghost_mcp_tokens')
        .select('id, node_id, label, token_hint, created_at, last_used_at, revoked_at')
        .eq('node_id', req.params.id)
        .order('created_at', { ascending: true });
    if (error) return tableError(res, error);
    res.json({ credentials: data || [] });
});

// POST /api/nodes/:id/mcp-token — mint a credential for Paperclip/another MCP client.
// It is scoped to exactly this user's Ghost. The raw value is returned once.
router.post('/:id/mcp-token', ownerRequired, async (req, res) => {
    const label = String(req.body?.label || 'Paperclip').trim().slice(0, 80) || 'Paperclip';
    const token = 'gcr_ghostmcp_' + crypto.randomBytes(32).toString('hex');
    const { data: node, error: nodeError } = await mine(supabase
        .from('ghost_nodes')
        .select('id, entity_slug, revoked_at')
        .eq('id', req.params.id), req)
        .maybeSingle();
    if (nodeError) return tableError(res, nodeError);
    if (!node || node.revoked_at) return res.status(404).json({ error: 'No such active Ghost.' });

    const { data, error } = await supabase
        .from('ghost_mcp_tokens')
        .insert({
            node_id: node.id,
            entity_slug: node.entity_slug,
            label,
            token_hash: hashToken(token),
            token_hint: token.slice(-6),
            created_by: req.ownerUserId || null,
        })
        .select('id, node_id, label, token_hint, created_at')
        .single();
    if (error) return tableError(res, error);
    res.status(201).json({ credential: data, token });
});

// DELETE /api/nodes/:id/mcp-token/:tokenId — revoke one Paperclip connection.
router.delete('/:id/mcp-token/:tokenId', ownerRequired, async (req, res) => {
    const { data: node, error: nodeError } = await mine(supabase
        .from('ghost_nodes')
        .select('id')
        .eq('id', req.params.id), req)
        .maybeSingle();
    if (nodeError) return tableError(res, nodeError);
    if (!node) return res.status(404).json({ error: 'No such Ghost.' });
    const { data, error } = await supabase
        .from('ghost_mcp_tokens')
        .update({ revoked_at: nowIso() })
        .eq('id', req.params.tokenId)
        .eq('node_id', req.params.id)
        .select('id');
    if (error) return tableError(res, error);
    if (!data?.length) return res.status(404).json({ error: 'No such MCP credential.' });
    res.json({ revoked: true });
});

// GET /api/nodes/:id/remote — a link to view this computer's screen
router.get('/:id/remote', ownerRequired, async (req, res) => {
    const template = envStr('NODE_REMOTE_URL_TEMPLATE');
    if (!template) return res.status(503).json({ error: 'Remote view is not configured (NODE_REMOTE_URL_TEMPLATE).' });
    const { data: node, error: nodeError } = await mine(supabase.from('ghost_nodes').select('id, revoked_at').eq('id', req.params.id), req).maybeSingle();
    if (nodeError) return tableError(res, nodeError);
    if (!node || node.revoked_at) return res.status(404).json({ error: 'No such computer.' });

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + envInt('NODE_REMOTE_TTL_MINUTES', 15) * 60 * 1000).toISOString();
    const { error } = await supabase.from('node_remote_sessions').insert({
        node_id: node.id, entity_slug: req.entitySlug, token_hash: hashToken(token), expires_at: expiresAt,
        created_by: req.paperclip?.userId ? `paperclip:${req.paperclip.userId}` : req.ownerUserId || null,
    });
    if (error) return tableError(res, error);
    // The computer is told the token's hash, never the token: it compares
    // sha256 of what a viewer presents (or asks POST /remote/verify), so the
    // queued request holds nothing that opens the session by itself.
    const { error: queueError } = await supabase.from('ghost_node_requests').insert({
        node_id: node.id, entity_slug: req.entitySlug, method: 'POST', path: '/remote/session',
        body: { token_hash: hashToken(token), expires_at: expiresAt }, created_by: req.ownerUserId || null,
    });
    if (queueError) return tableError(res, queueError);
    const url = template.replace(/\{node\}/g, encodeURIComponent(node.id)).replace(/\{token\}/g, encodeURIComponent(token));
    res.json({ url, expiresAt });
});

// DELETE /api/nodes/:id — revoke a box's token (and its agent credentials).
// Transitional (DECISIONS #69): Paperclip revokes through the signed
// POST /api/nextgent/nodes/:nodeId/revoke; both run lib/nodePairing.revokeNodes.
router.delete('/:id', ownerRequired, async (req, res) => {
    try {
        const count = await pairing.revokeNodes({
            entitySlug: req.entitySlug,
            nodeId: req.params.id,
            createdBy: req.actingAsAdmin || req.authVia === 'paperclip' ? null : req.ownerUserId,
        });
        if (!count) return res.status(404).json({ error: 'No such box.' });
        res.json({ revoked: true });
    } catch (err) {
        pairingError(res, err);
    }
});

// POST /api/nodes/:id/requests — queue something for the box to do
router.post('/:id/requests', ownerRequired, async (req, res) => {
    const method = String(req.body?.method || 'GET').toUpperCase();
    const path = req.body?.path;
    if (!['GET', 'POST'].includes(method) || !forwardable(path)) {
        return res.status(400).json({ error: 'That request cannot be sent to a box.' });
    }
    const { data: node, error: nodeError } = await mine(supabase
        .from('ghost_nodes')
        .select('id, revoked_at')
        .eq('id', req.params.id), req)
        .maybeSingle();
    if (nodeError) return tableError(res, nodeError);
    if (!node || node.revoked_at) return res.status(404).json({ error: 'No such box.' });

    const { data, error } = await supabase
        .from('ghost_node_requests')
        .insert({
            node_id: node.id,
            entity_slug: req.entitySlug,
            method,
            path,
            body: method === 'POST' ? req.body?.body ?? null : null,
            created_by: req.ownerUserId || null,
        })
        .select('id, status, created_at')
        .single();
    if (error) return tableError(res, error);
    res.status(202).json({ request: data });
});

// GET /api/nodes/:id/requests/:rid — the answer, when the box has served it
router.get('/:id/requests/:rid', ownerRequired, async (req, res) => {
    const { data, error } = await mine(supabase
        .from('ghost_node_requests')
        .select('id, method, path, status, response_status, response_body, created_at, dispatched_at, completed_at')
        .eq('id', req.params.rid)
        .eq('node_id', req.params.id), req)
        .maybeSingle();
    if (error) return tableError(res, error);
    if (!data) return res.status(404).json({ error: 'No such request.' });
    res.json({ request: data });
});

// GET /api/nodes/:id/requests — recent activity for one box
router.get('/:id/requests', ownerRequired, async (req, res) => {
    const { data, error } = await mine(supabase
        .from('ghost_node_requests')
        .select('id, method, path, status, response_status, created_at, completed_at')
        .eq('node_id', req.params.id), req)
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) return tableError(res, error);
    res.json({ requests: data || [] });
});

// ── box side ───────────────────────────────────────────────────────────────

// POST /api/nodes/heartbeat — {version, health}
router.post('/heartbeat', nodeRequired, async (req, res) => {
    const version = typeof req.body?.version === 'string' ? req.body.version.slice(0, 64) : null;
    const health = req.body?.health && typeof req.body.health === 'object' ? req.body.health : null;
    const { error } = await supabase
        .from('ghost_nodes')
        .update({ last_seen_at: nowIso(), version, health })
        .eq('id', req.node.id);
    if (error) return tableError(res, error);
    res.json({ ok: true });
});

// GET /api/nodes/pull — queued requests for this box, oldest first, marked dispatched
router.get('/pull', nodeRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('ghost_node_requests')
        .select('id, method, path, body')
        .eq('node_id', req.node.id)
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(10);
    if (error) return tableError(res, error);
    const requests = data || [];
    if (requests.length) {
        const { error: markError } = await supabase
            .from('ghost_node_requests')
            .update({ status: 'dispatched', dispatched_at: nowIso() })
            .in('id', requests.map((r) => r.id))
            .eq('node_id', req.node.id);
        if (markError) return tableError(res, markError);
    }
    res.json({ requests });
});

// POST /api/nodes/requests/:rid/response — {status, body}
router.post('/requests/:rid/response', nodeRequired, async (req, res) => {
    const status = Number(req.body?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
        return res.status(400).json({ error: 'status must be an HTTP status code.' });
    }
    const { data, error } = await supabase
        .from('ghost_node_requests')
        .update({
            status: status >= 200 && status < 300 ? 'done' : 'failed',
            response_status: status,
            response_body: req.body?.body ?? null,
            completed_at: nowIso(),
        })
        .eq('id', req.params.rid)
        .eq('node_id', req.node.id)
        .select('*');
    if (error) return tableError(res, error);
    if (!data?.length) return res.status(404).json({ error: 'No such request for this box.' });
    // A receipt in the answer goes to Paperclip against its task (plan §11).
    const receipt = await require('../lib/ghostReceipts').postReceipt(data[0]).catch((e) => ({ posted: false, reason: e.message }));
    res.json({ ok: true, receipt_posted: !!receipt.posted });
});

module.exports = router;
module.exports.forwardable = forwardable;
