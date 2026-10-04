// ============================================================
// APP INSTANCES — the runtime projection of installed apps (CONTRACT §14)
// ============================================================
//
// Paperclip is the authority for what is installed, at which version, enabled
// and entitled. gcr-api-clean keeps a projection of each installed app in
// business_app_instances (sql/nextgent_apps.sql) so a public page, and the
// app's own screens, render without calling Paperclip per visit:
//
//   install_id, entity_slug, company_id, app_key, version, enabled,
//   public_enabled, render_mode, public_label, config (the app's settings),
//   position, manifest (Paperclip's store version payload.app, kept whole)
//
// Written by routes/nextgent.js (install, update, uninstall, unlink); read by
// routes/app-data.js. The app's own records are in app_records, scoped by the
// install and the business. Table and column guards: lib/businessTables.js.

const supabase = require('../db');
const secretBox = require('./secretBox');
const { configKeys } = require('./storeManifest');

const SECRET_PURPOSE = 'app-setting';
const nowIso = () => new Date().toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (error) => /business_app_instances|app_records/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);

function notSetUp() {
    return Object.assign(new Error('Apps are not set up on this database yet (apply sql/nextgent_apps.sql, see sql/ORDER.md).'), { status: 503, code: 'not_configured' });
}

/** Create or refresh an install's projection. Fields left undefined keep what is stored. */
async function project({ installId, companyId, slug, itemKey, version, manifest, enabled }) {
    const { data: existing, error: readError } = await supabase
        .from('business_app_instances').select('install_id').eq('install_id', installId).maybeSingle();
    if (readError) throw missing(readError) ? notSetUp() : new Error(readError.message);
    const row = {
        install_id: installId,
        company_id: companyId,
        entity_slug: slug,
        app_key: itemKey,
        updated_at: nowIso(),
        ...(version !== undefined && version !== null ? { version: String(version) } : {}),
        ...(manifest ? { manifest } : {}),
        ...(typeof enabled === 'boolean' ? { enabled } : {}),
    };
    const { error } = existing
        ? await supabase.from('business_app_instances').update(row).eq('install_id', installId)
        : await supabase.from('business_app_instances').insert({ enabled: true, config: {}, ...row });
    if (error) throw missing(error) ? notSetUp() : new Error(error.message);
}

/**
 * Uninstalled: both surfaces go. The projection is switched off (kept, like
 * the install row), and the app's records are deleted when its manifest says
 * data.delete_on_uninstall. Null when there was no projection.
 */
async function remove(installId) {
    const { data, error } = await supabase
        .from('business_app_instances')
        .update({ enabled: false, public_enabled: false, updated_at: nowIso() })
        .eq('install_id', installId)
        .select('install_id, manifest');
    if (error) {
        if (missing(error)) return null;
        throw new Error(error.message);
    }
    if (!data?.length) return null;
    let recordsDeleted = 0;
    if (data[0].manifest?.data?.delete_on_uninstall === true) {
        const { data: gone, error: delError } = await supabase.from('app_records').delete().eq('install_id', installId).select('id');
        if (delError && !missing(delError)) throw new Error(delError.message);
        recordsDeleted = (gone || []).length;
    }
    return { disabled: true, recordsDeleted };
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
    const { data: instance, error: instError } = await supabase
        .from('business_app_instances').select('*').eq('install_id', install.install_id).maybeSingle();
    if (instError) throw missing(instError) ? notSetUp() : new Error(instError.message);
    if (!instance || instance.enabled === false || instance.entity_slug !== install.entity_slug) return null;
    return { instance, install };
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
    const { error } = await supabase
        .from('business_app_instances').update({ config, updated_at: nowIso() }).eq('install_id', instance.install_id);
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
    project,
    remove,
    liveInstance,
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
