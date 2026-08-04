// ============================================================
// COMPOSIO — API v3 client
// ============================================================
//
// The key is held here and never reaches a browser.
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// routes/composio.js was written against API v1 (POST /api/v1/connectedAccounts).
// Composio retired that path for OAuth schemes on 2026-07-03, so the connect
// flow was already dead — it would have failed on the first real attempt.
// v3 also changed the shape, not just the number: a connection now takes a
// user_id and an auth_config_id instead of an integrationId plus entityId.
//
// ── Managed auth ────────────────────────────────────────────────────────
//
// Composio registers and maintains the OAuth apps for most toolkits, so there
// is no Google Cloud project, no Facebook app review, and no per-provider
// consent screen to set up. An auth config is only needed when we want our own
// OAuth app or non-default scopes. That is what makes hundreds of toolkits a
// single integration rather than hundreds of them.

const BASE = (process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev').replace(/\/+$/, '');
const VERSION = process.env.COMPOSIO_API_VERSION || 'v3';
const KEY = process.env.COMPOSIO_API_KEY;

/** Where Composio sends a business back after they authorise. */
const REDIRECT_URL = process.env.COMPOSIO_REDIRECT_URL || null;

const configured = () => Boolean(KEY);

/**
 * Call Composio. Throws with a readable message and never echoes the key.
 *
 * `version` is overridable per call because Composio does not move every
 * endpoint at once — categories currently live on v3.1 while the rest sit on
 * v3, and pinning one number for the whole API is how this broke last time.
 */
async function composio(path, { method = 'GET', body, version, query } = {}) {
    if (!configured()) throw new Error('COMPOSIO_API_KEY is not set on this server.');

    const qs = query
        ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''))}`
        : '';
    const url = `${BASE}/api/${version || VERSION}${path}${qs}`;

    let response;
    try {
        response = await fetch(url, {
            method,
            headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
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
        const detail =
            parsed?.error?.message || parsed?.message || parsed?.error || text.slice(0, 300) || response.statusText;
        const error = new Error(`Composio ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
    }
    return parsed;
}

/**
 * Composio paginates with a cursor and has hundreds of toolkits. Anything that
 * wants the whole catalogue wants every page, not the first hundred.
 */
async function composioAll(path, { version, query, max = 2000 } = {}) {
    const out = [];
    let cursor;
    for (let page = 0; page < 40; page += 1) {
        const payload = await composio(path, { version, query: { ...query, limit: 100, cursor } });
        const items = payload?.items || payload?.data || (Array.isArray(payload) ? payload : []);
        out.push(...items);
        cursor = payload?.next_cursor || payload?.nextCursor || null;
        if (!cursor || out.length >= max) break;
    }
    return out;
}

/** One toolkit, flattened to the shape the catalogue and the UI both use. */
function normaliseToolkit(raw) {
    const slug = raw.slug || raw.key || raw.name;
    const categories = (raw.meta?.categories || raw.categories || [])
        .map((c) => (typeof c === 'string' ? c : c.name || c.slug))
        .filter(Boolean);

    return {
        tool_id: String(slug || '').toLowerCase(),
        name: raw.name || raw.meta?.name || slug,
        logo: raw.meta?.logo || raw.logo || null,
        description: raw.meta?.description || raw.description || null,
        cat: categories[0] || null,
        categories,
        composio_app: slug,
        auth_scheme: (raw.auth_schemes || raw.authSchemes || [])[0] || raw.no_auth === true ? 'none' : null,
        // Composio-managed means no OAuth app of ours is required.
        managed: raw.is_local === false || raw.managed_by === 'composio' || undefined,
    };
}

/**
 * The identity a connection belongs to, from Composio's side. One per
 * business, derived from the slug so it is stable and readable in their
 * dashboard.
 */
const userIdFor = (slug) => `gcr__${String(slug).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/* ── the calls the routes actually make ──────────────────────────────────── */

/** Every toolkit Composio offers. */
const listToolkits = (query) => composioAll('/toolkits', { query }).then((rows) => rows.map(normaliseToolkit));

/** The category list, for the App Store filter chips. */
async function listCategories() {
    const payload = await composio('/toolkits/categories', { version: 'v3.1' });
    const items = payload?.items || payload?.data || (Array.isArray(payload) ? payload : []);
    return items
        .map((c) => (typeof c === 'string' ? { slug: c, name: c } : { slug: c.slug || c.id || c.name, name: c.name || c.slug }))
        .filter((c) => c.slug);
}

/** Auth configs on this project, so a catalogue row can be pointed at one. */
const listAuthConfigs = () => composioAll('/auth_configs');

/**
 * Start a connection. Returns the URL the business must visit.
 *
 * v3 takes user_id + auth_config_id. The older integrationId/entityId pair is
 * gone, which is why the previous version of this returned 400.
 */
async function linkAccount({ slug, authConfigId, redirectUrl }) {
    const result = await composio('/connected_accounts/link', {
        method: 'POST',
        body: {
            user_id: userIdFor(slug),
            auth_config_id: authConfigId,
            ...(redirectUrl || REDIRECT_URL ? { callback_url: redirectUrl || REDIRECT_URL } : {}),
        },
    });
    return {
        accountRef: result?.id || result?.connected_account_id || result?.nanoid || null,
        redirectUrl: result?.redirect_url || result?.redirectUrl || result?.connection_url || null,
        status: /active/i.test(result?.status || '') ? 'connected' : 'pending',
    };
}

/** Ask Composio what actually happened after the business came back. */
async function accountStatus(accountRef) {
    const result = await composio(`/connected_accounts/${encodeURIComponent(accountRef)}`);
    const status = result?.status || result?.connectionStatus || '';
    return { active: /active/i.test(status), raw: status || null };
}

const deleteAccount = (accountRef) =>
    composio(`/connected_accounts/${encodeURIComponent(accountRef)}`, { method: 'DELETE' });

/** Can this server talk to Composio at all? Used by the dashboards. */
async function health() {
    if (!configured()) return { configured: false, reachable: false, reason: 'COMPOSIO_API_KEY is not set' };
    try {
        const toolkits = await composio('/toolkits', { query: { limit: 1 } });
        const items = toolkits?.items || toolkits?.data || [];
        return { configured: true, reachable: true, base: BASE, version: VERSION, sample: items.length };
    } catch (err) {
        return { configured: true, reachable: false, reason: err.message, base: BASE, version: VERSION };
    }
}

module.exports = {
    BASE,
    VERSION,
    configured,
    composio,
    composioAll,
    normaliseToolkit,
    userIdFor,
    listToolkits,
    listCategories,
    listAuthConfigs,
    linkAccount,
    accountStatus,
    deleteAccount,
    health,
};
