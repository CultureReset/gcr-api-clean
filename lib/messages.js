// ============================================================
// MESSAGES — what a business sends to and hears from its customers
// ============================================================
//
// One copy of messages.send (CONTRACT §6, plan §8 "Sending messages"), used by
// the business MCP tool (routes/mcp.js send_message), the owner app's Messages
// screen (/api/owner/messages, routes/owner.js), the automation `message` step
// (lib/automationEngine.js) and the live text handler (routes/telephony-live.js).
//
// And the one consent check, hasSmsConsent: messages.send uses it, and so does
// textCustomer below, which every other route that texts a customer (booking
// confirmations, reminders, review requests, campaigns …) goes through.
//
// The rules, in the order they are checked:
//
//   email   through utils/email.js, from the platform sender with the
//           business's own address as Reply-To.
//   sms     only from a number registered to this business
//           (business_phone_numbers, status active, registration_status
//           approved — the texting registration is an outside process and is
//           never assumed), and only to a customer who said yes
//           (message_consent granted — opt-ins from the booking forms are
//           recorded there too) and has not opted out (sms_opt_outs, or a
//           revoked consent row).
//   owner   a thread the owner took over (mode 'owner') takes nothing from an
//           agent or an automation until they hand it back.
//   review  requireApproval saves the message as pending_approval and tells
//           the owner; it goes out when they send it from the Messages screen.
//
// A message that may not go is still recorded, as `blocked` with the reason,
// so a quiet refusal is visible. Every message has a thread.

const supabase = require('../db');
const telephony = require('./telephony');
const { notifyOwner } = require('./notify');

const CHANNELS = Object.freeze(['email', 'sms']);
const AUTOMATIC_AUTHORS = new Set(['agent', 'automation', 'concierge']);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** A customer address in the form its channel stores it, or null. */
function addressFor(channel, raw) {
    if (channel === 'sms' || channel === 'voice') return telephony.normalizePhone(raw);
    if (channel === 'email') {
        const v = String(raw || '').trim().toLowerCase();
        return EMAIL_RE.test(v) ? v : null;
    }
    return null;
}

/* ── threads ──────────────────────────────────────────────────────────── */

async function threadFor(slug, channel, customer) {
    const { data: found } = await supabase.from('message_threads').select('*')
        .eq('entity_slug', slug).eq('channel', channel).eq('customer_address', customer).maybeSingle();
    if (found) return found;
    const { data, error } = await supabase.from('message_threads')
        .insert({ entity_slug: slug, channel, customer_address: customer, mode: 'agent', last_message_at: nowIso() })
        .select('*').single();
    if (error) {
        // Lost a race to create it: read the winner.
        const { data: again } = await supabase.from('message_threads').select('*')
            .eq('entity_slug', slug).eq('channel', channel).eq('customer_address', customer).maybeSingle();
        if (again) return again;
        throw httpError(503, `Messages are not set up on this database yet: ${error.message}`);
    }
    return data;
}

async function touchThread(threadId) {
    await supabase.from('message_threads').update({ last_message_at: nowIso() }).eq('id', threadId);
}

/** Owner takes a thread over (on=true) or hands it back to the agents. */
async function setTakeOver(slug, threadId, on, by = null) {
    const { data, error } = await supabase.from('message_threads')
        .update(on ? { mode: 'owner', taken_over_at: nowIso(), taken_over_by: by } : { mode: 'agent', taken_over_at: null, taken_over_by: null })
        .eq('id', threadId).eq('entity_slug', slug).select('*');
    if (error) throw httpError(500, error.message);
    if (!data?.length) throw httpError(404, 'No such conversation.');
    return data[0];
}

/* ── the texting rules ────────────────────────────────────────────────── */

/** The business's registered sending number, or { reason } why there is none. */
async function registeredNumber(slug) {
    const { data, error } = await supabase.from('business_phone_numbers')
        .select('phone_number, registration_status, status')
        .eq('entity_slug', slug).eq('status', 'active');
    if (error) return { reason: 'no_registered_number' };
    const rows = data || [];
    const approved = rows.find((r) => r.registration_status === 'approved');
    if (approved) return { number: approved.phone_number };
    if (rows.length) return { reason: `number_registration_${rows[0].registration_status}` };
    return { reason: 'no_registered_number' };
}

