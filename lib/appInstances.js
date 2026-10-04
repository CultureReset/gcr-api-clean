// ============================================================
// APP INSTANCES — the runtime projection of installed apps (CONTRACT §14)
// ============================================================
//
// Paperclip is the authority for what is installed, at which version and
// whether it is enabled. gcr-api-clean keeps one entity_modules row per app
// install (sql/nextgent_entity_modules.sql, Step 3 contract §B) so a public
// page, and the app's own screens, render without calling Paperclip per visit:
//
//   module_key = the app key, enabled, sort_order = position,
//   settings.manifest (Paperclip's store version payload.app, kept whole),
//   settings.config (the app's settings; secrets sealed), settings.showOnPublic
//   (the one public flag), managed_by = 'paperclip', install_id, company_id,
//   version, render_mode, public_label
//
// Written by routes/nextgent.js (install, update, uninstall, unlink) and the
// owner's switches in routes/owner.js; read by routes/app-data.js and the
// public list. The legacy dashboard (routes/platform.js) keeps its own rows in
// the same table and never touches a managed_by = 'paperclip' row. The app's
// own records are in app_records, scoped by the install and the business, and
// are never deleted on uninstall (DECISIONS #22). Table and column guards:
// lib/businessTables.js.

const supabase = require('../db');
const secretBox = require('./secretBox');
const { configKeys } = require('./storeManifest');

const TABLE = 'entity_modules';
const MANAGED_BY = 'paperclip';
const RENDER_MODES = ['inline', 'button', 'page', 'action'];
const DEFAULT_RENDER_MODE = RENDER_MODES[0];
const SECRET_PURPOSE = 'app-setting';
const nowIso = () => new Date().toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (error) => /entity_modules|app_records|managed_by|install_id|company_id|render_mode|public_label/.test(error?.message || '')
    && /(does not exist|schema cache)/i.test(error.message);

function notSetUp() {
    return Object.assign(new Error('Apps are not set up on this database yet (apply sql/nextgent_entity_modules.sql and sql/nextgent_apps.sql, see sql/ORDER.md).'), { status: 503, code: 'not_configured' });
}

/* ── the row as the rest of the code reads it ─────────────────────────── */

/**
 * One entity_modules row as an instance: the fields the routes read, by the
 * names they have always used, plus the raw `settings` for a read-modify-write.
 */
function fromRow(r) {
    const s = isObj(r.settings) ? r.settings : {};
    return {
        module_id: r.id,
        install_id: r.install_id,
        entity_slug: r.entity_slug,
        company_id: r.company_id ?? null,
        app_key: r.module_key,
        version: r.version ?? null,
        enabled: r.enabled !== false,
        public_enabled: s.showOnPublic !== false,
        render_mode: r.render_mode || DEFAULT_RENDER_MODE,
        public_label: r.public_label ?? null,
        position: r.sort_order ?? null,
        config: isObj(s.config) ? s.config : {},
        manifest: isObj(s.manifest) ? s.manifest : null,
        settings: s,
    };
}

/** The row shape the public list and the owner's screens share (contract §B). */
function rowShape(instance, { publicOnly = false } = {}) {
    const manifest = instance.manifest;
    return {
        installId: instance.install_id,
        appKey: instance.app_key,
        version: instance.version,
        renderMode: instance.render_mode,
        publicLabel: instance.public_label,
        position: instance.position,
        enabled: instance.enabled,
        publicEnabled: instance.public_enabled,
        config: publicOnly ? settingsFor(instance, { only: publicSettingKeys(manifest) }) : settingsFor(instance),
        manifest,
    };
}

async function rowByInstall(installId) {
    const { data, error } = await supabase.from(TABLE).select('*').eq('install_id', String(installId)).maybeSingle();
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
    return data || null;
}

/* ── Paperclip's writes ───────────────────────────────────────────────── */

