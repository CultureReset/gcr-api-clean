// ============================================================
// BILLING — the Stripe side of the one billing system (plan §15 step 11)
// ============================================================
//
// lib/billing.js decides (pure); lib/entitlements.js says who may have what;
// this file is the part that touches Stripe and the billing tables:
//
//   chargeInstall          a priced store item, billed when installed:
//                          month/year -> a Stripe subscription item on the
//                          business's subscription; one_time -> an invoice item
//                          on its next invoice. Every price is a row in
//                          billing_item_prices (amount + stripe_price_id).
//   removeInstallCharge    the item is uninstalled: its subscription item goes
//                          (prorated), the charge row is marked removed.
//   chargePhoneNumber      the Phone Agent number's monthly charge: the store
//                          item named by PHONE_AGENT_NUMBER_ITEM_KEY, billed
//                          like any other recurring item. Part of the hook the
//                          number purchase calls.
//   recordUsage            AI spend from LiteLLM per company and period ->
//                          billing_usage_credits, the billing_usage dimension
//                          that plan limits meter, and (if configured) a Stripe
//                          meter event for the credits added.
//   billingState           the business's subscription and whether it is
//                          paused for non-payment (lib/billing.paymentState).
//   applyStripeEvent       subscription and invoice webhooks -> the
//                          subscription row and the non-payment clock.
//
// Nothing is ever deleted for non-payment. A paused business keeps its data
// and its listing; it cannot take on new paid items until it pays.

const supabase = require('../db');
const billing = require('./billing');
const { defaultPlanKey } = require('./entitlements');

let stripeClient;
function stripe() {
    if (stripeClient !== undefined) return stripeClient;
    stripeClient = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
    return stripeClient;
}

const missing = (error) => /(does not exist|schema cache|column)/i.test(error?.message || '');
const RECURRING = new Set(['month', 'year']);

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

/* ── the subscription row ─────────────────────────────────────────────── */

async function subscriptionRow(slug) {
    const { data, error } = await supabase.from('billing_subscription').select('*').eq('entity_slug', slug).maybeSingle();
    if (error && !missing(error)) throw new Error(error.message);
    return data || null;
}

/** Write fields onto the business's subscription row, creating it on the default plan if needed. */
async function saveSubscription(slug, fields) {
    const existing = await subscriptionRow(slug);
    const now = new Date().toISOString();
    if (existing) {
        const { error } = await supabase.from('billing_subscription').update({ ...fields, updated_at: now }).eq('entity_slug', slug);
        if (error) throw new Error(error.message);
        return { ...existing, ...fields };
    }
    const planKey = fields.plan_key || await defaultPlanKey();
    if (!planKey) throw httpError(503, 'No default billing plan is configured (sql/billing.sql).');
    const row = { entity_slug: slug, plan_key: planKey, status: 'active', ...fields, updated_at: now };
    const { error } = await supabase.from('billing_subscription').insert(row);
    if (error) throw new Error(error.message);
    return row;
}

/** Is this business paused for non-payment? Records the moment it first is. */
async function billingState(slug, { now = new Date() } = {}) {
    const sub = await subscriptionRow(slug);
    const payment = billing.paymentState(sub?.payment_failed_since ?? null, now);
    if (payment.paused && sub && !sub.paused_at) {
        await supabase.from('billing_subscription').update({ paused_at: now.toISOString() }).eq('entity_slug', slug);
        require('./notify').notifyOwner(slug, {
            kind: 'failed_action',
            title: 'Payment has not gone through, so new paid items are paused',
            body: 'Nothing has been deleted. Update the payment method and everything resumes.',
            ref: `paused:${sub.payment_failed_since}`,
            link: process.env.OWNER_BILLING_PATH || null,
        });
    }
    return { subscription: sub, payment, paused: payment.paused };
}

/* ── Stripe customer and subscription ─────────────────────────────────── */

async function ensureCustomer(slug, companyId) {
    const s = stripe();
    if (!s) throw httpError(503, 'Billing is not configured (STRIPE_SECRET_KEY).');
    const sub = await subscriptionRow(slug);
    if (sub?.stripe_customer_id) return sub.stripe_customer_id;
    const { data: entity } = await supabase.from('entity').select('name, email').eq('slug', slug).maybeSingle();
    const customer = await s.customers.create({
        name: entity?.name || undefined,
        email: entity?.email || undefined,
        metadata: { entity_slug: slug, ...(companyId ? { company_id: String(companyId) } : {}) },
    });
    await saveSubscription(slug, { stripe_customer_id: customer.id, provider: 'stripe', provider_ref: customer.id });
    return customer.id;
}