/**
 * Has this customer agreed to texts from this business, and not taken it back?
 * The one consent check. `slug` is the business key consent was recorded
 * under (an entity slug; for the older site_id flows, see businessKeyForSite).
 * Resolves { ok: true } or { ok: false, reason: opted_out | consent_revoked |
 * no_consent | invalid_phone }.
 */
async function hasSmsConsent(slug, rawPhone) {
    const phone = telephony.normalizePhone(rawPhone);
    if (!phone) return { ok: false, reason: 'invalid_phone' };
    const [{ data: optOut }, { data: consent }] = await Promise.all([
        supabase.from('sms_opt_outs').select('id').eq('phone', phone).limit(1),
        supabase.from('message_consent').select('status').eq('entity_slug', slug).eq('channel', 'sms').eq('phone', phone).maybeSingle(),
    ]);
    if (optOut && optOut.length) return { ok: false, reason: 'opted_out' };
    if (consent?.status === 'revoked') return { ok: false, reason: 'consent_revoked' };
    if (consent?.status === 'granted') return { ok: true };
    return { ok: false, reason: 'no_consent' };
}

/**
 * The business key consent is recorded under for an older site_id flow: the
 * site's entity slug when businesses links one, else the site id itself.
 */
async function businessKeyForSite(siteId) {
    if (!siteId) return null;
    const { data } = await supabase.from('businesses').select('entity_slug').eq('id', siteId).maybeSingle();
    return data?.entity_slug || String(siteId);
}

/**
 * Text one customer of one business, if they agreed to it. Every route that
 * texts a customer outside messages.send comes through here, so the consent
 * rule is hasSmsConsent and nothing else.
 *
 * @param {object}  o
 * @param {string}  [o.slug]       the business (entity slug)
 * @param {string}  [o.siteId]     or an older flow's site_id (resolved by businessKeyForSite)
 * @param {string}  o.to           the customer's phone
 * @param {string}  o.body
 * @param {string}  [o.type]       sms_log type
 * @param {string}  [o.relatedId]
 * @param {string}  [o.from]       a sender number, else the platform sender
 * @param {boolean} [o.reply]      an answer to something the customer just asked
 *                                 for (their text, the code they requested):
 *                                 no separate consent needed, opt-outs still apply
 * @returns {Promise<{success, reason?}>} the utils/sms result, or { success: false, reason } when not allowed
 */
async function textCustomer({ slug = null, siteId = null, to, body, type = 'customer', relatedId = null, from = null, reply = false }) {
    const key = slug || await businessKeyForSite(siteId);
    const sms = require('../utils/sms');
    const phone = telephony.normalizePhone(to);
    if (!key || !phone) {
        await sms.logSms(key || siteId, to, body, type, !phone ? 'invalid_phone' : 'no_business', relatedId);
        return { success: false, reason: !phone ? 'invalid_phone' : 'no_business' };
    }
    const consent = await hasSmsConsent(key, phone);
    if (!consent.ok && !(reply && consent.reason === 'no_consent')) {
        await sms.logSms(siteId || key, phone, body, type, consent.reason, relatedId);
        return { success: false, reason: consent.reason };
    }
    return sms.sendSms(phone, body, siteId || key, type, relatedId, from);
}

/** Record a customer's yes or no. */
async function recordConsent(slug, rawPhone, { granted = true, source = null, text = null, by = null } = {}) {
    const phone = telephony.normalizePhone(rawPhone);
    if (!phone) throw httpError(400, 'Not a phone number.');
    const row = {
        entity_slug: slug, channel: 'sms', phone, status: granted ? 'granted' : 'revoked',
        source, consent_text: text, recorded_by: by, recorded_at: nowIso(),
    };
    const { data, error } = await supabase.from('message_consent').upsert(row, { onConflict: 'entity_slug,channel,phone' }).select('*');
    if (error) throw httpError(503, `Consent is not set up on this database yet: ${error.message}`);
    return data?.[0] || row;
}

/* ── sending ──────────────────────────────────────────────────────────── */

async function businessContact(slug) {
    const { data } = await supabase.from('entity').select('name, email').eq('slug', slug).maybeSingle();
    return data || {};
}

async function insertMessage(row) {
    const { data, error } = await supabase.from('business_messages').insert(row).select('*').single();
    if (error) throw httpError(503, `Messages are not set up on this database yet: ${error.message}`);
    return data;
}

async function updateMessage(id, patch) {
    const { data } = await supabase.from('business_messages').update(patch).eq('id', id).select('*');
    return data?.[0] || null;
}

