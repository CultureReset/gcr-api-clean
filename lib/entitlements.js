// ============================================================
// ENTITLEMENTS — may this business have this store item?
// ============================================================
//
// One copy of the rule, used by the operator's store routes and the business's
// store routes alike (routes/store.js). A security check that exists twice
// drifts until one has a hole.
//
// A business may have an item when the item is published AND one of:
//
//   free    the item's access is 'free': every business
//   grant   the operator granted it to this business, and the grant is live
//           (not revoked, not expired)
//   plan    the item's access is 'plan' and the business's plan includes it
//
// An item whose access is 'grant' is reached by grant only.
//
// The business's plan is its billing_subscription row, or the default plan
// when it has none. Until sql/billing.sql is applied there are no plans, and
// only free items and grants are reachable; that is reported, not guessed.
//
// Which version a business sees: the one released to everyone, or a later
// one offered to it early (a staged rollout), whichever is newer.

const supabase = require('../db');

const missingTable = (error) => /(does not exist|schema cache)/i.test(error?.message || '');

/* ── the pure part: no database, no clock of its own ─────────────────── */

function grantIsLive(grant, now) {
    if (!grant || grant.revoked_at) return false;
    return !grant.expires_at || new Date(grant.expires_at).getTime() > now.getTime();
}

/**
 * @returns {{ ok: boolean, reason: 'free'|'grant'|'plan'|'unpublished'|'not_entitled' }}
 */
function decide({ item, planItemIds, grant, now = new Date() }) {
    if (!item || item.status !== 'published') return { ok: false, reason: 'unpublished' };
    if (item.access === 'free') return { ok: true, reason: 'free' };
    if (grantIsLive(grant, now)) return { ok: true, reason: 'grant' };
    if (item.access === 'plan' && planItemIds && planItemIds.has(item.id)) return { ok: true, reason: 'plan' };
    return { ok: false, reason: 'not_entitled' };
}

/** The version this business is offered: released to all, or offered early to it. */
function availableVersion(item, install) {
    const released = item?.released_version || 0;
    const offered = install?.offered_version || 0;
    const best = Math.max(released, offered);
    return best > 0 ? best : null;
}

/** Permissions a version asks for that the business has not accepted. */
function newPermissions(granted, needed) {
    const have = new Set(granted || []);
    return (needed || []).filter((p) => !have.has(p));
}

/* ── the loaders ─────────────────────────────────────────────────────── */

async function defaultPlanKey() {
    const { data, error } = await supabase.from('billing_plan').select('key').eq('is_default', true).maybeSingle();
    if (error) {
        if (missingTable(error)) return null;
        throw new Error(error.message);
    }
    return data?.key || null;
}

/** The plan each business is on: its active subscription, else the default. */
async function planKeysFor(slugs) {
    const plans = new Map();
    if (!slugs.length) return plans;
    const fallback = await defaultPlanKey();
    for (let i = 0; i < slugs.length; i += 500) {
        const chunk = slugs.slice(i, i + 500);
        const { data, error } = await supabase
            .from('billing_subscription')
            .select('entity_slug, plan_key, status')
            .in('entity_slug', chunk);
        if (error && !missingTable(error)) throw new Error(error.message);
        for (const row of data || []) {
            if (row.status === 'active' || row.status === 'trialing') plans.set(row.entity_slug, row.plan_key);
        }
    }
    for (const slug of slugs) if (!plans.has(slug) && fallback) plans.set(slug, fallback);
    return plans;
}

/** plan_key -> Set(item_id), for the plans given. */
async function planItems(planKeys) {
    const keys = [...new Set(planKeys.filter(Boolean))];
    const out = new Map(keys.map((k) => [k, new Set()]));
    if (!keys.length) return out;
    const { data, error } = await supabase.from('store_plan_items').select('plan_key, item_id').in('plan_key', keys);
    if (error && !missingTable(error)) throw new Error(error.message);
    for (const row of data || []) out.get(row.plan_key)?.add(row.item_id);
    return out;
}

/** Live grants: Map(`${slug}|${item_id}` -> grant). */
async function liveGrants({ slugs, itemIds }) {
    let query = supabase.from('store_grants').select('id, entity_slug, item_id, expires_at, revoked_at, note').is('revoked_at', null);
    if (slugs) query = query.in('entity_slug', slugs);
    if (itemIds) query = query.in('item_id', itemIds);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const now = new Date();
    const out = new Map();
    for (const g of data || []) if (grantIsLive(g, now)) out.set(`${g.entity_slug}|${g.item_id}`, g);
    return out;
}

/** Everything needed to decide for one business, across every item. */
async function contextFor(slug) {
    const plans = await planKeysFor([slug]);
    const planKey = plans.get(slug) || null;
    const items = await planItems([planKey]);
    const grants = await liveGrants({ slugs: [slug] });
    return {
        planKey,
        decide: (item) => decide({
            item,
            planItemIds: items.get(planKey) || new Set(),
            grant: grants.get(`${slug}|${item.id}`),
        }),
    };
}

/** Which of these businesses may have this item. Map(slug -> decision). */
async function decideMany(item, slugs) {
    const plans = await planKeysFor(slugs);
    const items = await planItems([...plans.values()]);
    const grants = await liveGrants({ slugs, itemIds: [item.id] });
    const out = new Map();
    for (const slug of slugs) {
        out.set(slug, decide({
            item,
            planItemIds: items.get(plans.get(slug)) || new Set(),
            grant: grants.get(`${slug}|${item.id}`),
        }));
    }
    return out;
}

module.exports = {
    decide,
    grantIsLive,
    availableVersion,
    newPermissions,
    contextFor,
    decideMany,
    planKeysFor,
};
