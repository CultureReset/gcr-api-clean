// ============================================================
// THE STORE — the operator ships, businesses get what they are entitled to
// ============================================================
//
// Two routers, one rule (lib/entitlements.js):
//
//   admin   /api/admin/store   add an item, publish a version, choose who may
//                              have it (plans, grants), push it (release, offer
//                              early, install, force), roll back, see who is on
//                              what. adminRequired.
//   owner   /api/store         what this business may have, what it has, and
//                              "update available". ownerRequired: the business
//                              is the session's, never a slug in the request.
//
// ── Pushing a version ───────────────────────────────────────────────────
//
//   publish     version N exists. Nothing moves yet.
//   release     every entitled business sees N as available. Installed ones
//               get "update available" and choose when.
//   offer       only the audience sees N early: a staged rollout, or a pilot
//               of a new item before it is released to all.
//   install     put N on the audience's dashboards for them.
//   force       move the audience's installs to N now (a security fix, or a
//               rollback: force an older N).
//
// A push only ever reaches businesses entitled to the item; the rest are
// counted as skipped. A version that asks for permissions a business has not
// accepted is never forced on it: the business is offered it instead and
// accepts or not. Access is never widened without the business saying yes.

const express = require('express');
const supabase = require('../db');
const { adminRequired } = require('../middleware/auth');
const { ownerRequired } = require('../middleware/ownerAuth');
const { pageAll, resolveAudience, industries } = require('../lib/audience');
const ent = require('../lib/entitlements');
const { prepareVersion, configKeys } = require('../lib/storeManifest');
const { validateRelease } = require('../lib/ghostRelease');

const router = express.Router();
const ownerRouter = express.Router();

const KINDS = ['app', 'module', 'map', 'parser', 'automation', 'box_release', 'integration'];
const ACCESS = ['free', 'plan', 'grant'];
const ACTIONS = ['release', 'offer', 'install', 'force'];
const ITEM_FIELDS = ['name', 'summary', 'description', 'icon', 'category', 'access', 'publisher'];

const fail = (res, code, message, extra) => res.status(code).json({ error: message, ...(extra || {}) });
const missingTable = (error) => /(does not exist|schema cache)/i.test(error?.message || '');
const dbFail = (res, error) => (missingTable(error)
    ? fail(res, 501, 'The store is not set up on this database yet (run sql/billing.sql, then sql/store.sql).')
    : fail(res, 500, error.message));
const nowIso = () => new Date().toISOString();

async function loadItem(id) {
    const { data, error } = await supabase.from('store_items').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
}

async function loadVersion(itemId, version) {
    const { data, error } = await supabase
        .from('store_versions')
        .select('version, semver, manifest, permissions, changelog, published_at')
        .eq('item_id', itemId)
        .eq('version', version)
        .maybeSingle();
    if (error) throw error;
    return data;
}

/* ════════════════════════════════════════════════════════════════════════
 *  ADMIN
 * ════════════════════════════════════════════════════════════════════════ */

