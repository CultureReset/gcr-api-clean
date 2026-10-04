// ============================================================
// /api/notify-settings — where the owner hears about things (lib/notify.js)
// ============================================================
//
// The business comes from the session (ownerRequired), never the request.

const express = require('express');
const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const { KINDS } = require('../lib/notify');
const { normalizePhone } = require('../lib/telephony');

const router = express.Router();

router.get('/', ownerRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('owner_notify_settings')
        .select('email, phone, email_on, sms_on, muted_kinds, updated_at')
        .eq('entity_slug', req.entitySlug)
        .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const { data: recent } = await supabase
        .from('owner_notifications')
        .select('kind, title, channels, created_at')
        .eq('entity_slug', req.entitySlug)
        .order('created_at', { ascending: false })
        .limit(20);
    res.json({ settings: data || null, kinds: KINDS, recent: recent || [] });
});

router.put('/', ownerRequired, async (req, res) => {
    const b = req.body || {};
    const row = { entity_slug: req.entitySlug, updated_at: new Date().toISOString() };
    if (b.email !== undefined) {
        const email = b.email ? String(b.email).trim() : null;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'That is not an email address.' });
        row.email = email;
    }
    if (b.phone !== undefined) {
        const phone = b.phone ? normalizePhone(b.phone) : null;
        if (b.phone && !phone) return res.status(400).json({ error: 'That is not a phone number.' });
        row.phone = phone;
    }
    if (b.email_on !== undefined) row.email_on = !!b.email_on;
    if (b.sms_on !== undefined) row.sms_on = !!b.sms_on;
    if (b.muted_kinds !== undefined) {
        if (!Array.isArray(b.muted_kinds) || b.muted_kinds.some((k) => !KINDS.includes(k))) {
            return res.status(400).json({ error: `muted_kinds must be a list of: ${KINDS.join(', ')}` });
        }
        row.muted_kinds = b.muted_kinds;
    }
    const { data, error } = await supabase
        .from('owner_notify_settings')
        .upsert(row, { onConflict: 'entity_slug' })
        .select('email, phone, email_on, sms_on, muted_kinds, updated_at')
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data });
});

module.exports = router;
