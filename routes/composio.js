// ============================================================
// COMPOSIO CONNECTIONS — the App Store
// ============================================================
//
// Two halves, and two audiences.
//
//   The catalogue      which tools are on offer. Rows in platform_connections,
//                      synced from Composio and curated by an admin: feature
//                      it, hide it, reorder it. Adding a tool is an insert.
//
//   The connections    which business has connected which tool. Rows in
//                      entity_connections, keyed by entity_slug.
//
// Admin routes are mounted at /api/admin/connections and see every business.
// Owner routes are mounted at /api/connections and see exactly one — the
// business the caller owns, resolved server-side from entity_owners. A
// business could not previously connect anything at all: every route was
// adminRequired, so the App Store existed only for the operator.
//
// The Composio key lives on this server and never reaches a browser. When it
// is not set the catalogue still renders from the database and every screen
// says why connecting is unavailable, rather than showing a button that fails.

const express = require('express');
const { adminRequired } = require('../middleware/auth');
const { ownerRequired } = require('../middleware/ownerAuth');
const supabase = require('../db');
const composio = require('../lib/composioClient');

const router = express.Router();
const ownerRouter = express.Router();

const fail = (res, code, message, extra) => res.status(code).json({ error: message, ...(extra || {}) });

const TOOL_FIELDS = [
    'tool_id', 'name', 'logo', 'icon', 'cat', 'description', 'provider',
    'sort_order', 'is_featured', 'is_active', 'composio_app', 'auth_scheme',
    'auth_config_id', 'categories', 'industries',
];

/* ── catalogue ───────────────────────────────────────────────────────────── */

/** The catalogue as both dashboards render it: tools, categories, and status. */
async function loadCatalogue({ activeOnly = false } = {}) {
    const toolQuery = supabase.from('platform_connections').select('*').order('sort_order', { ascending: true });
    if (activeOnly) toolQuery.eq('is_active', true);

    const [tools, cats] = await Promise.all([
        toolQuery,
        supabase.from('platform_connection_categories').select('*').order('sort_order', { ascending: true }),
    ]);
    if (tools.error) throw new Error(tools.error.message);

    return {
        tools: tools.data || [],
        categories: cats.data || [],
        composio_configured: composio.configured(),
    };
}

router.get('/catalog', adminRequired, async (_req, res) => {
    try {
        res.json(await loadCatalogue());
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.post('/catalog', adminRequired, async (req, res) => {
    const row = {};
    for (const key of TOOL_FIELDS) if (req.body?.[key] !== undefined) row[key] = req.body[key];
    if (!row.tool_id) return fail(res, 400, 'tool_id is required');
    if (!row.name) return fail(res, 400, 'name is required');
    if (!row.provider) row.provider = 'composio';

    const { data, error } = await supabase
        .from('platform_connections')
        .upsert(row, { onConflict: 'tool_id' })
        .select()
        .single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ tool: data });
});

router.put('/catalog/:toolId', adminRequired, async (req, res) => {
    const row = {};
    for (const key of TOOL_FIELDS) {
        if (key !== 'tool_id' && req.body?.[key] !== undefined) row[key] = req.body[key];
    }
    const { data, error } = await supabase
        .from('platform_connections')
        .update(row)
        .eq('tool_id', req.params.toolId)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'No such tool');
    res.json({ tool: data[0] });
});

router.delete('/catalog/:toolId', adminRequired, async (req, res) => {
    // Deactivate rather than delete — businesses may already be connected, and
    // dropping the catalogue row would orphan their connection.
    const { data, error } = await supabase
        .from('platform_connections')
        .update({ is_active: false })
        .eq('tool_id', req.params.toolId)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'No such tool');
    res.json({ success: true, deactivated: true });
});

/**
 * Pull everything Composio offers into the catalogue.
 *
 * Upserts, so an admin's curation survives a re-sync: is_featured, sort_order
 * and is_active are only set when the row is new. Hundreds of toolkits arrive
 * inactive by default — the store shows what you chose to offer, not a dump of
 * every integration in existence.
 */
