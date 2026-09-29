// What a published store version must look like. Pure: no database.
//
// Apps follow the cybercheck-marketplace app-manifest v1 contract
// (contract/app-manifest.v1.json): schema_version, id, name, version,
// publisher and runtime are required there. The store fills the four it
// already knows (id from the item key, name, version from the semver being
// published, publisher from the item) so the operator only supplies what is
// actually about the app. Other kinds (maps, parsers, box releases, modules)
// carry their own manifest shape; the store keeps it whole and reads only
// `permissions` and `config` from it.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function permissionIds(list) {
    if (!Array.isArray(list)) return [];
    const ids = list
        .map((p) => (typeof p === 'string' ? p : p && (p.id || p.name || p.key)))
        .filter((p) => typeof p === 'string' && p.trim())
        .map((p) => p.trim());
    return [...new Set(ids)].sort();
}

/** The setting keys a version declares; anything else a business sends is dropped. */
function configKeys(manifest) {
    const config = manifest?.config;
    if (Array.isArray(config)) return config.map((c) => c && c.key).filter(Boolean);
    if (config && typeof config === 'object') {
        if (config.properties && typeof config.properties === 'object') return Object.keys(config.properties);
        return Object.keys(config);
    }
    return [];
}

/**
 * @returns {{ ok: true, manifest, permissions } | { ok: false, error }}
 */
function prepareVersion(item, { semver, manifest }) {
    if (typeof semver !== 'string' || !SEMVER.test(semver.trim())) {
        return { ok: false, error: 'semver must look like 1.2.3.' };
    }
    const v = semver.trim();
    if (manifest !== undefined && (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))) {
        return { ok: false, error: 'manifest must be an object.' };
    }
    const m = { ...(manifest || {}) };
    if (m.version !== undefined && m.version !== v) {
        return { ok: false, error: `manifest.version (${m.version}) does not match ${v}.` };
    }
    if (item.kind === 'app') {
        m.schema_version = m.schema_version || 1;
        m.id = m.id || item.key;
        m.name = m.name || item.name;
        m.publisher = m.publisher || item.publisher;
        if (m.id !== item.key) return { ok: false, error: `manifest.id (${m.id}) must be the item key (${item.key}).` };
        if (!m.runtime || typeof m.runtime !== 'object') {
            return { ok: false, error: 'An app manifest needs a runtime (how its code runs), per app-manifest v1.' };
        }
    }
    m.version = v;
    return { ok: true, manifest: m, permissions: permissionIds(m.permissions) };
}

module.exports = { SEMVER, prepareVersion, permissionIds, configKeys };
