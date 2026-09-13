// ============================================================
// AUTOMATIONS — build in the admin console, push to every dashboard
// ============================================================
//
// Three routers, three audiences, one engine (lib/automationEngine.js).
//
//   admin    /api/admin/automations      build, publish, deploy, watch
//   owner    /api/business/automations   a business's own installs: switch
//                                        on, fill in settings, run, see runs
//   public   /api/automations            the hourly cron tick and the inbound
//                                        webhook URLs, neither of which has a
//                                        dashboard session
//
// ── The lifecycle ───────────────────────────────────────────────────────
//
//   draft ──publish──▶ version N ──deploy──▶ installed on business X at N
//                                              │
//     edit the draft again, nothing moves      │  push version N+1 to
//     until the next publish + deploy          │  everyone, or to a few and
//                                              ▼  let the rest pull it
//                                        "update available"
//
// ── The one rule, again ─────────────────────────────────────────────────
//
// Owner routes take the slug from the session (ownerRequired). No handler in
// the owner router reads a slug from the request. Admin routes name slugs
// explicitly, and are adminRequired. The public hook identifies an install by
// a random token, never by a slug.

const express = require('express');
const supabase = require('../db');
const { adminRequired } = require('../middleware/auth');
const { ownerRequired } = require('../middleware/ownerAuth');
const engine = require('../lib/automationEngine');

const router = express.Router();
const ownerRouter = express.Router();
const publicRouter = express.Router();

const fail = (res, code, message, extra) => res.status(code).json({ error: message, ...(extra || {}) });

const DEFINITION_FIELDS = ['name', 'description', 'icon', 'category', 'kind', 'trigger', 'steps', 'config_schema'];

/** The part of an automations row that a version snapshot carries. */
function snapshotOf(row) {
    return {
        name: row.name,
        description: row.description,
        icon: row.icon,
        category: row.category,
        kind: row.kind,
        trigger: row.trigger,
        steps: row.steps,
        config_schema: row.config_schema,
    };
}

async function loadAutomation(id) {
    const { data, error } = await supabase.from('automations').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
}

/** PostgREST caps at 1,000 rows silently; page explicitly. */
async function pageAll(build, pageSize = 1000) {
    const all = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await build().range(from, from + pageSize - 1);
        if (error) throw new Error(error.message);
        all.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return all;
}

/* ── audiences ───────────────────────────────────────────────────────────
 *
 * Who a push goes to. "owners" is the default and the honest meaning of
 * "my users": the businesses that have a login and therefore a dashboard to
 * see it on. "all" is every active listing, which is thousands — the preview
 * says so before anything is written.
 */
async function resolveAudience(audience) {
    const mode = audience?.mode || 'owners';

    if (mode === 'slugs') {
        const slugs = [...new Set((audience.slugs || []).map((s) => String(s).trim()).filter(Boolean))];
        if (!slugs.length) return [];
        const rows = await pageAll(() => supabase.from('entity').select('slug').in('slug', slugs));
        return rows.map((r) => r.slug);
    }

    if (mode === 'owners') {
        const rows = await pageAll(() => supabase.from('entity_owners').select('entity_slug').order('entity_slug'));
        return [...new Set(rows.map((r) => r.entity_slug).filter(Boolean))];
    }

    if (mode === 'industries') {
        const types = (audience.industries || []).map((s) => String(s).trim()).filter(Boolean);
        if (!types.length) return [];
        const rows = await pageAll(() =>
            supabase.from('entity').select('slug').eq('is_active', true).in('entity_type', types).order('slug'));
        return rows.map((r) => r.slug);
    }

    if (mode === 'all') {
        const rows = await pageAll(() => supabase.from('entity').select('slug').eq('is_active', true).order('slug'));
        return rows.map((r) => r.slug);
    }

    throw new Error(`Unknown audience mode: ${mode}`);
}

