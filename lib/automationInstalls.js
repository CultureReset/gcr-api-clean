// ============================================================
// AUTOMATION INSTALLS — the one code path that puts an automation on a business
// ============================================================
//
// An automation reaches a business's entity_automations in two ways, and both
// come through here:
//
//   the store       POST /api/nextgent/installs, kind "automation" — the owner
//                   installed it from Paperclip's store (CONTRACT §4). The
//                   store item's key is the automation's key.
//   a rollout       POST /api/admin/automations/:id/deploy — the operator
//                   moves a published version out to a chosen audience
//                   (routes/automations.js, the builder).
//
// Existing installs keep their settings and their on/off state; only the
// version moves — unless the caller asks for them to be switched on (a store
// install is the owner choosing it again). New installs get a fresh hook
// token. Uninstalling from the store switches the install off; its settings
// and run history stay.

const supabase = require('../db');
const engine = require('./automationEngine');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const CHUNK = 500;

/** The automation whose key is this store item's key, or null. */
async function automationByKey(key) {
    const { data, error } = await supabase.from('automations').select('*').eq('key', String(key || '')).maybeSingle();
    if (error) throw httpError(503, `Automations are not set up on this database yet: ${error.message}`);
    return data || null;
}

/**
 * Which published version a store install gets: the one named when it is a
 * version this automation has, else the latest published.
 */
async function versionFor(automation, requested) {
    if (!automation || automation.status === 'archived') throw httpError(409, 'That automation is not available.');
    if (!automation.version) throw httpError(409, 'That automation has no published version yet.');
    const n = Number(requested);
    if (requested == null || requested === '' || !Number.isInteger(n) || n <= 0) return automation.version;
    const { data } = await supabase.from('automation_versions').select('version')
        .eq('automation_id', automation.id).eq('version', n).maybeSingle();
    if (!data) throw httpError(409, `There is no version ${n} of that automation.`);
    return n;
}

/**
 * Install (or move to `version`) one automation for each slug.
 *
 * @param {object}   o
 * @param {object}   o.automation      the automations row
 * @param {number}   o.version         a published version
 * @param {string[]} o.slugs
 * @param {boolean}  [o.enabled]       on/off for NEW installs (default on)
 * @param {boolean}  [o.enableExisting] also switch existing installs on (store installs)
 * @param {string}   [o.deploymentId]  the automation_deployments row, for a rollout
 * @returns {Promise<{installed, updated, failed, fresh: string[]}>}
 */
async function installAutomation({ automation, version, slugs, enabled = true, enableExisting = false, deploymentId = null }) {
    let installed = 0;
    let updated = 0;
    let failed = 0;
    const fresh = [];
    const now = new Date().toISOString();

    for (let i = 0; i < slugs.length; i += CHUNK) {
        const chunk = slugs.slice(i, i + CHUNK);
        const { data: existing } = await supabase
            .from('entity_automations')
            .select('entity_slug')
            .eq('automation_id', automation.id)
            .in('entity_slug', chunk);
        const have = new Set((existing || []).map((r) => r.entity_slug));

        const newSlugs = chunk.filter((s) => !have.has(s));
        const known = chunk.filter((s) => have.has(s));

        if (newSlugs.length) {
            const { error } = await supabase.from('entity_automations').insert(newSlugs.map((slug) => ({
                entity_slug: slug,
                automation_id: automation.id,
                version,
                enabled: enabled !== false,
                config: {},
                hook_token: engine.newHookToken(),
                deployment_id: deploymentId,
                installed_at: now,
                updated_at: now,
            })));
            if (error) failed += newSlugs.length;
            else { installed += newSlugs.length; fresh.push(...newSlugs); }
        }
        if (known.length) {
            const patch = { version, updated_at: now };
            if (deploymentId) patch.deployment_id = deploymentId;
            if (enableExisting) patch.enabled = true;
            const { error } = await supabase
                .from('entity_automations')
                .update(patch)
                .eq('automation_id', automation.id)
                .in('entity_slug', known);
            if (error) failed += known.length;
            else updated += known.length;
        }
    }
    return { installed, updated, failed, fresh };
}

/** Switch one business's install off (a store uninstall). Returns how many rows changed. */
async function disableAutomation({ automationId, slug }) {
    const { data, error } = await supabase.from('entity_automations')
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq('automation_id', automationId).eq('entity_slug', slug)
        .select('id');
    if (error) throw httpError(500, error.message);
    return (data || []).length;
}

/**
 * The store path: install the automation whose key is `itemKey` for one
 * business, switched on. Throws (err.status) if there is nothing to install.
 */
async function installFromStore({ itemKey, slug, version }) {
    const automation = await automationByKey(itemKey);
    if (!automation) throw httpError(409, `No automation has the key ${itemKey}.`);
    const v = await versionFor(automation, version);
    const result = await installAutomation({ automation, version: v, slugs: [slug], enabled: true, enableExisting: true });
    if (result.failed) throw httpError(500, 'The automation could not be installed.');
    if (result.fresh.length && automation.trigger?.type === 'event' && automation.trigger?.event === 'automation.installed') {
        await engine.emitEvent('automation.installed', slug, { version: v });
    }
    return { automation, version: v, ...result };
}

/** The store path, removing: switch the install off. */
async function uninstallFromStore({ itemKey, slug }) {
    const automation = await automationByKey(itemKey);
    if (!automation) return 0;
    return disableAutomation({ automationId: automation.id, slug });
}

module.exports = {
    automationByKey,
    versionFor,
    installAutomation,
    disableAutomation,
    installFromStore,
    uninstallFromStore,
};
