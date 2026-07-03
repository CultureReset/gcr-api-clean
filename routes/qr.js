// ============================================
// QR Code Tracking — Universal scan intelligence
// Numbered sticker rolls, business cards, ads, tables, anywhere
// ============================================

const express = require('express');
const crypto  = require('crypto');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

const CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous 0/O/1/I/l

function makeCode(len = 8) {
    const bytes = crypto.randomBytes(len);
    return Array.from(bytes).map(b => CHARS[b % CHARS.length]).join('');
}

async function uniqueCode() {
    for (let i = 0; i < 20; i++) {
        const code = makeCode();
        const { data } = await supabase.from('qr_codes').select('id').eq('code', code).maybeSingle();
        if (!data) return code;
    }
    throw new Error('Could not generate unique code');
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin / Dashboard — authenticated
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/qr  — list all codes (admin sees all; business sees theirs)
router.get('/', authRequired, async (req, res) => {
    const { seq_from, seq_to, limit } = req.query;
    let query = supabase
        .from('qr_codes')
        .select('*')
        .order('seq_number', { ascending: false });

    // Non-admin scoped to their site
    if (req.role !== 'admin') query = query.eq('site_id', req.siteId);

    // Optional seq-number range — used by the print-sheet / mailing-batch views
    if (seq_from) query = query.gte('seq_number', parseInt(seq_from, 10));
    if (seq_to)   query = query.lte('seq_number', parseInt(seq_to, 10));
    if (limit)    query = query.limit(parseInt(limit, 10));

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// POST /api/qr/batch  — generate a numbered batch (admin only)
router.post('/batch', authRequired, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { count = 10, site_id, label_prefix = 'Sticker', type = 'general', destination_url, location } = req.body;
    if (count < 1 || count > 5000) return res.status(400).json({ error: 'count must be 1–5000' });

    // Get next seq number
    const { data: last } = await supabase
        .from('qr_codes')
        .select('seq_number')
        .order('seq_number', { ascending: false })
        .limit(1)
        .maybeSingle();

    const startSeq = (last?.seq_number || 0) + 1;
    const rows = [];

    for (let i = 0; i < count; i++) {
        const seq = startSeq + i;
        const code = await uniqueCode();
        rows.push({
            code,
            seq_number: seq,
            type,
            site_id: site_id || null,
            label: `${label_prefix} #${seq}`,
            destination_url: destination_url || null,
            location: location || null,
            scan_url: `https://gcr-unified.vercel.app/q.html?c=${code}`,
            scan_count: 0,
            active: true,
        });
    }

    const { data, error } = await supabase.from('qr_codes').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ created: data.length, start_seq: startSeq, end_seq: startSeq + count - 1, codes: data });
});