/**
 * Actually put one stored outgoing message on the wire. Returns the updated
 * row. `reply` is an answer to a text the customer just sent: they started
 * the conversation, so no separate consent is needed — but the registered
 * number and their opt-out still apply.
 */
async function deliver(msg, { reply = false } = {}) {
    const slug = msg.entity_slug;
    if (msg.channel === 'email') {
        const { sendEmail } = require('../utils/email');
        const biz = await businessContact(slug);
        const html = `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap">${esc(msg.body)}</div>`;
        const r = await sendEmail({
            to: msg.customer_address,
            subject: msg.subject || biz.name || '',
            html,
            ...(biz.email ? { replyTo: biz.email } : {}),
        });
        return updateMessage(msg.id, r?.success
            ? { status: 'sent', sent_at: nowIso(), provider_message_id: r.messageId || r.id || null, status_reason: null }
            : { status: 'failed', status_reason: r?.reason || 'email_failed' });
    }

    if (msg.channel === 'sms') {
        const from = await registeredNumber(slug);
        if (!from.number) return updateMessage(msg.id, { status: 'blocked', status_reason: from.reason });
        const consent = await hasSmsConsent(slug, msg.customer_address);
        if (!consent.ok && !(reply && consent.reason === 'no_consent')) return updateMessage(msg.id, { status: 'blocked', status_reason: consent.reason });
        const { sendSms } = require('../utils/sms');
        const r = await sendSms(msg.customer_address, msg.body, slug, 'business_message', msg.id, from.number);
        return updateMessage(msg.id, r?.success
            ? { status: 'sent', sent_at: nowIso(), business_address: from.number, provider_message_id: r.id || null, status_reason: r.relayed ? 'relayed_to_owner' : null }
            : { status: r?.reason === 'opted_out' ? 'blocked' : 'failed', status_reason: r?.reason || 'sms_failed', business_address: from.number });
    }
    return updateMessage(msg.id, { status: 'failed', status_reason: 'unknown_channel' });
}

/**
 * messages.send. One message to one customer of one business.
 *
 * @param {object} o
 * @param {string} o.slug           the business — always from the caller's credential
 * @param {string} o.channel        email | sms
 * @param {string} o.to             the customer's address or phone
 * @param {string} o.body
 * @param {string} [o.subject]      email only
 * @param {string} o.author         owner | agent | automation | concierge
 * @param {boolean} [o.requireApproval] hold for the owner instead of sending
 * @param {string} [o.installId]    the install acting, for the record
 * @param {string} [o.runId]        the automation run acting, for the record
 * @param {boolean} [o.inReplyTo]   an answer to a text the customer just sent (live handler only)
 * @returns {Promise<object>}       the stored message (status says what happened)
 */
async function sendMessage({ slug, channel, to, body, subject = null, author, requireApproval = false, installId = null, runId = null, inReplyTo = false }) {
    if (!slug) throw httpError(400, 'No business.');
    if (!CHANNELS.includes(channel)) throw httpError(400, `channel must be one of ${CHANNELS.join(', ')}.`);
    const text = String(body ?? '').trim();
    if (!text) throw httpError(400, 'Nothing to send.');
    const customer = addressFor(channel, to);
    if (!customer) throw httpError(400, channel === 'sms' ? 'Not a phone number.' : 'Not an email address.');

    const thread = await threadFor(slug, channel, customer);
    const base = {
        entity_slug: slug,
        thread_id: thread.id,
        channel,
        direction: 'out',
        customer_address: customer,
        subject: channel === 'email' ? (subject ? String(subject).slice(0, 300) : null) : null,
        body: text,
        author: author || 'owner',
        install_id: installId,
        automation_run_id: runId ? String(runId) : null,
    };

    if (thread.mode === 'owner' && AUTOMATIC_AUTHORS.has(base.author)) {
        const msg = await insertMessage({ ...base, status: 'blocked', status_reason: 'owner_has_taken_over' });
        await touchThread(thread.id);
        return msg;
    }

    if (requireApproval) {
        const msg = await insertMessage({ ...base, status: 'pending_approval' });
        await touchThread(thread.id);
        await notifyOwner(slug, {
            kind: 'approval',
            title: `A ${channel === 'sms' ? 'text' : 'message'} is waiting for your OK`,
            body: `To ${customer}:\n${text}`.slice(0, 500),
            ref: `message:${msg.id}`,
            link: process.env.OWNER_MESSAGES_PATH || null,
        });
        return msg;
    }

    const queued = await insertMessage({ ...base, status: 'queued' });
    await touchThread(thread.id);
    return (await deliver(queued, { reply: inReplyTo === true })) || queued;
}

