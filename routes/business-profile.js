// ============================================================
// BUSINESS PROFILE — every table carrying one slug, discovered
// ============================================================
//
// One business, rendered the way its own dashboard would render it: every
// table in the database that carries this `entity_slug` and actually has rows
// for it, returned as sections.
//
// ── Nothing here is hardcoded ───────────────────────────────────────────
//
// There is no list of tables in this file. The table list comes from the
// database on every request, via the OpenAPI schema PostgREST publishes. So:
//
//   add a table with a row for a slug   → a new section appears
//   delete the rows                     → the section disappears
//   rename or add a column              → it flows straight through
//
// No deploy, no code change. That is the whole point, and it is why this file
// must never grow a `const TABLES = [...]`. A hardcoded list is how a schema
// and its code drift apart.
//
// The label and grouping are DERIVED from the table name, not looked up. A
// table called `marina_bait_items` becomes "Bait items" under "Marina" without
// anyone having taught this file what a marina is.
//
// ── Why the service key ─────────────────────────────────────────────────
//
// The business's own dashboard reads through RLS, so a table it is not allowed
// to see silently returns nothing. An admin needs the opposite: to see
// everything a business has, including what the business cannot. This runs on
// the service key behind `adminRequired`.

const express = require('express');
const db = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

const SUPABASE_URL = process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.GCR_SUPABASE_SERVICE_KEY ||
  process.env.GCR_SUPABASE_KEY ||
  process.env.SUPABASE_KEY;

/** How many tables to probe at once. The schema has ~300 of them. */
const CONCURRENCY = 16;

/** Rows returned per section. A menu can be long; the UI paginates. */
const ROW_LIMIT = 500;

/** Columns that carry no meaning for a human reading a profile. */
const NOISE_COLUMNS = new Set(['search_vector', 'tsv', 'embedding']);

/* ── schema discovery ────────────────────────────────────────────────────── */

// The spec is a few hundred KB and changes only when the schema does, so it is
// held briefly in memory. The TTL is short on purpose: "add a table and it
// appears" should mean minutes, not a redeploy.
let schemaCache = null;
let schemaCachedAt = 0;
const SCHEMA_TTL_MS = 60_000;

async function loadSchema() {
    if (schemaCache && Date.now() - schemaCachedAt < SCHEMA_TTL_MS) return schemaCache;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`schema read failed: HTTP ${res.status}`);

    const spec = await res.json();
    const defs = spec.definitions || {};

    const tables = [];
    for (const [name, def] of Object.entries(defs)) {
        const props = def.properties || {};
        if (!props.entity_slug) continue;          // not slug-keyed → not a business section
        tables.push({
            table: name,
            columns: Object.entries(props)
                .filter(([col]) => !NOISE_COLUMNS.has(col))
                .map(([col, meta]) => ({
                    name: col,
                    type: meta.format || meta.type || 'text',
                })),
        });
    }

    schemaCache = tables;
    schemaCachedAt = Date.now();
    return tables;
}

/* ── naming, derived rather than looked up ───────────────────────────────── */

/** `marina_bait_items` → `Marina` (the grouping bucket). */
function groupOf(table) {
    const head = table.split('_')[0];
    return head.charAt(0).toUpperCase() + head.slice(1);
}

/**
 * `marina_bait_items` → `Bait items`. The group prefix is dropped so the
 * heading does not repeat the group it sits under.
 */
