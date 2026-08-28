// ============================================================
// BILLING — the routes
// ============================================================
//
// Same rule as every other owner route in this API: the slug is never taken
// from the request. ownerRequired resolves it from the session via
// entity_owners, and every query below filters on req.entitySlug. A caller can
// ask about its own plan and nothing else.
//
// The pure logic is in lib/billing.js, ported from Huly. This file is the part
// that touches the database.

const express = require('express');
const supabase = require('../db');
const { ownerRequired, sessionRequired } = require('../middleware/ownerAuth');
const billing = require('../lib/billing');

const router = express.Router();
const fail = (res, code, message) => res.status(code).json({ error: message });

// The plans on offer. Public: a business compares plans before it has one.
//
// No plan is named in this file. `is_public` and `sort_order` are columns, so
// the operator changes the pricing table with an insert.
router.get('/plans', async (req, res) => {
    const { data: plans, error } = await supabase
        .from('billing_plan')
        .select('key,name,description,price_monthly,currency,sort_order,is_default')
        .eq('is_public', true)
        .order('sort_order');
    if (error) return fail(res, 500, error.message);

    const { data: limits, error: limitError } = await supabase
        .from('billing_plan_limit')
        .select('plan_key,dimension,max_value');
    if (limitError) return fail(res, 500, limitError.message);

    const byPlan = {};
    for (const row of limits || []) {
        (byPlan[row.plan_key] ||= {})[row.dimension] = row.max_value;
    }
    res.json({ plans: (plans || []).map((p) => ({ ...p, limits: byPlan[p.key] || {} })) });
});

// Read a business's plan, its limits, its usage, and whether it is restricted.
//
// The default plan applies when there is no subscription row, so a business
// that never subscribed still gets a coherent answer rather than a 404 that
// every caller has to special-case.
async function stateFor(slug) {
    const [{ data: sub }, { data: usageRows }] = await Promise.all([
        supabase.from('billing_subscription').select('*').eq('entity_slug', slug).maybeSingle(),
        supabase.from('billing_usage').select('dimension,value').eq('entity_slug', slug),
    ]);

    let plan = null;
    if (sub?.plan_key) {
        const { data } = await supabase.from('billing_plan').select('*').eq('key', sub.plan_key).maybeSingle();
        plan = data;
    }
    if (!plan) {
        const { data } = await supabase.from('billing_plan').select('*').eq('is_default', true).maybeSingle();
        plan = data;
    }
    if (!plan) return { error: 'no default billing plan is configured' };

    const { data: limitRows } = await supabase
        .from('billing_plan_limit').select('dimension,max_value').eq('plan_key', plan.key);

    const limits = Object.fromEntries((limitRows || []).map((r) => [r.dimension, r.max_value]));
    const usage = Object.fromEntries((usageRows || []).map((r) => [r.dimension, Number(r.value)]));

    return {
        evaluation: billing.evaluate({
            plan, limits, usage,
            limitsExceededSince: sub?.limits_exceeded_since ?? null,
        }),
        subscription: sub ?? null,
        plan,
    };
}

router.get('/me', ownerRequired, async (req, res) => {
    const state = await stateFor(req.entitySlug);
    if (state.error) return fail(res, 500, state.error);

    // The clock is stored here rather than by a cron: this endpoint is hit on
    // every dashboard load, which is often enough to start and stop a
    // seven-day timer, and it means the grace period cannot drift because a
    // scheduled job stopped running.
    const next = state.evaluation.persist.limits_exceeded_since;
    const prev = state.subscription?.limits_exceeded_since ?? null;
    const changed = (next ? new Date(next).toISOString() : null) !== (prev ? new Date(prev).toISOString() : null);
    if (changed && state.subscription) {
        await supabase.from('billing_subscription')
            .update({ limits_exceeded_since: next, updated_at: new Date().toISOString() })
            .eq('entity_slug', req.entitySlug);
    }

    const { persist, ...evaluation } = state.evaluation;
    res.json({ ...evaluation, subscription: state.subscription });
});

// Ask before doing something metered: "may I add another listing?"
//
// A dimension the plan has never heard of is allowed. A plan written before a
// feature existed must not block that feature.
router.get('/allows/:dimension', ownerRequired, async (req, res) => {
    const state = await stateFor(req.entitySlug);
    if (state.error) return fail(res, 500, state.error);
    const amount = Number(req.query.amount) || 1;
    res.json({
        dimension: req.params.dimension,
        amount,
        allowed: billing.allows(state.evaluation, req.params.dimension, amount),
        mode: state.evaluation.mode,
    });
});

// Record usage. Absolute value, not a delta: a counter that drifts is worse
// than one that is occasionally recomputed, and every caller already knows its
// own total.
router.put('/usage/:dimension', ownerRequired, async (req, res) => {
    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value < 0) return fail(res, 400, 'value must be a non-negative number');

    const { error } = await supabase.from('billing_usage').upsert({
        entity_slug: req.entitySlug,
        dimension: req.params.dimension,
        value,
        observed_at: new Date().toISOString(),
    }, { onConflict: 'entity_slug,dimension' });
    if (error) return fail(res, 500, error.message);

    const state = await stateFor(req.entitySlug);
    if (state.error) return fail(res, 500, state.error);
    const { persist, ...evaluation } = state.evaluation;
    res.json(evaluation);
});

module.exports = router;