router.get('/meta', adminRequired, async (_req, res) => {
    try {
        res.json({ kinds: KINDS, access: ACCESS, actions: ACTIONS, industries: await industries() });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.get('/items', adminRequired, async (_req, res) => {
    try {
        const { data: items, error } = await supabase.from('store_items').select('*').neq('status', 'archived').order('name');
        if (error) return dbFail(res, error);
        const installs = await pageAll(() => supabase.from('store_installs').select('item_id, status').order('id'));
        const counts = new Map();
        for (const row of installs) {
            const c = counts.get(row.item_id) || { installed: 0, offered: 0 };
            if (row.status === 'installed' || row.status === 'disabled') c.installed += 1;
            if (row.status === 'offered') c.offered += 1;
            counts.set(row.item_id, c);
        }
        res.json({ items: (items || []).map((i) => ({ ...i, installs: counts.get(i.id) || { installed: 0, offered: 0 } })) });
    } catch (err) {
        dbFail(res, err);
    }
});

router.post('/items', adminRequired, async (req, res) => {
    const b = req.body || {};
    const key = String(b.key || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key)) return fail(res, 400, 'key: lowercase letters, digits, . _ -, 2 to 80 characters.');
    if (!KINDS.includes(b.kind)) return fail(res, 400, `kind must be one of ${KINDS.join(', ')}.`);
    if (b.access !== undefined && !ACCESS.includes(b.access)) return fail(res, 400, `access must be one of ${ACCESS.join(', ')}.`);
    if (!String(b.name || '').trim()) return fail(res, 400, 'name is required.');
    const row = { key, kind: b.kind, created_by: req.userId || null };
    for (const f of ITEM_FIELDS) if (b[f] !== undefined) row[f] = typeof b[f] === 'string' ? b[f].trim() : b[f];
    const { data, error } = await supabase.from('store_items').insert(row).select().single();
    if (error) return /duplicate|unique/i.test(error.message) ? fail(res, 409, `An item with key ${key} exists.`) : dbFail(res, error);
    res.status(201).json({ item: data });
});

router.get('/items/:id', adminRequired, async (req, res) => {
    try {
        const item = await loadItem(req.params.id);
        if (!item) return fail(res, 404, 'No such item.');
        const [versions, plans, deployments] = await Promise.all([
            supabase.from('store_versions').select('version, semver, permissions, changelog, published_at').eq('item_id', item.id).order('version', { ascending: false }),
            supabase.from('store_plan_items').select('plan_key').eq('item_id', item.id),
            supabase.from('store_deployments').select('*').eq('item_id', item.id).order('created_at', { ascending: false }).limit(20),
        ]);
        res.json({
            item,
            versions: versions.data || [],
            plans: (plans.data || []).map((p) => p.plan_key),
            deployments: deployments.data || [],
        });
    } catch (err) {
        dbFail(res, err);
    }
});

router.put('/items/:id', adminRequired, async (req, res) => {
    const b = req.body || {};
    if (b.access !== undefined && !ACCESS.includes(b.access)) return fail(res, 400, `access must be one of ${ACCESS.join(', ')}.`);
    const patch = { updated_at: nowIso() };
    for (const f of ITEM_FIELDS) if (b[f] !== undefined) patch[f] = typeof b[f] === 'string' ? b[f].trim() : b[f];
    if (b.status === 'archived' || b.status === 'published') patch.status = b.status;
    const { data, error } = await supabase.from('store_items').update(patch).eq('id', req.params.id).select().maybeSingle();
    if (error) return dbFail(res, error);
    if (!data) return fail(res, 404, 'No such item.');
    res.json({ item: data });
});

/** Publish version N+1. Nothing reaches a business until it is pushed. */
router.post('/items/:id/versions', adminRequired, async (req, res) => {
    try {
        const item = await loadItem(req.params.id);
        if (!item) return fail(res, 404, 'No such item.');
        if (item.status === 'archived') return fail(res, 409, 'This item is archived.');
        const prepared = prepareVersion(item, req.body || {});
        if (!prepared.ok) return fail(res, 400, prepared.error);
        try { validateRelease(prepared.manifest, item.kind); } catch (err) { return fail(res, 400, err.message); }
        const version = (item.latest_version || 0) + 1;
        const { data, error } = await supabase.from('store_versions').insert({
            item_id: item.id,
            version,
            semver: prepared.manifest.version,
            manifest: prepared.manifest,
            permissions: prepared.permissions,
            changelog: req.body?.changelog ? String(req.body.changelog) : null,
            published_by: req.userId || null,
        }).select('version, semver, permissions, changelog, published_at').single();
        if (error) return /duplicate|unique/i.test(error.message) ? fail(res, 409, `${prepared.manifest.version} is already published.`) : dbFail(res, error);
        await supabase.from('store_items').update({ latest_version: version, status: 'published', updated_at: nowIso() }).eq('id', item.id);
        res.status(201).json({ version: data });
    } catch (err) {
        dbFail(res, err);
    }
});

/**
 * Work out a push without writing it. Returns, per business in the audience,
 * what would happen: apply, skip (not entitled / already there / needs the
 * business's consent), and why.
 */
async function planPush(item, target, action, audience) {
    if (action === 'release') return { slugs: [], plan: [] };
    const slugs = await resolveAudience(audience || { mode: 'owners' });
    const decisions = await ent.decideMany(item, slugs);
    const installs = new Map();
    for (let i = 0; i < slugs.length; i += 500) {
        const { data, error } = await supabase
            .from('store_installs')
            .select('id, entity_slug, version, offered_version, status, granted_permissions')
            .eq('item_id', item.id)
            .in('entity_slug', slugs.slice(i, i + 500));
        if (error) throw error;
        for (const row of data || []) installs.set(row.entity_slug, row);
    }
    const plan = slugs.map((slug) => {
        const d = decisions.get(slug);
        const row = installs.get(slug) || null;
        if (!d.ok) return { slug, do: 'skip', why: d.reason };
        const has = row && (row.status === 'installed' || row.status === 'disabled');
        if (action === 'offer') {
            if (has && row.version >= target.version) return { slug, do: 'skip', why: 'already_on_it' };
            return { slug, do: row ? 'offer' : 'offer_new', row };
        }
        if (action === 'install') {
            if (has) return { slug, do: 'skip', why: 'already_installed' };
            if (['map', 'box_release'].includes(item.kind) && ent.newPermissions(row?.granted_permissions, target.permissions).length) {
                return { slug, do: row ? 'offer' : 'offer_new', row, why: 'needs_consent' };
            }
            return { slug, do: row ? 'install_existing' : 'install_new', row };
        }
        // force
        if (!has) return { slug, do: 'skip', why: 'not_installed' };
        if (row.version === target.version) return { slug, do: 'skip', why: 'already_on_it' };
        if (ent.newPermissions(row.granted_permissions, target.permissions).length) {
            return { slug, do: 'offer', row, why: 'needs_consent' };
        }
        return { slug, do: 'force', row };
    });
    return { slugs, plan };
}

function summarize(plan) {
    const out = { targeted: plan.length, apply: 0, skip: 0, needs_consent: 0, reasons: {} };
    for (const p of plan) {
        if (p.do === 'skip') {
            out.skip += 1;
            out.reasons[p.why] = (out.reasons[p.why] || 0) + 1;
        } else {
            out.apply += 1;
            if (p.why === 'needs_consent') out.needs_consent += 1;
        }
    }
    return out;
}

async function readPushInput(req, res) {
    const item = await loadItem(req.params.id);
    if (!item) return fail(res, 404, 'No such item.') && null;
    const action = req.body?.action;
    if (!ACTIONS.includes(action)) return fail(res, 400, `action must be one of ${ACTIONS.join(', ')}.`) && null;
    const version = Number(req.body?.version || item.latest_version);
    const target = version ? await loadVersion(item.id, version) : null;
    if (!target) return fail(res, 400, 'Publish a version before pushing it.') && null;
    return { item, action, target, audience: req.body?.audience || { mode: 'owners' } };
}

router.post('/items/:id/deploy/preview', adminRequired, async (req, res) => {
    try {
        const input = await readPushInput(req, res);
        if (!input) return;
        const { plan } = await planPush(input.item, input.target, input.action, input.audience);
        res.json({ action: input.action, version: input.target.version, semver: input.target.semver, ...summarize(plan) });
    } catch (err) {
        dbFail(res, err);
    }
});

router.post('/items/:id/deploy', adminRequired, async (req, res) => {
    try {
        const input = await readPushInput(req, res);
        if (!input) return;
        const { item, action, target, audience } = input;
        const { data: dep, error: depError } = await supabase.from('store_deployments').insert({
            item_id: item.id,
            version: target.version,
            action,
            audience: action === 'release' ? { mode: 'all' } : audience,
            notes: req.body?.notes ? String(req.body.notes) : null,
            created_by: req.userId || null,
        }).select().single();
        if (depError) return dbFail(res, depError);

        if (action === 'release') {
            const { error } = await supabase.from('store_items').update({ released_version: target.version, status: 'published', updated_at: nowIso() }).eq('id', item.id);
            const { data: done } = await supabase.from('store_deployments').update({
                status: error ? 'failed' : 'done', finished_at: nowIso(),
            }).eq('id', dep.id).select().single();
            return error ? dbFail(res, error) : res.json({ deployment: done || dep });
        }

        const { plan } = await planPush(item, target, action, audience);
        let applied = 0;
        let failed = 0;
        const now = nowIso();
        for (const p of plan) {
            if (p.do === 'skip') continue;
            let result;
            if (p.do === 'offer_new') {
                result = await supabase.from('store_installs').insert({
                    entity_slug: p.slug, item_id: item.id, version: target.version, offered_version: target.version,
                    status: 'offered', deployment_id: dep.id, installed_at: now, updated_at: now,
                });
            } else if (p.do === 'offer') {
                result = await supabase.from('store_installs').update({ offered_version: target.version, deployment_id: dep.id, updated_at: now }).eq('id', p.row.id);
            } else if (p.do === 'install_new') {
                result = await supabase.from('store_installs').insert({
                    entity_slug: p.slug, item_id: item.id, version: target.version, status: 'installed',
                    granted_permissions: target.permissions || [], deployment_id: dep.id,
                    installed_by: req.userId || null, installed_at: now, updated_at: now,
                });
            } else if (p.do === 'install_existing') {
                result = await supabase.from('store_installs').update({
                    version: target.version, status: 'installed', granted_permissions: target.permissions || [],
                    offered_version: null, deployment_id: dep.id, installed_by: req.userId || null, updated_at: now,
                }).eq('id', p.row.id);
            } else if (p.do === 'force') {
                result = await supabase.from('store_installs').update({
                    version: target.version, offered_version: null, deployment_id: dep.id, updated_at: now,
                }).eq('id', p.row.id);
            }
            if (result?.error) failed += 1;
            else applied += 1;
        }
        const s = summarize(plan);
        const { data: done } = await supabase.from('store_deployments').update({
            targeted: s.targeted, applied, skipped: s.skip, failed,
            status: failed && !applied ? 'failed' : 'done', finished_at: nowIso(),
        }).eq('id', dep.id).select().single();
        res.json({ deployment: done || dep, ...s });
    } catch (err) {
        dbFail(res, err);
    }
});

router.get('/items/:id/installs', adminRequired, async (req, res) => {
    try {
        const rows = await pageAll(() => supabase
            .from('store_installs')
            .select('entity_slug, version, offered_version, status, installed_at, updated_at')
            .eq('item_id', req.params.id)
            .order('entity_slug'));
        res.json({ installs: rows });
    } catch (err) {
        dbFail(res, err);
    }
});

router.get('/deployments/recent', adminRequired, async (_req, res) => {
    const { data, error } = await supabase.from('store_deployments').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) return dbFail(res, error);
    res.json({ deployments: data || [] });
});

/* ── plans: billing_plan rows, and which items each includes ─────────── */

router.get('/plans', adminRequired, async (_req, res) => {
    const { data: plans, error } = await supabase.from('billing_plan').select('*').order('sort_order');
    if (error) return dbFail(res, error);
    const { data: links, error: linkError } = await supabase.from('store_plan_items').select('plan_key, item_id');
    if (linkError) return dbFail(res, linkError);
    res.json({
        plans: (plans || []).map((p) => ({ ...p, item_ids: (links || []).filter((l) => l.plan_key === p.key).map((l) => l.item_id) })),
    });
});

router.post('/plans', adminRequired, async (req, res) => {
    const b = req.body || {};
    const key = String(b.key || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(key)) return fail(res, 400, 'key: lowercase letters, digits, _ -.');
    if (!String(b.name || '').trim()) return fail(res, 400, 'name is required.');
    const { data, error } = await supabase.from('billing_plan').insert({
        key,
        name: String(b.name).trim(),
        description: b.description || null,
        price_monthly: Number(b.price_monthly || 0),
        is_public: b.is_public !== false,
        sort_order: Number(b.sort_order || 0),
    }).select().single();
    if (error) return /duplicate|unique/i.test(error.message) ? fail(res, 409, `Plan ${key} exists.`) : dbFail(res, error);
    res.status(201).json({ plan: data });
});

router.put('/plans/:key', adminRequired, async (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const f of ['name', 'description', 'is_public', 'sort_order']) if (b[f] !== undefined) patch[f] = b[f];
    if (b.price_monthly !== undefined) patch.price_monthly = Number(b.price_monthly);
    if (Object.keys(patch).length) {
        const { error } = await supabase.from('billing_plan').update(patch).eq('key', req.params.key);
        if (error) return dbFail(res, error);
    }
    if (Array.isArray(b.item_ids)) {
        const wanted = [...new Set(b.item_ids.map(String))];
        const { data: current, error } = await supabase.from('store_plan_items').select('item_id').eq('plan_key', req.params.key);
        if (error) return dbFail(res, error);
        const have = new Set((current || []).map((r) => r.item_id));
        const add = wanted.filter((id) => !have.has(id));
        const drop = [...have].filter((id) => !wanted.includes(id));
        if (add.length) {
            const { error: addError } = await supabase.from('store_plan_items').insert(add.map((item_id) => ({ plan_key: req.params.key, item_id })));
            if (addError) return dbFail(res, addError);
        }
        if (drop.length) {
            const { error: dropError } = await supabase.from('store_plan_items').delete().eq('plan_key', req.params.key).in('item_id', drop);
            if (dropError) return dbFail(res, dropError);
        }
    }
    res.json({ ok: true });
});