/* ── items billed on install ──────────────────────────────────────────── */

/** Price columns store_items still carries until a later SQL file drops them. Never read. */
const LEGACY_PRICE_COLUMNS = ['price_cents', 'price_interval', 'stripe_price_id'];

/**
 * The billing view of one item: its store_items row (access, plan, status)
 * with its price from billing_item_prices, the one place prices live
 * (CONTRACT §12; sql/nextgent_prices_fold.sql moved the old store_items
 * prices there). No price row means free. An item Paperclip has priced but
 * this API's store has no row for is still billable: it is represented by its
 * price row, open to every business (Paperclip's catalog decides who may see
 * it).
 */
async function itemByKey(itemKey) {
    const [{ data, error }, priced] = await Promise.all([
        supabase.from('store_items').select('*').eq('key', itemKey).maybeSingle(),
        priceRow(itemKey),
    ]);
    if (error && !missing(error)) throw new Error(error.message);
    if (!data && !priced) return null;
    const price = priced
        ? {
            price_cents: priced.amount_cents,
            price_interval: priced.interval,
            price_currency: priced.currency,
            price_model: priced.model,
            stripe_price_id: priced.stripe_price_id,
        }
        : { price_cents: 0, price_interval: null, price_currency: null, price_model: null, stripe_price_id: null };
    if (!data) return { id: null, key: itemKey, access: 'free', status: 'published', ...price };
    const base = { ...data };
    for (const col of LEGACY_PRICE_COLUMNS) delete base[col];
    return { ...base, ...price };
}

async function priceRow(itemKey) {
    const { data, error } = await supabase.from('billing_item_prices').select('*').eq('item_key', itemKey).maybeSingle();
    if (error) {
        if (missing(error)) return null;
        throw new Error(error.message);
    }
    return data || null;
}

const INTERVALS = new Set(['one_time', ...RECURRING]);

/**
 * Set an item's price (PUT /api/nextgent/items/:itemKey/price). Stripe prices
 * cannot change, so a new amount makes a new Stripe Price (on the item's own
 * Stripe Product) and the row points at it; installs already billed keep the
 * price they were billed at. Without Stripe the price is stored and an install
 * of a priced item is refused until Stripe is configured.
 */
async function setItemPrice({ itemKey, amountCents, currency, interval, model }) {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount < 0) throw httpError(400, 'amountCents must be a whole number of cents, 0 or more.');
    const cur = String(currency || '').trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(cur)) throw httpError(400, 'currency must be a three-letter ISO code.');
    const iv = amount === 0 ? (interval || null) : String(interval || '');
    if (amount > 0 && !INTERVALS.has(iv)) throw httpError(400, `interval must be one of ${[...INTERVALS].join(', ')}.`);
    const md = model == null || model === '' ? null : String(model).trim();
    if (md !== null && !/^[a-z][a-z0-9_-]{0,39}$/i.test(md)) throw httpError(400, 'model must be a short identifier.');

    const prior = await priceRow(itemKey);
    const unchanged = prior && prior.amount_cents === amount && prior.currency === cur && (prior.interval || null) === (iv || null);
    let stripeProductId = prior?.stripe_product_id || null;
    let stripePriceId = unchanged ? prior.stripe_price_id : null;

    const s = stripe();
    if (amount > 0 && s && !stripePriceId) {
        if (!stripeProductId) {
            const product = await s.products.create({ name: itemKey, metadata: { item_key: itemKey } });
            stripeProductId = product.id;
        }
        const price = await s.prices.create({
            product: stripeProductId,
            unit_amount: amount,
            currency: cur,
            ...(RECURRING.has(iv) ? { recurring: { interval: iv } } : {}),
            metadata: { item_key: itemKey, ...(md ? { model: md } : {}) },
        });
        stripePriceId = price.id;
    }

    const row = {
        item_key: itemKey,
        amount_cents: amount,
        currency: cur,
        interval: iv || null,
        model: md,
        stripe_product_id: stripeProductId,
        stripe_price_id: amount > 0 ? stripePriceId : null,
        updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('billing_item_prices').upsert(row, { onConflict: 'item_key' });
    if (error) throw httpError(missing(error) ? 503 : 500, missing(error) ? 'Item prices are not set up on this database yet (sql/nextgent_prices.sql).' : error.message);
    return { ...row, stripeConfigured: !!s };
}