/** The row for this app key on this business, if one exists (a Paperclip one first). */
async function rowByKey(slug, itemKey) {
    const { data, error } = await supabase.from(TABLE).select('*').eq('entity_slug', slug).eq('module_key', itemKey);
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
    const rows = data || [];
    return rows.find((r) => r.managed_by === MANAGED_BY) || rows[0] || null;
}

/**
 * Create or refresh an install's projection. Fields left undefined keep what
 * is stored. One row per (business, app key): a reinstall after an uninstall
 * reuses the row (DECISIONS #28) — re-enabled, with the new install id,
 * version, manifest, an empty config and the public flag on — never a second.
 * A legacy row (the owner's, managed_by null) under the same key is taken over
 * the same way, except its config is kept: owner configuration is never lost
 * (DECISIONS #30).
 */
async function project({ installId, companyId, slug, itemKey, version, manifest, enabled }) {
    const existing = await rowByInstall(installId);
    const settings = { ...(isObj(existing?.settings) ? existing.settings : {}) };
    if (manifest) settings.manifest = manifest;
    const row = {
        entity_slug: slug,
        module_key: itemKey,
        company_id: companyId,
        managed_by: MANAGED_BY,
        settings,
        updated_at: nowIso(),
        ...(version !== undefined && version !== null ? { version: String(version) } : {}),
        ...(typeof enabled === 'boolean' ? { enabled } : {}),
    };
    if (existing) {
        const { error } = await supabase.from(TABLE).update(row).eq('install_id', installId);
        if (error) throw missing(error) ? notSetUp() : new Error(error.message);
        return;
    }
    const reuse = await rowByKey(slug, itemKey);
    const legacyConfig = reuse && reuse.managed_by !== MANAGED_BY && isObj(reuse.settings?.config) ? reuse.settings.config : {};
    const fresh = {
        install_id: installId,
        enabled: true,
        ...row,
        settings: { manifest: manifest || null, config: legacyConfig, showOnPublic: true },
    };
    const { error } = reuse
        ? await supabase.from(TABLE).update(fresh).eq('id', reuse.id)
        : await supabase.from(TABLE).insert({ render_mode: DEFAULT_RENDER_MODE, ...fresh });
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
}

/**
 * Uninstalled: both surfaces go. The row is switched off (enabled and the
 * public flag), never deleted, and the app's records stay (DECISIONS #22).
 * Null when there was no projection.
 */
async function remove(installId) {
    let existing;
    try {
        existing = await rowByInstall(installId);
    } catch (err) {
        if (err.code === 'not_configured') return null;
        throw err;
    }
    if (!existing) return null;
    const settings = { ...(isObj(existing.settings) ? existing.settings : {}), showOnPublic: false };
    const { error } = await supabase.from(TABLE)
        .update({ enabled: false, settings, updated_at: nowIso() })
        .eq('install_id', installId);
    if (error) throw new Error(error.message);
    return { disabled: true };
}

/**
 * The projection of one live install: the install must be active and the
 * app enabled. Resolves { instance, install } or null.
 */
async function liveInstance(installId) {
    const { data: install, error } = await supabase
        .from('nextgent_installs')
        .select('install_id, company_id, entity_slug, item_key, kind, version, permissions, status')
        .eq('install_id', String(installId))
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!install || install.status !== 'active' || install.kind !== 'app') return null;
    const row = await rowByInstall(install.install_id);
    if (!row || row.enabled === false || row.entity_slug !== install.entity_slug) return null;
    return { instance: fromRow(row), install };
}

/* ── one business's apps ──────────────────────────────────────────────── */

/**
 * Paperclip's rows for one business, in sort order. `publicOnly` keeps the
 * enabled ones whose public flag is on, with only the public settings.
 */
