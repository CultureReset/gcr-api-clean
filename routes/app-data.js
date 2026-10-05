// ============================================================
// APP DATA — what an app-engine app reads and writes (App-build- engine)
// ============================================================
//
// The routes the engine's adapter calls (packages/engine/src/adapter.js):
//
//   /api/app-data          GET/POST /:table, PATCH/DELETE /:table/:id
//                          the app's own records (manifest data.tables),
//                          kept in app_records, scoped by the install AND the
//                          business, both from the token
//   /api/app-install       GET → { installId, itemKey, version, settings, granted }
//                          PUT /settings { settings } → { settings }
//   /api/public/apps       GET /:installId → { settings, data, manifest }
//                          POST /:installId/:sourceKey — a visitor's form: an
//                          app-owned table (public append), or a source bound
//                          read-write to a business contract (DECISIONS #57),
//                          written through the contract with the install's
//                          permissions
//   /api/public/business   GET /:slug/apps → [{ installId, appKey, version,
//                          renderMode, publicLabel, position, enabled,
//                          publicEnabled, config, manifest }] — the business's
//                          enabled, public apps in order (what gcr-unified draws)
//
// The owner side takes only an install's token (gcr_mcp_…, long-lived or the
// short-lived session form, lib/businessTokens.js). The business is the
// install's, never anything in the request. The public side takes no token:
// the install id names an install, the install names the business, and only
// what the manifest declares public is read or appended. Table and column
// guards: lib/businessTables.js (one copy). The projection: lib/appInstances.js.

const express = require('express');
const supabase = require('../db');
const { isBusinessToken, lookupToken } = require('../lib/businessTokens');
const {
    appTableFor, cleanAppRecord, appRecordRow, ownerOnlyColumns, publicSectionFor, scrubPublic,
    sectionSelect, applySection, sectionRow, sectionRows, sectionFor, sectionInsertValues, scopeForPermissions, settleExclusive,
} = require('../lib/businessTables');
const appInstances = require('../lib/appInstances');
const businessEvents = require('../lib/businessEvents');
const messages = require('../lib/messages');
const { envInt } = require('../lib/env');

const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const nowIso = () => new Date().toISOString();
const rowLimit = () => envInt('APP_DATA_ROW_LIMIT', 500);
const maxRows = () => envInt('APP_DATA_MAX_ROWS_PER_TABLE', 5000);
const maxRecordBytes = () => envInt('APP_RECORD_MAX_BYTES', 16384);

function dbFail(res, err) {
    if (err?.code === 'not_configured') return fail(res, 503, err.message, { code: 'not_configured' });
    return fail(res, err?.status || 500, err?.message || 'Something went wrong.');
}

/* ── who: an install's token ──────────────────────────────────────────── */

async function installCaller(req, res, next) {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!isBusinessToken(raw)) return fail(res, 401, 'An installed app\'s token is required.');
    const found = await lookupToken(raw);
    if (found.reason) return fail(res, 401, found.reason);
    if (!found.installId) return fail(res, 403, 'This token does not belong to an installed app.');
    let live;
    try {
        live = await appInstances.liveInstance(found.installId);
    } catch (err) {
        return dbFail(res, err);
    }
    if (!live || live.install.entity_slug !== found.slug) return fail(res, 404, 'This app is not installed.');
    req.entitySlug = found.slug;
    req.appInstall = live;
    next();
}

/** The app table named in the URL, if the manifest declares it for `who`/`action`. */
function tableFor(req, res, manifest, opts) {
    const def = appTableFor(manifest, req.params.table, opts);
    if (!def) {
        fail(res, 404, `Not a table of this app: ${req.params.table}`);
        return null;
    }
    return req.params.table;
}

async function countRows(installId, table) {
    const { count, error } = await supabase.from('app_records').select('id', { count: 'exact', head: true })
        .eq('install_id', installId).eq('app_table', table);
    if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
    return count || 0;
}

async function insertRecord({ install, instance, table, data, source }) {
    if (Buffer.byteLength(JSON.stringify(data)) > maxRecordBytes()) throw Object.assign(new Error('That record is too large.'), { status: 413 });
    if (await countRows(install.install_id, table) >= maxRows()) throw Object.assign(new Error('This table is full.'), { status: 409 });
    const { data: made, error } = await supabase.from('app_records').insert({
        install_id: install.install_id,
        entity_slug: install.entity_slug,
        app_table: table,
        data,
        source,
    }).select().single();
    if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
    // <appKey>.<event> for each event the manifest declares for this table
    // (events.emits, DECISIONS #47). The record as the engine reads it, with a
    // visitor's owner-only columns left out. Never fails the insert.
    await businessEvents.appRecordCreated(install.entity_slug, {
        appKey: instance.app_key,
        manifest: instance.manifest,
        table,
        record: appRecordRow(made, { strip: source === 'visitor' ? ownerOnlyColumns(instance.manifest, table) : null }),
        source,
        installId: install.install_id,
    });
    return made;
}