/** Owner edits a message that has not gone yet. */
async function editMessage(slug, id, { body, subject } = {}) {
    const { data: msg } = await supabase.from('business_messages').select('*').eq('id', id).eq('entity_slug', slug).maybeSingle();
    if (!msg) throw httpError(404, 'No such message.');
    if (!['draft', 'pending_approval', 'blocked', 'failed'].includes(msg.status)) throw httpError(409, 'That message has already gone.');
    const patch = { edited_at: nowIso() };
    if (body !== undefined) {
        const text = String(body).trim();
        if (!text) throw httpError(400, 'Nothing to send.');
        patch.body = text;
    }
    if (subject !== undefined && msg.channel === 'email') patch.subject = String(subject).slice(0, 300);
    return updateMessage(id, patch);
}

/** Owner sends a held (or previously refused) message now. */
async function sendExisting(slug, id) {
    const { data: msg } = await supabase.from('business_messages').select('*').eq('id', id).eq('entity_slug', slug).maybeSingle();
    if (!msg) throw httpError(404, 'No such message.');
    if (msg.direction !== 'out' || ['sent', 'queued', 'received'].includes(msg.status)) throw httpError(409, 'That message cannot be sent again.');
    const queued = await updateMessage(id, { status: 'queued', status_reason: null, author: 'owner' });
    return (await deliver(queued || msg)) || queued;
}

/** A message from a customer (texts and calls arriving at the business's number). */
async function recordInbound({ slug, channel, from, to = null, body }) {
    const customer = addressFor(channel, from);
    if (!slug || !customer) return null;
    const thread = await threadFor(slug, channel, customer);
    const msg = await insertMessage({
        entity_slug: slug, thread_id: thread.id, channel, direction: 'in', customer_address: customer,
        business_address: to, body: String(body || '').slice(0, 5000) || '(empty)', status: 'received', author: 'customer',
    });
    await touchThread(thread.id);
    return { message: msg, thread };
}

/* ── reading ──────────────────────────────────────────────────────────── */

/**
 * The inbox: threads newest first with their last message, plus the business's
 * older text log (sms_log, keyed by the slug where the platform logged one),
 * read-only, so nothing that was sent before threads existed is hidden.
 */
async function inbox(slug, { limit = 50 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const { data: threads, error } = await supabase.from('message_threads').select('*')
        .eq('entity_slug', slug).order('last_message_at', { ascending: false }).limit(lim);
    if (error) throw httpError(503, `Messages are not set up on this database yet: ${error.message}`);
    const ids = (threads || []).map((t) => t.id);
    const last = {};
    if (ids.length) {
        const { data: msgs } = await supabase.from('business_messages').select('*')
            .in('thread_id', ids).order('created_at', { ascending: false }).limit(lim * 5);
        for (const m of msgs || []) if (!last[m.thread_id]) last[m.thread_id] = m;
    }
    const { data: pending } = await supabase.from('business_messages').select('id')
        .eq('entity_slug', slug).eq('status', 'pending_approval');
    const { data: log } = await supabase.from('sms_log').select('to_phone, message, type, status, created_at')
        .eq('site_id', slug).order('created_at', { ascending: false }).limit(lim);
    return {
        threads: (threads || []).map((t) => ({ ...t, last_message: last[t.id] || null })),
        waiting_for_approval: (pending || []).length,
        text_log: log || [],
    };
}

async function threadMessages(slug, threadId, { limit = 200 } = {}) {
    const { data: thread } = await supabase.from('message_threads').select('*').eq('id', threadId).eq('entity_slug', slug).maybeSingle();
    if (!thread) throw httpError(404, 'No such conversation.');
    const { data } = await supabase.from('business_messages').select('*')
        .eq('thread_id', threadId).eq('entity_slug', slug).order('created_at', { ascending: true })
        .limit(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    return { thread, messages: data || [] };
}

module.exports = {
    CHANNELS,
    addressFor,
    sendMessage,
    editMessage,
    sendExisting,
    recordInbound,
    recordConsent,
    hasSmsConsent,
    textCustomer,
    businessKeyForSite,
    registeredNumber,
    setTakeOver,
    threadFor,
    inbox,
    threadMessages,
};
