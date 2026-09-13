// ============================================================
// STRIPE CONNECT — one account per business, keyed by slug.
// ============================================================
//
// The money model, stated once so nobody has to infer it from the calls:
//
//   DESTINATION CHARGES. The platform creates the charge, Stripe settles it
//   into the business's own connected account, and the platform's cut is
//   taken as an `application_fee_amount` on the way past. The business is
//   paid out by Stripe on its own schedule, to its own bank, and the
//   platform never holds their money or becomes their bank.
//
// Why not the alternatives:
//   - Direct charges would put every webhook on the connected account and
//     make one endpoint into hundreds.
//   - Separate charges and transfers would mean the platform IS holding
//     their funds, with the licensing that implies.
//
// ── What this file is replacing ─────────────────────────────────────────
//
// `routes/stripe.js` asks businesses to paste their own `sk_live_…` secret
// key, encrypts it and charges with it. That works, and it is a standing
// liability: a stolen encryption key is every business's Stripe account at
// once, and nothing about a booking needs that much power. A Connect
// account id (`acct_…`) is not a credential — it is useless without the
// platform key that signs for it. Nothing stored here can be stolen and
// spent. The old route is left alone for whatever still calls it; new
// booking money goes through this one.
//
// ── The platform's cut is configuration ─────────────────────────────────
//
// `platform_fee_rules` decides the fee, per business if need be. A business
// negotiated to zero is a row in a table, not a special case in a function.
// ============================================================

'use strict';

const supabase = require('../db');
const { applicationFee } = require('./bookingCore');

const API_VERSION = '2024-06-20';

/** The platform's own Stripe client, or null when no key is configured. */
function stripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    return require('stripe')(key, { apiVersion: API_VERSION });
}

/** True when this deployment can take money at all. */
function configured() {
    return !!process.env.STRIPE_SECRET_KEY;
}

function dashboardBase() {
    return (process.env.DASHBOARD_URL || 'https://cybercheck-login.vercel.app').replace(/\/+$/, '');
}
function publicBase() {
    return (process.env.PUBLIC_PAGE_BASE_URL || 'https://gulfcoastradar.com').replace(/\/+$/, '');
}

/* ── the account row ────────────────────────────────────────────────── */

/** This business's payment account row, or null. Never throws. */
async function getAccount(entitySlug) {
    if (!entitySlug) return null;
    const { data } = await supabase
        .from('payment_accounts')
        .select('*')
        .eq('entity_slug', entitySlug)
        .eq('provider', 'stripe')
        .maybeSingle();
    return data || null;
}

/** Which business an `acct_…` belongs to — the webhook's reverse lookup. */
async function slugForAccount(accountId) {
    if (!accountId) return null;
    const { data } = await supabase
        .from('payment_accounts')
        .select('entity_slug')
        .eq('account_id', accountId)
        .maybeSingle();
    return (data && data.entity_slug) || null;
}

/**
 * Create this business's Connect account if it has none yet.
 *
 * Express accounts: Stripe runs the onboarding and the identity checks,
 * and hosts a dashboard the business can log into for its own payouts.
 * We never see a bank number or a social security number, which is the
 * point — that data is a liability nobody here wants to hold.
 */
async function ensureAccount(entitySlug, entity) {
    const client = stripe();
    if (!client) throw new Error('Stripe is not configured on this deployment.');

    const existing = await getAccount(entitySlug);
    if (existing && existing.account_id) return existing;

    const account = await client.accounts.create({
        type: 'express',
        country: (existing && existing.country) || 'US',
        email: (entity && entity.email) || undefined,
        business_profile: {
            name: (entity && entity.name) || entitySlug,
            url: (entity && entity.website_url) || undefined,
            support_phone: (entity && entity.phone) || undefined,
        },
        capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
        },
        metadata: { entity_slug: entitySlug },
    });

    const row = {
        entity_slug: entitySlug,
        provider: 'stripe',
        account_id: account.id,
        account_type: 'express',
        country: account.country || 'US',
        default_currency: (account.default_currency || 'usd').toLowerCase(),
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
        details_submitted: !!account.details_submitted,
        requirements: account.requirements || {},
        livemode: !!account.livemode,
        business_profile: account.business_profile || {},
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
        .from('payment_accounts')
        .upsert(row, { onConflict: 'entity_slug,provider' })
        .select('*')
        .single();
    if (error) throw new Error(error.message);
    return data;
}

