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
//                          name auth.users in the path. A dotted name is a
//                          data contract (lib/dataContracts.js): the registry
//                          names the table, the filter the rows carry and the
//                          permission resource — the same door, by contract.
//
//   The column filter      identity and bookkeeping columns are stripped from
//                          every incoming body, so a business cannot reassign
//                          its own row to somebody else's slug.
//
// Reads use the service key, which bypasses row-level security by design. That
// is what makes the 99 slug tables with RLS on and no policy — the ones that
// silently returned nothing to the browser — visible again.

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const supabase = require('../db');
const googlePush = require('../lib/googlePush');
const businessEvents = require('../lib/businessEvents');
const { ownerRequired, sessionRequired } = require('../middleware/ownerAuth');

// The schema discovery, the table allow-list and the column filter live in
// lib/businessTables.js so routes/mcp.js applies exactly the same three guards
// to an AI assistant that this file applies to the dashboard. One copy only —
// a second copy of a security check drifts until one of them has a hole in it.
const {
    getSchema, tablesFor,
    permitsResource, sectionNamed, sectionPermitted, sectionSelect, sectionColumns, applySection, orderSection, sectionRow, sectionRows, sectionInsertValues, sectionPatchValues, settleExclusive, pivotColumn,
} = require('../lib/businessTables');
const { isBusinessToken, lookupToken } = require('../lib/businessTokens');
const { envStr, envInt } = require('../lib/env');

const router = express.Router();

const fail = (res, code, message, extra) => res.status(code).json({ error: message, ...(extra || {}) });

/* ── who may use the section routes ──────────────────────────────────────
 *
 * The dashboard's session (Supabase or Paperclip, via ownerRequired), or a
 * business token (gcr_mcp_…) an installed app was issued. Either way the slug
 * comes from the table that vouched for the caller, and req.businessCaller
 * carries { scope, permissions } for lib/businessTables.js to check — the same
 * check routes/mcp.js runs. A session is the owner: write scope, no
 * permission list, so every section.
 *
 * Only these section routes take a token. The rest of the owner API (billing,
 * the store, token minting) stays session-only, so an app's token cannot mint
 * itself a wider one.
 */
async function businessCaller(req, res, next) {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (isBusinessToken(raw)) {
        const found = await lookupToken(raw);
        if (found.reason) return fail(res, 401, found.reason);
        req.entitySlug = found.slug;
        req.businessCaller = { scope: found.scope, permissions: found.permissions, installId: found.installId };
        return next();
    }
    return ownerRequired(req, res, () => {
        req.businessCaller = { scope: 'write', permissions: null };
        next();
    });
}

/**
 * The section named in the URL, if it exists and this caller may `action` it.
 *
 * A raw table name (`menu_items`) or a data contract (`menu.items`,
 * `products.items` — lib/dataContracts.js, DECISIONS #45). Either way the
 * answer is a section descriptor from lib/businessTables.js: the table, the
 * contract's server-side filter, and the business key. For a contract the
 * permission resource is the registry's, not the table name's.
 */
async function sectionFor(req, res, action) {
    let section;
    let permitted;
    try {
        section = await sectionNamed(req.params.table);
        permitted = section && await sectionPermitted(req.businessCaller, section, action);
    } catch (err) {
        fail(res, 502, err.message);
        return null;
    }
    if (!section) {
        fail(res, 400, `Not a business section: ${req.params.table}`);
        return null;
    }
    if (!permitted) {
        fail(res, 403, `This connection is not allowed to ${action} ${req.params.table}.`);
        return null;
    }
    return section;
}