// POST /api/qr  — generate a single code
router.post('/', authRequired, async (req, res) => {
    const { type, label, destination_url, metadata, site_id, notes, location, placement } = req.body;
    if (!label) return res.status(400).json({ error: 'label required' });

    // Get next seq number
    const { data: last } = await supabase
        .from('qr_codes')
        .select('seq_number')
        .order('seq_number', { ascending: false })
        .limit(1)
        .maybeSingle();

    const seq = (last?.seq_number || 0) + 1;
    const code = await uniqueCode();
    const assignedSiteId = req.role === 'admin' ? (site_id || req.siteId) : req.siteId;

    const { data, error } = await supabase
        .from('qr_codes')
        .insert({
            code,
            seq_number: seq,
            type: type || 'general',
            site_id: assignedSiteId,
            label,
            destination_url: destination_url || null,
            scan_url: `https://gcr-unified.vercel.app/q.html?c=${code}`,
            metadata: metadata || {},
            notes: notes || null,
            location: location || null,
            placement: placement || 'fixed',
            scan_count: 0,
            active: true,
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// PATCH /api/qr/:id  — update label, destination, active
// DELETE /api/qr/locations/:id — free up an id for reassignment (must be registered
// before the generic DELETE /:id route below, or "/locations" would be swallowed
// as if it were a qr_codes id)
router.delete('/locations/:id', authRequired, async (req, res) => {
    const locId = parseInt(req.params.id, 10);
    const { error } = await supabase.from('qr_locations').delete().eq('id', locId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.patch('/:id', authRequired, async (req, res) => {
    const allowed = ['label', 'destination_url', 'active', 'metadata', 'type', 'notes', 'location', 'placement'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    let query = supabase.from('qr_codes').update(updates).eq('id', req.params.id);
    if (req.role !== 'admin') query = query.eq('site_id', req.siteId);

    const { data, error } = await query.select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// DELETE /api/qr/:id
router.delete('/:id', authRequired, async (req, res) => {
    let query = supabase.from('qr_codes').delete().eq('id', req.params.id);
    if (req.role !== 'admin') query = query.eq('site_id', req.siteId);
    const { error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// GET /api/qr/:id/scans  — scan history for one code
router.get('/:id/scans', authRequired, async (req, res) => {
    let qrQuery = supabase.from('qr_codes').select('id').eq('id', req.params.id);
    if (req.role !== 'admin') qrQuery = qrQuery.eq('site_id', req.siteId);
    const { data: qr } = await qrQuery.maybeSingle();
    if (!qr) return res.status(404).json({ error: 'Not found' });

    const { data, error } = await supabase
        .from('qr_scans')
        .select('*')
        .eq('qr_code_id', req.params.id)
        .order('scanned_at', { ascending: false })
        .limit(500);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// GET /api/qr/:id/events — post-scan events for all scans of a code
router.get('/:id/events', authRequired, async (req, res) => {
    try {
        const { data } = await supabase.from('qr_events')
            .select('*')
            .eq('qr_code_id', req.params.id)
            .order('created_at', { ascending: false })
            .limit(200);
        res.json(data || []);
    } catch (e) {
        res.json([]); // table may not exist yet
    }
});

// GET /api/qr/stats/summary — scan totals across all codes (admin)
router.get('/stats/summary', authRequired, async (req, res) => {
    let query = supabase.from('qr_codes').select('id, label, seq_number, type, scan_count, active, created_at');
    if (req.role !== 'admin') query = query.eq('site_id', req.siteId);
    const { data, error } = await query.order('scan_count', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─────────────────────────────────────────────────────────────────────────────
// QR Locations — numbered (1-9999) name/notes registry, independent of any
// single QR code. Lets staff print "Location ID" stickers ahead of time and
// look up what each number means later (table numbers, condo units, ad spots).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/qr/locations — returns { "1": {name, notes}, "2": {...}, ... }
router.get('/locations', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('qr_locations').select('id, name, notes').order('id');
    if (error) return res.status(500).json({ error: error.message });
    const out = {};
    (data || []).forEach(loc => { out[loc.id] = { name: loc.name, notes: loc.notes || '' }; });
    res.json(out);
});

// POST /api/qr/locations — create or upsert a location by id
// Body: { id, name, notes }
router.post('/locations', authRequired, async (req, res) => {
    const { id, name, notes } = req.body;
    const locId = parseInt(id, 10);
    if (!locId || locId < 1 || locId > 9999) return res.status(400).json({ error: 'id must be between 1 and 9999' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    const { error } = await supabase.from('qr_locations').upsert({
        id: locId,
        name: String(name).trim(),
        notes: notes || null,
        updated_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, id: locId });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public — no auth (scan tracking + phone capture)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/qr/scan/:code  — log scan, return destination
router.post('/scan/:code', async (req, res) => {
    const { data: qr, error } = await supabase
        .from('qr_codes')
        .select('*')
        .eq('code', req.params.code)
        .eq('active', true)
        .maybeSingle();

    if (error || !qr) return res.status(404).json({ error: 'QR code not found' });

    const ua  = req.headers['user-agent'] || '';
    const ip  = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const mob = /mobile|android|iphone|ipad/i.test(ua);

    // Log scan + increment counter
    const { data: scanRow } = await supabase.from('qr_scans').insert({
        qr_code_id:  qr.id,
        device_type: mob ? 'mobile' : 'desktop',
        ip_address:  ip,
        user_agent:  ua,
        scanned_at:  new Date().toISOString(),
    }).select('id').single();

    const newScanCount = (qr.scan_count || 0) + 1;
    supabase.from('qr_codes')
        .update({ scan_count: newScanCount })
        .eq('id', qr.id)
        .then(() => {});

    // ── Instant SMS alert (non-blocking) ──────────────────────────────────────
    const alertPhone = qr.alert_phone || (qr.metadata && qr.metadata.alert_phone);
    if (alertPhone) {
        try {
            const { sendSms } = require('../utils/sms');
            const dt = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
            const locLine = qr.location ? `\n📍 ${qr.location}` : '';
            const body = `🔔 QR Scanned!\n#${qr.seq_number} — ${qr.label}${locLine}\n📱 ${mob ? 'Mobile' : 'Desktop'} · ${dt} CT\nTotal scans: ${newScanCount}`;
            sendSms(alertPhone, body, qr.site_id, 'qr_alert').catch(() => {});
        } catch (e) {}
    }

    res.json({
        type:            qr.type,
        seq_number:      qr.seq_number,
        label:           qr.label,
        destination_url: qr.destination_url,
        metadata:        qr.metadata || {},
        site_id:         qr.site_id,
        scan_id:         scanRow?.id || null,
        code:            qr.code,
    });
});

// POST /api/qr/track — log post-scan behavior event + time-on-page + lead score
router.post('/track', async (req, res) => {
    const { scan_id, qr_code_id, event_type, page_url, page_title, duration_seconds, data } = req.body;
    if (!scan_id && !qr_code_id) return res.status(400).json({ error: 'scan_id or qr_code_id required' });
    try {
        await supabase.from('qr_events').insert({
            scan_id: scan_id || null,
            qr_code_id: qr_code_id || null,
            event_type: event_type || 'page_view',
            page_url: page_url || null,
            page_title: page_title || null,
            duration_seconds: duration_seconds || null,
            data: data || null,
            created_at: new Date().toISOString(),
        });

        // Recompute lead score for this scan
        if (scan_id) {
            const { data: events } = await supabase.from('qr_events').select('event_type,duration_seconds').eq('scan_id', scan_id);
            const { data: scan }   = await supabase.from('qr_scans').select('scanner_phone').eq('id', scan_id).single();
            const totalTime  = (events || []).reduce((s, e) => s + (e.duration_seconds || 0), 0);
            const pageViews  = (events || []).filter(e => e.event_type === 'page_view').length;
            const hasPhone   = !!(scan && scan.scanner_phone);
            // Scoring: 0–100
            // phone captured = +40 pts, every 30s on page = +10 pts (max 40), page views = +5 each (max 20)
            let score = 0;
            if (hasPhone)   score += 40;
            score += Math.min(40, Math.floor(totalTime / 30) * 10);
            score += Math.min(20, pageViews * 5);
            const tier = score >= 70 ? 'on_fire' : score >= 40 ? 'warm' : score >= 15 ? 'interested' : 'cold';
            supabase.from('qr_scans').update({ lead_score: score, lead_tier: tier, time_on_page: totalTime }).eq('id', scan_id).then(() => {});
        }
    } catch (e) {}
    res.json({ ok: true });
});

// POST /api/qr/capture/:code  — attach phone number to this scan (hot lead)
router.post('/capture/:code', async (req, res) => {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const { data: qr } = await supabase
        .from('qr_codes')
        .select('id, site_id')
        .eq('code', req.params.code)
        .maybeSingle();
    if (!qr) return res.status(404).json({ error: 'Not found' });

    // Attach phone to most recent unattributed scan
    const { data: scan } = await supabase
        .from('qr_scans')
        .select('id')
        .eq('qr_code_id', qr.id)
        .is('scanner_phone', null)
        .order('scanned_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    const ops = [];
    if (scan) {
        ops.push(
            supabase.from('qr_scans')
                .update({ scanner_phone: phone, scanner_name: name || null })
                .eq('id', scan.id)
        );
    }

    // Upsert as lead in customers table
    if (qr.site_id) {
        ops.push(
            supabase.from('customers').upsert(
                { site_id: qr.site_id, phone, name: name || '', source: 'qr_scan' },
                { onConflict: 'site_id,phone', ignoreDuplicates: true }
            )
        );
    }

    await Promise.all(ops);
    res.json({ success: true, message: 'Lead captured' });
});

// ═══════════════════════════════════════════════════════════════
// REFERRAL PARTNER SYSTEM
// Rental companies, Airbnbs, hotels get a QR magnet.
// Every tourist who scans and signs up is attributed to them.
// ═══════════════════════════════════════════════════════════════

const gcrDb = require('../db');

// GET /api/qr/partners — list all referral partners
router.get('/partners', async (req, res) => {
    const { data, error } = await gcrDb.from('referral_partners')
        .select('*').order('total_signups', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// POST /api/qr/partners — create a new referral partner + generate their QR code
router.post('/partners', async (req, res) => {
    const { name, email, phone, type = 'rental', referral_rate = 0.05, incentive_text } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    // Generate unique QR code for this partner
    const qrCode = 'ref-' + makeCode(8);

    const { data, error } = await gcrDb.from('referral_partners').insert({
        name, email, phone, type, qr_code: qrCode,
        referral_rate: parseFloat(referral_rate) || 0.05,
        incentive_text: incentive_text || 'Welcome to the Gulf Coast! Get $10 off your first activity booking.',
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Also register the QR code in the main qr_codes table so it tracks scans
    await supabase.from('qr_codes').insert({
        code: qrCode, type: 'referral', label: name,
        location: type, active: true,
        metadata: { partner_id: data.id, partner_type: type, partner_name: name },
        scan_url: `https://gcr-unified.vercel.app/q.html?c=${qrCode}`,
    }).catch(() => {});

    res.status(201).json(data);
});

// PUT /api/qr/partners/:id — update partner
router.put('/partners/:id', async (req, res) => {
    const { error } = await gcrDb.from('referral_partners')
        .update(req.body).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// GET /api/qr/partners/:id/stats — detailed stats for one partner
router.get('/partners/:id/stats', async (req, res) => {
    const { id } = req.params;
    const [partnerRes, eventsRes] = await Promise.all([
        gcrDb.from('referral_partners').select('*').eq('id', id).single(),
        gcrDb.from('referral_events').select('*').eq('partner_id', id)
            .order('created_at', { ascending: false }).limit(100),
    ]);
    if (partnerRes.error) return res.status(404).json({ error: 'Partner not found' });

    const events = eventsRes.data || [];
    const signups = events.filter(e => e.event_type === 'signup').length;
    const bookings = events.filter(e => e.event_type === 'booking');
    const totalEarned = bookings.reduce((n, e) => n + (parseFloat(e.commission) || 0), 0);

    // Last 30 days breakdown
    const thirtyAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const recentEvents = events.filter(e => e.created_at > thirtyAgo);

    res.json({
        partner: partnerRes.data,
        stats: {
            total_signups: signups,
            total_bookings: bookings.length,
            total_earned: totalEarned,
            last_30_days: {
                signups: recentEvents.filter(e => e.event_type === 'signup').length,
                bookings: recentEvents.filter(e => e.event_type === 'booking').length,
                earned: recentEvents.filter(e => e.event_type === 'booking')
                    .reduce((n, e) => n + (parseFloat(e.commission) || 0), 0),
            },
        },
        recent_events: events.slice(0, 20),
    });
});

// POST /api/qr/referral/scan — called when tourist scans a referral QR
// Records the scan and returns the incentive + destination
router.post('/referral/scan', async (req, res) => {
    const { qr_code, tourist_id, device_type } = req.body;
    if (!qr_code) return res.status(400).json({ error: 'qr_code required' });

    const { data: partner } = await gcrDb.from('referral_partners')
        .select('*').eq('qr_code', qr_code).eq('active', true).maybeSingle();

    if (!partner) return res.status(404).json({ error: 'QR not found' });

    // Log the scan event
    await gcrDb.from('referral_events').insert({
        partner_id: partner.id, qr_code,
        tourist_id: tourist_id || null,
        event_type: 'scan',
        metadata: { device_type: device_type || 'unknown' },
    }).catch(() => {});

    res.json({
        partner_name: partner.name,
        partner_type: partner.type,
        incentive: partner.incentive_text,
        redirect_url: `https://cybercheck-links.vercel.app/?ref=${qr_code}`,
    });
});

// POST /api/qr/referral/attribute — called when a tourist signs up via a referral QR
router.post('/referral/attribute', async (req, res) => {
    const { qr_code, tourist_id, event_type = 'signup', amount = 0 } = req.body;
    if (!qr_code || !tourist_id) return res.status(400).json({ error: 'qr_code and tourist_id required' });

    const { data: partner } = await gcrDb.from('referral_partners')
        .select('*').eq('qr_code', qr_code).maybeSingle();
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    const commission = parseFloat(amount) * (parseFloat(partner.referral_rate) || 0.05);

    await gcrDb.from('referral_events').insert({
        partner_id: partner.id, qr_code, tourist_id,
        event_type, amount: parseFloat(amount) || 0, commission,
    });

    // Update partner totals
    const updates = {};
    if (event_type === 'signup') updates.total_signups = (partner.total_signups || 0) + 1;
    if (event_type === 'booking') {
        updates.total_bookings = (partner.total_bookings || 0) + 1;
        updates.total_earned = parseFloat(partner.total_earned || 0) + commission;
    }
    if (Object.keys(updates).length) {
        await gcrDb.from('referral_partners').update(updates).eq('id', partner.id);
    }

    res.json({ ok: true, commission, partner_name: partner.name });
});

// GET /api/qr/partner-portal/:qr_code — public endpoint for partner self-service portal
router.get('/partner-portal/:qr_code', async (req, res) => {
    const { data: partner } = await gcrDb.from('referral_partners')
        .select('id,name,type,total_signups,total_bookings,total_earned,total_paid,created_at')
        .eq('qr_code', req.params.qr_code).eq('active', true).maybeSingle();
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    const { data: events } = await gcrDb.from('referral_events')
        .select('event_type,amount,commission,created_at')
        .eq('partner_id', partner.id)
        .order('created_at', { ascending: false }).limit(50);

    const thirtyAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const recent = (events || []).filter(e => e.created_at > thirtyAgo);

    res.json({
        partner,
        this_month: {
            signups: recent.filter(e => e.event_type === 'signup').length,
            bookings: recent.filter(e => e.event_type === 'booking').length,
            earned: recent.filter(e => e.event_type === 'booking')
                .reduce((n, e) => n + (parseFloat(e.commission) || 0), 0).toFixed(2),
        },
        recent_activity: (events || []).slice(0, 20),
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// QR Alert Settings — per-code or global (admin)
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /api/qr/:id/alert — set alert_phone, digest frequency on a code
router.patch('/:id/alert', authRequired, async (req, res) => {
    const { alert_phone, digest } = req.body; // digest: 'none' | 'daily' | 'weekly'
    let query = supabase.from('qr_codes').select('metadata').eq('id', req.params.id);
    if (req.role !== 'admin') query = query.eq('site_id', req.siteId);
    const { data: qr } = await query.maybeSingle();
    if (!qr) return res.status(404).json({ error: 'Not found' });

    const updates = { alert_phone: alert_phone || null };
    const meta = Object.assign({}, qr.metadata || {});
    if (digest !== undefined) meta.digest = digest;
    updates.metadata = meta;

    let uq = supabase.from('qr_codes').update(updates).eq('id', req.params.id);
    if (req.role !== 'admin') uq = uq.eq('site_id', req.siteId);
    const { data, error } = await uq.select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/qr/alert-settings/global — set global alert phone for all codes (admin)
router.post('/alert-settings/global', authRequired, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { alert_phone, digest } = req.body;
    // Store in a settings row — use metadata table or upsert to a config key
    await supabase.from('app_settings').upsert({ key: 'qr_alert_phone', value: alert_phone || '' }, { onConflict: 'key' }).catch(() => {});
    await supabase.from('app_settings').upsert({ key: 'qr_digest', value: digest || 'daily' }, { onConflict: 'key' }).catch(() => {});
    res.json({ ok: true, alert_phone, digest });
});

// ─────────────────────────────────────────────────────────────────────────────
// Digest cron — called by Vercel cron daily + weekly
// GET /api/qr/digest/daily   → send daily SMS summary
// GET /api/qr/digest/weekly  → send weekly SMS summary
// ─────────────────────────────────────────────────────────────────────────────

async function buildAndSendDigest(period) {
    const secret = process.env.CRON_SECRET;
    const { sendSms } = require('../utils/sms');

    // Get global alert phone
    const { data: phoneSetting } = await supabase.from('app_settings').select('value').eq('key', 'qr_alert_phone').maybeSingle().catch(() => ({ data: null }));
    const globalPhone = phoneSetting?.value || process.env.ADMIN_SMS_NUMBER;
    if (!globalPhone) return { skipped: 'no alert phone configured' };

    const since = new Date();
    if (period === 'daily')  since.setDate(since.getDate() - 1);
    if (period === 'weekly') since.setDate(since.getDate() - 7);

    // Get all scans in the period
    const { data: scans } = await supabase.from('qr_scans')
        .select('qr_code_id, device_type, scanner_phone, lead_score, lead_tier, time_on_page, scanned_at')
        .gte('scanned_at', since.toISOString());

    if (!scans || !scans.length) {
        await sendSms(globalPhone, `📊 QR ${period === 'daily' ? 'Daily' : 'Weekly'} Digest\nNo scans in the last ${period === 'daily' ? '24 hours' : '7 days'}.`, null, 'qr_digest');
        return { sent: 1, scans: 0 };
    }

    // Get code labels for scanned codes
    const codeIds = [...new Set(scans.map(s => s.qr_code_id))];
    const { data: codes } = await supabase.from('qr_codes').select('id, label, seq_number, location').in('id', codeIds);
    const codeMap = {};
    (codes || []).forEach(c => { codeMap[c.id] = c; });

    // Aggregate stats
    const total    = scans.length;
    const leads    = scans.filter(s => s.scanner_phone).length;
    const onFire   = scans.filter(s => s.lead_tier === 'on_fire').length;
    const warm     = scans.filter(s => s.lead_tier === 'warm').length;
    const avgTime  = Math.round(scans.reduce((s, x) => s + (x.time_on_page || 0), 0) / total);
    const mobile   = scans.filter(s => s.device_type === 'mobile').length;

    // Top 3 codes by scans
    const byCode = {};
    scans.forEach(s => { byCode[s.qr_code_id] = (byCode[s.qr_code_id] || 0) + 1; });
    const top3 = Object.entries(byCode).sort((a,b) => b[1]-a[1]).slice(0, 3).map(([id, cnt]) => {
        const c = codeMap[id] || {};
        return `  #${c.seq_number||'?'} ${c.label||'?'}: ${cnt} scan${cnt!==1?'s':''}`;
    });

    const label = period === 'daily' ? 'Daily' : 'Weekly';
    const msg = [
        `📊 QR ${label} Digest`,
        `Period: last ${period === 'daily' ? '24 hrs' : '7 days'}`,
        ``,
        `📲 Total scans: ${total}`,
        `📱 Mobile: ${Math.round(mobile/total*100)}%`,
        `⏱ Avg time on page: ${avgTime}s`,
        `📞 Phone leads: ${leads}`,
        ``,
        `🔥 Lead heat:`,
        `  On Fire: ${onFire}`,
        `  Warm: ${warm}`,
        `  Interested: ${scans.filter(s=>s.lead_tier==='interested').length}`,
        `  Cold: ${scans.filter(s=>!s.lead_tier||s.lead_tier==='cold').length}`,
        ``,
        `🏆 Top codes:`,
        ...top3,
    ].join('\n');

    await sendSms(globalPhone, msg, null, 'qr_digest');
    return { sent: 1, scans: total };
}

router.get('/digest/daily', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== 'Bearer ' + secret) return res.status(401).json({ error: 'Unauthorized' });
    const result = await buildAndSendDigest('daily').catch(e => ({ error: e.message }));
    res.json(result);
});

router.get('/digest/weekly', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== 'Bearer ' + secret) return res.status(401).json({ error: 'Unauthorized' });
    const result = await buildAndSendDigest('weekly').catch(e => ({ error: e.message }));
    res.json(result);
});

module.exports = router;
