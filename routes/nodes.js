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

const router = express.Router();

const TOKEN_PREFIX = 'gcr_node_';
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const nowIso = () => new Date().toISOString();

// Paths the dashboard may ask a box to serve. The box enforces the same list.
const FORWARDABLE = ['/health', '/capabilities', '/intent', '/approvals', '/actions/'];
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

// DELETE /api/nodes/:id — revoke a box's token
router.delete('/:id', ownerRequired, async (req, res) => {
    const { data, error } = await mine(supabase
        .from('ghost_nodes')
        .update({ revoked_at: nowIso() })
        .eq('id', req.params.id), req)
        .select('id');
    if (error) return tableError(res, error);
    if (!data?.length) return res.status(404).json({ error: 'No such box.' });
    res.json({ revoked: true });
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
        .select('id');
    if (error) return tableError(res, error);
    if (!data?.length) return res.status(404).json({ error: 'No such request for this box.' });
    res.json({ ok: true });
});

module.exports = router;
module.exports.forwardable = forwardable;
