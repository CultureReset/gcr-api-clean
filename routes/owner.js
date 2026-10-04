// ============================================================
// /api/owner — the owner app's screens (Play-user src/lib/business.js)
// ============================================================
//
// Every route is ownerRequired: the business is req.entitySlug, resolved from
// the session (a Paperclip business token -> company_links), never from the
// request. Shapes match what Play-user documents next to each call.
//
//   GET   /bookings?from&to                 { bookings: [...] }
//   GET   /payments?from&to                 { payments: [...] }
//   GET   /messages                         { slug, threads, waiting_for_approval, text_log } (the full inbox)
//   POST  /messages                         { channel, to, subject?, body, hold? } -> { message }
//   GET   /messages/threads                 { threads: [...] }
//   GET   /messages/threads/:id             { thread, messages: [...] }
//   POST  /messages/threads/:id/send        { text } -> { message }
//   POST  /messages/threads/:id/takeover    { owner: bool } -> { thread }
//   PATCH /messages/:id                     { body?, subject? } -> { message } (one that has not gone)
//   POST  /messages/:id/send                send a held or refused message now -> { message }
//   POST  /messages/consent                 { phone, granted?, text?, source? } -> { consent }
//   GET   /messages/numbers                 { numbers: [...] } (the business's numbers, texting registration)
//
// This is the one Messages API (the copy at /api/business/messages was folded
// in here). The rules for what may be sent live in lib/messages.js.
//   GET   /intake/forwarding                { address, confirmation }
//   GET   /intake/senders                   { senders }
//   POST  /intake/senders/:id/approve|block { sender, processed? }
//   PATCH /profile                          { field: value } -> { profile, ignored }
//   POST  /export                           { url, expiresAt }

const express = require('express');
const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const messages = require('../lib/messages');
const intake = require('../lib/intake');
const { forwardingAddressFor } = require('../lib/forwardingAddress');
const { ownerEditableEntityColumns } = require('../lib/businessTables');
const { envInt } = require('../lib/env');

const router = express.Router();
router.use(ownerRequired);

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
const who = (req) => (req.paperclip?.userId ? `paperclip:${req.paperclip.userId}` : req.ownerUserId || null);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const listLimit = () => envInt('OWNER_LIST_LIMIT', 500);

/** A date and an optional wall-clock time as one local ISO-like string. */
function localStamp(date, time) {
    if (!date) return null;
    const t = String(time || '').trim().match(/^(\d{1,2}):(\d{2})/);
    return t ? `${String(date).slice(0, 10)}T${t[1].padStart(2, '0')}:${t[2]}` : String(date).slice(0, 10);
}

/* ── bookings ─────────────────────────────────────────────────────────── */

router.get('/bookings', async (req, res) => {
    const { from, to } = req.query;
    let q = supabase.from('booking_calendar').select('*').eq('entity_slug', req.entitySlug).eq('kind', 'booking');
    if (isDate(from)) q = q.gte('date', from);
    if (isDate(to)) q = q.lte('date', to);
    const { data, error } = await q.order('date', { ascending: true }).limit(listLimit());
    if (error) return fail(res, { status: 500, message: error.message });
    res.json({
        bookings: (data || []).map((b) => {
            const d = b.details && typeof b.details === 'object' ? b.details : {};
            return {
                id: b.id,
                title: b.title || null,
                start: localStamp(b.date, b.start_time),
                end: localStamp(b.end_date || b.date, d.end_time || b.end_time),
                status: b.status || null,
                source: b.source || null,
                customer_name: d.customer_name || d.guest_name || d.customer || null,
                party_size: b.party ?? null,
                staff: d.staff || d.staff_name || null,
                notes: d.notes || d.special_requests || null,
            };
        }),
    });
});

/* ── payments ─────────────────────────────────────────────────────────── */