/* ── the install's own records: one copy of each operation ─────────────
 *
 * The routes below and the business MCP's app tools (routes/mcp.js, an
 * installed app's declared actions, DECISIONS #46) run these same three, so
 * the scoping — the install AND the business, both from the credential — and
 * the manifest's column rules exist once. Each throws err.status for the
 * caller to answer with (422 with err.errors, 400, 404, 413, 409, 503).
 */

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...(extra || {}) });

/** This install's rows in one of its tables, newest first: { rows, total, limit, offset }. */
async function listAppRecords({ install, table, limit, offset }) {
    const lim = Math.min(Number(limit) || rowLimit(), rowLimit());
    const off = Math.max(Number(offset) || 0, 0);
    const { data, error, count } = await supabase.from('app_records').select('*', { count: 'exact' })
        .eq('install_id', install.install_id).eq('entity_slug', install.entity_slug).eq('app_table', table)
        .order('created_at', { ascending: false })
        .range(off, off + lim - 1);
    if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
    return { rows: (data || []).map((r) => appRecordRow(r)), total: count ?? null, limit: lim, offset: off };
}

/** A new record from a body, checked against the manifest. Resolves the stored row. */
async function createAppRecord({ install, instance, table, body, source = 'owner' }) {
    const checked = cleanAppRecord(instance.manifest, table, body);
    if (!checked.ok) throw httpError(422, 'Some fields need attention.', { errors: checked.errors });
    return insertRecord({ install, instance, table, data: checked.data, source });
}

async function scopedRecord({ install, table, id }) {
    const { data, error } = await supabase.from('app_records').select('*')
        .eq('id', id).eq('install_id', install.install_id)
        .eq('entity_slug', install.entity_slug).eq('app_table', table)
        .maybeSingle();
    if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
    return data;
}

/** Change the given columns of one of this install's records. Resolves the stored row. */
async function updateAppRecord({ install, instance, table, id, body }) {
    const checked = cleanAppRecord(instance.manifest, table, body, { partial: true });
    if (!checked.ok) throw httpError(422, 'Some fields need attention.', { errors: checked.errors });
    if (!Object.keys(checked.data).length) throw httpError(400, 'Nothing to change.');
    const current = await scopedRecord({ install, table, id });
    if (!current) throw httpError(404, 'That row is not there.');
    const data = { ...(current.data || {}), ...checked.data };
    if (Buffer.byteLength(JSON.stringify(data)) > maxRecordBytes()) throw httpError(413, 'That record is too large.');
    const { data: rows, error } = await supabase.from('app_records')
        .update({ data, updated_at: nowIso() })
        .eq('id', current.id).eq('install_id', current.install_id).eq('entity_slug', install.entity_slug)
        .select();
    if (error) throw new Error(error.message);
    if (!rows?.length) throw httpError(404, 'That row is not there.');
    return rows[0];
}

/* ── /api/app-data ────────────────────────────────────────────────────── */

const dataRouter = express.Router();
dataRouter.use(installCaller);

const answer = (res, err) => (err?.errors ? fail(res, err.status, err.message, { errors: err.errors }) : dbFail(res, err));

