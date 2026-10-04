// ============================================================
// PAYMENTS DETECTED — what the owner's Payments screen and payment.received read
// ============================================================
//
// One row per payment the platform saw, from wherever it saw it:
//
//   claimed    read from a forwarded email (Venmo, Cash App, Zelle…). None of
//              them lets a new business verify a payment, so it stays claimed
//              until matched to a request (plan §9).
//   verified   a provider's signed webhook said so (Stripe).
//
// The same payment seen twice (same business, source and reference) is
// recorded once and announced once (payment.received, lib/businessEvents.js).

const supabase = require('../db');
const { paymentReceived } = require('./businessEvents');

const toCents = (amount) => {
    const n = Number(amount);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * @param {string} slug
 * @param {object} p  { amountCents | amount, currency?, payer?, source, status, reference?, receivedAt?, details? }
 * @returns the row, or null when it was already recorded or could not be
 */
async function recordPayment(slug, p) {
    if (!slug || !p?.source) return null;
    const row = {
        entity_slug: slug,
        amount_cents: Number.isInteger(p.amountCents) ? p.amountCents : toCents(p.amount),
        currency: p.currency ? String(p.currency).toLowerCase() : null,
        payer: p.payer ? String(p.payer).slice(0, 200) : null,
        source: String(p.source),
        status: p.status === 'verified' ? 'verified' : 'claimed',
        reference: p.reference ? String(p.reference).slice(0, 200) : null,
        received_at: p.receivedAt || new Date().toISOString(),
        details: p.details || {},
    };
    if (row.reference) {
        const { data: seen } = await supabase.from('payments_detected').select('id')
            .eq('entity_slug', slug).eq('source', row.source).eq('reference', row.reference).maybeSingle();
        if (seen) return null;
    }
    const { data, error } = await supabase.from('payments_detected').insert(row).select('*').single();
    if (error) {
        if (!/(does not exist|schema cache)/i.test(error.message)) console.error('[payments]', error.message);
        // Still an event: the automation should not miss a payment because
        // the table is not there yet.
        await paymentReceived(slug, row);
        return null;
    }
    await paymentReceived(slug, data);
    return data;
}

module.exports = { recordPayment };
