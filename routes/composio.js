// ============================================================
// COMPOSIO CONNECTIONS
// ============================================================
// Lets a business connect its own third-party accounts — Google Calendar,
// Gmail, Stripe, QuickBooks, Mailchimp and so on — through Composio, so the
// platform can act on their behalf without anyone pasting API keys around.
//
// Two halves:
//
//   The catalog        which tools are offered, how they're grouped and
//                      ordered. Rows in platform_connections, editable by an
//                      admin. Adding a tool is an insert, not a release.
//
//   The connections    which business has connected which tool. Rows in
//                      entity_connections, keyed by entity_slug.
//
// The Composio API key lives only on this server and is never returned to a
// browser. When it isn't set, the connect route answers 501 with a clear
// message rather than pretending — the catalog, search and disconnect flows
// still work, so the screen is usable while the key is being sorted out.
//
// Mounted in server.js as:
//   mount('/api/admin/connections', () => require('./routes/composio'));

const express = require('express');
const { adminRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

/* ── config ──────────────────────────────────────────────────────────── */

const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY;
// Pinned but overridable: Composio has moved this more than once, and a
// hardcoded host is how an integration quietly dies.
const COMPOSIO_BASE = (process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev').replace(/\/+$/, '');
const COMPOSIO_VERSION = process.env.COMPOSIO_API_VERSION || 'v1';
// Where Composio sends the user back after they authorise.
const CONNECT_REDIRECT = process.env.COMPOSIO_REDIRECT_URL || null;

const fail = (res, code, message, extra) =>
    res.status(code).json({ error: message, ...(extra || {}) });

const configured = () => Boolean(COMPOSIO_KEY);

/** Call Composio. Throws with a readable message; never leaks the key. */
async function composio(path, { method = 'GET', body } = {}) {
    if (!configured()) throw new Error('COMPOSIO_API_KEY is not set');

    const url = `${COMPOSIO_BASE}/api/${COMPOSIO_VERSION}${path}`;
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                'x-api-key': COMPOSIO_KEY,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        throw new Error(`Could not reach Composio: ${err.message}`);
    }

    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }

    if (!response.ok) {
        const detail = parsed?.message || parsed?.error || text.slice(0, 300) || response.statusText;
        throw new Error(`Composio ${response.status}: ${detail}`);
    }
    return parsed;
}

/**
 * The identity a connection belongs to, from Composio's point of view.
 * One per business, derived from the slug so it is stable and readable.
 */
