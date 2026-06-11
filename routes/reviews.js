// ============================================================
// Authentic Review Platform
// POS webhook → review request SMS → customer responds →
// positive: show Google link  |  negative: internal only
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

function getSms() { return require('../utils/sms').sendSms; }

// ─────────────────────────────────────────────────────────────
// POS WEBHOOK — receives daily order data from Toast / Square
// POST /api/reviews/webhook/pos
// Header: x-webhook-secret = REVIEW_WEBHOOK_SECRET env var
// ─────────────────────────────────────────────────────────────

router.post('/webhook/pos', async (req, res) => {
    const secret = process.env.REVIEW_WEBHOOK_SECRET;
    if (secret && req.headers['x-webhook-secret'] !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Accept either a single order or an array
    const orders = Array.isArray(req.body) ? req.body : [req.body];
    const siteId = req.query.site_id || req.body.site_id;
    const results = { imported: 0, skipped: 0, errors: 0 };

    for (const order of orders) {
        try {
            const phone = normalizePhone(order.customer_phone || order.phone || '');
            const externalId = order.id || order.order_id || order.external_id || null;

            // Skip orders with no phone — can't send review request
            if (!phone) { results.skipped++; continue; }

            // Upsert by external_id to avoid duplicates
            const row = {
                site_id:         siteId || order.site_id || null,
                external_id:     externalId,
                customer_phone:  phone,
                customer_name:   order.customer_name || order.name || null,
                table_number:    order.table_number || order.table || null,
                server_name:     order.server || order.server_name || null,
                visit_time:      order.created_at || order.visit_time || order.order_time || new Date().toISOString(),
                items:           order.items || order.line_items || [],
                total:           parseFloat(order.total || order.amount || 0) || null,
                pos_source:      order.source || 'toast',
            };

            const { error } = await supabase.from('pos_orders')
                .upsert(row, { onConflict: 'site_id,external_id', ignoreDuplicates: false })
                .select('id').single();

            if (error) { results.errors++; continue; }
            results.imported++;
        } catch (e) {
            results.errors++;
        }
    }

    res.json(results);
});

// ─────────────────────────────────────────────────────────────
// SEND REVIEW REQUEST — manually or from cron/auto job
// POST /api/reviews/request
// Body: { pos_order_id } OR { customer_phone, customer_name, site_id, items, visit_date, table_number }
// ─────────────────────────────────────────────────────────────

router.post('/request', authRequired, async (req, res) => {
    const { pos_order_id, customer_phone, customer_name, site_id, items, visit_date, table_number, google_url } = req.body;
    const sendSms = getSms();

    let order = null;
    if (pos_order_id) {
        const { data } = await supabase.from('pos_orders').select('*').eq('id', pos_order_id).single();
        order = data;
    }

    const phone    = normalizePhone(order?.customer_phone || customer_phone || '');
    const name     = order?.customer_name || customer_name || '';
    const siteIdFinal = order?.site_id || site_id || req.siteId;
    const itemList = order?.items || items || [];
    const vDate    = order?.visit_time ? new Date(order.visit_time).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : (visit_date || 'recently');
    const tableNum = order?.table_number || table_number || null;

    if (!phone) return res.status(400).json({ error: 'customer_phone required' });

    // Build review request row
    const token = crypto.randomUUID();
    const { data: reqRow, error: reqErr } = await supabase.from('review_requests').insert({
        site_id:       siteIdFinal,
        pos_order_id:  pos_order_id || null,
        customer_phone: phone,
        customer_name: name || null,
        items_ordered: itemList,
        visit_date:    order?.visit_time ? new Date(order.visit_time).toISOString().slice(0, 10) : (visit_date || null),
        table_number:  tableNum,
        token,
        source:        pos_order_id ? 'pos' : 'manual',
    }).select().single();

    if (reqErr) return res.status(500).json({ error: reqErr.message });

    // Mark pos_order as requested
    if (pos_order_id) {
        await supabase.from('pos_orders').update({ review_requested: true }).eq('id', pos_order_id);
    }

    // Build SMS
    const firstName = name ? name.split(' ')[0] : 'there';
    const itemNames = itemList.slice(0, 2).map(i => i.name || i.item_name || i).filter(Boolean);
    const itemMention = itemNames.length > 0
        ? ` — especially the ${itemNames.join(' and ')}`
        : '';

    const reviewUrl = `https://cybercheck-links.vercel.app/review.html?t=${token}`;
    const msg = `Hey ${firstName}! Hope you enjoyed your visit ${vDate}${itemMention}. We'd love your honest feedback — it takes 30 seconds and means a lot to us:\n\n${reviewUrl}\n\nOr just reply 1–5 ⭐`;

    try {
        await sendSms(phone, msg, siteIdFinal, 'review_request');
    } catch (e) {
        return res.status(500).json({ error: 'SMS failed: ' + e.message });
    }

    res.status(201).json({ ok: true, request_id: reqRow.id, token });
});

// ─────────────────────────────────────────────────────────────
// AUTO-SEND CRON — send requests for yesterday's POS orders
// GET /api/reviews/send-daily  (secured by CRON_SECRET)
// ─────────────────────────────────────────────────────────────

router.get('/send-daily', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== 'Bearer ' + secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStart = new Date(yesterday); yStart.setHours(0, 0, 0, 0);
    const yEnd   = new Date(yesterday); yEnd.setHours(23, 59, 59, 999);

    const { data: orders } = await supabase.from('pos_orders')
        .select('*')
        .eq('review_requested', false)
        .not('customer_phone', 'is', null)
        .gte('visit_time', yStart.toISOString())
        .lte('visit_time', yEnd.toISOString());

    if (!orders || !orders.length) return res.json({ sent: 0, message: 'No orders to process' });

    const sendSms = getSms();
    let sent = 0, failed = 0;

    for (const order of orders) {
        try {
            const token = crypto.randomUUID();
            const firstName = order.customer_name ? order.customer_name.split(' ')[0] : 'there';
            const itemList  = order.items || [];
            const itemNames = itemList.slice(0, 2).map(i => i.name || i.item_name || i).filter(Boolean);
            const itemMention = itemNames.length > 0 ? ` — especially the ${itemNames.join(' and ')}` : '';
            const vDate = new Date(order.visit_time).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
            const reviewUrl = `https://cybercheck-links.vercel.app/review.html?t=${token}`;

            await supabase.from('review_requests').insert({
                site_id: order.site_id, pos_order_id: order.id,
                customer_phone: order.customer_phone, customer_name: order.customer_name,
                items_ordered: itemList,
                visit_date: new Date(order.visit_time).toISOString().slice(0, 10),
                table_number: order.table_number, token, source: 'pos',
            });

            await supabase.from('pos_orders').update({ review_requested: true }).eq('id', order.id);

            const msg = `Hey ${firstName}! Hope you enjoyed your visit ${vDate}${itemMention}.\n\nWe'd love your feedback:\n${reviewUrl}\n\nOr reply 1–5 ⭐`;
            await sendSms(order.customer_phone, msg, order.site_id, 'review_request');
            sent++;
        } catch (e) {
            failed++;
        }
    }

    // Also process consents from the widget where visit_date was yesterday
    const { data: consents } = await supabase.from('customer_consents')
        .select('*')
        .eq('review_sent', false)
        .not('phone', 'is', null)
        .lte('visit_date', yEnd.toISOString().slice(0, 10));

    for (const consent of (consents || [])) {
        try {
            const token = crypto.randomUUID();
            const firstName = consent.name ? consent.name.split(' ')[0] : 'there';
            const itemList  = consent.items || [];
            const itemNames = itemList.slice(0, 2).map(i => i.name || i.item_name || String(i)).filter(Boolean);
            const itemMention = itemNames.length > 0 ? ` — especially the ${itemNames.join(' and ')}` : '';
            const vDate = consent.visit_date
                ? new Date(consent.visit_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
                : 'recently';
            const reviewUrl = `https://cybercheck-links.vercel.app/review.html?t=${token}`;

            await supabase.from('review_requests').insert({
                site_id: consent.site_id, customer_phone: consent.phone,
                customer_name: consent.name, items_ordered: itemList,
                visit_date: consent.visit_date, token, source: 'consent',
            });

            await supabase.from('customer_consents').update({ review_sent: true }).eq('id', consent.id);

            const msg = `Hey ${firstName}! Hope you enjoyed your experience ${vDate}${itemMention}.\n\nWe'd love your honest feedback:\n${reviewUrl}\n\nOr reply 1–5 ⭐`;
            await sendSms(consent.phone, msg, consent.site_id, 'review_request');
            sent++;
        } catch (e) { failed++; }
    }

    res.json({ sent, failed, total: (orders?.length || 0) + (consents?.length || 0) });
});

// ─────────────────────────────────────────────────────────────
// CONSENT — customer opts in at booking time
// POST /api/reviews/consent  (public — no auth)
// ─────────────────────────────────────────────────────────────

router.post('/consent', async (req, res) => {
    const { site_id, phone, name, email, booking_ref, items, visit_date, source } = req.body;
    if (!site_id || !phone) return res.status(400).json({ error: 'site_id and phone required' });

    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ error: 'Invalid phone number' });

    const { error } = await supabase.from('customer_consents').upsert({
        site_id,
        phone:       normalized,
        name:        name  || null,
        email:       email || null,
        booking_ref: booking_ref || null,
        items:       items || [],
        visit_date:  visit_date || null,
        source:      source || 'widget',
        review_sent: false,
        consented_at: new Date().toISOString(),
    }, { onConflict: 'site_id,phone,booking_ref' });

    if (error) return res.status(500).json({ error: error.message });

    // Confirm SMS to customer
    try {
        const sendSms = getSms();
        const firstName = name ? name.split(' ')[0] : 'there';
        await sendSms(normalized, `Hey ${firstName}! Thanks for booking. You'll receive a quick text from us after your visit asking for your feedback. Reply STOP anytime to opt out. 🙏`, site_id, 'consent_confirm');
    } catch (e) {}

    res.json({ ok: true });
});

