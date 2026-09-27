// ============================================================
// ADMIN VIEW OVER THE FLEET OF GHOST BOXES
// ============================================================
// routes/nodes.js is the owner's view: one login, one box, one phone. This is
// the operator's view: every box at every business, what release each one
// runs, whether it is online, what it has been asked and whether it answered.
//
// Read-only. Nothing here can enrol, revoke, or send a request to a box: an
// operator who wants to drive a box acts as that business through the owner
// routes, which the audit trail then attributes correctly. The slug is a
// FILTER here, not a boundary, so every route is adminRequired and must never
// be reachable with an owner token.
//
// Mounted in server.js as:
//   mount('/api/admin/ghost', () => require('./routes/admin-ghost'));

const express = require('express');
const { adminRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

const ONLINE_WINDOW_MS = 3 * 60 * 1000; // a box heartbeats every 60 s

const missingTable = (error) =>
    /ghost_node/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);
const tableError = (res, error) =>
    res.status(missingTable(error) ? 501 : 500).json({
        error: missingTable(error) ? 'Ghost nodes are not set up on this database yet (run sql/ghost_nodes.sql).' : error.message,
    });

function limitOf(req, fallback = 200, max = 1000) {
    const n = parseInt(req.query.limit, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

const online = (row, now = Date.now()) =>
    !!row.last_seen_at && !row.revoked_at && now - new Date(row.last_seen_at).getTime() < ONLINE_WINDOW_MS;

async function withBusinessNames(rows) {
    const slugs = [...new Set(rows.map((r) => r.entity_slug).filter(Boolean))];
    if (!slugs.length) return rows;
    const { data } = await supabase.from('entity').select('slug, name').in('slug', slugs);
    const names = new Map((data || []).map((e) => [e.slug, e.name]));
    return rows.map((r) => ({ ...r, business_name: names.get(r.entity_slug) || null }));
}

// GET /api/admin/ghost/nodes?slug=&online=1|0&version=
router.get('/nodes', adminRequired, async (req, res) => {
    let query = supabase
        .from('ghost_nodes')
        .select('id, entity_slug, name, token_hint, version, health, created_by, created_at, last_seen_at, revoked_at')
        .order('last_seen_at', { ascending: false, nullsFirst: false })
        .limit(limitOf(req));
    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
    if (req.query.version) query = query.eq('version', req.query.version);
    const { data, error } = await query;
    if (error) return tableError(res, error);
    const now = Date.now();
    let rows = (data || []).map((r) => ({ ...r, online: online(r, now) }));
    if (req.query.online === '1') rows = rows.filter((r) => r.online);
    if (req.query.online === '0') rows = rows.filter((r) => !r.online);
    res.json({ nodes: await withBusinessNames(rows), total: rows.length });
});

// GET /api/admin/ghost/summary — the fleet at a glance: how many, how many
// online, which releases are out there (so a rollout can be watched).
router.get('/summary', adminRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('ghost_nodes')
        .select('id, entity_slug, version, health, last_seen_at, revoked_at');
    if (error) return tableError(res, error);
    const now = Date.now();
    const rows = (data || []).filter((r) => !r.revoked_at);
    const releases = {};
    let unhealthy = 0;
    for (const r of rows) {
        const key = r.version || 'unknown';
        releases[key] = releases[key] || { version: key, boxes: 0, online: 0 };
        releases[key].boxes += 1;
        if (online(r, now)) releases[key].online += 1;
        if (r.health && r.health.core && r.health.core !== 'ok') unhealthy += 1;
    }
    res.json({
        boxes: rows.length,
        online: rows.filter((r) => online(r, now)).length,
        businesses: new Set(rows.map((r) => r.entity_slug)).size,
        unhealthy,
        revoked: (data || []).length - rows.length,
        releases: Object.values(releases).sort((a, b) => b.boxes - a.boxes),
    });
});

// GET /api/admin/ghost/nodes/:id/requests — what this box was asked, and
// whether it answered. Bodies are the owner's business; only the shape is shown.
router.get('/nodes/:id/requests', adminRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('ghost_node_requests')
        .select('id, method, path, status, response_status, created_at, dispatched_at, completed_at')
        .eq('node_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(limitOf(req, 50, 500));
    if (error) return tableError(res, error);
    res.json({ requests: data || [] });
});

module.exports = router;