/** Distinct entity_type values with counts, for the audience picker. */
let industryCache = null;
async function industries() {
    if (industryCache && Date.now() - industryCache.at < 5 * 60 * 1000) return industryCache.list;
    const rows = await pageAll(() => supabase.from('entity').select('entity_type').eq('is_active', true).not('entity_type', 'is', null));
    const counts = new Map();
    for (const r of rows) {
        const v = (r.entity_type || '').trim();
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    const list = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    industryCache = { list, at: Date.now() };
    return list;
}

/* ── deploy ──────────────────────────────────────────────────────────────
 *
 * Existing installs keep their settings and their on/off state; only the
 * version moves. New installs get a fresh hook token and the enabled flag the
 * operator chose.
 */
async function deploy({ automation, version, audience, enabled, createdBy, notes }) {
    const slugs = await resolveAudience(audience);
    const { data: dep, error: depError } = await supabase.from('automation_deployments').insert({
        automation_id: automation.id,
        version,
        audience,
        status: 'done',
        targeted: slugs.length,
        notes: notes || null,
        created_by: createdBy || null,
    }).select().single();
    if (depError) throw new Error(depError.message);

    let installed = 0;
    let updated = 0;
    let failed = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < slugs.length; i += 500) {
        const chunk = slugs.slice(i, i + 500);
        const { data: existing } = await supabase
            .from('entity_automations')
            .select('entity_slug')
            .eq('automation_id', automation.id)
            .in('entity_slug', chunk);
        const have = new Set((existing || []).map((r) => r.entity_slug));

        const fresh = chunk.filter((s) => !have.has(s));
        const known = chunk.filter((s) => have.has(s));

        if (fresh.length) {
            const { error } = await supabase.from('entity_automations').insert(fresh.map((slug) => ({
                entity_slug: slug,
                automation_id: automation.id,
                version,
                enabled: enabled !== false,
                config: {},
                hook_token: engine.newHookToken(),
                deployment_id: dep.id,
                installed_at: now,
                updated_at: now,
            })));
            if (error) failed += fresh.length;
            else installed += fresh.length;
        }
        if (known.length) {
            const { error } = await supabase
                .from('entity_automations')
                .update({ version, deployment_id: dep.id, updated_at: now })
                .eq('automation_id', automation.id)
                .in('entity_slug', known);
            if (error) failed += known.length;
            else updated += known.length;
        }
    }

    const { data: done } = await supabase.from('automation_deployments').update({
        installed, updated, failed,
        status: failed && !installed && !updated ? 'failed' : 'done',
        finished_at: new Date().toISOString(),
    }).eq('id', dep.id).select().single();

    // Tell the freshly installed ones, if the automation listens for it.
    if (installed && automation.trigger?.type === 'event' && automation.trigger?.event === 'automation.installed') {
        for (const slug of slugs.slice(0, 200)) await engine.emitEvent('automation.installed', slug, { version });
    }

    return done || dep;
}

/* ════════════════════════════════════════════════════════════════════════
 *  ADMIN
 * ════════════════════════════════════════════════════════════════════════ */