/* ── grants: the operator giving a business an item by hand ──────────── */

router.get('/grants', adminRequired, async (req, res) => {
    let query = supabase.from('store_grants').select('*').is('revoked_at', null).order('created_at', { ascending: false }).limit(500);
    if (req.query.item_id) query = query.eq('item_id', req.query.item_id);
    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
    const { data, error } = await query;
    if (error) return dbFail(res, error);
    res.json({ grants: data || [] });
});

router.post('/grants', adminRequired, async (req, res) => {
    try {
        const b = req.body || {};
        const item = b.item_id ? await loadItem(b.item_id) : null;
        if (!item) return fail(res, 400, 'item_id must name an item.');
        const audience = Array.isArray(b.slugs) ? { mode: 'slugs', slugs: b.slugs } : b.audience;
        if (!audience) return fail(res, 400, 'Name the businesses: slugs, or an audience.');
        const slugs = await resolveAudience(audience);
        if (!slugs.length) return fail(res, 400, 'That audience names no business.');
        const { data: existing, error } = await supabase.from('store_grants').select('entity_slug').eq('item_id', item.id).is('revoked_at', null).in('entity_slug', slugs);
        if (error) return dbFail(res, error);
        const have = new Set((existing || []).map((r) => r.entity_slug));
        const fresh = slugs.filter((s) => !have.has(s));
        if (fresh.length) {
            const { error: insertError } = await supabase.from('store_grants').insert(fresh.map((entity_slug) => ({
                entity_slug,
                item_id: item.id,
                note: b.note ? String(b.note) : null,
                expires_at: b.expires_at || null,
                granted_by: req.userId || null,
            })));
            if (insertError) return dbFail(res, insertError);
        }
        res.status(201).json({ granted: fresh.length, already: have.size });
    } catch (err) {
        dbFail(res, err);
    }
});