dataRouter.get('/:table', async (req, res) => {
    const { install, instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    try {
        res.json({ table, ...(await listAppRecords({ install, table, limit: req.query.limit, offset: req.query.offset })) });
    } catch (err) {
        answer(res, err);
    }
});

dataRouter.post('/:table', async (req, res) => {
    const { install, instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    try {
        const made = await createAppRecord({ install, instance, table, body: req.body, source: 'owner' });
        res.status(201).json({ table, row: appRecordRow(made) });
    } catch (err) {
        answer(res, err);
    }
});

dataRouter.patch('/:table/:id', async (req, res) => {
    const { install, instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    try {
        const row = await updateAppRecord({ install, instance, table, id: req.params.id, body: req.body });
        res.json({ table, row: appRecordRow(row) });
    } catch (err) {
        answer(res, err);
    }
});

dataRouter.delete('/:table/:id', async (req, res) => {
    const { install, instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    try {
        const current = await scopedRecord({ install, table, id: req.params.id });
        if (!current) return fail(res, 404, 'That row is not there.');
        const { data, error } = await supabase.from('app_records').delete()
            .eq('id', current.id).eq('install_id', current.install_id).eq('entity_slug', req.entitySlug)
            .select('id');
        if (error) throw new Error(error.message);
        if (!data?.length) return fail(res, 404, 'That row is not there.');
        res.json({ table, deleted: data[0].id });
    } catch (err) {
        dbFail(res, err);
    }
});

/* ── /api/app-install ─────────────────────────────────────────────────── */

const installRouter = express.Router();
installRouter.use(installCaller);

installRouter.get('/', (req, res) => {
    const { install, instance } = req.appInstall;
    res.set('Cache-Control', 'no-store');
    res.json({
        installId: install.install_id,
        itemKey: install.item_key,
        version: instance.version || install.version || null,
        settings: appInstances.settingsFor(instance),
        granted: Array.isArray(install.permissions) ? install.permissions : [],
    });
});

installRouter.put('/settings', async (req, res) => {
    const incoming = req.body?.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return fail(res, 400, 'Send { settings: { … } }.');
    try {
        res.json({ settings: await appInstances.saveSettings(req.appInstall.instance, incoming) });
    } catch (err) {
        dbFail(res, err);
    }
});

/* ── /api/public/apps ─────────────────────────────────────────────────── */

const publicRouter = express.Router();

/** A live install whose public surface is on, or null. */
async function publicInstance(installId) {
    const live = await appInstances.liveInstance(installId);
    if (!live || live.instance.public_enabled === false || !live.instance.manifest) return null;
    return live;
}

/** Rows a visitor may see: hidden rows dropped, owner-only and sensitive columns removed. */
function visibleRows(rows, source, strip) {
    const flag = source.visibleWhen;
    return rows
        .filter((r) => !flag || (r[flag] !== false && r[flag] !== 'false'))
        .map((r) => {
            const out = { ...r };
            for (const col of strip) delete out[col];
            return scrubPublic(out);
        });
}

publicRouter.get('/:installId', async (req, res) => {
    try {
        const live = await publicInstance(req.params.installId);
        if (!live) return fail(res, 404, 'No such app.');
        const { install, instance } = live;
        const manifest = instance.manifest;
        const sources = manifest.ui?.sources || {};
        const caller = { scope: 'read', permissions: Array.isArray(install.permissions) ? install.permissions : [] };
        const limit = envInt('APP_PUBLIC_ROW_LIMIT', 200);
        const data = {};
        for (const key of appInstances.publicSources(manifest)) {
            const source = sources[key];
            const strip = new Set((source.fields || []).filter((f) => f?.ownerOnly).map((f) => f.key));
            if (source.from === 'app') {
                if (!appTableFor(manifest, source.table, { who: 'visitor', action: 'read' })) continue;
                for (const col of ownerOnlyColumns(manifest, source.table)) strip.add(col);
                const { data: rows, error } = await supabase.from('app_records').select('*')
                    .eq('install_id', install.install_id).eq('entity_slug', install.entity_slug).eq('app_table', source.table)
                    .order('created_at', { ascending: false }).limit(limit);
                if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
                data[key] = visibleRows((rows || []).map((r) => appRecordRow(r)), source, strip);
            } else if (source.from === 'business') {
                // A section by table name, or by data contract (source.contract,
                // lib/dataContracts.js): the registry's table, filter and resource.
                const section = await publicSectionFor(caller, source.contract || source.section);
                if (!section) continue;
                const { data: rows, error } = await applySection(
                    supabase.from(section.table).select(await sectionSelect(section)), section, install.entity_slug,
                ).limit(limit);
                if (error) throw new Error(error.message);
                data[key] = visibleRows(await sectionRows(section, rows), source, strip);
            }
        }
        res.set('Cache-Control', `public, max-age=${envInt('APP_PUBLIC_CACHE_SECONDS', 30, { min: 0 })}`);
        res.json({ settings: appInstances.settingsFor(instance, { only: appInstances.publicSettingKeys(manifest) }), data, manifest });
    } catch (err) {
        dbFail(res, err);
    }
});

/**
 * A visitor's submission into the business through a read-write binding
 * (DECISIONS #57): the contract's table, filter and business key from the
 * registry, under the install's permissions (what the owner approved for the
 * app), never the visitor's. Owner-only fields of the source are dropped.
 * Resolves the stored row, or throws err.status.
 */
async function insertBound({ install, bound, body }) {
    const caller = { scope: scopeForPermissions(install.permissions), permissions: Array.isArray(install.permissions) ? install.permissions : [] };
    const section = await sectionFor(caller, bound.binding.contract, 'write');
    if (!section) throw Object.assign(new Error('This form is not open to visitors.'), { status: 403 });
    if (section.single) throw Object.assign(new Error(`${section.name} is the business's one record; a visitor cannot add to it.`), { status: 405 });
    const input = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
    for (const f of bound.source.fields || []) if (f?.ownerOnly && typeof f.key === 'string') delete input[f.key];
    const { values, refused } = await sectionInsertValues(section, input);
    if (refused.length) throw Object.assign(new Error(`${section.name}: ${refused.join('; ')}.`), { status: 400 });
    const { data, error } = await supabase.from(section.table)
        .insert({ ...values, [section.slugColumn]: install.entity_slug }) // the business is the install's
        .select().single();
    if (error) throw Object.assign(new Error(error.message), { status: 400 });
    await settleExclusive(supabase, section, install.entity_slug, data); // one cover per business (DECISIONS #97)
    await businessEvents.sectionWritten(install.entity_slug, section.table, null, data);
    return { row: sectionRow(section, data), table: section.table };
}

publicRouter.post('/:installId/:table', async (req, res) => {
    try {
        const live = await publicInstance(req.params.installId);
        if (!live) return fail(res, 404, 'No such app.');
        const { install, instance } = live;
        const manifest = instance.manifest;
        const key = req.params.table;
        // The path names an app-owned table a visitor may append to, or a
        // public source bound read-write to a business contract (DECISIONS #57).
        const bound = appTableFor(manifest, key, { who: 'visitor', action: 'append' }) ? null : appInstances.boundSubmission(manifest, key);
        const table = bound ? key : tableFor(req, res, manifest, { who: 'visitor', action: 'append' });
        if (!table) return;
        // A form the owner closed ({ openWhen: { setting } } set to false) takes nothing.
        const settings = appInstances.settingsFor(instance);
        const forms = appInstances.publicFormsFor(manifest, table);
        if (forms.length && forms.every((v) => v.openWhen?.setting && settings[v.openWhen.setting] === false)) {
            return fail(res, 403, 'This form is closed.');
        }
        let made;
        let record;
        if (bound) {
            try {
                const out = await insertBound({ install, bound, body: req.body });
                made = out.row;
                record = out.row;
            } catch (err) {
                return fail(res, err.status || 500, err.message);
            }
            await businessEvents.appRecordCreated(install.entity_slug, {
                appKey: instance.app_key, manifest, table: key, record, source: 'visitor', installId: install.install_id,
            });
        } else {
            const checked = cleanAppRecord(manifest, table, req.body, { visitor: true });
            if (!checked.ok) return fail(res, 422, 'Some fields need attention.', { errors: checked.errors });
            made = await insertRecord({ install, instance, table, data: checked.data, source: 'visitor' });
            record = appRecordRow(made, { strip: ownerOnlyColumns(manifest, table) });
        }
        // A submission to the business lands in the one Messages inbox too
        // (lib/messages.js, DECISIONS #48): an app table with inbox true, or
        // by default one visitors may append to; a binding with inbox true.
        // The inbox row must never fail the submission: a refusal is logged.
        if (appInstances.isInboxSubmission(manifest, key)) {
            try {
                await messages.recordAppSubmission({
                    slug: install.entity_slug,
                    installId: install.install_id,
                    record,
                    titleField: (bound ? bound.source : appInstances.appSourceFor(manifest, table))?.title || null,
                });
            } catch (err) {
                console.error(`[app-data] inbox row for ${instance.app_key}/${key} on ${install.entity_slug}:`, err.message);
            }
        }
        // Write-only: a visitor gets the receipt, not the row back.
        res.status(201).json({ table: key, row: { id: made.id, created_at: made.created_at } });
    } catch (err) {
        dbFail(res, err);
    }
});

/* ── /api/public/business ─────────────────────────────────────────────── */

const businessRouter = express.Router();

// The apps a business's public page draws: Paperclip's rows that are enabled
// and switched on for the public, in the owner's order, each with its
// manifest. A slug nobody has is 404 with a JSON body, so a page can tell
// "no such business" from "no such route". This is a public read by slug,
// like /api/gcr/entity/:slug; nothing here acts as the business.
businessRouter.get('/:slug/apps', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    try {
        const { data: entity, error } = await supabase.from('entity').select('slug').eq('slug', slug).maybeSingle();
        if (error) throw new Error(error.message);
        if (!entity) return fail(res, 404, 'No such business.');
        const rows = await appInstances.listForSlug(entity.slug, { publicOnly: true });
        res.set('Cache-Control', `public, max-age=${envInt('APP_PUBLIC_CACHE_SECONDS', 30, { min: 0 })}`);
        res.json(rows);
    } catch (err) {
        dbFail(res, err);
    }
});

module.exports = {
    dataRouter, installRouter, publicRouter, businessRouter, installCaller,
    listAppRecords, createAppRecord, updateAppRecord,
};