const priceOf = (item) => ({
    priceCents: Number(item?.price_cents) || 0,
    interval: item?.price_interval || (Number(item?.price_cents) > 0 ? 'one_time' : null),
});

/**
 * Bill an install. Free items record nothing. A priced item needs Stripe and
 * a stripe_price_id on its row; without them the install is refused rather
 * than given away.
 */
async function chargeInstall({ slug, companyId = null, installId, item }) {
    const { priceCents, interval } = priceOf(item);
    if (priceCents <= 0) return { charged: false, priceCents: 0 };
    const s = stripe();
    if (!s) throw httpError(503, 'Billing is not configured (STRIPE_SECRET_KEY).');
    if (!item.stripe_price_id) throw httpError(409, `${item.key} has a price but no stripe_price_id.`);

    const { data: existing } = await supabase
        .from('billing_item_charges').select('id, stripe_ref, status')
        .eq('install_id', String(installId)).eq('status', 'active').maybeSingle();
    if (existing) return { charged: true, already: true, priceCents, interval, stripeRef: existing.stripe_ref };

    const customer = await ensureCustomer(slug, companyId);
    // One Stripe object per install: the same key on a retry (a timeout, a
    // crash before the row below was written) gives back the object already
    // made instead of billing twice.
    const idempotency = { idempotencyKey: `install-charge:${slug}:${String(installId)}:${item.key}` };
    let stripeRef;
    if (RECURRING.has(interval)) {
        const sub = await subscriptionRow(slug);
        if (sub?.stripe_subscription_id) {
            const si = await s.subscriptionItems.create({
                subscription: sub.stripe_subscription_id,
                price: item.stripe_price_id,
                proration_behavior: 'create_prorations',
                metadata: { install_id: String(installId), item_key: item.key },
            }, idempotency);
            stripeRef = si.id;
        } else {
            const created = await s.subscriptions.create({
                customer,
                items: [{ price: item.stripe_price_id, metadata: { install_id: String(installId), item_key: item.key } }],
                metadata: { entity_slug: slug },
            }, idempotency);
            await saveSubscription(slug, { stripe_subscription_id: created.id });
            stripeRef = created.items?.data?.[0]?.id || created.id;
        }
    } else {
        const ii = await s.invoiceItems.create({
            customer,
            price: item.stripe_price_id,
            metadata: { install_id: String(installId), item_key: item.key, entity_slug: slug },
        }, idempotency);
        stripeRef = ii.id;
    }

    const { error } = await supabase.from('billing_item_charges').insert({
        entity_slug: slug,
        company_id: companyId ? String(companyId) : null,
        install_id: String(installId),
        item_key: item.key,
        price_cents: priceCents,
        price_interval: interval,
        stripe_ref: stripeRef,
        status: 'active',
    });
    if (error) console.error('[billing] charge recorded in Stripe but not locally:', installId, error.message);
    return { charged: true, priceCents, interval, stripeRef };
}

async function removeInstallCharge(installId) {
    const { data: rows, error } = await supabase
        .from('billing_item_charges').select('id, stripe_ref, price_interval')
        .eq('install_id', String(installId)).eq('status', 'active');
    if (error) {
        if (missing(error)) return { removed: 0 };
        throw new Error(error.message);
    }
    const s = stripe();
    let removed = 0;
    for (const row of rows || []) {
        try {
            // A subscription item stops the recurring charge (prorated). A
            // one-time invoice item already billed stays billed.
            if (s && row.stripe_ref && RECURRING.has(row.price_interval) && String(row.stripe_ref).startsWith('si_')) {
                await s.subscriptionItems.del(row.stripe_ref, { proration_behavior: 'create_prorations' });
            }
        } catch (err) {
            console.error('[billing] could not remove subscription item', row.stripe_ref, err.message);
        }
        await supabase.from('billing_item_charges')
            .update({ status: 'removed', removed_at: new Date().toISOString() }).eq('id', row.id);
        removed += 1;
    }
    return { removed };
}