router.get('/payments', async (req, res) => {
    const { from, to } = req.query;
    let q = supabase.from('payments_detected').select('*').eq('entity_slug', req.entitySlug);
    if (isDate(from)) q = q.gte('received_at', `${from}T00:00:00Z`);
    if (isDate(to)) q = q.lte('received_at', `${to}T23:59:59Z`);
    const { data, error } = await q.order('received_at', { ascending: false }).limit(listLimit());
    if (error) return res.status(503).json({ error: `Payments are not set up on this database yet: ${error.message}` });
    res.json({
        payments: (data || []).map((p) => ({
            id: p.id,
            amount_cents: p.amount_cents,
            currency: p.currency,
            payer: p.payer || null,
            source: p.source,
            status: p.status,
            received_at: p.received_at,
        })),
    });
});

/* ── messages ─────────────────────────────────────────────────────────── */

const messageOut = (m) => ({ id: m.id, direction: m.direction, text: m.body, subject: m.subject || undefined, at: m.sent_at || m.created_at, author: m.author, status: m.status, status_reason: m.status_reason || undefined });

router.get('/messages/threads', async (req, res) => {
    try {
        const box = await messages.inbox(req.entitySlug, { limit: req.query.limit });
        const ids = box.threads.map((t) => t.id);
        const { data: inbound } = ids.length
            ? await supabase.from('business_messages').select('thread_id, created_at').in('thread_id', ids).eq('direction', 'in')
            : { data: [] };
        const readAt = Object.fromEntries(box.threads.map((t) => [t.id, t.owner_read_at || null]));
        const unread = {};
        for (const m of inbound || []) {
            if (!readAt[m.thread_id] || m.created_at > readAt[m.thread_id]) unread[m.thread_id] = (unread[m.thread_id] || 0) + 1;
        }
        res.json({
            threads: box.threads.map((t) => ({
                id: t.id,
                channel: t.channel,
                contact: t.customer_address,
                last_message: t.last_message?.body || null,
                last_at: t.last_message_at || t.last_message?.created_at || null,
                unread: unread[t.id] || 0,
                handled_by: t.mode === 'owner' ? 'owner' : 'agent',
            })),
            waiting_for_approval: box.waiting_for_approval,
        });
    } catch (err) { fail(res, err); }
});

router.get('/messages/threads/:id', async (req, res) => {
    try {
        const { thread, messages: rows } = await messages.threadMessages(req.entitySlug, req.params.id);
        await supabase.from('message_threads').update({ owner_read_at: new Date().toISOString() }).eq('id', thread.id).eq('entity_slug', req.entitySlug);
        res.json({
            thread: { id: thread.id, channel: thread.channel, contact: thread.customer_address, handled_by: thread.mode === 'owner' ? 'owner' : 'agent' },
            messages: rows.map(messageOut),
        });
    } catch (err) { fail(res, err); }
});

router.post('/messages/threads/:id/send', async (req, res) => {
    try {
        const { thread } = await messages.threadMessages(req.entitySlug, req.params.id, { limit: 1 });
        const msg = await messages.sendMessage({
            slug: req.entitySlug, channel: thread.channel, to: thread.customer_address, body: req.body?.text,
            subject: req.body?.subject, author: 'owner',
        });
        res.status(msg.status === 'sent' ? 201 : 202).json({ message: messageOut(msg) });
    } catch (err) { fail(res, err); }
});

router.post('/messages/threads/:id/takeover', async (req, res) => {
    try {
        // `owner` (this API) or `on` (the folded-in /api/business/messages).
        const on = req.body?.owner ?? req.body?.on;
        const t = await messages.setTakeOver(req.entitySlug, req.params.id, on !== false, who(req));
        res.json({ thread: { id: t.id, handled_by: t.mode === 'owner' ? 'owner' : 'agent' } });
    } catch (err) { fail(res, err); }
});

/** The full inbox: threads with their last message, the waiting count, the older text log. */
router.get('/messages', async (req, res) => {
    try {
        res.json({ slug: req.entitySlug, ...(await messages.inbox(req.entitySlug, { limit: req.query.limit })) });
    } catch (err) { fail(res, err); }
});

