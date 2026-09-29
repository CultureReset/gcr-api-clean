// ============================================================
// BILLING — the pure part
// ============================================================
//
// Ported from Huly: plugins/billing/src/types.ts, plugins/billing/src/limits.ts
// and plugins/billing-resources/src/stores/restrictionLogic.ts
// (github.com/hcengineering/platform, EPL-2.0).
//
// Their idea worth taking, verbatim in spirit:
//
//   A business over its limit is not cut off. It crosses the line, a clock
//   starts, it gets warned, and only when the clock runs out does anything
//   stop working. Going back under the limit stops the clock.
//
// That is the difference between billing that keeps customers and billing that
// makes an angry phone call out of a busy Saturday.
//
// What was changed on the way in:
//
//   Theirs                                  Here
//   ─────────────────────────────────────   ─────────────────────────────────
//   TIER_LIMITS_GB, four plans compiled in  plans are rows in billing_plan
//   storageGB / trafficGB, two dimensions   any dimension, rows in
//                                           billing_plan_limit
//   RESTRICTED_FEATURES = {'fileUpload'}    the plan says what it restricts
//   Timestamp = number                      Date, because Postgres returns
//                                           timestamptz
//
// Everything here is pure: no database, no clock of its own, no Express. `now`
// is always passed in, which is what makes the grace period testable without
// waiting seven days.

// How long a business stays warned before anything is actually restricted.
// Huly's default, kept because a week spans a full billing cycle for the kind
// of business that pays on a Friday.
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

const EMPTY = Object.freeze([]);

/**
 * Which dimensions are over their limit.
 *
 * @param {object} limits  { dimension: maxValue | null }  null = unlimited
 * @param {object} usage   { dimension: value }
 * @returns {Array<{dimension, value, max}>}
 */
function exceeded(limits, usage) {
    const over = [];
    for (const [dimension, max] of Object.entries(limits || {})) {
        // null is unlimited. 0 is "off", which is a real limit and must still
        // be checked — `!max` would collapse the two.
        if (max === null || max === undefined) continue;
        const value = Number(usage?.[dimension] ?? 0);
        if (value > Number(max)) over.push({ dimension, value, max: Number(max) });
    }
    return over;
}

/**
 * The state machine, ported from computeRestrictionState.
 *
 * `limitsExceededSince` is the only piece of stored state the whole thing
 * needs: absent means the business has never been over, or has come back
 * under. Present means the clock is running.
 *
 * @param {Date|string|null} limitsExceededSince
 * @param {Date|number} now
 * @param {number} gracePeriodMs
 * @returns {{mode:'ok'|'warning'|'restricted', limitsExceededSince:Date|null, gracePeriodEndsAt:Date|null}}
 */
function restrictionState(limitsExceededSince, now = new Date(), gracePeriodMs = GRACE_PERIOD_MS) {
    if (!limitsExceededSince) {
        return { mode: 'ok', limitsExceededSince: null, gracePeriodEndsAt: null };
    }
    const since = new Date(limitsExceededSince);
    if (Number.isNaN(since.getTime())) {
        // An unparseable timestamp must not silently restrict a paying
        // business. Fail open and let it show up as ok.
        return { mode: 'ok', limitsExceededSince: null, gracePeriodEndsAt: null };
    }
    const endsAt = new Date(since.getTime() + gracePeriodMs);
    const at = now instanceof Date ? now : new Date(now);
    return {
        mode: at < endsAt ? 'warning' : 'restricted',
        limitsExceededSince: since,
        gracePeriodEndsAt: endsAt,
    };
}

/**
 * Everything a caller needs to decide what to show and what to allow.
 *
 * @param {object} plan    a billing_plan row
 * @param {object} limits  { dimension: max|null }
 * @param {object} usage   { dimension: value }
 * @param {Date|string|null} limitsExceededSince
 * @param {Date} now
 */
function evaluate({ plan, limits, usage, limitsExceededSince, now = new Date(), gracePeriodMs = GRACE_PERIOD_MS }) {
    const over = exceeded(limits, usage);
    // The clock starts the moment usage first goes over and is cleared the
    // moment it comes back under. A caller that is over but has no stored
    // timestamp yet is treated as starting now, so the first observation does
    // not restrict anybody.
    const since = over.length === 0 ? null : (limitsExceededSince || now);
    const state = restrictionState(since, now, gracePeriodMs);
    return {
        plan: plan?.key ?? null,
        planName: plan?.name ?? null,
        limits: limits || {},
        usage: usage || {},
        exceeded: over,
        ...state,
        // What the caller should persist. Returning it rather than writing it
        // keeps this file pure and gives the route one obvious thing to save.
        persist: { limits_exceeded_since: since },
    };
}

/**
 * Is one specific thing allowed right now?
 *
 * A dimension not named by the plan is unlimited, not forbidden — a plan that
 * has never heard of a dimension must not block a feature that shipped after
 * the plan was written.
 */
function allows(evaluation, dimension, amount = 1) {
    if (!evaluation) return true;
    const max = evaluation.limits?.[dimension];
    if (max === null || max === undefined) return true;
    if (evaluation.mode === 'restricted') return false;
    return Number(evaluation.usage?.[dimension] ?? 0) + Number(amount) <= Number(max);
}

module.exports = { GRACE_PERIOD_MS, exceeded, restrictionState, evaluate, allows, EMPTY };