router.delete('/grants/:id', adminRequired, async (req, res) => {
    const { data, error } = await supabase.from('store_grants').update({ revoked_at: nowIso() }).eq('id', req.params.id).is('revoked_at', null).select('id');
    if (error) return dbFail(res, error);
    if (!data?.length) return fail(res, 404, 'No live grant with that id.');
    res.json({ revoked: true });
});

/* ── one business, as the operator sees it ───────────────────────────── */

router.get('/businesses/:slug', adminRequired, async (req, res) => {
    try {
        const slug = req.params.slug;
        const ctx = await ent.contextFor(slug);
        const { data: items, error } = await supabase.from('store_items').select('*').eq('status', 'published');
        if (error) return dbFail(res, error);
        const { data: installs } = await supabase.from('store_installs').select('item_id, version, offered_version, status').eq('entity_slug', slug);
        const byItem = new Map((installs || []).map((r) => [r.item_id, r]));
        res.json({
            slug,
            plan: ctx.planKey,
            items: (items || []).map((item) => ({
                id: item.id, key: item.key, name: item.name, kind: item.kind,
                entitlement: ctx.decide(item),
                install: byItem.get(item.id) || null,
            })),
        });
    } catch (err) {
        dbFail(res, err);
    }
});

router.put('/businesses/:slug/plan', adminRequired, async (req, res) => {
    const planKey = String(req.body?.plan_key || '').trim();
    if (!planKey) return fail(res, 400, 'plan_key is required.');
    const { data: plan, error: planError } = await supabase.from('billing_plan').select('key').eq('key', planKey).maybeSingle();
    if (planError) return dbFail(res, planError);
    if (!plan) return fail(res, 400, `No plan ${planKey}.`);
    const { error } = await supabase.from('billing_subscription').upsert({
        entity_slug: req.params.slug, plan_key: planKey, status: 'active', provider: 'operator', updated_at: nowIso(),
    }, { onConflict: 'entity_slug' });
    if (error) return dbFail(res, error);
    res.json({ slug: req.params.slug, plan: planKey });
});