function labelOf(table) {
    const parts = table.split('_');
    const rest = parts.length > 1 ? parts.slice(1) : parts;
    const words = rest.join(' ').replace(/\bai\b/gi, 'AI').replace(/\bseo\b/gi, 'SEO');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ── run promises with a ceiling ─────────────────────────────────────────── */

async function pooled(items, worker, limit) {
    const out = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return out;
}

/* ── GET /api/admin/gcr/profile/:slug ────────────────────────────────────── */

router.get('/profile/:slug', adminRequired, async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug required' });

    // `include_empty=true` returns the tables this business has NOT filled in,
    // with a zero count and no rows. Useful for "what is missing".
    const includeEmpty = String(req.query.include_empty || '') === 'true';

    try {
        // `entity_modules` is the business's OWN declared structure, with the
        // order the public site renders it in. routes/gcr.js already reads it
        // to decide what to load, so this is not a second opinion — it is the
        // same source of truth, surfaced to the admin.
        //
        // Discovery still runs underneath it. A module says what a business
        // means to show; rows say what it actually has, and the two disagree
        // often enough that hiding either would be a lie.
        const [schema, entityRead, modulesRead] = await Promise.all([
            loadSchema(),
            db.from('entity').select('*').eq('slug', slug).maybeSingle(),
            db.from('entity_modules')
                .select('module_key, enabled, sort_order')
                .eq('entity_slug', slug)
                .order('sort_order'),
        ]);

        if (entityRead.error) {
            return res.status(500).json({ error: entityRead.error.message });
        }
        if (!entityRead.data) {
            return res.status(404).json({ error: `No business with slug "${slug}"` });
        }

        const probed = await pooled(
            schema,
            async ({ table, columns }) => {
                const { data, error, count } = await db
                    .from(table)
                    .select('*', { count: 'exact' })
                    .eq('entity_slug', slug)
                    .limit(ROW_LIMIT);

                // A table that errors (dropped mid-request, odd permission) is
                // reported rather than silently dropped — a section vanishing
                // without explanation is exactly the kind of thing that hides
                // a real problem.
                if (error) return { table, columns, count: 0, rows: [], error: error.message };
                return { table, columns, count: count ?? (data || []).length, rows: data || [] };
            },
            CONCURRENCY
        );

        const sections = probed
            .filter((s) => (includeEmpty ? true : s.count > 0 || s.error))
            .map((s) => ({
                ...s,
                label: labelOf(s.table),
                group: groupOf(s.table),
            }))
            .sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));

        const modules = (modulesRead.data || []).map((m) => ({
            key: m.module_key,
            enabled: m.enabled !== false,
            sort_order: m.sort_order ?? 999,
        }));

        res.json({
            slug,
            entity: entityRead.data,
            // What the business declares it has, in its own order. Empty for a
            // business that has never had modules set — which is itself worth
            // seeing, so it is reported rather than defaulted.
            modules,
            tables_scanned: schema.length,
            sections_with_data: sections.filter((s) => s.count > 0).length,
            total_rows: sections.reduce((n, s) => n + s.count, 0),
            sections,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── GET /api/admin/gcr/profile-schema ───────────────────────────────────── */
// What the discovery step currently sees. Answers "why is my new table not
// showing up" without guessing.

router.get('/profile-schema', adminRequired, async (_req, res) => {
    try {
        const schema = await loadSchema();
        res.json({
            tables: schema.length,
            cached_for_ms: SCHEMA_TTL_MS,
            names: schema.map((s) => s.table).sort(),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ══════════════════════════════════════════════════════════════════════
   WRITES
   ══════════════════════════════════════════════════════════════════════ */
//
// Editing an arbitrary table is only safe if the table and the columns are
// both checked against the live schema, and the row is always pinned to the
// slug in the URL. All three happen here, on every write:
//
//   1. The table must appear in the discovered slug-keyed set. A name that is
//      not in that set is rejected — so a caller cannot reach `admin_users`
//      or anything else that is not part of a business profile.
//   2. Every field must be a real column of that table, per the same schema
//      read. Unknown keys are dropped rather than passed through.
//   3. Update and delete are filtered by BOTH the row id AND entity_slug, so
//      a mistyped id belonging to another business matches nothing instead of
//      editing someone else's row.
//
// Identity and bookkeeping columns are never writable.

const IMMUTABLE = new Set(['id', 'entity_slug', 'entity_id', 'site_id', 'created_at']);

/** Resolve a table name against the live schema, or throw. */
async function resolveTable(name) {
    const schema = await loadSchema();
    const found = schema.find((t) => t.table === name);
    if (!found) {
        const err = new Error(`"${name}" is not a slug-keyed table in this schema`);
        err.status = 400;
        throw err;
    }
    return found;
}

/** Keep only real, writable columns. Returns [cleanBody, ignoredKeys]. */
function sanitise(table, body) {
    const allowed = new Set(table.columns.map((c) => c.name));
    const out = {};
    const ignored = [];
    for (const [k, v] of Object.entries(body || {})) {
        if (IMMUTABLE.has(k)) { ignored.push(k); continue; }
        if (!allowed.has(k)) { ignored.push(k); continue; }
        out[k] = v === '' ? null : v;
    }
    return [out, ignored];
}

/* ── PATCH /api/admin/gcr/profile/:slug/:table/:id ───────────────────────── */

router.patch('/profile/:slug/:table/:id', adminRequired, async (req, res) => {
    const { slug, table: tableName, id } = req.params;
    try {
        const table = await resolveTable(tableName);
        const [patch, ignored] = sanitise(table, req.body);
        if (!Object.keys(patch).length) {
            return res.status(400).json({ error: 'No writable fields supplied', ignored });
        }

        // Pinned to the slug as well as the id — a row belonging to another
        // business simply does not match.
        const { data, error } = await db
            .from(tableName)
            .update(patch)
            .eq('id', id)
            .eq('entity_slug', slug)
            .select();

        if (error) return res.status(400).json({ error: error.message });
        if (!data || !data.length) {
            return res.status(404).json({ error: `No row ${id} in ${tableName} for "${slug}"` });
        }
        res.json({ row: data[0], ignored });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

/* ── POST /api/admin/gcr/profile/:slug/:table ────────────────────────────── */

router.post('/profile/:slug/:table', adminRequired, async (req, res) => {
    const { slug, table: tableName } = req.params;
    try {
        const table = await resolveTable(tableName);
        const [row, ignored] = sanitise(table, req.body);

        // The slug comes from the URL, never from the body, so a new row
        // cannot be filed under a different business.
        const { data, error } = await db
            .from(tableName)
            .insert({ ...row, entity_slug: slug })
            .select();

        if (error) return res.status(400).json({ error: error.message });
        res.status(201).json({ row: data?.[0] || null, ignored });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

/* ── DELETE /api/admin/gcr/profile/:slug/:table/:id ──────────────────────── */

router.delete('/profile/:slug/:table/:id', adminRequired, async (req, res) => {
    const { slug, table: tableName, id } = req.params;
    try {
        await resolveTable(tableName);
        const { data, error } = await db
            .from(tableName)
            .delete()
            .eq('id', id)
            .eq('entity_slug', slug)
            .select();

        if (error) return res.status(400).json({ error: error.message });
        if (!data || !data.length) {
            return res.status(404).json({ error: `No row ${id} in ${tableName} for "${slug}"` });
        }
        res.json({ deleted: data[0] });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

module.exports = router;