/** What the builder needs to draw itself: step palette, triggers, events, industries. */
router.get('/meta', adminRequired, async (_req, res) => {
    try {
        res.json({ ...engine.catalogue(), industries: await industries() });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** Every automation, with install counts and the latest deployment. */
router.get('/', adminRequired, async (req, res) => {
    try {
        let q = supabase.from('automations').select('*').order('updated_at', { ascending: false });
        if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);
        else q = q.neq('status', 'archived');
        const { data: rows, error } = await q;
        if (error) return fail(res, 500, error.message);

        const ids = (rows || []).map((r) => r.id);
        const installs = ids.length
            ? await pageAll(() => supabase.from('entity_automations').select('automation_id, version, enabled').in('automation_id', ids))
            : [];
        const { data: deployments } = ids.length
            ? await supabase.from('automation_deployments').select('*').in('automation_id', ids).order('created_at', { ascending: false }).limit(500)
            : { data: [] };

        const stats = {};
        for (const i of installs) {
            const s = (stats[i.automation_id] ||= { installs: 0, enabled: 0, current: 0 });
            s.installs += 1;
            if (i.enabled) s.enabled += 1;
        }
        const lastDeploy = {};
        for (const d of deployments || []) if (!lastDeploy[d.automation_id]) lastDeploy[d.automation_id] = d;

        res.json({
            automations: (rows || []).map((r) => {
                const s = stats[r.id] || { installs: 0, enabled: 0 };
                const current = installs.filter((i) => i.automation_id === r.id && i.version === r.version).length;
                return { ...r, stats: { ...s, current, behind: s.installs - current }, last_deployment: lastDeploy[r.id] || null };
            }),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.post('/', adminRequired, async (req, res) => {
    const b = req.body || {};
    const row = {
        key: String(b.key || '').trim() || slugify(b.name),
        name: String(b.name || '').trim(),
        description: b.description || null,
        icon: b.icon || '⚡',
        category: b.category || 'general',
        kind: b.kind === 'script' ? 'script' : 'automation',
        trigger: b.trigger && typeof b.trigger === 'object' ? b.trigger : { type: 'manual' },
        steps: Array.isArray(b.steps) ? b.steps : [],
        config_schema: Array.isArray(b.config_schema) ? b.config_schema : [],
        status: 'draft',
        created_by: req.userId ? String(req.userId) : null,
    };
    const problems = engine.validateDefinition(row);
    if (problems.length) return fail(res, 400, problems[0], { problems });

    const { data, error } = await supabase.from('automations').insert(row).select().single();
    if (error) return fail(res, 400, error.code === '23505' ? `The key "${row.key}" is already used.` : error.message);
    res.status(201).json({ automation: data });
});

/** One automation with its versions, deployments, install stats and recent runs. */
router.get('/:id', adminRequired, async (req, res) => {
    try {
        const automation = await loadAutomation(req.params.id);
        if (!automation) return fail(res, 404, 'No such automation');

        const [versions, deployments, runs, installs] = await Promise.all([
            supabase.from('automation_versions').select('id, version, changelog, published_by, published_at').eq('automation_id', automation.id).order('version', { ascending: false }),
            supabase.from('automation_deployments').select('*').eq('automation_id', automation.id).order('created_at', { ascending: false }).limit(50),
            supabase.from('automation_runs').select('*').eq('automation_id', automation.id).order('started_at', { ascending: false }).limit(50),
            pageAll(() => supabase.from('entity_automations').select('version, enabled').eq('automation_id', automation.id)),
        ]);

        const stats = { installs: installs.length, enabled: 0, current: 0 };
        for (const i of installs) {
            if (i.enabled) stats.enabled += 1;
            if (i.version === automation.version) stats.current += 1;
        }
        stats.behind = stats.installs - stats.current;

        res.json({
            automation,
            versions: versions.data || [],
            deployments: deployments.data || [],
            runs: runs.data || [],
            stats,
            problems: engine.validateDefinition(automation),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** Edit the draft. Nothing a business has installed changes. */
router.put('/:id', adminRequired, async (req, res) => {
    try {
        const automation = await loadAutomation(req.params.id);
        if (!automation) return fail(res, 404, 'No such automation');

        const patch = {};
        for (const k of DEFINITION_FIELDS) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
        if (req.body?.key !== undefined) patch.key = String(req.body.key).trim();
        if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change');

        const merged = { ...automation, ...patch };
        const problems = engine.validateDefinition(merged);
        // A draft may be saved with problems (you are mid-edit); publishing may not.
        patch.updated_at = new Date().toISOString();

        const { data, error } = await supabase.from('automations').update(patch).eq('id', automation.id).select().single();
        if (error) return fail(res, 400, error.code === '23505' ? `The key "${patch.key}" is already used.` : error.message);
        res.json({ automation: data, problems });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** Archive, never delete — installs and runs keep pointing at something real. */
router.delete('/:id', adminRequired, async (req, res) => {
    const { data, error } = await supabase.from('automations')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('id', req.params.id).select();
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'No such automation');
    // Switch it off everywhere so a scheduled one stops firing.
    await supabase.from('entity_automations').update({ enabled: false, updated_at: new Date().toISOString() }).eq('automation_id', req.params.id);
    res.json({ automation: data[0], archived: true });
});

/** Snapshot the draft as the next version. */
router.post('/:id/publish', adminRequired, async (req, res) => {
    try {
        const automation = await loadAutomation(req.params.id);
        if (!automation) return fail(res, 404, 'No such automation');
        const problems = engine.validateDefinition(automation);
        if (problems.length) return fail(res, 400, 'Fix these before publishing.', { problems });
        if (!Array.isArray(automation.steps) || !automation.steps.length) return fail(res, 400, 'Add at least one step before publishing.');

        const version = (automation.version || 0) + 1;
        const { error: vError } = await supabase.from('automation_versions').insert({
            automation_id: automation.id,
            version,
            definition: snapshotOf(automation),
            changelog: req.body?.changelog || null,
            published_by: req.userId ? String(req.userId) : null,
        });
        if (vError) return fail(res, 400, vError.message);

        const { data, error } = await supabase.from('automations')
            .update({ version, status: 'published', updated_at: new Date().toISOString() })
            .eq('id', automation.id).select().single();
        if (error) return fail(res, 400, error.message);
        res.json({ automation: data, version });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** How many businesses a push would reach, before it does. */
router.post('/:id/deploy/preview', adminRequired, async (req, res) => {
    try {
        const slugs = await resolveAudience(req.body?.audience || { mode: 'owners' });
        const { count } = await supabase.from('entity_automations')
            .select('id', { count: 'exact', head: true }).eq('automation_id', req.params.id).in('entity_slug', slugs.slice(0, 1000));
        res.json({ targeted: slugs.length, already_installed: count || 0, sample: slugs.slice(0, 12) });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

/** The push. `version` defaults to the latest; name an older one to roll back. */
router.post('/:id/deploy', adminRequired, async (req, res) => {
    try {
        const automation = await loadAutomation(req.params.id);
        if (!automation) return fail(res, 404, 'No such automation');
        if (automation.status === 'archived') return fail(res, 400, 'This automation is archived.');
        if (!automation.version) return fail(res, 400, 'Publish a version before deploying.');

        const version = Number(req.body?.version) || automation.version;
        const { data: snap } = await supabase.from('automation_versions').select('version').eq('automation_id', automation.id).eq('version', version).maybeSingle();
        if (!snap) return fail(res, 400, `There is no version ${version}.`);

        const deployment = await deploy({
            automation,
            version,
            audience: req.body?.audience || { mode: 'owners' },
            enabled: req.body?.enabled !== false,
            createdBy: req.userId ? String(req.userId) : null,
            notes: req.body?.notes,
        });
        res.json({ deployment });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

/** Try the DRAFT against one business, with side effects off unless asked. */
router.post('/:id/test', adminRequired, async (req, res) => {
    try {
        const automation = await loadAutomation(req.params.id);
        if (!automation) return fail(res, 404, 'No such automation');
        const slug = String(req.body?.slug || '').trim();
        if (!slug) return fail(res, 400, 'Pick a business to test against.');
        const problems = engine.validateDefinition(automation);
        if (problems.length) return fail(res, 400, 'Fix these before testing.', { problems });

        const { data: install } = await supabase.from('entity_automations').select('config').eq('automation_id', automation.id).eq('entity_slug', slug).maybeSingle();
        const result = await engine.runDefinition({
            definition: snapshotOf(automation),
            slug,
            trigger: { type: 'test', payload: req.body?.input ?? null },
            config: { ...(install?.config || {}), ...(req.body?.config || {}) },
            dryRun: req.body?.dry_run !== false,
            record: { automationId: automation.id, version: automation.version || 0 },
        });
        res.json({ result });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** Run the INSTALLED version for one business, for real. */
router.post('/:id/run', adminRequired, async (req, res) => {
    const slug = String(req.body?.slug || '').trim();
    if (!slug) return fail(res, 400, 'Name the business to run for.');
    const { data: install } = await supabase.from('entity_automations').select('*').eq('automation_id', req.params.id).eq('entity_slug', slug).maybeSingle();
    if (!install) return fail(res, 404, 'That business does not have this automation installed.');
    try {
        res.json({ result: await engine.runInstall(install, { type: 'manual', payload: req.body?.input ?? null }) });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** Who has it, at which version. */
router.get('/:id/installs', adminRequired, async (req, res) => {
    try {
        const rows = await pageAll(() =>
            supabase.from('entity_automations').select('*').eq('automation_id', req.params.id).order('updated_at', { ascending: false }));
        const slugs = rows.map((r) => r.entity_slug);
        const names = {};
        for (let i = 0; i < slugs.length; i += 500) {
            const { data } = await supabase.from('entity').select('slug, name, entity_type').in('slug', slugs.slice(i, i + 500));
            for (const e of data || []) names[e.slug] = e;
        }
        res.json({
            installs: rows.map((r) => ({
                ...r,
                hook_token: undefined,           // never leaves the owner router
                has_hook: !!r.hook_token,
                entity_name: names[r.entity_slug]?.name || null,
                entity_type: names[r.entity_slug]?.entity_type || null,
            })),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.patch('/:id/installs/:slug', adminRequired, async (req, res) => {
    const patch = { updated_at: new Date().toISOString() };
    if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
    if (req.body?.config && typeof req.body.config === 'object') patch.config = req.body.config;
    if (req.body?.version !== undefined) patch.version = Number(req.body.version);
    const { data, error } = await supabase.from('entity_automations').update(patch)
        .eq('automation_id', req.params.id).eq('entity_slug', req.params.slug).select();
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'Not installed there.');
    res.json({ install: { ...data[0], hook_token: undefined } });
});

router.delete('/:id/installs/:slug', adminRequired, async (req, res) => {
    const { data, error } = await supabase.from('entity_automations').delete()
        .eq('automation_id', req.params.id).eq('entity_slug', req.params.slug).select('id');
    if (error) return fail(res, 400, error.message);
    if (!data?.length) return fail(res, 404, 'Not installed there.');
    res.json({ uninstalled: true });
});

/** Recent runs across everything, filterable. */
router.get('/runs/recent', adminRequired, async (req, res) => {
    let q = supabase.from('automation_runs').select('*').order('started_at', { ascending: false })
        .limit(Math.min(Number(req.query.limit) || 100, 500));
    if (req.query.automation_id) q = q.eq('automation_id', req.query.automation_id);
    if (req.query.slug) q = q.eq('entity_slug', req.query.slug);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) return fail(res, 500, error.message);

    const ids = [...new Set((data || []).map((r) => r.automation_id))];
    const { data: names } = ids.length ? await supabase.from('automations').select('id, name, icon').in('id', ids) : { data: [] };
    const byId = Object.fromEntries((names || []).map((a) => [a.id, a]));
    res.json({
        runs: (data || []).map((r) => ({ ...r, automation_name: byId[r.automation_id]?.name || null, automation_icon: byId[r.automation_id]?.icon || null })),
        counts: (data || []).reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    });
});

/** Every deployment, newest first — the rollout ledger. */
router.get('/deployments/recent', adminRequired, async (req, res) => {
    const { data, error } = await supabase.from('automation_deployments').select('*').order('created_at', { ascending: false })
        .limit(Math.min(Number(req.query.limit) || 100, 500));
    if (error) return fail(res, 500, error.message);
    const ids = [...new Set((data || []).map((r) => r.automation_id))];
    const { data: names } = ids.length ? await supabase.from('automations').select('id, name, icon, version').in('id', ids) : { data: [] };
    const byId = Object.fromEntries((names || []).map((a) => [a.id, a]));
    res.json({
        deployments: (data || []).map((d) => ({
            ...d,
            automation_name: byId[d.automation_id]?.name || null,
            automation_icon: byId[d.automation_id]?.icon || null,
            latest_version: byId[d.automation_id]?.version ?? null,
        })),
    });
});

/* ════════════════════════════════════════════════════════════════════════
 *  OWNER — one business, its own installs
 * ════════════════════════════════════════════════════════════════════════ */

function hookUrl(req, token) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}/api/automations/hook/${token}`;
}

/** Everything pushed to this business, at the version it has. */
ownerRouter.get('/', ownerRequired, async (req, res) => {
    try {
        const { data: installs, error } = await supabase.from('entity_automations').select('*')
            .eq('entity_slug', req.entitySlug).order('installed_at', { ascending: false });
        if (error) return fail(res, 500, error.message);
        if (!installs?.length) return res.json({ automations: [] });

        const ids = installs.map((i) => i.automation_id);
        const [{ data: automations }, { data: runs }] = await Promise.all([
            supabase.from('automations').select('id, name, description, icon, category, kind, version, status').in('id', ids),
            supabase.from('automation_runs').select('automation_id, status, started_at, error, trigger').eq('entity_slug', req.entitySlug).eq('dry_run', false)
                .in('automation_id', ids).order('started_at', { ascending: false }).limit(200),
        ]);
        const byId = Object.fromEntries((automations || []).map((a) => [a.id, a]));
        const lastRun = {};
        for (const r of runs || []) if (!lastRun[r.automation_id]) lastRun[r.automation_id] = r;

        const out = [];
        for (const install of installs) {
            const auto = byId[install.automation_id];
            if (!auto || auto.status === 'archived') continue;
            const def = await engine.loadVersion(install.automation_id, install.version);
            out.push({
                id: auto.id,
                name: def?.name || auto.name,
                description: def?.description || auto.description,
                icon: def?.icon || auto.icon,
                category: def?.category || auto.category,
                kind: def?.kind || auto.kind,
                trigger: def?.trigger || { type: 'manual' },
                config_schema: def?.config_schema || [],
                steps_summary: (def?.steps || []).map((s) => ({ id: s.id, type: s.type, name: s.name })),
                version: install.version,
                latest_version: auto.version,
                update_available: auto.status === 'published' && auto.version > install.version,
                enabled: install.enabled,
                config: install.config || {},
                installed_at: install.installed_at,
                updated_at: install.updated_at,
                last_run_at: install.last_run_at,
                last_run_status: install.last_run_status,
                last_run: lastRun[auto.id] || null,
                hook_url: def?.trigger?.type === 'webhook' && install.hook_token ? hookUrl(req, install.hook_token) : null,
            });
        }
        res.json({ automations: out });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

async function ownInstall(req, res) {
    const { data, error } = await supabase.from('entity_automations').select('*')
        .eq('entity_slug', req.entitySlug).eq('automation_id', req.params.id).maybeSingle();
    if (error) { fail(res, 500, error.message); return null; }
    if (!data) { fail(res, 404, 'That automation is not on your dashboard.'); return null; }
    return data;
}

/** Switch on/off, or change settings. Only keys the version declares are kept. */
ownerRouter.patch('/:id', ownerRequired, async (req, res) => {
    const install = await ownInstall(req, res);
    if (!install) return;
    const patch = { updated_at: new Date().toISOString() };
    if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
    if (req.body?.config && typeof req.body.config === 'object') {
        const def = await engine.loadVersion(install.automation_id, install.version);
        const allowed = new Set((def?.config_schema || []).map((f) => f.key));
        const config = { ...(install.config || {}) };
        for (const [k, v] of Object.entries(req.body.config)) if (allowed.has(k)) config[k] = v;
        patch.config = config;
    }
    const { data, error } = await supabase.from('entity_automations').update(patch).eq('id', install.id).select().single();
    if (error) return fail(res, 400, error.message);
    res.json({ enabled: data.enabled, config: data.config, version: data.version });
});

/** Move to the latest published version. */
ownerRouter.post('/:id/update', ownerRequired, async (req, res) => {
    const install = await ownInstall(req, res);
    if (!install) return;
    const { data: auto } = await supabase.from('automations').select('version, status').eq('id', install.automation_id).maybeSingle();
    if (!auto || auto.status !== 'published') return fail(res, 400, 'There is no newer version.');
    if (auto.version <= install.version) return res.json({ version: install.version, updated: false });
    const { error } = await supabase.from('entity_automations')
        .update({ version: auto.version, updated_at: new Date().toISOString() }).eq('id', install.id);
    if (error) return fail(res, 400, error.message);
    res.json({ version: auto.version, updated: true });
});

/** Run it now. */
ownerRouter.post('/:id/run', ownerRequired, async (req, res) => {
    const install = await ownInstall(req, res);
    if (!install) return;
    try {
        res.json({ result: await engine.runInstall(install, { type: 'manual', payload: req.body?.input ?? null }) });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

ownerRouter.get('/:id/runs', ownerRequired, async (req, res) => {
    const install = await ownInstall(req, res);
    if (!install) return;
    const { data, error } = await supabase.from('automation_runs').select('*')
        .eq('entity_slug', req.entitySlug).eq('automation_id', install.automation_id)
        .order('started_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 30, 100));
    if (error) return fail(res, 500, error.message);
    res.json({ runs: data || [] });
});

/** A fresh webhook URL; the old one stops working. */
ownerRouter.post('/:id/hook/rotate', ownerRequired, async (req, res) => {
    const install = await ownInstall(req, res);
    if (!install) return;
    const token = engine.newHookToken();
    const { error } = await supabase.from('entity_automations').update({ hook_token: token, updated_at: new Date().toISOString() }).eq('id', install.id);
    if (error) return fail(res, 400, error.message);
    res.json({ hook_url: hookUrl(req, token) });
});

/* ════════════════════════════════════════════════════════════════════════
 *  PUBLIC — the cron tick and the inbound hooks
 * ════════════════════════════════════════════════════════════════════════ */

function cronAllowed(req) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true;
    return (req.headers.authorization || '') === `Bearer ${secret}` || req.query.secret === secret;
}

/** Hourly, from vercel.json. Runs every scheduled install that is due. */
publicRouter.get('/cron/tick', async (req, res) => {
    if (!cronAllowed(req)) return fail(res, 401, 'Unauthorized');
    try {
        res.json(await engine.tick());
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/** One URL per install. The token is the credential; nothing else is trusted. */
publicRouter.post('/hook/:token', async (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{48}$/.test(token)) return fail(res, 404, 'Unknown hook');
    const { data: install } = await supabase.from('entity_automations').select('*').eq('hook_token', token).maybeSingle();
    if (!install) return fail(res, 404, 'Unknown hook');
    if (!install.enabled) return res.status(202).json({ accepted: false, reason: 'switched off' });
    const def = await engine.loadVersion(install.automation_id, install.version);
    if (def?.trigger?.type !== 'webhook') return fail(res, 400, 'This automation is not triggered by a URL.');
    try {
        const result = await engine.runInstall(install, { type: 'webhook', payload: req.body ?? null });
        res.json({ accepted: true, status: result.status, run_id: result.run_id || null });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── util ─────────────────────────────────────────────────────────────── */

function slugify(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || `automation-${Date.now().toString(36)}`;
}

module.exports = router;
module.exports.ownerRouter = ownerRouter;
module.exports.publicRouter = publicRouter;
module.exports.resolveAudience = resolveAudience;
