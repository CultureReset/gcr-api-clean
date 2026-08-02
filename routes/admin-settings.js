// ============================================================
// ADMIN SETTINGS, LEADS, GUEST PHOTOS, CATEGORY CARDS
// ============================================================
// Fills the last gaps the admin dashboard had no route for.
//
// The settings half is deliberately generic. `platform_settings` is already a
// key/value jsonb table, so site config, SMS config and auth config are three
// keys rather than three endpoints — adding another settings screen needs no
// route at all.
//
// Two things are NOT here, on purpose:
//
//   Storing provider API keys. The old dashboard posted them to
//   /api/admin/save-api-key. Putting long-lived provider secrets in a table
//   that an admin session can read back is worse than the environment
//   variables the API already uses, so this exposes /provider-status instead:
//   booleans saying which keys are present, and nothing that can leak one.
//
//   /api/admin/set-connection. Superseded by /api/admin/connections (Composio).
//
// Mounted in server.js as:
//   mount('/api/admin', () => require('./routes/admin-settings'));

const express = require('express');
const { adminRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

const fail = (res, code, message) => res.status(code).json({ error: message });

/* ── generic settings ────────────────────────────────────────────────── */
//
// GET  /api/admin/settings/:key   → { key, value }
// PUT  /api/admin/settings/:key   { ...anything } → { key, value }
// GET  /api/admin/settings        → every key, for an overview screen
//
// Keys the dashboard uses today: site_hero, sms_config, auth_config,
// points_config. Any new one works without touching this file.

/** Keys must be simple identifiers — they end up in a unique index. */
const KEY_PATTERN = /^[a-z0-9_]{2,64}$/;

router.get('/settings', adminRequired, async (_req, res) => {
    const { data, error } = await supabase
        .from('platform_settings')
        .select('key, value, updated_at')
        .order('key');
    if (error) return fail(res, 500, error.message);
    res.json({ settings: data || [] });
});

router.get('/settings/:key', adminRequired, async (req, res) => {
    const key = String(req.params.key || '').toLowerCase();
    if (!KEY_PATTERN.test(key)) return fail(res, 400, 'Invalid settings key');

    const { data, error } = await supabase
        .from('platform_settings')
        .select('key, value, updated_at')
        .eq('key', key)
        .maybeSingle();
    if (error) return fail(res, 500, error.message);

    // A key that has never been set is an empty config, not an error — the
    // dashboard should render its form, not a 404.
    res.json({ key, value: data?.value || {}, updated_at: data?.updated_at || null });
});

router.put('/settings/:key', adminRequired, async (req, res) => {
    const key = String(req.params.key || '').toLowerCase();
    if (!KEY_PATTERN.test(key)) return fail(res, 400, 'Invalid settings key');

    const value = req.body && typeof req.body === 'object' ? req.body : {};

    const { data, error } = await supabase
        .from('platform_settings')
        .upsert(
            { key, value, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
        )
        .select()
        .single();
    if (error) return fail(res, 400, error.message);
    res.json({ key, value: data.value });
});

/* ── which providers are configured ──────────────────────────────────── */
//
// Booleans only. This route can never leak a key, which is the point: an admin
// needs to know whether Stripe is set up, not what the secret is.

const PROVIDER_ENV = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    groq: 'GROQ_API_KEY',
    xai: 'XAI_API_KEY',
    stripe: 'STRIPE_SECRET_KEY',
    square: 'SQUARE_ACCESS_TOKEN',
    brevo: 'BREVO_API_KEY',
    twilio: 'TWILIO_AUTH_TOKEN',
    resend: 'RESEND_API_KEY',
    sendgrid: 'SENDGRID_API_KEY',
    composio: 'COMPOSIO_API_KEY',
    google_places: 'GOOGLE_PLACES_API_KEY',
};

router.get('/provider-status', adminRequired, (_req, res) => {
    const providers = Object.entries(PROVIDER_ENV).map(([id, envVar]) => {
        const raw = process.env[envVar];
        return {
            id,
            env_var: envVar,
            configured: Boolean(raw && String(raw).trim()),
            // Enough to tell two accounts apart without revealing the key.
            fingerprint: raw ? `…${String(raw).trim().slice(-4)}` : null,
        };
    });
    res.json({
        providers,
        configured_count: providers.filter((p) => p.configured).length,
        note: 'Keys are environment variables on the API. They cannot be read or set from the dashboard.',
    });
});

/* ── business leads ──────────────────────────────────────────────────── */
//
// routes/public.js already writes this table from the public sign-up form.
// This is the admin side of it, which never existed.

router.get('/business-leads', adminRequired, async (req, res) => {
    let query = supabase
        .from('business_leads')
        .select('*')
        .order('submitted_at', { ascending: false })
        .limit(Math.min(parseInt(req.query.limit, 10) || 500, 1000));

    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    res.json({ leads: data || [], total: (data || []).length });
});

const LEAD_FIELDS = ['status', 'notes', 'plan', 'contact_name', 'phone', 'email', 'website', 'category'];

router.patch('/business-leads/:id', adminRequired, async (req, res) => {
    const row = {};
    for (const key of LEAD_FIELDS) if (req.body?.[key] !== undefined) row[key] = req.body[key];
    if (Object.keys(row).length === 0) return fail(res, 400, 'Nothing to update');

    const { data, error } = await supabase
        .from('business_leads')
        .update(row)
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Lead not found');
    res.json({ lead: data[0] });
});

/* ── guest photos ────────────────────────────────────────────────────── */

router.get('/community-photos', adminRequired, async (req, res) => {
    let query = supabase
        .from('community_photos')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.min(parseInt(req.query.limit, 10) || 300, 1000));

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);

    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    res.json({ photos: data || [], total: (data || []).length });
});