/** The Phone Agent number's monthly charge (the hook a number purchase calls). */
async function chargePhoneNumber({ slug, companyId = null, phoneNumber }) {
    const key = process.env.PHONE_AGENT_NUMBER_ITEM_KEY;
    if (!key) throw httpError(503, 'PHONE_AGENT_NUMBER_ITEM_KEY is not set, so a number has no price.');
    const item = await itemByKey(key);
    if (!item) throw httpError(503, `No store item ${key} to price the number with.`);
    return chargeInstall({ slug, companyId, installId: `phone-number:${phoneNumber}`, item });
}

const releasePhoneNumberCharge = (phoneNumber) => removeInstallCharge(`phone-number:${phoneNumber}`);

/* ── AI usage from LiteLLM ────────────────────────────────────────────── */

function monthStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Record one period's AI spend for a company. Idempotent per
 * (company, source, period): sending the same period again with a new total
 * replaces it and bills only the difference.
 */
async function recordUsage({ slug, companyId, source, periodStart, periodEnd, spendUsd, now = new Date() }) {
    const credits = billing.creditsFor(spendUsd, process.env.USAGE_CREDITS_PER_USD);
    const key = { company_id: String(companyId), source, period_start: periodStart, period_end: periodEnd };

    const { data: prior } = await supabase.from('billing_usage_credits').select('credits')
        .eq('company_id', key.company_id).eq('source', source)
        .eq('period_start', periodStart).eq('period_end', periodEnd).maybeSingle();
    const delta = credits - Number(prior?.credits || 0);

    const { error } = await supabase.from('billing_usage_credits').upsert({
        ...key, entity_slug: slug, spend_usd: Number(spendUsd) || 0, credits, recorded_at: now.toISOString(),
    }, { onConflict: 'company_id,source,period_start,period_end' });
    if (error) throw new Error(error.message);

    // The month's total feeds the same usage table plan limits read, so a
    // plan's AI allowance gets the same warn-then-restrict grace period.
    const dimension = process.env.USAGE_CREDITS_DIMENSION || 'ai_credits';
    const { data: rows } = await supabase.from('billing_usage_credits').select('credits')
        .eq('entity_slug', slug).gte('period_start', monthStart(now).toISOString());
    const monthTotal = (rows || []).reduce((sum, r) => sum + Number(r.credits || 0), 0);
    await supabase.from('billing_usage').upsert({
        entity_slug: slug, dimension, value: monthTotal, observed_at: now.toISOString(),
    }, { onConflict: 'entity_slug,dimension' });

    let metered = false;
    const meter = process.env.STRIPE_USAGE_METER_EVENT;
    if (meter && delta > 0 && stripe()) {
        const sub = await subscriptionRow(slug);
        if (sub?.stripe_customer_id) {
            await stripe().billing.meterEvents.create({
                event_name: meter,
                payload: { stripe_customer_id: sub.stripe_customer_id, value: String(delta) },
                identifier: `${key.company_id}:${source}:${periodStart}:${periodEnd}:${credits}`,
            });
            metered = true;
        }
    }
    return { credits, delta, monthTotal, dimension, metered };
}

/* ── Stripe webhooks for the platform subscription ────────────────────── */

async function slugForCustomer(customerId) {
    if (!customerId) return null;
    const { data } = await supabase.from('billing_subscription').select('entity_slug')
        .eq('stripe_customer_id', customerId).maybeSingle();
    return data?.entity_slug || null;
}

/**
 * Subscription and invoice events. Returns what it did, or null when the event
 * is not a platform-billing one (the booking events are handled elsewhere).
 */
