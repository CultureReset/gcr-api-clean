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
//   /api/public/apps       GET /:installId → { settings, data }
//                          POST /:installId/:table — a visitor's form
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
} = require('../lib/businessTables');
const appInstances = require('../lib/appInstances');
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

async function insertRecord({ install, table, data, source }) {
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
    return made;
}

/* ── /api/app-data ────────────────────────────────────────────────────── */

const dataRouter = express.Router();
dataRouter.use(installCaller);

dataRouter.get('/:table', async (req, res) => {
    const { install, instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    const limit = Math.min(Number(req.query.limit) || rowLimit(), rowLimit());
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    try {
        const { data, error, count } = await supabase.from('app_records').select('*', { count: 'exact' })
            .eq('install_id', install.install_id).eq('entity_slug', req.entitySlug).eq('app_table', table)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
        res.json({ table, rows: (data || []).map((r) => appRecordRow(r)), total: count ?? null, limit, offset });
    } catch (err) {
        dbFail(res, err);
    }
});

dataRouter.post('/:table', async (req, res) => {
    const { install, instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    const checked = cleanAppRecord(instance.manifest, table, req.body);
    if (!checked.ok) return fail(res, 422, 'Some fields need attention.', { errors: checked.errors });
    try {
        const made = await insertRecord({ install, table, data: checked.data, source: 'owner' });
        res.status(201).json({ table, row: appRecordRow(made) });
    } catch (err) {
        dbFail(res, err);
    }
});

async function scopedRecord(req, table) {
    const { data, error } = await supabase.from('app_records').select('*')
        .eq('id', req.params.id).eq('install_id', req.appInstall.install.install_id)
        .eq('entity_slug', req.entitySlug).eq('app_table', table)
        .maybeSingle();
    if (error) throw (appInstances.missing(error) ? appInstances.notSetUp() : new Error(error.message));
    return data;
}

dataRouter.patch('/:table/:id', async (req, res) => {
    const { instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    const checked = cleanAppRecord(instance.manifest, table, req.body, { partial: true });
    if (!checked.ok) return fail(res, 422, 'Some fields need attention.', { errors: checked.errors });
    if (!Object.keys(checked.data).length) return fail(res, 400, 'Nothing to change.');
    try {
        const current = await scopedRecord(req, table);
        if (!current) return fail(res, 404, 'That row is not there.');
        const data = { ...(current.data || {}), ...checked.data };
        if (Buffer.byteLength(JSON.stringify(data)) > maxRecordBytes()) return fail(res, 413, 'That record is too large.');
        const { data: rows, error } = await supabase.from('app_records')
            .update({ data, updated_at: nowIso() })
            .eq('id', current.id).eq('install_id', current.install_id).eq('entity_slug', req.entitySlug)
            .select();
        if (error) throw new Error(error.message);
        if (!rows?.length) return fail(res, 404, 'That row is not there.');
        res.json({ table, row: appRecordRow(rows[0]) });
    } catch (err) {
        dbFail(res, err);
    }
});

dataRouter.delete('/:table/:id', async (req, res) => {
    const { instance } = req.appInstall;
    const table = tableFor(req, res, instance.manifest, { who: 'install' });
    if (!table) return;
    try {
        const current = await scopedRecord(req, table);
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
                const table = await publicSectionFor(caller, source.section);
                if (!table) continue;
                const { data: rows, error } = await supabase.from(table).select('*')
                    .eq('entity_slug', install.entity_slug).limit(limit);
                if (error) throw new Error(error.message);
                data[key] = visibleRows(rows || [], source, strip);
            }
        }
        res.set('Cache-Control', `public, max-age=${envInt('APP_PUBLIC_CACHE_SECONDS', 30, { min: 0 })}`);
        res.json({ settings: appInstances.settingsFor(instance, { only: appInstances.publicSettingKeys(manifest) }), data });
    } catch (err) {
        dbFail(res, err);
    }
});

publicRouter.post('/:installId/:table', async (req, res) => {
    try {
        const live = await publicInstance(req.params.installId);
        if (!live) return fail(res, 404, 'No such app.');
        const { install, instance } = live;
        const manifest = instance.manifest;
        const table = tableFor(req, res, manifest, { who: 'visitor', action: 'append' });
        if (!table) return;
        // A form the owner closed ({ openWhen: { setting } } set to false) takes nothing.
        const settings = appInstances.settingsFor(instance);
        const forms = appInstances.publicFormsFor(manifest, table);
        if (forms.length && forms.every((v) => v.openWhen?.setting && settings[v.openWhen.setting] === false)) {
            return fail(res, 403, 'This form is closed.');
        }
        const checked = cleanAppRecord(manifest, table, req.body, { visitor: true });
        if (!checked.ok) return fail(res, 422, 'Some fields need attention.', { errors: checked.errors });
        const made = await insertRecord({ install, table, data: checked.data, source: 'visitor' });
        // Write-only: a visitor gets the receipt, not the row back.
        res.status(201).json({ table, row: { id: made.id, created_at: made.created_at } });
    } catch (err) {
        dbFail(res, err);
    }
});

module.exports = { dataRouter, installRouter, publicRouter, installCaller };