router.post('/sync', adminRequired, async (req, res) => {
    if (!composio.configured()) {
        return fail(res, 501, 'Composio is not configured on this server.', { hint: 'Set COMPOSIO_API_KEY and redeploy.' });
    }
    const activateAll = req.body?.activate_all === true;

    try {
        const [toolkits, categories] = await Promise.all([composio.listToolkits(), composio.listCategories()]);

        if (categories.length) {
            await supabase.from('platform_connection_categories').upsert(
                categories.map((c, i) => ({ cat_id: c.slug, name: c.name, sort_order: i })),
                { onConflict: 'cat_id' }
            );
        }

        const { data: existing } = await supabase.from('platform_connections').select('tool_id');
        const known = new Set((existing || []).map((r) => r.tool_id));

        const rows = toolkits.map((t, i) => {
            const row = {
                tool_id: t.tool_id,
                name: t.name,
                logo: t.logo,
                description: t.description,
                cat: t.cat,
                categories: t.categories,
                composio_app: t.composio_app,
                auth_scheme: t.auth_scheme,
                provider: 'composio',
            };
            // Only stamp curation fields on first sight, so a re-sync never
            // un-features a tool or turns one back on that was switched off.
            if (!known.has(t.tool_id)) {
                row.is_active = activateAll;
                row.is_featured = false;
                row.sort_order = i;
            }
            return row;
        });

        // Chunked: a few hundred rows in one upsert is a large statement.
        for (let i = 0; i < rows.length; i += 200) {
            const { error } = await supabase
                .from('platform_connections')
                .upsert(rows.slice(i, i + 200), { onConflict: 'tool_id' });
            if (error) throw new Error(error.message);
        }

        res.json({
            synced: rows.length,
            new: rows.filter((r) => !known.has(r.tool_id)).length,
            categories: categories.length,
            activated: activateAll,
        });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/** Auth configs on the Composio project, so a catalogue row can point at one. */
router.get('/auth-configs', adminRequired, async (_req, res) => {
    if (!composio.configured()) return fail(res, 501, 'Composio is not configured on this server.');
    try {
        const configs = await composio.listAuthConfigs();
        res.json({
            auth_configs: configs.map((c) => ({
                id: c.id || c.nanoid,
                name: c.name || c.toolkit?.slug,
                toolkit: c.toolkit?.slug || c.toolkit || null,
                is_composio_managed: c.is_composio_managed ?? c.managed ?? null,
            })),
        });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/** Read-only view of what Composio offers, before curating it. */
router.get('/available', adminRequired, async (_req, res) => {
    if (!composio.configured()) {
        return fail(res, 501, 'Composio is not configured on this server.', { hint: 'Set COMPOSIO_API_KEY and redeploy.' });
    }
    try {
        const apps = await composio.listToolkits();
        res.json({ apps, total: apps.length });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/* ── connections, shared by both audiences ───────────────────────────────── */

async function listConnections({ slug, status, toolId }) {
    let query = supabase.from('entity_connections').select('*').order('created_at', { ascending: false });
    if (slug) query = query.eq('entity_slug', slug);
    if (status) query = query.eq('status', status);
    if (toolId) query = query.eq('tool_id', toolId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows = data || [];
    const slugs = [...new Set(rows.map((r) => r.entity_slug).filter(Boolean))];
    const toolIds = [...new Set(rows.map((r) => r.tool_id).filter(Boolean))];

    const [entities, tools] = await Promise.all([
        slugs.length ? supabase.from('entity').select('slug, name').in('slug', slugs) : Promise.resolve({ data: [] }),
        toolIds.length
            ? supabase.from('platform_connections').select('tool_id, name, logo').in('tool_id', toolIds)
            : Promise.resolve({ data: [] }),
    ]);

    const nameBySlug = Object.fromEntries((entities.data || []).map((e) => [e.slug, e.name]));
    const toolById = Object.fromEntries((tools.data || []).map((t) => [t.tool_id, t]));

    return rows.map((r) => ({
        ...r,
        entity_name: nameBySlug[r.entity_slug] || null,
        tool_name: toolById[r.tool_id]?.name || r.tool_id,
        tool_logo: toolById[r.tool_id]?.logo || null,
    }));
}

/** Begin the handshake. Shared so admin and owner cannot drift apart. */
async function beginConnect({ slug, toolId, redirectUrl }) {
    const { data: tool } = await supabase
        .from('platform_connections')
        .select('tool_id, name, composio_app, auth_config_id')
        .eq('tool_id', toolId)
        .maybeSingle();
    if (!tool) {
        const err = new Error('No such tool in the catalogue');
        err.status = 404;
        throw err;
    }
    if (!tool.auth_config_id) {
        const err = new Error(`“${tool.name}” has no Composio auth config yet.`);
        err.status = 400;
        err.hint = 'Set auth_config_id on the catalogue row — see GET /auth-configs.';
        throw err;
    }

    const { data: entity } = await supabase.from('entity').select('slug').eq('slug', slug).maybeSingle();
    if (!entity) {
        const err = new Error('No such business');
        err.status = 404;
        throw err;
    }

    const result = await composio.linkAccount({ slug, authConfigId: tool.auth_config_id, redirectUrl });

    await supabase.from('entity_connections').upsert(
        {
            entity_slug: slug,
            tool_id: toolId,
            status: result.status,
            account_ref: result.accountRef,
            connected_at: result.status === 'connected' ? new Date().toISOString() : null,
        },
        { onConflict: 'entity_slug,tool_id' }
    );

    return result;
}

/** Reconcile a connection against Composio after the owner comes back. */
async function refreshConnection(slug, toolId) {
    const { data: row } = await supabase
        .from('entity_connections')
        .select('id, account_ref')
        .eq('entity_slug', slug)
        .eq('tool_id', toolId)
        .maybeSingle();
    if (!row) {
        const err = new Error('No connection attempt on record');
        err.status = 404;
        throw err;
    }
    if (!row.account_ref) {
        const err = new Error('That attempt has no Composio account reference');
        err.status = 400;
        throw err;
    }

    const { active } = await composio.accountStatus(row.account_ref);
    const { data, error } = await supabase
        .from('entity_connections')
        .update({
            status: active ? 'connected' : 'pending',
            connected_at: active ? new Date().toISOString() : null,
        })
        .eq('id', row.id)
        .select();
    if (error) throw new Error(error.message);
    return data?.[0] || null;
}

async function disconnect(slug, toolId) {
    const { data: row } = await supabase
        .from('entity_connections')
        .select('id, account_ref')
        .eq('entity_slug', slug)
        .eq('tool_id', toolId)
        .maybeSingle();
    if (!row) {
        const err = new Error('No such connection');
        err.status = 404;
        throw err;
    }

    // Best effort upstream, then always record it locally — a business that
    // asked to disconnect must not still look connected because Composio was
    // briefly unreachable.
    if (row.account_ref && composio.configured()) {
        try {
            await composio.deleteAccount(row.account_ref);
        } catch (err) {
            console.error(`[composio] upstream disconnect failed for ${slug}/${toolId}:`, err.message);
        }
    }

    const { error } = await supabase
        .from('entity_connections')
        .update({ status: 'disconnected', connected_at: null })
        .eq('id', row.id);
    if (error) throw new Error(error.message);
}

/* ── admin routes ────────────────────────────────────────────────────────── */

router.get('/', adminRequired, async (req, res) => {
    try {
        const connections = await listConnections({
            slug: req.query.slug,
            status: req.query.status,
            toolId: req.query.tool_id,
        });
        res.json({ connections, total: connections.length, composio_configured: composio.configured() });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.get('/status', adminRequired, async (_req, res) => res.json(await composio.health()));

router.post('/:slug/:toolId/connect', adminRequired, async (req, res) => {
    if (!composio.configured()) {
        return fail(res, 501, 'Composio is not configured on this server.', {
            hint: 'Set COMPOSIO_API_KEY (and optionally COMPOSIO_REDIRECT_URL) and redeploy.',
        });
    }
    try {
        const result = await beginConnect({
            slug: req.params.slug,
            toolId: req.params.toolId,
            redirectUrl: req.body?.redirect_url,
        });
        res.json({ status: result.status, redirect_url: result.redirectUrl, account_ref: result.accountRef });
    } catch (err) {
        fail(res, err.status || 502, err.message, err.hint ? { hint: err.hint } : undefined);
    }
});

router.post('/:slug/:toolId/refresh', adminRequired, async (req, res) => {
    if (!composio.configured()) return fail(res, 501, 'Composio is not configured on this server.');
    try {
        res.json({ connection: await refreshConnection(req.params.slug, req.params.toolId) });
    } catch (err) {
        fail(res, err.status || 502, err.message);
    }
});

router.delete('/:slug/:toolId', adminRequired, async (req, res) => {
    try {
        await disconnect(req.params.slug, req.params.toolId);
        res.json({ success: true });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── owner routes — one business, its own tools ──────────────────────────── */

/**
 * The store as a business sees it: what is on offer, and what they already
 * have. Only active catalogue rows, because a business should not be shown a
 * tool the operator has not chosen to offer.
 */
ownerRouter.get('/', ownerRequired, async (req, res) => {
    try {
        const [catalogue, connections] = await Promise.all([
            loadCatalogue({ activeOnly: true }),
            listConnections({ slug: req.entitySlug }),
        ]);
        const byTool = Object.fromEntries(connections.map((c) => [c.tool_id, c]));

        res.json({
            entity_slug: req.entitySlug,
            categories: catalogue.categories,
            composio_configured: catalogue.composio_configured,
            tools: catalogue.tools.map((t) => ({
                ...t,
                connection: byTool[t.tool_id]
                    ? { status: byTool[t.tool_id].status, connected_at: byTool[t.tool_id].connected_at }
                    : null,
            })),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

ownerRouter.post('/:toolId/connect', ownerRequired, async (req, res) => {
    if (!composio.configured()) {
        return fail(res, 501, 'Connecting tools is not switched on yet.', { hint: 'COMPOSIO_API_KEY is not set on the server.' });
    }
    try {
        const result = await beginConnect({
            slug: req.entitySlug,
            toolId: req.params.toolId,
            redirectUrl: req.body?.redirect_url,
        });
        res.json({ status: result.status, redirect_url: result.redirectUrl, account_ref: result.accountRef });
    } catch (err) {
        fail(res, err.status || 502, err.message, err.hint ? { hint: err.hint } : undefined);
    }
});

ownerRouter.post('/:toolId/refresh', ownerRequired, async (req, res) => {
    if (!composio.configured()) return fail(res, 501, 'Connecting tools is not switched on yet.');
    try {
        res.json({ connection: await refreshConnection(req.entitySlug, req.params.toolId) });
    } catch (err) {
        fail(res, err.status || 502, err.message);
    }
});

ownerRouter.delete('/:toolId', ownerRequired, async (req, res) => {
    try {
        await disconnect(req.entitySlug, req.params.toolId);
        res.json({ success: true });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

module.exports = router;
module.exports.ownerRouter = ownerRouter;