/* ════════════════════════════════════════════════════════════════════════
 *  OWNER — the business's own store. Slug from the session only.
 * ════════════════════════════════════════════════════════════════════════ */

/** Everything this business may have or has, with what is available to it. */
async function ownerCatalog(slug) {
    const ctx = await ent.contextFor(slug);
    const { data: items, error } = await supabase.from('store_items').select('*').eq('status', 'published').order('name');
    if (error) throw error;
    const { data: installs, error: installError } = await supabase
        .from('store_installs')
        .select('item_id, version, offered_version, status, granted_permissions, config')
        .eq('entity_slug', slug);
    if (installError) throw installError;
    const byItem = new Map((installs || []).map((r) => [r.item_id, r]));

    const wanted = [];
    for (const item of items || []) {
        const row = byItem.get(item.id);
        const available = ent.availableVersion(item, row);
        const has = row && (row.status === 'installed' || row.status === 'disabled');
        if (available) wanted.push([item.id, available]);
        if (has) wanted.push([item.id, row.version]);
    }
    const versions = new Map();
    if (wanted.length) {
        const ids = [...new Set(wanted.map(([id]) => id))];
        const { data } = await supabase.from('store_versions').select('item_id, version, semver, changelog, permissions, manifest').in('item_id', ids);
        for (const v of data || []) versions.set(`${v.item_id}|${v.version}`, v);
    }

    const out = [];
    for (const item of items || []) {
        const row = byItem.get(item.id) || null;
        const has = row && (row.status === 'installed' || row.status === 'disabled');
        const decision = ctx.decide(item);
        const availableN = ent.availableVersion(item, row);
        // Not entitled and not installed: this business does not see it at all.
        if (!decision.ok && !has) continue;
        if (!availableN && !has) continue;
        const available = availableN ? versions.get(`${item.id}|${availableN}`) || null : null;
        const installed = has ? versions.get(`${item.id}|${row.version}`) || null : null;
        const updateAvailable = !!(has && decision.ok && available && available.version > row.version);
        out.push({
            id: item.id,
            key: item.key,
            kind: item.kind,
            name: item.name,
            summary: item.summary,
            icon: item.icon,
            category: item.category,
            entitled: decision.ok,
            reason: decision.reason,
            installed: has ? {
                version: row.version,
                semver: installed?.semver || null,
                status: row.status,
                config: row.config || {},
                settings: installed ? configKeys(installed.manifest) : [],
            } : null,
            available: available ? {
                version: available.version,
                semver: available.semver,
                changelog: available.changelog,
                permissions: available.permissions || [],
            } : null,
            update_available: updateAvailable,
            new_permissions: updateAvailable ? ent.newPermissions(row.granted_permissions, available.permissions) : [],
        });
    }
    return out;
}