/**
 * A one-time link into Stripe's hosted onboarding.
 *
 * These expire in minutes and are single-use by design, so the dashboard
 * asks for a fresh one every time rather than storing the URL anywhere.
 */
async function onboardingLink(entitySlug, entity, options) {
    const client = stripe();
    if (!client) throw new Error('Stripe is not configured on this deployment.');

    const account = await ensureAccount(entitySlug, entity);
    const opts = options || {};
    const base = dashboardBase();

    const link = await client.accountLinks.create({
        account: account.account_id,
        refresh_url: opts.refreshUrl || (base + '/#bookings/payments?stripe=refresh'),
        return_url: opts.returnUrl || (base + '/#bookings/payments?stripe=return'),
        type: 'account_onboarding',
        collection_options: { fields: 'eventually_due' },
    });

    return { url: link.url, expires_at: link.expires_at, account_id: account.account_id };
}

/** Re-read the account from Stripe and write what changed back down. */
async function syncAccount(entitySlug) {
    const client = stripe();
    const row = await getAccount(entitySlug);
    if (!client || !row || !row.account_id) return row;

    let account;
    try {
        account = await client.accounts.retrieve(row.account_id);
    } catch (err) {
        // A deleted or rejected account must not take down the settings page.
        console.error('[stripeConnect] retrieve failed for', entitySlug, err.message);
        return row;
    }

    const patch = {
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
        details_submitted: !!account.details_submitted,
        requirements: account.requirements || {},
        default_currency: (account.default_currency || row.default_currency || 'usd').toLowerCase(),
        business_profile: account.business_profile || {},
        livemode: !!account.livemode,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    if (account.charges_enabled && !row.onboarded_at) patch.onboarded_at = new Date().toISOString();

    const { data } = await supabase
        .from('payment_accounts')
        .update(patch)
        .eq('entity_slug', entitySlug)
        .eq('provider', 'stripe')
        .select('*')
        .maybeSingle();
    return data || Object.assign({}, row, patch);
}

/** A link into the business's own Stripe Express dashboard. */
async function loginLink(entitySlug) {
    const client = stripe();
    if (!client) throw new Error('Stripe is not configured on this deployment.');
    const row = await getAccount(entitySlug);
    if (!row || !row.account_id) throw new Error('This business has not connected Stripe yet.');
    const link = await client.accounts.createLoginLink(row.account_id);
    return { url: link.url };
}

/** Can this business actually be paid right now? */
function canAcceptPayments(account) {
    return !!(account && account.account_id && account.charges_enabled);
}

/* ── the fee ────────────────────────────────────────────────────────── */

/** Every active fee rule, for bookingCore.applicationFee to choose from. */
async function feeRules() {
    const { data, error } = await supabase
        .from('platform_fee_rules')
        .select('scope, entity_slug, template_id, percent, fixed_cents, min_cents, max_cents, active')
        .eq('active', true)
        .limit(500);
    if (error) {
        console.error('[stripeConnect] fee rules unreadable:', error.message);
        return [];
    }
    return data || [];
}

/** The platform's cut of one charge, in cents. */
async function feeForCharge(input) {
    return applicationFee({
        rules: await feeRules(),
        entitySlug: input.entitySlug,
        templateId: input.templateId,
        amountCents: input.amountCents,
        fallbackPercent: parseFloat(process.env.PLATFORM_FEE_PERCENT || '0'),
    });
}

/* ── taking the money ───────────────────────────────────────────────── */

/**
 * A hosted Stripe Checkout session for one booking.
 *
 * Stripe's own page handles the card form, 3-D Secure, Apple and Google
 * Pay, and every card-data rule that comes with them. Writing that here
 * would mean owning PCI scope for no gain.
 *
 * The amount is passed in cents from a server-side quote. There is no
 * path by which a browser reaches this function with a price of its own.
 */
async function createCheckoutSession(input) {
    const client = stripe();
    if (!client) throw new Error('Stripe is not configured on this deployment.');

    const account = input.account;
    if (!canAcceptPayments(account)) {
        throw new Error('This business has not finished connecting Stripe, so it cannot take payments yet.');
    }

    const amountCents = Math.max(0, Math.round(input.amountCents || 0));
    if (amountCents <= 0) throw new Error('Nothing to charge.');

    const currency = (input.currency || account.default_currency || 'usd').toLowerCase();
    const fee = Math.max(0, Math.round(input.applicationFeeCents || 0));

    const session = await client.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
            quantity: 1,
            price_data: {
                currency: currency,
                unit_amount: amountCents,
                product_data: {
                    name: input.title || 'Booking',
                    description: input.description || undefined,
                },
            },
        }],
        customer_email: input.customerEmail || undefined,
        client_reference_id: input.bookingId || undefined,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: input.expiresAt || undefined,
        payment_intent_data: {
            // The business is the one settling the charge; the platform takes
            // its fee in the same movement and never holds the balance.
            application_fee_amount: fee > 0 ? fee : undefined,
            transfer_data: { destination: account.account_id },
            on_behalf_of: account.account_id,
            description: input.title || 'Booking',
            metadata: bookingMetadata(input),
        },
        metadata: bookingMetadata(input),
    });

    return session;
}