// GET /api/reviews/consents — admin view of all consents
router.get('/consents', authRequired, async (req, res) => {
    let q = supabase.from('customer_consents').select('*').order('consented_at', { ascending: false }).limit(300);
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─────────────────────────────────────────────────────────────
// INBOUND SMS — Twilio webhook for customer replies
// POST /api/reviews/inbound-sms
// ─────────────────────────────────────────────────────────────

router.post('/inbound-sms', express.urlencoded({ extended: false }), async (req, res) => {
    const from = normalizePhone(req.body.From || '');
    const body = (req.body.Body || '').trim();
    const sendSms = getSms();

    if (!from) return res.status(200).send('');

    // Look up SMS state for this phone
    const { data: state } = await supabase.from('review_sms_state')
        .select('*, review_requests(*)')
        .eq('phone', from)
        .maybeSingle();

    // Check if they have a pending review request
    let request = state?.review_requests || null;
    if (!request) {
        // Find their most recent pending request
        const { data: req2 } = await supabase.from('review_requests')
            .select('*')
            .eq('customer_phone', from)
            .eq('status', 'pending')
            .order('sent_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        request = req2;
    }

    if (!request) {
        res.status(200).send('');
        return;
    }

    const step = state?.step || 'awaiting_rating';

    if (step === 'awaiting_rating') {
        const rating = parseRating(body);
        if (!rating) {
            await sendSms(from, 'Thanks for your message! Reply with a number 1–5 to rate your experience (5 = amazing 🌟)', request.site_id, 'review_prompt');
            res.status(200).send('');
            return;
        }

        // Save state
        await supabase.from('review_sms_state').upsert({
            phone: from, request_id: request.id, step: 'awaiting_text', rating
        }, { onConflict: 'phone' });

        if (rating >= 4) {
            await sendSms(from, `${rating === 5 ? '🌟 Amazing!' : '😊 Great!'} So glad you had a good time! Care to share a few words about your experience? (Or reply SKIP to skip)`, request.site_id, 'review_prompt');
        } else {
            await sendSms(from, `Thank you for letting us know. We're sorry it wasn't perfect — what could we have done better? Your feedback goes directly to the owner.`, request.site_id, 'review_prompt');
        }
    } else if (step === 'awaiting_text') {
        const rating = state.rating;
        const text   = body.toUpperCase() === 'SKIP' ? null : body;

        // Save the review
        const { data: review } = await supabase.from('reviews').insert({
            site_id:           request.site_id,
            review_request_id: request.id,
            customer_phone:    from,
            customer_name:     request.customer_name,
            rating,
            text,
            source:            'sms',
            is_public:         rating >= 4,
        }).select().single();

        // Mark request responded
        await supabase.from('review_requests').update({ status: 'responded', responded_at: new Date().toISOString() }).eq('id', request.id);

        // Clear SMS state
        await supabase.from('review_sms_state').delete().eq('phone', from);

        if (rating >= 4) {
            await sendSms(from, `Thank you so much! 🙏 Your review has been saved on our platform. Future visitors will see your experience when choosing where to go. We appreciate you!`, request.site_id, 'review_thanks');
        } else {
            await sendSms(from, `Thank you for being honest — we really appreciate it. Your feedback goes directly to the owner and won't be shown publicly. We'll work to make it right. 🙏`, request.site_id, 'review_thanks');
            // Notify business owner of critical review
            const { data: biz } = await supabase.from('businesses').select('owner_phone').eq('site_id', request.site_id).maybeSingle();
            if (biz?.owner_phone) {
                const notif = `⚠️ New ${rating}★ internal review from ${request.customer_name || from}:\n\n"${text || '(no text)'}"\n\nVisit: ${request.visit_date || 'recent'}${request.table_number ? ' · Table ' + request.table_number : ''}`;
                await sendSms(biz.owner_phone, notif, request.site_id, 'review_alert').catch(() => {});
            }
        }
    }

    res.status(200).send('');
});

// ─────────────────────────────────────────────────────────────
// WEB SUBMISSION — from review.html page
// POST /api/reviews/submit
// ─────────────────────────────────────────────────────────────

router.post('/submit', async (req, res) => {
    const { token, rating, text, items_feedback } = req.body;
    if (!token || !rating) return res.status(400).json({ error: 'token and rating required' });

    const { data: request } = await supabase.from('review_requests')
        .select('*').eq('token', token).eq('status', 'pending').maybeSingle();
    if (!request) return res.status(404).json({ error: 'Review request not found or already completed' });

    // Save review
    await supabase.from('reviews').insert({
        site_id:           request.site_id,
        review_request_id: request.id,
        customer_phone:    request.customer_phone,
        customer_name:     request.customer_name,
        rating:            parseInt(rating),
        text:              text || null,
        items_feedback:    items_feedback || {},
        source:            'web',
        is_public:         parseInt(rating) >= 4,
    });

    // Mark responded
    await supabase.from('review_requests').update({
        status: 'responded', responded_at: new Date().toISOString()
    }).eq('id', request.id);

    // Alert owner on critical review (1-3 stars)
    if (parseInt(rating) <= 3) {
        const sendSms = getSms();
        const { data: biz } = await supabase.from('businesses').select('owner_phone').eq('site_id', request.site_id).maybeSingle();
        if (biz?.owner_phone) {
            const notif = `⚠️ New ${rating}★ internal review from ${request.customer_name || request.customer_phone}:\n\n"${text || '(no text)'}"\n\nVisit: ${request.visit_date || 'recent'}`;
            sendSms(biz.owner_phone, notif, request.site_id, 'review_alert').catch(() => {});
        }
    }

    res.json({ ok: true, is_public: parseInt(rating) >= 4 });
});

// ─────────────────────────────────────────────────────────────
// GET request info (for review.html to load)
// GET /api/reviews/request/:token
// ─────────────────────────────────────────────────────────────

router.get('/request/:token', async (req, res) => {
    const { data } = await supabase.from('review_requests')
        .select('customer_name, items_ordered, visit_date, table_number, status, site_id')
        .eq('token', req.params.token)
        .maybeSingle();
    if (!data) return res.status(404).json({ error: 'Not found' });

    // Get business name
    const { data: biz } = await supabase.from('businesses').select('name').eq('site_id', data.site_id).maybeSingle();
    res.json({ ...data, business_name: biz?.name || 'Us' });
});

// ─────────────────────────────────────────────────────────────
// PUBLIC — reviews for a business page (no auth)
// GET /api/reviews/public/:site_id
// ─────────────────────────────────────────────────────────────

router.get('/public/:site_id', async (req, res) => {
    const { site_id } = req.params;

    const [reviewsRes, bizRes] = await Promise.all([
        supabase.from('reviews')
            .select('id, customer_name, rating, text, items_feedback, owner_reply, owner_replied_at, created_at, review_requests(visit_date, table_number, items_ordered)')
            .eq('site_id', site_id)
            .eq('is_public', true)
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .limit(200),
        supabase.from('businesses').select('name, logo_url, cover_url').eq('site_id', site_id).maybeSingle(),
    ]);

    const reviews = reviewsRes.data || [];
    const biz     = bizRes.data || {};

    const total = reviews.length;
    const avg   = total ? (reviews.reduce((s, r) => s + r.rating, 0) / total) : 0;
    const dist  = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviews.forEach(r => { dist[r.rating] = (dist[r.rating] || 0) + 1; });

    res.json({
        business: { name: biz.name || 'Business', logo_url: biz.logo_url || null, cover_url: biz.cover_url || null },
        stats: { total, avg: Math.round(avg * 10) / 10, distribution: dist },
        reviews,
    });
});

// ─────────────────────────────────────────────────────────────
// ADMIN — list reviews
// GET /api/reviews
// ─────────────────────────────────────────────────────────────

router.get('/', authRequired, async (req, res) => {
    const { rating, status, limit = 100 } = req.query;
    let q = supabase.from('reviews').select('*, review_requests(visit_date, table_number, items_ordered, pos_order_id)').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    if (rating) q = q.eq('rating', parseInt(rating));
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// GET /api/reviews/stats
router.get('/stats', authRequired, async (req, res) => {
    let q = supabase.from('reviews').select('rating, is_public, google_shared, created_at');
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    const { data } = await q;
    if (!data) return res.json({});
    const total = data.length;
    const avg   = total ? (data.reduce((s, r) => s + r.rating, 0) / total).toFixed(1) : 0;
    const dist  = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    data.forEach(r => { dist[r.rating] = (dist[r.rating] || 0) + 1; });
    res.json({ total, avg, distribution: dist, public_count: data.filter(r => r.is_public).length, google_shared: data.filter(r => r.google_shared).length });
});

// GET /api/reviews/requests — list sent requests
router.get('/requests', authRequired, async (req, res) => {
    let q = supabase.from('review_requests').select('*').order('sent_at', { ascending: false }).limit(200);
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// PATCH /api/reviews/:id — owner reply, toggle public/private
router.patch('/:id', authRequired, async (req, res) => {
    const allowed = ['owner_reply', 'is_public', 'status', 'google_shared'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (updates.owner_reply) updates.owner_replied_at = new Date().toISOString();
    let q = supabase.from('reviews').update(updates).eq('id', req.params.id);
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    const { data, error } = await q.select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// DELETE /api/reviews/:id
router.delete('/:id', authRequired, async (req, res) => {
    let q = supabase.from('reviews').delete().eq('id', req.params.id);
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    const { error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// POS ORDERS — list for admin
// GET /api/reviews/pos-orders
// ─────────────────────────────────────────────────────────────

router.get('/pos-orders', authRequired, async (req, res) => {
    let q = supabase.from('pos_orders').select('*').order('visit_time', { ascending: false }).limit(200);
    if (req.role !== 'admin') q = q.eq('site_id', req.siteId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function normalizePhone(p) {
    if (!p) return '';
    const digits = p.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
    if (digits.length > 7) return '+' + digits;
    return '';
}

function parseRating(text) {
    const t = text.trim().toLowerCase();
    const n = parseInt(t);
    if (n >= 1 && n <= 5) return n;
    if (t.includes('5') || t === 'five' || t.includes('amazing') || t.includes('perfect') || t.includes('excellent')) return 5;
    if (t.includes('4') || t === 'four' || t.includes('good') || t.includes('great')) return 4;
    if (t.includes('3') || t === 'three' || t.includes('ok') || t.includes('average')) return 3;
    if (t.includes('2') || t === 'two' || t.includes('bad') || t.includes('poor')) return 2;
    if (t.includes('1') || t === 'one' || t.includes('terrible') || t.includes('awful')) return 1;
    return null;
}

module.exports = router;
