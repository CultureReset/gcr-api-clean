const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

// All routes require auth - site_id comes from JWT

// GET /api/site/content - get site content
router.get('/content', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('site_content')
        .select('*')
        .eq('site_id', req.siteId)
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || {});
});

// PUT /api/site/content - update site content
router.put('/content', authRequired, async (req, res) => {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.site_id; // Don't allow changing site_id

    const { data, error } = await supabase
        .from('site_content')
        .upsert({ site_id: req.siteId, ...updates })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// GET /api/site/apps - list attached apps
router.get('/apps', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('site_apps')
        .select('app_id, config, enabled, apps(name, description, category, icon)')
        .eq('site_id', req.siteId)
        .eq('enabled', true);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// GET /api/site/business - get business info
router.get('/business', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('businesses')
        .select('*')
        .eq('site_id', req.siteId)
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- MENU ITEMS ---

// GET /api/site/menu-items
router.get('/menu-items', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('menu_items')
        .select('*')
        .eq('site_id', req.siteId)
        .order('sort_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// POST /api/site/menu-items
router.post('/menu-items', authRequired, async (req, res) => {
    const item = { ...req.body, site_id: req.siteId };

    const { data, error } = await supabase
        .from('menu_items')
        .insert(item)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// PUT /api/site/menu-items/:id
router.put('/menu-items/:id', authRequired, async (req, res) => {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.site_id;
    delete updates.id;

    const { data, error } = await supabase
        .from('menu_items')
        .update(updates)
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// DELETE /api/site/menu-items/:id
router.delete('/menu-items/:id', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('menu_items')
        .delete()
        .eq('id', req.params.id)
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- SERVICES ---

router.get('/services', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('services')
        .select('*')
        .eq('site_id', req.siteId)
        .order('sort_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/services', authRequired, async (req, res) => {
    const service = { ...req.body, site_id: req.siteId };

    const { data, error } = await supabase
        .from('services')
        .insert(service)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

router.put('/services/:id', authRequired, async (req, res) => {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.site_id;
    delete updates.id;

    const { data, error } = await supabase
        .from('services')
        .update(updates)
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.delete('/services/:id', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('services')
        .delete()
        .eq('id', req.params.id)
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- BOOKINGS ---

router.get('/bookings', authRequired, async (req, res) => {
    let query = supabase
        .from('bookings')
        .select('*')
        .eq('site_id', req.siteId)
        .order('booking_date', { ascending: true });

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.date) query = query.eq('booking_date', req.query.date);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.put('/bookings/:id', authRequired, async (req, res) => {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.site_id;
    delete updates.id;

    const { data, error } = await supabase
        .from('bookings')
        .update(updates)
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- ORDERS ---

router.get('/orders', authRequired, async (req, res) => {
    let query = supabase
        .from('orders')
        .select('*')
        .eq('site_id', req.siteId)
        .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.put('/orders/:id', authRequired, async (req, res) => {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.site_id;
    delete updates.id;

    const { data, error } = await supabase
        .from('orders')
        .update(updates)
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- CUSTOMERS ---

router.get('/customers', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('site_id', req.siteId)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/customers', authRequired, async (req, res) => {
    const customer = { ...req.body, site_id: req.siteId };

    const { data, error } = await supabase
        .from('customers')
        .insert(customer)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// --- CONNECTIONS ---

router.get('/connections', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('connections')
        .select('id, provider, account_name, status, connected_at')
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.delete('/connections/:id', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('connections')
        .delete()
        .eq('id', req.params.id)
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- SPECIALS ---

router.get('/specials', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('specials')
        .select('*')
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/specials', authRequired, async (req, res) => {
    const special = { ...req.body, site_id: req.siteId };

    const { data, error } = await supabase
        .from('specials')
        .insert(special)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// --- EVENTS ---

router.get('/events', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/events', authRequired, async (req, res) => {
    const event = { ...req.body, site_id: req.siteId };

    const { data, error } = await supabase
        .from('events')
        .insert(event)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// ── FLEET TYPES ──────────────────────────────────────────────────────────────

router.get('/fleet', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('fleet_types').select('*').eq('site_id', req.siteId).order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/fleet', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('fleet_types').insert({ ...req.body, site_id: req.siteId }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

router.put('/fleet/:id', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('fleet_types').update(req.body).eq('id', req.params.id).eq('site_id', req.siteId).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.delete('/fleet/:id', authRequired, async (req, res) => {
    const { error } = await supabase.from('fleet_types').delete().eq('id', req.params.id).eq('site_id', req.siteId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── TIME SLOTS ────────────────────────────────────────────────────────────────

router.get('/time-slots', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_time_slots').select('*').eq('site_id', req.siteId).order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/time-slots', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_time_slots').insert({ ...req.body, site_id: req.siteId }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

router.put('/time-slots/:id', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_time_slots').update(req.body).eq('id', req.params.id).eq('site_id', req.siteId).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.delete('/time-slots/:id', authRequired, async (req, res) => {
    const { error } = await supabase.from('rental_time_slots').delete().eq('id', req.params.id).eq('site_id', req.siteId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── PRICING ───────────────────────────────────────────────────────────────────

router.get('/pricing', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_pricing').select('*').eq('site_id', req.siteId);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/pricing', authRequired, async (req, res) => {
    const { fleet_type_id, time_slot_id, price } = req.body;
    const { data, error } = await supabase.from('rental_pricing')
        .upsert({ site_id: req.siteId, fleet_type_id, time_slot_id, price }, { onConflict: 'site_id,fleet_type_id,time_slot_id' })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ── ADD-ONS ───────────────────────────────────────────────────────────────────

router.get('/addons', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_addons').select('*').eq('site_id', req.siteId).order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.post('/addons', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_addons').insert({ ...req.body, site_id: req.siteId }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

router.put('/addons/:id', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('rental_addons').update(req.body).eq('id', req.params.id).eq('site_id', req.siteId).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.delete('/addons/:id', authRequired, async (req, res) => {
    const { error } = await supabase.from('rental_addons').delete().eq('id', req.params.id).eq('site_id', req.siteId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── WAIVERS ───────────────────────────────────────────────────────────────────

router.get('/waivers/template', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('site_content').select('waiver_text, waiver_required').eq('site_id', req.siteId).single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || {});
});

router.put('/waivers/template', authRequired, async (req, res) => {
    const { waiver_text, waiver_required } = req.body;
    const { data, error } = await supabase.from('site_content')
        .upsert({ site_id: req.siteId, waiver_text, waiver_required })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.get('/waivers/signed', authRequired, async (req, res) => {
    const { data, error } = await supabase.from('waivers').select('*').eq('site_id', req.siteId).order('signed_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

module.exports = router;