/** A new message to a customer; `hold` keeps it for the owner to send later. */
router.post('/messages', async (req, res) => {
    const b = req.body || {};
    try {
        const msg = await messages.sendMessage({
            slug: req.entitySlug,
            channel: b.channel,
            to: b.to,
            subject: b.subject,
            body: b.body,
            requireApproval: b.hold === true,
            author: 'owner',
        });
        res.status(msg.status === 'sent' ? 201 : 202).json({ message: msg });
    } catch (err) { fail(res, err); }
});

/** Record a customer's yes or no to texts. */
router.post('/messages/consent', async (req, res) => {
    try {
        const row = await messages.recordConsent(req.entitySlug, req.body?.phone, {
            granted: req.body?.granted !== false,
            source: typeof req.body?.source === 'string' ? req.body.source.slice(0, 80) : 'owner',
            text: typeof req.body?.text === 'string' ? req.body.text.slice(0, 1000) : null,
            by: who(req),
        });
        res.status(201).json({ consent: row });
    } catch (err) { fail(res, err); }
});

/** The business's numbers and where their texting registration stands. */
router.get('/messages/numbers', async (req, res) => {
    const { data, error } = await supabase.from('business_phone_numbers')
        .select('phone_number, purpose, status, registration_status, registration_note, registration_updated_at, created_at, released_at')
        .eq('entity_slug', req.entitySlug).order('created_at', { ascending: false });
    if (error) return res.status(503).json({ error: `Numbers are not set up on this database yet: ${error.message}` });
    res.json({ numbers: data || [] });
});

/** Edit a message that has not gone yet. */
router.patch('/messages/:id', async (req, res) => {
    try {
        res.json({ message: await messages.editMessage(req.entitySlug, req.params.id, req.body || {}) });
    } catch (err) { fail(res, err); }
});

/** Send a held (or refused) message now. */
router.post('/messages/:id/send', async (req, res) => {
    try {
        const msg = await messages.sendExisting(req.entitySlug, req.params.id);
        res.status(msg?.status === 'sent' ? 200 : 202).json({ message: msg });
    } catch (err) { fail(res, err); }
});

/* ── forwarded email ──────────────────────────────────────────────────── */

router.get('/intake/forwarding', async (req, res) => {
    const c = await intake.latestConfirmation(req.entitySlug);
    res.json({
        address: forwardingAddressFor(req.entitySlug),
        confirmation: c ? { provider: c.provider, code: c.code, link: c.link || null, mailbox: c.mailbox || null, received_at: c.received_at } : null,
    });
});

router.get('/intake/senders', async (req, res) => {
    try { res.json({ senders: await intake.listSenders(req.entitySlug) }); } catch (err) { fail(res, err); }
});

for (const action of ['approve', 'block']) {
    router.post(`/intake/senders/:id/${action}`, async (req, res) => {
        try {
            const sender = await intake.decideSender(req.entitySlug, req.params.id, action === 'approve', who(req));
            const processed = action === 'approve'
                ? await require('./email-parser').processHeld(req.entitySlug, sender.sender)
                : 0;
            res.json({ sender, processed });
        } catch (err) { fail(res, err); }
    });
}

/* ── the business record ──────────────────────────────────────────────── */

router.patch('/profile', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    try {
        const allowed = new Set(await ownerEditableEntityColumns());
        const patch = {};
        const ignored = [];
        for (const [k, v] of Object.entries(body)) {
            if (allowed.has(k)) patch[k] = v === '' ? null : v;
            else ignored.push(k);
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing here can be changed.', ignored });
        const { data, error } = await supabase.from('entity').update(patch).eq('slug', req.entitySlug).select('*');
        if (error) return res.status(400).json({ error: error.message });
        res.json({ profile: data?.[0] || null, ignored });
    } catch (err) { fail(res, err); }
});

/* ── export ───────────────────────────────────────────────────────────── */

router.post('/export', async (req, res) => {
    try {
        const out = await require('../lib/exportBusiness').exportBusiness(req.entitySlug);
        res.json({ url: out.url, expiresAt: out.expiresAt });
    } catch (err) { fail(res, err); }
});

module.exports = router;