ownerRouter.get('/', ownerRequired, async (req, res) => {
    try {
        const items = await ownerCatalog(req.entitySlug);
        res.json({ items });
    } catch (err) {
        dbFail(res, err);
    }
});

async function ownerTarget(req, res) {
    const item = await loadItem(req.params.itemId);
    if (!item || item.status !== 'published') return fail(res, 404, 'No such item.') && null;
    const ctx = await ent.contextFor(req.entitySlug);
    const decision = ctx.decide(item);
    const { data: row, error } = await supabase
        .from('store_installs')
        .select('id, version, offered_version, status, granted_permissions, config')
        .eq('entity_slug', req.entitySlug)
        .eq('item_id', item.id)
        .maybeSingle();
    if (error) throw error;
    return { item, decision, row };
}

/** Install, or update: both move this business to the version available to it. */
async function takeVersion(req, res, { mustBeInstalled }) {
    try {
        const t = await ownerTarget(req, res);
        if (!t) return;
        const { item, decision, row } = t;
        if (!decision.ok) return fail(res, 403, 'Your plan does not include this.', { reason: decision.reason });
        const has = row && (row.status === 'installed' || row.status === 'disabled');
        if (mustBeInstalled && !has) return fail(res, 409, 'Install it first.');
        if (!mustBeInstalled && has) return fail(res, 409, 'Already installed; use update.');
        const availableN = ent.availableVersion(item, row);
        if (!availableN) return fail(res, 409, 'No version is available to you yet.');
        if (has && availableN <= row.version) return fail(res, 409, 'You already have the latest version.');
        const target = await loadVersion(item.id, availableN);
        if (!target) return fail(res, 409, 'That version is missing.');
        const asks = ent.newPermissions(has ? row.granted_permissions : [], target.permissions);
        if (asks.length && req.body?.accept_permissions !== true) {
            return fail(res, 409, 'This version asks for access you have not given.', { permissions: asks });
        }
        const granted = [...new Set([...(has ? row.granted_permissions || [] : []), ...(target.permissions || [])])].sort();
        const now = nowIso();
        const change = {
            version: target.version,
            status: has ? row.status : 'installed',
            granted_permissions: granted,
            offered_version: row?.offered_version && row.offered_version > target.version ? row.offered_version : null,
            installed_by: req.ownerUserId || null,
            updated_at: now,
        };
        const result = row
            ? await supabase.from('store_installs').update(change).eq('id', row.id).select().single()
            : await supabase.from('store_installs').insert({
                ...change, entity_slug: req.entitySlug, item_id: item.id, installed_at: now,
            }).select().single();
        if (result.error) return dbFail(res, result.error);
        res.json({ install: { item_id: item.id, version: target.version, semver: target.semver, status: result.data.status } });
    } catch (err) {
        dbFail(res, err);
    }
}

