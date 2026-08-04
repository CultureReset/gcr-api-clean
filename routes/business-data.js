// ============================================================
// BUSINESS DATA — the only door the business dashboard uses
// ============================================================
//
// Everything the business dashboard reads or writes about itself comes through
// here. Before this file existed the dashboard held the Supabase anon key in
// its own bundle and talked to PostgREST directly: 316 table sweeps per page
// load from the browser, and a key anyone could copy out of developer tools.
//
// ── The one rule ────────────────────────────────────────────────────────
//
// No handler in this file reads a slug from the URL, the query string, or the
// body. The slug comes from req.entitySlug, which middleware/ownerAuth.js
// resolves from the session token via entity_owners. A caller can name a row
// id; it can never name a business.
//
// That is the whole security model. The browser sends "update menu_items 8821"
// and the query that runs is:
//
//     update menu_items set … where id = 8821 and entity_slug = 'flora-bama'
//                                                 ↑ from the session
//
// Change the id to another business's row and the second condition makes the
// update match nothing. There is nothing in the request that moves it.
//
// ── Two guard rails ─────────────────────────────────────────────────────
//
//   The table allow-list   :table arrives from the URL, so it is checked
//                          against the live list of slug-scoped tables before
//                          it reaches a query. Without this, a caller could
//                          name auth.users in the path.
//
//   The column filter      identity and bookkeeping columns are stripped from
//                          every incoming body, so a business cannot reassign
//                          its own row to somebody else's slug.
//
// Reads use the service key, which bypasses row-level security by design. That
// is what makes the 99 slug tables with RLS on and no policy — the ones that
// silently returned nothing to the browser — visible again.

const express = require('express');
const supabase = require('../db');
const { ownerRequired, sessionRequired } = require('../middleware/ownerAuth');

// The schema discovery, the table allow-list and the column filter live in
// lib/businessTables.js so routes/mcp.js applies exactly the same three guards
// to an AI assistant that this file applies to the dashboard. One copy only —
// a second copy of a security check drifts until one of them has a hole in it.
const { getSchema, allowTable, cleanBody } = require('../lib/businessTables');

const router = express.Router();

const fail = (res, code, message, extra) => res.status(code).json({ error: message, ...(extra || {}) });

/* ── who am I ─────────────────────────────────────────────────────────────
 *
 * The dashboard's first call after sign-in, and the only handler here that is
 * not ownerRequired.
 *
 * It cannot be: ownerRequired answers 403 when the account owns nothing, and
 * this is the endpoint whose job is to report that fact. An admin who has not
 * yet picked a business owns nothing either, and still needs the business
 * picker. So this verifies the session and reports honestly — hasAccess false,
 * isAdmin true — and every handler below it stays ownerRequired.
 */
router.get('/me', sessionRequired, async (req, res) => {
    const userId = req.ownerUserId;

    const [{ data: owned, error: ownerError }, { data: admin }] = await Promise.all([
        supabase.from('entity_owners').select('entity_slug, role').eq('user_id', userId).limit(1),
        supabase.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ]);
    if (ownerError) return fail(res, 500, ownerError.message);

    const slug = owned?.[0]?.entity_slug || null;
    let name = null;
    if (slug) {
        const { data: entity } = await supabase.from('entity').select('name').eq('slug', slug).maybeSingle();
        name = entity?.name || null;
    }

    res.json({
        slug,
        name,
        role: owned?.[0]?.role || null,
        isAdmin: !!admin,
        hasAccess: !!slug,
        user_id: userId,
    });
});

/* ── the schema the edit forms build themselves from ───────────────────── */

// GET /api/business/schema — replaces the dashboard's PostgREST OpenAPI read.
router.get('/schema', ownerRequired, async (req, res) => {
    try {
        const { tables, columns, at } = await getSchema();
        res.json({ tables, columns, cached_at: new Date(at).toISOString() });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/* ── every section this business has, in one call ─────────────────────────
 *
 * This is the request that replaces 316 of them. The browser used to open one
 * connection per slug table, twelve at a time, on every page load. The same
 * sweep runs here instead — on one machine, next to the database, with the
 * service key, so the tables that are locked to the browser come back too.
 *
 * The entity_sections RPC does the whole thing in a single round trip when it
 * has been installed. It has not been everywhere, so its absence falls through
 * to the sweep rather than failing.
 */

const SWEEP_CONCURRENCY = 24;
const ROW_LIMIT = 500;

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            await worker(items[index]);
        }
    });
    await Promise.all(runners);
}

async function sweepViaRpc(slug) {
    const { data, error } = await supabase.rpc('entity_sections', { p_slug: slug });
    if (error || !data || typeof data !== 'object') return null;
    const out = {};
    for (const [table, rows] of Object.entries(data)) {
        if (Array.isArray(rows) && rows.length) out[table] = rows;
    }
    return out;
}

