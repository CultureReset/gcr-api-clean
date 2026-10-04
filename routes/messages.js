// ============================================================
// /api/business/messages — the owner app's Messages screen
// ============================================================
//
// The business is req.entitySlug from the session (middleware/ownerAuth.js);
// nothing in a request names it. The rules for what may be sent live in
// lib/messages.js, the same copy the MCP send_message tool and the automation
// `message` step use.
//
//   GET    /                       the inbox: threads, last message, waiting count, older text log
//   GET    /threads/:id            one conversation
//   POST   /                       send { channel, to, subject?, body, hold? }
//   PATCH  /:id                    edit a message that has not gone { body?, subject? }
//   POST   /:id/send               send a held or refused message now
//   POST   /threads/:id/take-over  { on: true|false } — the owner answers, agents stop
//   POST   /consent                record a customer's yes or no to texts { phone, granted?, text?, source? }
//   GET    /numbers                the business's numbers and their texting registration

const express = require('express');
const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const messages = require('../lib/messages');

const router = express.Router();
router.use(ownerRequired);

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
const who = (req) => (req.paperclip?.userId ? `paperclip:${req.paperclip.userId}` : req.ownerUserId || null);

router.get('/', async (req, res) => {
    try {
        res.json({ slug: req.entitySlug, ...(await messages.inbox(req.entitySlug, { limit: req.query.limit })) });
    } catch (err) { fail(res, err); }
});

router.get('/numbers', async (req, res) => {
    const { data, error } = await supabase.from('business_phone_numbers')
        .select('phone_number, purpose, status, registration_status, registration_note, registration_updated_at, created_at, released_at')
        .eq('entity_slug', req.entitySlug).order('created_at', { ascending: false });
    if (error) return res.status(503).json({ error: `Numbers are not set up on this database yet: ${error.message}` });
    res.json({ numbers: data || [] });
});

router.get('/threads/:id', async (req, res) => {
    try {
        res.json(await messages.threadMessages(req.entitySlug, req.params.id, { limit: req.query.limit }));
    } catch (err) { fail(res, err); }
});

router.post('/threads/:id/take-over', async (req, res) => {
    try {
        res.json({ thread: await messages.setTakeOver(req.entitySlug, req.params.id, req.body?.on !== false, who(req)) });
    } catch (err) { fail(res, err); }
});

router.post('/consent', async (req, res) => {
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

router.post('/', async (req, res) => {
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

router.patch('/:id', async (req, res) => {
    try {
        res.json({ message: await messages.editMessage(req.entitySlug, req.params.id, req.body || {}) });
    } catch (err) { fail(res, err); }
});

router.post('/:id/send', async (req, res) => {
    try {
        const msg = await messages.sendExisting(req.entitySlug, req.params.id);
        res.status(msg?.status === 'sent' ? 200 : 202).json({ message: msg });
    } catch (err) { fail(res, err); }
});

module.exports = router;