router.patch('/community-photos/:id', adminRequired, async (req, res) => {
    const status = req.body?.status;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
        return fail(res, 400, 'status must be pending, approved, or rejected');
    }

    const { data, error } = await supabase
        .from('community_photos')
        .update({
            status,
            reviewed_at: new Date().toISOString(),
            caption: req.body?.caption !== undefined ? req.body.caption : undefined,
        })
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Photo not found');
    res.json({ photo: data[0] });
});

router.delete('/community-photos/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('community_photos')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Photo not found');
    res.json({ success: true });
});

/* ── category cards ──────────────────────────────────────────────────── */
//
// The tiles linking to each category page on the public site.

const CARD_FIELDS = ['title', 'subtitle', 'page', 'category', 'image_url', 'link_url', 'sort_order', 'is_active'];

router.get('/gcr/category-cards', adminRequired, async (req, res) => {
    let query = supabase
        .from('category_cards')
        .select('*')
        .order('sort_order', { ascending: true });
    if (req.query.page) query = query.eq('page', req.query.page);

    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    res.json({ cards: data || [], total: (data || []).length });
});

router.post('/gcr/category-cards', adminRequired, async (req, res) => {
    const row = {};
    for (const key of CARD_FIELDS) if (req.body?.[key] !== undefined) row[key] = req.body[key];
    if (!row.title) return fail(res, 400, 'title is required');
    if (row.is_active === undefined) row.is_active = true;

    const { data, error } = await supabase.from('category_cards').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ card: data });
});

router.put('/gcr/category-cards/:id', adminRequired, async (req, res) => {
    const row = {};
    for (const key of CARD_FIELDS) if (req.body?.[key] !== undefined) row[key] = req.body[key];

    const { data, error } = await supabase
        .from('category_cards')
        .update(row)
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Card not found');
    res.json({ card: data[0] });
});

router.delete('/gcr/category-cards/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('category_cards')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Card not found');
    res.json({ success: true });
});

module.exports = router;