router.get('/sections', ownerRequired, async (req, res) => {
    const slug = req.entitySlug;

    let schema;
    try {
        schema = await getSchema();
    } catch (err) {
        return fail(res, 502, err.message);
    }

    const viaRpc = await sweepViaRpc(slug);
    if (viaRpc) {
        return res.json({ slug, sections: viaRpc, tables_scanned: schema.tables.length, via: 'rpc' });
    }

    const sections = {};
    await mapLimit(schema.tables, SWEEP_CONCURRENCY, async (table) => {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq('entity_slug', slug)
            .limit(ROW_LIMIT);
        // A table that cannot be read must not take the whole dashboard with it.
        if (!error && data && data.length) sections[table] = data;
    });

    res.json({ slug, sections, tables_scanned: schema.tables.length, via: 'sweep' });
});

/* ── the industry list, from the database rather than a constant ───────── */

const INDUSTRY_TTL_MS = 5 * 60 * 1000;
let industryCache = null;

// GET /api/business/industries — distinct entity.entity_type values, live.
router.get('/industries', ownerRequired, async (req, res) => {
    if (industryCache && Date.now() - industryCache.at < INDUSTRY_TTL_MS) {
        return res.json({ industries: industryCache.industries });
    }

    // PostgREST has no DISTINCT, so the column comes back whole and is counted
    // here. One short string per business — small enough to be cheaper than
    // adding a view for it.
    const { data, error } = await supabase
        .from('entity')
        .select('entity_type')
        .not('entity_type', 'is', null);
    if (error) return fail(res, 500, error.message);

    const counts = new Map();
    for (const row of data || []) {
        const value = (row.entity_type || '').trim();
        if (!value) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }

    const industries = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

    industryCache = { industries, at: Date.now() };
    res.json({ industries });
});

/* ── one section, for refreshing after an edit ───────────────────────────── */

// GET /api/business/:table — this business's rows in one table, paged.
router.get('/:table', ownerRequired, async (req, res) => {
    let table;
    try {
        table = await allowTable(req.params.table);
    } catch (err) {
        return fail(res, 502, err.message);
    }
    if (!table) return fail(res, 400, `Not a business section: ${req.params.table}`);

    const limit = Math.min(Number(req.query.limit) || 200, ROW_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { data, error, count } = await supabase
        .from(table)
        .select('*', { count: 'exact' })
        .eq('entity_slug', req.entitySlug)
        .range(offset, offset + limit - 1);
    if (error) return fail(res, 500, error.message);

    res.json({ table, rows: data || [], total: count ?? null, limit, offset });
});

/* ── the three writes ─────────────────────────────────────────────────────
 *
 * Create stamps the slug. Update and delete filter on it as well as the id, so
 * a tampered id matches nothing rather than somebody else's row.
 */

// POST /api/business/:table
router.post('/:table', ownerRequired, async (req, res) => {
    let table;
    try {
        table = await allowTable(req.params.table);
    } catch (err) {
        return fail(res, 502, err.message);
    }
    if (!table) return fail(res, 400, `Not a business section: ${req.params.table}`);

    const values = await cleanBody(table, req.body);

    const { data, error } = await supabase
        .from(table)
        .insert({ ...values, entity_slug: req.entitySlug }) // the slug is ours, not theirs
        .select()
        .single();
    if (error) return fail(res, 400, error.message);

    res.status(201).json({ table, row: data });
});

// PATCH /api/business/:table/:id
router.patch('/:table/:id', ownerRequired, async (req, res) => {
    let table;
    try {
        table = await allowTable(req.params.table);
    } catch (err) {
        return fail(res, 502, err.message);
    }
    if (!table) return fail(res, 400, `Not a business section: ${req.params.table}`);

    const values = await cleanBody(table, req.body);
    if (!Object.keys(values).length) return fail(res, 400, 'Nothing to change.');

    const { data, error } = await supabase
        .from(table)
        .update(values)
        .eq('id', req.params.id)
        .eq('entity_slug', req.entitySlug) // never reachable outside this business
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'That row is not there.');

    res.json({ table, row: data[0] });
});

// DELETE /api/business/:table/:id
router.delete('/:table/:id', ownerRequired, async (req, res) => {
    let table;
    try {
        table = await allowTable(req.params.table);
    } catch (err) {
        return fail(res, 502, err.message);
    }
    if (!table) return fail(res, 400, `Not a business section: ${req.params.table}`);

    const { data, error } = await supabase
        .from(table)
        .delete()
        .eq('id', req.params.id)
        .eq('entity_slug', req.entitySlug)
        .select('id');
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'That row is not there.');

    res.json({ table, deleted: data[0].id });
});

module.exports = router;