/** What every section response carries: the table, and the contract when one was named. */
const named = (section) => ({ table: section.table, ...(section.contract ? { contract: section.contract } : {}) });

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
    // A Paperclip sign-in: the business is the company's link, if any.
    if (req.authVia === 'paperclip') {
        const slug = req.linkedSlug || null;
        let name = null;
        if (slug) {
            const { data: entity } = await supabase.from('entity').select('name').eq('slug', slug).maybeSingle();
            name = entity?.name || null;
        }
        return res.json({
            slug,
            name,
            role: req.paperclip.role,
            isAdmin: !!req.paperclip.isAdmin,
            hasAccess: !!slug,
            user_id: req.paperclip.userId,
            company_id: req.paperclip.companyId,
        });
    }

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
router.get('/schema', businessCaller, async (req, res) => {
    try {
        const { columns: all, at } = await getSchema();
        const tables = await tablesFor(req.businessCaller, 'read');
        const columns = Object.fromEntries(tables.map((t) => [t, all[t]]));
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

router.get('/sections', businessCaller, async (req, res) => {
    const slug = req.entitySlug;

    let readable;
    try {
        readable = await tablesFor(req.businessCaller, 'read');
    } catch (err) {
        return fail(res, 502, err.message);
    }
    const allowed = new Set(readable);

    const viaRpc = await sweepViaRpc(slug);
    if (viaRpc) {
        // The RPC returns every table; a token sees only what it may read.
        const sections = Object.fromEntries(Object.entries(viaRpc).filter(([t]) => allowed.has(t)));
        return res.json({ slug, sections, tables_scanned: readable.length, via: 'rpc' });
    }

    const sections = {};
    await mapLimit(readable, SWEEP_CONCURRENCY, async (table) => {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .eq('entity_slug', slug)
            .limit(ROW_LIMIT);
        // A table that cannot be read must not take the whole dashboard with it.
        if (!error && data && data.length) sections[table] = data;
    });

    res.json({ slug, sections, tables_scanned: readable.length, via: 'sweep' });
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

/* ── an image file, into storage (DECISIONS #99) ──────────────────────────
 *
 * POST /api/business/media/upload — multipart, one `file`, an image. The owner's
 * session or an install token with business:write (the resource media.images
 * is on). The file goes where the business's photos already go: the same
 * storage client (db.js) and the bucket named by MEDIA_UPLOAD_BUCKET, under
 * the credential's slug. Answers { url, image_path } and writes no
 * entity_photos row — the app then POSTs media.images with the url, so the
 * photo's record is made through the one door every other record uses.
 *
 * The cap is MEDIA_UPLOAD_MAX_BYTES. Neither is defaulted here: unset, the
 * route answers 503 naming what is missing, as the export does.
 */
const mediaUpload = (req, res, next) => {
    const max = envInt('MEDIA_UPLOAD_MAX_BYTES', null);
    if (!envStr('MEDIA_UPLOAD_BUCKET')) return fail(res, 503, 'MEDIA_UPLOAD_BUCKET is not set, so there is nowhere to put the file.');
    if (!max) return fail(res, 503, 'MEDIA_UPLOAD_MAX_BYTES is not set, so no size cap applies; refusing rather than guessing.');
    const single = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: max, files: 1 },
        fileFilter: (_req, file, cb) => (/^image\//.test(file.mimetype || '') ? cb(null, true) : cb(Object.assign(new Error('Only an image can be uploaded here.'), { status: 400 }))),
    }).single('file');
    single(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `The file is over ${max} bytes.` : err.message);
        fail(res, err.status || 400, err.message);
    });
};

router.post('/media/upload', businessCaller, (req, res, next) => {
    if (!permitsResource(req.businessCaller, 'business', 'write')) return fail(res, 403, 'This connection is not allowed to upload media.');
    next();
}, mediaUpload, async (req, res) => {
    if (!req.file) return fail(res, 400, 'Send one image as the `file` field.');
    const bucket = envStr('MEDIA_UPLOAD_BUCKET');
    const ext = (req.file.mimetype.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const imagePath = `${req.entitySlug}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`; // the slug is the credential's
    const { error } = await supabase.storage.from(bucket).upload(imagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) return fail(res, 502, `Storage refused the file: ${error.message}`);
    const { data } = supabase.storage.from(bucket).getPublicUrl(imagePath);
    res.json({ url: data.publicUrl, image_path: imagePath });
});

/* ── one section, for refreshing after an edit ───────────────────────────── */

// GET /api/business/:table — this business's rows in one table (or contract), paged.
router.get('/:table', businessCaller, async (req, res) => {
    const section = await sectionFor(req, res, 'read');
    if (!section) return;

    const limit = Math.min(Number(req.query.limit) || 200, ROW_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { data, error, count } = await orderSection(applySection(
        supabase.from(section.table).select(await sectionSelect(section), { count: 'exact' }),
        section, req.entitySlug,
    ), section, await sectionColumns(section)).range(offset, offset + limit - 1);
    if (error) return fail(res, 500, error.message);

    const rows = await sectionRows(section, data);
    // A scalar contract (business.currency) is one value of the business (DECISIONS #56).
    if (section.scalar) return res.json({ ...named(section), value: rows[0]?.[section.scalar] ?? null });
    // A pivot contract (business.links) has as many rows as set columns (DECISIONS #63).
    if (section.pivot) return res.json({ ...named(section), rows, total: rows.length, limit, offset });
    res.json({ ...named(section), rows, total: count ?? null, limit, offset });
});

/* ── a pivot contract's writes (business.links, DECISIONS #63) ─────────────
 *
 * A row is one column of the business record: POST { network, url } sets the
 * column the network names, PATCH /:id { url } changes it, DELETE /:id clears
 * it. The column must be live and must be one the pivot rule yields — a row
 * id can never name another column of the record. The slug is the caller's.
 */
async function writePivot(req, res, section, id, value, { create = false } = {}) {
    const column = await pivotColumn(section, id);
    if (!column) return fail(res, create ? 400 : 404, create ? `The business record has no ${section.pivot.key} called "${id}".` : 'That row is not there.');
    const { data, error } = await applySection(
        supabase.from(section.table).update({ [column]: value }), section, req.entitySlug,
    ).select(`${section.slugColumn}, ${column}`);
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'That row is not there.');
    await googlePush.noteTableWrite(req.entitySlug, section.table, data[0]);
    const row = { id, [section.pivot.key]: id, [section.pivot.value]: value };
    if (value === null) return res.json({ ...named(section), deleted: id });
    res.status(create ? 201 : 200).json({ ...named(section), row });
}

const pivotValue = (section, body) => {
    const v = body && typeof body === 'object' ? body[section.pivot.value] : undefined;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/* ── the three writes ─────────────────────────────────────────────────────
 *
 * Create stamps the slug. Update and delete filter on it as well as the id, so
 * a tampered id matches nothing rather than somebody else's row.
 *
 * A single-record contract (business.profile, DECISIONS #96) is the business's
 * own record: it exists once, so it is PATCHed — with or without an id — and
 * never POSTed or DELETEd. Its columns are the owner's column rule
 * (lib/businessTables.js ownerProfilePatch, shared with PATCH /api/owner/profile);
 * a governed column is refused by name.
 */

const onlyPatch = (res, section) => fail(res, 405, `${section.name} is this business's one record: PATCH it.`);

// POST /api/business/:table
router.post('/:table', businessCaller, async (req, res) => {
    const section = await sectionFor(req, res, 'write');
    if (!section) return;
    const { table } = section;

    if (section.single) return onlyPatch(res, section);
    if (section.pivot) {
        const id = req.body && typeof req.body === 'object' ? req.body[section.pivot.key] : undefined;
        const value = pivotValue(section, req.body);
        if (!value) return fail(res, 400, `A ${section.pivot.value} is required.`);
        return writePivot(req, res, section, String(id || ''), value, { create: true });
    }

    // The contract's filter columns are stamped after the body is cleaned, so a
    // products.items write is a product whatever `kind` the body carried.
    const { values, refused } = await sectionInsertValues(section, req.body);
    if (refused.length) return fail(res, 400, `${section.name}: ${refused.join('; ')}.`, { refused });

    const { data, error } = await supabase
        .from(table)
        .insert({ ...values, [section.slugColumn]: req.entitySlug }) // the slug is ours, not theirs
        .select()
        .single();
    if (error) return fail(res, 400, error.message);

    // One cover photo per business (DECISIONS #97): the registry's exclusive columns.
    await settleExclusive(supabase, section, req.entitySlug, data);
    // A fact Google shows (hours, menus…) is queued for the profile (lib/googlePush.js).
    await googlePush.noteTableWrite(req.entitySlug, table, data);
    // A booking or a review written here fires the same events the dashboard's
    // own paths fire (lib/businessEvents.js, DECISIONS #47). Never fails the write.
    await businessEvents.sectionWritten(req.entitySlug, table, null, data);
    res.status(201).json({ ...named(section), row: sectionRow(section, data) });
});

// Tables whose change is an event (booking.changed / cancelled need the row as it was).
const EVENTFUL_ON_CHANGE = new Set(['bookings', 'booking_calendar']);

// PATCH /api/business/:table/:id
router.patch('/:table/:id', businessCaller, async (req, res) => {
    const section = await sectionFor(req, res, 'write');
    if (!section) return;

    if (section.pivot) {
        const value = pivotValue(section, req.body);
        if (!value) return fail(res, 400, 'Nothing to change.');
        return writePivot(req, res, section, req.params.id, value);
    }
    return updateRow(req, res, section, req.params.id);
});

// PATCH /api/business/:table — the business's one record (business.profile) needs no id.
router.patch('/:table', businessCaller, async (req, res) => {
    const section = await sectionFor(req, res, 'write');
    if (!section) return;
    if (!section.single) return fail(res, 400, 'An id is required.');
    return updateRow(req, res, section, null);
});

/** Update one row of this business — by id, or the single record when id is null. */
async function updateRow(req, res, section, id) {
    const { table } = section;
    const { values, refused } = await sectionPatchValues(section, req.body);
    if (refused.length) return fail(res, 400, `${section.name}: ${refused.join('; ')}.`, { refused });
    if (!Object.keys(values).length) return fail(res, 400, 'Nothing to change.');

    // The id never widens the match: the slug from the credential always applies.
    const byId = (q) => (id === null ? q : q.eq(section.idColumn, id));

    let before = null;
    if (EVENTFUL_ON_CHANGE.has(table)) {
        const { data: was } = await applySection(
            byId(supabase.from(table).select('*')), section, req.entitySlug,
        ).maybeSingle();
        before = was ? { ...was } : null; // a snapshot, not a reference the update could move
    }

    const { data, error } = await applySection(
        byId(supabase.from(table).update(values)),
        section, req.entitySlug, // never reachable outside this business, or outside the contract
    ).select(await sectionSelect(section));
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'That row is not there.');

    await settleExclusive(supabase, section, req.entitySlug, data[0]);
    await googlePush.noteTableWrite(req.entitySlug, table, data[0]);
    if (EVENTFUL_ON_CHANGE.has(table)) await businessEvents.sectionWritten(req.entitySlug, table, before, data[0]);
    res.json({ ...named(section), row: sectionRow(section, data[0]) });
}

// DELETE /api/business/:table/:id
router.delete('/:table/:id', businessCaller, async (req, res) => {
    const section = await sectionFor(req, res, 'write');
    if (!section) return;
    const { table } = section;

    if (section.single) return onlyPatch(res, section);
    if (section.pivot) return writePivot(req, res, section, req.params.id, null);

    const { data, error } = await applySection(
        supabase.from(table).delete().eq(section.idColumn, req.params.id),
        section, req.entitySlug,
    ).select(section.idColumn);
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'That row is not there.');

    await googlePush.noteTableWrite(req.entitySlug, table, null);
    res.json({ ...named(section), deleted: data[0][section.idColumn] });
});

module.exports = router;