async function listForSlug(slug, { publicOnly = false } = {}) {
    let q = supabase.from(TABLE).select('*').eq('entity_slug', slug).eq('managed_by', MANAGED_BY);
    if (publicOnly) q = q.eq('enabled', true);
    const { data, error } = await q.order('sort_order', { ascending: true }).order('module_key', { ascending: true });
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
    return (data || [])
        .map(fromRow)
        .filter((i) => !publicOnly || i.public_enabled)
        .map((i) => rowShape(i, { publicOnly }));
}

/** One of this business's Paperclip rows by install id, as a row, or null. */
async function ownedRow(slug, installId) {
    const { data, error } = await supabase.from(TABLE).select('*')
        .eq('entity_slug', slug).eq('managed_by', MANAGED_BY).eq('install_id', String(installId)).maybeSingle();
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
    return data || null;
}

/**
 * The owner's switches on one install: any of { renderMode, publicLabel,
 * position, publicEnabled }. `enabled` is Paperclip's and is not here.
 * Resolves to the row shape, or null when the install is not this business's.
 * Throws err.status 400 for a value that is not allowed.
 */
async function updateOwnerFields(slug, installId, { renderMode, publicLabel, position, publicEnabled }) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    const patch = {};
    if (renderMode !== undefined) {
        if (!RENDER_MODES.includes(renderMode)) throw bad(`renderMode must be one of ${RENDER_MODES.join(', ')}.`);
        patch.render_mode = renderMode;
    }
    if (publicLabel !== undefined) {
        if (publicLabel !== null && typeof publicLabel !== 'string') throw bad('publicLabel must be a string or null.');
        patch.public_label = publicLabel === null ? null : publicLabel.trim().slice(0, 120) || null;
    }
    if (position !== undefined) {
        if (!Number.isInteger(position)) throw bad('position must be an integer.');
        patch.sort_order = position;
    }
    if (publicEnabled !== undefined && typeof publicEnabled !== 'boolean') throw bad('publicEnabled must be true or false.');
    if (!Object.keys(patch).length && publicEnabled === undefined) throw bad('Nothing to change.');

    const row = await ownedRow(slug, installId);
    if (!row) return null;
    if (publicEnabled !== undefined) patch.settings = { ...(isObj(row.settings) ? row.settings : {}), showOnPublic: publicEnabled };
    const { data, error } = await supabase.from(TABLE)
        .update({ ...patch, updated_at: nowIso() })
        .eq('id', row.id).eq('entity_slug', slug).eq('managed_by', MANAGED_BY)
        .select('*');
    if (error) throw new Error(error.message);
    if (!data?.length) return null;
    return rowShape(fromRow(data[0]));
}

/**
 * Reorder this business's apps: sort_order = index in `installIds`. Every id
 * must be one of its Paperclip rows (err.status 400 otherwise; nothing moves).
 * Resolves to the owner's list in the new order.
 */
async function reorder(slug, installIds) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!Array.isArray(installIds) || installIds.some((id) => typeof id !== 'string' || !id)) throw bad('Send an array of install ids.');
    if (new Set(installIds).size !== installIds.length) throw bad('An install id is repeated.');
    const { data, error } = await supabase.from(TABLE).select('id, install_id')
        .eq('entity_slug', slug).eq('managed_by', MANAGED_BY);
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
    const byInstall = new Map((data || []).map((r) => [r.install_id, r.id]));
    const strangers = installIds.filter((id) => !byInstall.has(id));
    if (strangers.length) throw bad(`Not an installed app of this business: ${strangers.join(', ')}`);
    for (const [index, installId] of installIds.entries()) {
        const { error: upError } = await supabase.from(TABLE)
            .update({ sort_order: index, updated_at: nowIso() })
            .eq('id', byInstall.get(installId)).eq('entity_slug', slug).eq('managed_by', MANAGED_BY);
        if (upError) throw new Error(upError.message);
    }
    return listForSlug(slug);
}

/* ── settings ─────────────────────────────────────────────────────────── */