ownerRouter.post('/:itemId/install', ownerRequired, (req, res) => takeVersion(req, res, { mustBeInstalled: false }));
ownerRouter.post('/:itemId/update', ownerRequired, (req, res) => takeVersion(req, res, { mustBeInstalled: true }));

async function setStatus(req, res, status) {
    try {
        const t = await ownerTarget(req, res);
        if (!t) return;
        const has = t.row && (t.row.status === 'installed' || t.row.status === 'disabled');
        if (!has) return fail(res, 404, 'Not installed.');
        const { error } = await supabase.from('store_installs').update({ status, updated_at: nowIso() }).eq('id', t.row.id);
        if (error) return dbFail(res, error);
        res.json({ status });
    } catch (err) {
        dbFail(res, err);
    }
}

ownerRouter.post('/:itemId/disable', ownerRequired, (req, res) => setStatus(req, res, 'disabled'));
ownerRouter.post('/:itemId/enable', ownerRequired, (req, res) => setStatus(req, res, 'installed'));
ownerRouter.delete('/:itemId', ownerRequired, (req, res) => setStatus(req, res, 'uninstalled'));

/** Settings: only the keys the installed version declares are kept. */
ownerRouter.patch('/:itemId/config', ownerRequired, async (req, res) => {
    try {
        const t = await ownerTarget(req, res);
        if (!t) return;
        const has = t.row && (t.row.status === 'installed' || t.row.status === 'disabled');
        if (!has) return fail(res, 404, 'Not installed.');
        const version = await loadVersion(t.item.id, t.row.version);
        const allowed = new Set(configKeys(version?.manifest));
        const incoming = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
        const config = { ...(t.row.config || {}) };
        for (const [k, v] of Object.entries(incoming)) if (allowed.has(k)) config[k] = v;
        const { error } = await supabase.from('store_installs').update({ config, updated_at: nowIso() }).eq('id', t.row.id);
        if (error) return dbFail(res, error);
        res.json({ config });
    } catch (err) {
        dbFail(res, err);
    }
});

module.exports = router;
module.exports.ownerRouter = ownerRouter;
module.exports.ownerCatalog = ownerCatalog;
