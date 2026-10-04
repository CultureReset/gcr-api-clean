// ============================================================
// INTAKE — forwarding confirmations and known senders (plan §9)
// ============================================================
//
// Two checks every email forwarded to a business's address goes through
// before it is read as a booking or a payment (routes/email-parser.js,
// routes/email-webhook.js):
//
//   1. Is it a mail provider asking to confirm forwarding? Gmail and Outlook
//      send a code (and a link) to the forwarding address before they forward
//      automatically. Which emails those are is data
//      (forwarding_confirmation_rules), not code. The code is stored
//      (forwarding_confirmations) and the owner app shows it in onboarding
//      (GET /api/owner/intake/forwarding).
//
//   2. Is the sender one this business forwards from? A sender not approved
//      in intake_known_senders waits for review: the email is logged as held,
//      the owner is told once per sender, and approving the sender processes
//      what was held (routes/email-parser.js).
//
// A database without sql/nextgent_intake.sql keeps the old behaviour: no
// confirmations recognised, every sender trusted.

const supabase = require('../db');
const { notifyOwner } = require('./notify');

const RULES_TTL_MS = 5 * 60 * 1000;
let rulesCache = { at: 0, rules: null };

const missing = (error) => /(does not exist|schema cache)/i.test(error?.message || '');

function compile(pattern) {
    if (!pattern) return null;
    try { return new RegExp(pattern, 'i'); } catch {
        console.warn('[intake] a forwarding_confirmation_rules pattern is not a valid regex:', pattern);
        return null;
    }
}

async function confirmationRules() {
    if (rulesCache.rules && Date.now() - rulesCache.at < RULES_TTL_MS) return rulesCache.rules;
    const { data, error } = await supabase.from('forwarding_confirmation_rules').select('*').eq('enabled', true);
    const rules = error ? [] : (data || []).map((r) => ({
        provider: r.provider,
        label: r.label,
        from: compile(r.from_pattern),
        subject: compile(r.subject_pattern),
        code: compile(r.code_pattern),
        link: compile(r.link_pattern),
        mailbox: compile(r.mailbox_pattern),
    })).filter((r) => r.from);
    rulesCache = { at: Date.now(), rules };
    return rules;
}

/** The bare address out of a From header ("Name <a@b.c>" → "a@b.c"). */
function senderAddress(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return String(m ? m[1] : from || '').trim().toLowerCase();
}

/**
 * Is this email a provider's forwarding confirmation? Returns
 * { provider, label, code, link, mailbox } or null.
 */
async function matchConfirmation({ from, subject, text, html }) {
    const sender = senderAddress(from);
    const body = `${subject || ''}\n${text || ''}\n${String(html || '').replace(/<[^>]+>/g, ' ')}`;
    for (const rule of await confirmationRules()) {
        if (!rule.from.test(sender)) continue;
        if (rule.subject && !rule.subject.test(String(subject || ''))) continue;
        const code = rule.code ? (body.match(rule.code) || [])[1] || null : null;
        const link = rule.link ? ((`${text || ''}\n${html || ''}`).match(rule.link) || [])[1] || null : null;
        if (!code && !link) continue;
        const mailbox = rule.mailbox ? (body.match(rule.mailbox) || [])[1] || null : null;
        return { provider: rule.provider, label: rule.label, code, link: link ? link.replace(/["'<>].*$/, '') : null, mailbox };
    }
    return null;
}

/** Store a confirmation for the owner app. */
async function recordConfirmation(slug, found, { from, subject } = {}) {
    const { data, error } = await supabase.from('forwarding_confirmations').insert({
        entity_slug: slug,
        provider: found.provider,
        code: found.code,
        link: found.link,
        mailbox: found.mailbox,
        from_email: senderAddress(from),
        subject: subject ? String(subject).slice(0, 300) : null,
        received_at: new Date().toISOString(),
    }).select('*').single();
    if (error) {
        console.error('[intake] confirmation not stored:', error.message);
        return null;
    }
    return data;
}

/** The newest confirmation for a business, or null. */
async function latestConfirmation(slug) {
    const { data, error } = await supabase.from('forwarding_confirmations').select('*')
        .eq('entity_slug', slug).order('received_at', { ascending: false }).limit(1);
    if (error) return null;
    return data?.[0] || null;
}

/**
 * May this sender's mail be read for this business?
 * Resolves 'known' | 'held' | 'blocked'. A new sender is recorded as pending
 * and the owner is told (once per sender).
 */
async function checkSender(slug, from, { subject } = {}) {
    const sender = senderAddress(from);
    if (!slug || !sender) return 'known';
    const { data, error } = await supabase.from('intake_known_senders').select('id, status')
        .eq('entity_slug', slug).eq('sender', sender).maybeSingle();
    if (error) return missing(error) ? 'known' : 'held';
    if (data?.status === 'approved') return 'known';
    if (data?.status === 'blocked') return 'blocked';
    if (!data) {
        await supabase.from('intake_known_senders').insert({
            entity_slug: slug, sender, status: 'pending', example_subject: subject ? String(subject).slice(0, 300) : null,
        });
    }
    await notifyOwner(slug, {
        kind: 'unknown_sender',
        title: `Forwarded mail from ${sender} is waiting for you`,
        body: `Is ${sender} one of your booking or payment platforms? Approve it and its mail is read; until then it waits.${subject ? `\n\n${subject}` : ''}`.slice(0, 500),
        ref: `sender:${sender}`,
        link: process.env.OWNER_REVIEW_PATH || null,
    });
    return 'held';
}

/** Owner approves (or blocks) a sender. Returns the row. */
async function decideSender(slug, id, approve, by = null) {
    const { data, error } = await supabase.from('intake_known_senders')
        .update({ status: approve ? 'approved' : 'blocked', decided_at: new Date().toISOString(), decided_by: by })
        .eq('id', id).eq('entity_slug', slug).select('*');
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    if (!data?.length) throw Object.assign(new Error('No such sender.'), { status: 404 });
    return data[0];
}

async function listSenders(slug) {
    const { data, error } = await supabase.from('intake_known_senders').select('*')
        .eq('entity_slug', slug).order('first_seen_at', { ascending: false });
    if (error) throw Object.assign(new Error(`Senders are not set up on this database yet: ${error.message}`), { status: 503 });
    return data || [];
}

module.exports = {
    senderAddress,
    matchConfirmation,
    recordConfirmation,
    latestConfirmation,
    checkSender,
    decideSender,
    listSenders,
    _resetRules: () => { rulesCache = { at: 0, rules: null }; },
};