/** The settings a manifest declares: [{ key, type, default }]. */
function configSpec(manifest) {
    const config = manifest?.config;
    const keys = configKeys(manifest);
    const specOf = (k) => {
        if (Array.isArray(config)) return config.find((c) => c && c.key === k) || {};
        if (isObj(config?.properties)) return config.properties[k] || {};
        return isObj(config) && isObj(config[k]) ? config[k] : {};
    };
    return keys.map((key) => {
        const s = specOf(key);
        return { key, type: s.type || null, default: s.default };
    });
}

/**
 * The settings as a screen reads them: declared keys only, defaults filled.
 * Secrets are never returned. `only` limits the keys (a public page).
 */
function settingsFor(instance, { only } = {}) {
    const stored = isObj(instance?.config) ? instance.config : {};
    const out = {};
    for (const { key, type, default: def } of configSpec(instance?.manifest)) {
        if (type === 'secret') continue;
        if (only && !only.has(key)) continue;
        if (Object.prototype.hasOwnProperty.call(stored, key)) out[key] = stored[key];
        else if (def !== undefined) out[key] = def;
    }
    return out;
}

/** Save settings: declared keys only; a secret is sealed, and an empty one keeps what is stored. */
async function saveSettings(instance, incoming) {
    const config = { ...(isObj(instance.config) ? instance.config : {}) };
    for (const { key, type } of configSpec(instance.manifest)) {
        if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
        const value = incoming[key];
        if (type === 'secret') {
            if (value === '' || value === null || value === undefined) continue;
            config[key] = secretBox.seal(String(value), SECRET_PURPOSE);
        } else {
            config[key] = value;
        }
    }
    const settings = { ...(isObj(instance.settings) ? instance.settings : {}), config };
    const { error } = await supabase
        .from(TABLE).update({ settings, updated_at: nowIso() }).eq('install_id', instance.install_id);
    if (error) throw new Error(error.message);
    return settingsFor({ ...instance, config });
}

/* ── what a public page shows ─────────────────────────────────────────── */

const PUBLIC_SURFACE_KINDS = ['public'];

/** The views on the manifest's public surfaces. */
function publicViews(manifest) {
    const views = [];
    for (const s of manifest?.surfaces || []) {
        if (!PUBLIC_SURFACE_KINDS.includes(s?.kind) || typeof s.path !== 'string') continue;
        const list = manifest?.ui?.views?.[s.path.slice(1)];
        if (Array.isArray(list)) views.push(...list.filter(isObj));
    }
    return views;
}

/** Sources public views read (and the sources their select options come from). */
function publicSources(manifest) {
    const sources = manifest?.ui?.sources || {};
    const out = new Set();
    for (const v of publicViews(manifest)) {
        if (!v.source || !sources[v.source]) continue;
        out.add(v.source);
        for (const f of sources[v.source].fields || []) if (f?.optionsFrom && sources[f.optionsFrom.source]) out.add(f.optionsFrom.source);
    }
    return [...out];
}

/** Setting keys a public view or the format refers to ({ setting: key }), anywhere in them. */
function publicSettingKeys(manifest) {
    const keys = new Set();
    const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!isObj(v)) return;
        if (typeof v.setting === 'string') keys.add(v.setting);
        Object.values(v).forEach(walk);
    };
    walk(publicViews(manifest));
    walk(manifest?.ui?.format);
    return keys;
}

/** The public form views that write to this app table (for openWhen). */
function publicFormsFor(manifest, table) {
    const sources = manifest?.ui?.sources || {};
    return publicViews(manifest).filter((v) => v.type === 'form' && sources[v.source]?.from === 'app' && sources[v.source].table === table);
}

module.exports = {
    MANAGED_BY,
    RENDER_MODES,
    project,
    remove,
    liveInstance,
    listForSlug,
    updateOwnerFields,
    reorder,
    rowShape,
    configSpec,
    settingsFor,
    saveSettings,
    publicViews,
    publicSources,
    publicSettingKeys,
    publicFormsFor,
    notSetUp,
    missing,
};