async function applyStripeEvent(event, { now = new Date() } = {}) {
    const type = event?.type;
    const obj = event?.data?.object || {};
    const handled = ['invoice.payment_failed', 'invoice.paid', 'invoice.payment_succeeded',
        'customer.subscription.updated', 'customer.subscription.created', 'customer.subscription.deleted'];
    if (!handled.includes(type)) return null;

    const slug = await slugForCustomer(obj.customer);
    if (!slug) return { type, ignored: 'unknown_customer' };
    const sub = await subscriptionRow(slug);

    if (type === 'invoice.payment_failed') {
        // Keep the first failure: the clock must not restart on every retry.
        await saveSubscription(slug, {
            status: 'past_due',
            payment_failed_since: sub?.payment_failed_since || now.toISOString(),
        });
        require('./notify').notifyOwner(slug, {
            kind: 'failed_action',
            title: 'A payment did not go through',
            body: 'Nothing changes yet. Update the payment method before the grace period ends.',
            ref: `invoice:${obj.id}`,
            link: process.env.OWNER_BILLING_PATH || null,
        });
        return { type, slug, status: 'past_due' };
    }
    if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
        await saveSubscription(slug, { status: 'active', payment_failed_since: null, paused_at: null });
        return { type, slug, status: 'active' };
    }
    if (type === 'customer.subscription.deleted') {
        // Cancelled is not deleted: the business drops to the default plan.
        await saveSubscription(slug, { status: 'canceled', stripe_subscription_id: null });
        return { type, slug, status: 'canceled' };
    }
    await saveSubscription(slug, {
        // A plan bought through Checkout carries its key (checkoutForPlan).
        ...(obj.metadata?.plan_key ? { plan_key: obj.metadata.plan_key } : {}),
        status: obj.status || sub?.status || 'active',
        stripe_subscription_id: obj.id || sub?.stripe_subscription_id || null,
        current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : (sub?.current_period_end ?? null),
    });
    return { type, slug, status: obj.status };
}

/** Where Stripe sends the owner back to: OWNER_APP_URL + OWNER_BILLING_PATH. */
function billingReturnUrl(result) {
    const base = (process.env.OWNER_APP_URL || '').replace(/\/+$/, '');
    if (!base) return null;
    const path = String(process.env.OWNER_BILLING_PATH || '').replace(/^\/*/, '/');
    const url = `${base}${path === '/' ? '' : path}`;
    return result ? `${url}${url.includes('?') ? '&' : '?'}checkout=${result}` : url;
}

/**
 * Pay for a plan (POST /api/billing/checkout). A business with no Stripe
 * subscription gets a Checkout session for the plan's price; one that already
 * has a subscription gets the Stripe billing portal, where its plan and card
 * are managed, so it never ends up with two subscriptions.
 * Resolves { url, mode: 'checkout' | 'portal' }.
 */
async function checkoutForPlan({ slug, companyId = null, planKey }) {
    const s = stripe();
    if (!s) throw httpError(503, 'Billing is not configured (STRIPE_SECRET_KEY).');
    const success = billingReturnUrl('success');
    const cancel = billingReturnUrl('cancelled');
    if (!success) throw httpError(503, 'OWNER_APP_URL is not set, so Stripe has nowhere to send the owner back.');
    const { data: plan } = await supabase.from('billing_plan').select('key, stripe_price_id, is_public').eq('key', String(planKey || '')).maybeSingle();
    if (!plan || plan.is_public === false) throw httpError(404, 'No such plan.');
    if (!plan.stripe_price_id) throw httpError(409, `${plan.key} has no stripe_price_id.`);

    const customer = await ensureCustomer(slug, companyId);
    const sub = await subscriptionRow(slug);
    if (sub?.stripe_subscription_id && sub.status !== 'canceled') {
        const portal = await s.billingPortal.sessions.create({ customer, return_url: billingReturnUrl(null) });
        return { url: portal.url, mode: 'portal' };
    }
    const session = await s.checkout.sessions.create({
        mode: 'subscription',
        customer,
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        success_url: success,
        cancel_url: cancel,
        client_reference_id: slug,
        metadata: { entity_slug: slug, plan_key: plan.key },
        subscription_data: { metadata: { entity_slug: slug, plan_key: plan.key } },
    });
    return { url: session.url, mode: 'checkout' };
}

/** Cancel at period end on unlink. Nothing is deleted. */
async function cancelAtPeriodEnd(slug) {
    const sub = await subscriptionRow(slug);
    if (!sub?.stripe_subscription_id || !stripe()) return { cancelled: false };
    await stripe().subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
    return { cancelled: true };
}

module.exports = {
    priceOf,
    itemByKey,
    setItemPrice,
    billingState,
    ensureCustomer,
    chargeInstall,
    removeInstallCharge,
    chargePhoneNumber,
    releasePhoneNumberCharge,
    recordUsage,
    applyStripeEvent,
    cancelAtPeriodEnd,
    checkoutForPlan,
    stripeConfigured: () => !!stripe(),
    _setStripe: (client) => { stripeClient = client; },
};
