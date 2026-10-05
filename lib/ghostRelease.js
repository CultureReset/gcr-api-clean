// Use the existing store installations and permission grants for signed box releases.
const crypto = require('crypto');
const { pageAll } = require('./audience');
const entitlements = require('./entitlements');
const supabase = require('../db');

function validateRelease(manifest, kind) {
    const release = manifest?.ghost_release;
    if (!release) return null; // Existing non-device manifests remain valid.
    if (!['map', 'box_release'].includes(kind)) throw new Error('Signed Ghost releases require map or box_release items.');
    if (typeof release.plan !== 'string' || Buffer.byteLength(release.plan) > 512 * 1024) throw new Error('A signed release plan must be a JSON string under 512 KiB.');
    if (typeof release.signature !== 'string' || release.signature.length > 16384 || !release.signature.startsWith('-----BEGIN SSH SIGNATURE-----')) throw new Error('An SSH release signature is required.');
    let plan;
    try { plan = JSON.parse(release.plan); } catch { throw new Error('The signed release plan is not JSON.'); }
    if (plan?.schema_version !== 1 || !Array.isArray(plan.modules) || !plan.modules.length) throw new Error('The release must contain schema_version 1 modules.');
    const ids = new Set();
    for (const module of plan.modules) {
        if (!module || !/^[a-z0-9][a-z0-9._-]*$/.test(module.id) || ids.has(module.id)) throw new Error('Release module IDs must be valid and unique.');
        ids.add(module.id);
        if (typeof module.repo !== 'string' || !module.repo.trim() || typeof module.ref !== 'string' || !module.ref.trim() || !/^[a-f0-9]{40}$/.test(module.commit)) throw new Error('Every release module must name a repository, ref and pinned commit.');
    }
    if (kind === 'map' && !ids.has('nextgent-maps')) throw new Error('A map release must contain nextgent-maps.');
    return { plan: release.plan, signature: release.signature, sha256: crypto.createHash('sha256').update(release.plan).digest('hex') };
}

async function releasesFor(slug) {
    const installs = await pageAll(() => supabase.from('store_installs').select('*').eq('entity_slug', slug).eq('status', 'installed').order('id'));
    if (!installs.length) return [];
    const ids = [...new Set(installs.map(row => row.item_id))];
    const items = await pageAll(() => supabase.from('store_items').select('*').in('id', ids).in('kind', ['map', 'box_release']).order('id'));
    if (!items.length) return [];
    const versions = await pageAll(() => supabase.from('store_versions').select('*').in('item_id', items.map(row => row.id)).order('id'));
    const context = await entitlements.contextFor(slug);
    const releases = [];
    for (const item of items) {
        if (!context.decide(item).ok) continue;
        const install = installs.find(row => row.item_id === item.id);
        const version = versions.find(row => row.item_id === item.id && row.version === install.version);
        if (!version || entitlements.newPermissions(install.granted_permissions, version.permissions).length) continue;
        const signed = validateRelease(version.manifest, item.kind);
        if (signed) releases.push({ item_id: item.id, key: item.key, kind: item.kind, version: version.version, semver: version.semver, ...signed });
    }
    if (new Set(releases.map(row => row.sha256)).size > 1) {
        const error = new Error('Conflicting installed Ghost release plans; choose one desired release before updating.');
        error.status = 409;
        throw error;
    }
    return releases;
}
module.exports = { validateRelease, releasesFor };