function bookingMetadata(input) {
    return {
        booking_id: String(input.bookingId || ''),
        entity_slug: String(input.entitySlug || ''),
        product_id: String(input.productId || ''),
        template_id: String(input.templateId || ''),
        kind: String(input.kind || 'payment'),
    };
}

/**
 * Refund a charge, pulling the platform's fee back with it.
 *
 * `reverse_transfer` claws the money back out of the business's balance and
 * `refund_application_fee` returns the platform's cut, so a refunded
 * booking leaves nobody holding a share of a trip that did not happen.
 */
async function refundPayment(input) {
    const client = stripe();
    if (!client) throw new Error('Stripe is not configured on this deployment.');
    if (!input.paymentIntentId) throw new Error('Nothing to refund — this booking was not paid through Stripe.');

    const params = {
        payment_intent: input.paymentIntentId,
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: {
            booking_id: String(input.bookingId || ''),
            entity_slug: String(input.entitySlug || ''),
        },
    };
    if (input.amountCents != null) params.amount = Math.max(0, Math.round(input.amountCents));
    if (input.reason) params.reason = input.reason;

    return client.refunds.create(params);
}

/** Verify a webhook signature, or throw. Never trust an unsigned event. */
function constructEvent(rawBody, signature) {
    const client = stripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!client) throw new Error('Stripe is not configured on this deployment.');
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set — refusing to trust an unverified event.');
    return client.webhooks.constructEvent(rawBody, signature, secret);
}

/** The balance and next payout, for the dashboard's Payments tab. */
async function accountSummary(entitySlug) {
    const client = stripe();
    const row = await getAccount(entitySlug);
    if (!client || !canAcceptPayments(row)) return null;
    try {
        const balance = await client.balance.retrieve({ stripeAccount: row.account_id });
        const sum = function (list) {
            return (list || []).reduce(function (total, item) { return total + (item.amount || 0); }, 0);
        };
        return {
            currency: (row.default_currency || 'usd').toUpperCase(),
            available_cents: sum(balance.available),
            pending_cents: sum(balance.pending),
        };
    } catch (err) {
        console.error('[stripeConnect] balance failed for', entitySlug, err.message);
        return null;
    }
}

module.exports = {
    stripe,
    configured,
    getAccount,
    slugForAccount,
    ensureAccount,
    onboardingLink,
    syncAccount,
    loginLink,
    canAcceptPayments,
    feeRules,
    feeForCharge,
    createCheckoutSession,
    refundPayment,
    constructEvent,
    accountSummary,
    dashboardBase,
    publicBase,
};