const entityIdFor = (slug) => `gcr__${String(slug).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/* ── catalog ─────────────────────────────────────────────────────────── */

const TOOL_FIELDS = [
    'tool_id', 'name', 'logo', 'icon', 'cat', 'description', 'provider',
    'sort_order', 'is_featured', 'is_active', 'composio_app', 'auth_scheme',
];

router.get('/catalog', adminRequired, async (req, res) => {
    try {
        const [tools, cats] = await Promise.all([
            supabase
                .from('platform_connections')
                .select('*')
                .order('sort_order', { ascending: true }),
            supabase
                .from('platform_connection_categories')
                .select('*')
                .order('sort_order', { ascending: true }),
        ]);

        if (tools.error) return fail(res, 500, tools.error.message);

        res.json({
            tools: tools.data || [],
            categories: cats.data || [],
            composio_configured: configured(),
        });
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
    if (!data || !data.length) return fail(res, 404, 'No such tool');
    res.json({ tool: data[0] });
});

router.delete('/catalog/:toolId', adminRequired, async (req, res) => {
    // Deactivate rather than delete — businesses may already be connected, and
    // dropping the catalog row would orphan their connection.
    const { data, error } = await supabase
        .from('platform_connections')
        .update({ is_active: false })
        .eq('tool_id', req.params.toolId)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'No such tool');
    res.json({ success: true, deactivated: true });
});

/**
 * Pull the available apps from Composio so the catalog can be built from what
 * actually exists rather than typed by hand. Read-only: it returns what
 * Composio offers and leaves curation to the admin.
 */
router.get('/available', adminRequired, async (_req, res) => {
    if (!configured()) {
        return fail(res, 501, 'Composio is not configured on this server.', {
            hint: 'Set COMPOSIO_API_KEY and redeploy.',
        });
    }
    try {
        const payload = await composio('/apps');
        const items = payload?.items || payload?.apps || (Array.isArray(payload) ? payload : []);
        res.json({
            apps: items.map((a) => ({
                composio_app: a.key || a.appId || a.name,
                name: a.name || a.key,
                logo: a.logo || a.meta?.logo || null,
                description: a.description || a.meta?.description || null,
                categories: a.categories || a.tags || [],
                auth_scheme: a.auth_schemes?.[0] || a.authScheme || null,
            })),
            total: items.length,
        });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/* ── connections ─────────────────────────────────────────────────────── */

router.get('/', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('entity_connections')
            .select('*')
            .order('created_at', { ascending: false });

        if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
        if (req.query.status) query = query.eq('status', req.query.status);
        if (req.query.tool_id) query = query.eq('tool_id', req.query.tool_id);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);

        // Decorate with business and tool names so the list is readable.
        const slugs = [...new Set((data || []).map((r) => r.entity_slug).filter(Boolean))];
        const toolIds = [...new Set((data || []).map((r) => r.tool_id).filter(Boolean))];

        const [entities, tools] = await Promise.all([
            slugs.length
                ? supabase.from('entity').select('slug, name').in('slug', slugs)
                : Promise.resolve({ data: [] }),
            toolIds.length
                ? supabase.from('platform_connections').select('tool_id, name, logo').in('tool_id', toolIds)
                : Promise.resolve({ data: [] }),
        ]);

        const nameBySlug = Object.fromEntries((entities.data || []).map((e) => [e.slug, e.name]));
        const toolById = Object.fromEntries((tools.data || []).map((t) => [t.tool_id, t]));

        res.json({
            connections: (data || []).map((r) => ({
                ...r,
                entity_name: nameBySlug[r.entity_slug] || null,
                tool_name: toolById[r.tool_id]?.name || r.tool_id,
                tool_logo: toolById[r.tool_id]?.logo || null,
            })),
            total: (data || []).length,
            composio_configured: configured(),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/**
 * Start the OAuth handshake for one business and one tool.
 *
 * Composio returns a redirect URL the business owner must visit. We record the
 * attempt as `pending` so the row exists before they finish, then the status
 * route below reconciles it.
 */
router.post('/:slug/:toolId/connect', adminRequired, async (req, res) => {
    const { slug, toolId } = req.params;

    if (!configured()) {
        return fail(res, 501, 'Composio is not configured on this server.', {
            hint: 'Set COMPOSIO_API_KEY (and optionally COMPOSIO_REDIRECT_URL) and redeploy.',
        });
    }

    const { data: tool } = await supabase
        .from('platform_connections')
        .select('tool_id, name, composio_app, integration_id')
        .eq('tool_id', toolId)
        .maybeSingle();
    if (!tool) return fail(res, 404, 'No such tool in the catalog');

    const integrationId = req.body?.integration_id || tool.integration_id;
    if (!integrationId) {
        return fail(res, 400, `“${tool.name}” has no Composio integration id.`, {
            hint: 'Set integration_id on the catalog row, or pass integration_id in the body.',
        });
    }

    const { data: entity } = await supabase
        .from('entity')
        .select('slug')
        .eq('slug', slug)
        .maybeSingle();
    if (!entity) return fail(res, 404, 'No such business');

    try {
        const result = await composio('/connectedAccounts', {
            method: 'POST',
            body: {
                integrationId,
                entityId: entityIdFor(slug),
                ...(CONNECT_REDIRECT ? { redirectUri: CONNECT_REDIRECT } : {}),
                data: req.body?.data || {},
            },
        });

        const accountRef = result?.connectedAccountId || result?.id || null;
        const redirectUrl = result?.redirectUrl || result?.redirect_url || null;
        const status = result?.connectionStatus === 'ACTIVE' ? 'connected' : 'pending';

        await supabase.from('entity_connections').upsert(
            {
                entity_slug: slug,
                tool_id: toolId,
                status,
                account_ref: accountRef,
                connected_at: status === 'connected' ? new Date().toISOString() : null,
            },
            { onConflict: 'entity_slug,tool_id' }
        );

        res.json({ status, redirect_url: redirectUrl, account_ref: accountRef });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/**
 * Ask Composio what actually happened, and write the answer down. Called
 * after the owner comes back from the OAuth screen.
 */
router.post('/:slug/:toolId/refresh', adminRequired, async (req, res) => {
    const { slug, toolId } = req.params;

    const { data: row } = await supabase
        .from('entity_connections')
        .select('id, account_ref')
        .eq('entity_slug', slug)
        .eq('tool_id', toolId)
        .maybeSingle();

    if (!row) return fail(res, 404, 'No connection attempt on record');
    if (!row.account_ref) return fail(res, 400, 'That attempt has no Composio account reference');
    if (!configured()) return fail(res, 501, 'Composio is not configured on this server.');

    try {
        const result = await composio(`/connectedAccounts/${encodeURIComponent(row.account_ref)}`);
        const active = result?.status === 'ACTIVE' || result?.connectionStatus === 'ACTIVE';

        const { data, error } = await supabase
            .from('entity_connections')
            .update({
                status: active ? 'connected' : 'pending',
                connected_at: active ? new Date().toISOString() : null,
            })
            .eq('id', row.id)
            .select();
        if (error) return fail(res, 400, error.message);
        res.json({ connection: data?.[0] || null });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

router.delete('/:slug/:toolId', adminRequired, async (req, res) => {
    const { slug, toolId } = req.params;

    const { data: row } = await supabase
        .from('entity_connections')
        .select('id, account_ref')
        .eq('entity_slug', slug)
        .eq('tool_id', toolId)
        .maybeSingle();
    if (!row) return fail(res, 404, 'No such connection');

    // Best effort upstream, then always record it locally — a business that
    // asked to disconnect must not still look connected because Composio
    // was briefly unreachable.
    if (row.account_ref && configured()) {
        try {
            await composio(`/connectedAccounts/${encodeURIComponent(row.account_ref)}`, {
                method: 'DELETE',
            });
        } catch (err) {
            console.error(`[composio] upstream disconnect failed for ${slug}/${toolId}:`, err.message);
        }
    }

    const { error } = await supabase
        .from('entity_connections')
        .update({ status: 'disconnected', connected_at: null })
        .eq('id', row.id);
    if (error) return fail(res, 400, error.message);
    res.json({ success: true });
});

/** Whether the server can talk to Composio at all — used by the dashboard. */
router.get('/status', adminRequired, async (_req, res) => {
    if (!configured()) {
        return res.json({ configured: false, reachable: false, reason: 'COMPOSIO_API_KEY is not set' });
    }
    try {
        await composio('/apps');
        res.json({ configured: true, reachable: true, base: COMPOSIO_BASE, version: COMPOSIO_VERSION });
    } catch (err) {
        res.json({ configured: true, reachable: false, reason: err.message });
    }
});

module.exports = router;
