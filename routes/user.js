const express = require('express');
const { authRequired } = require('../middleware/auth');
const getGcrDb = () => require('../db'); // db module exports the client itself

const router = express.Router();
router.use(authRequired);

// All routes require GCR auth
router.use((req, res, next) => {
    if (!req.isGCR) return res.status(403).json({ error: 'GCR account required' });
    next();
});

// Helper: get gcrDb and resolve the owner's entity (by SLUG — the key
// every entity_* child table actually uses)
async function resolveEntity(userId) {
    const gcrDb = getGcrDb();

    // primary: profiles.slug; fallback: entity_owners (the claim table)
    let slug = null;
    const { data: profile } = await gcrDb
        .from('profiles')
        .select('slug')
        .eq('id', userId)
        .maybeSingle();
    if (profile && profile.slug) slug = profile.slug;
    if (!slug) {
        const { data: owner } = await gcrDb
            .from('entity_owners')
            .select('entity_slug')
            .eq('user_id', userId)
            .maybeSingle();
        if (owner && owner.entity_slug) slug = owner.entity_slug;
    }
    if (!slug) return { gcrDb, entity: null, entityId: null, entitySlug: null };

    const { data: entity } = await gcrDb
        .from('entity')
        .select('id, slug, name, subtitle, entity_type, entity_subtype, phone, email, address_line_1, city, state, zip, description, website_url, booking_url, reservation_url, order_url, social_instagram, social_facebook, social_tiktok, hh_days, hh_start, hh_end, hh_description, hero_image_url, price_range, is_active')
        .eq('slug', slug)
        .single();

    return { gcrDb, entity, entityId: entity ? entity.id : null, entitySlug: entity ? entity.slug : null };
}

// ─── PROFILE ───────────────────────────────────────────────────────────────

// GET /api/user/profile
router.get('/profile', async (req, res) => {
    try {
        const { gcrDb, entity } = await resolveEntity(req.gcrUserId);
        if (!entity) return res.status(404).json({ error: 'Entity not found' });

        const { data: profile } = await gcrDb.from('profiles').select('*').eq('id', req.gcrUserId).single();
        const { data: hours } = await gcrDb.from('entity_hours').select('*').eq('entity_slug', entity.slug).order('day_of_week');
        const { data: modules } = await gcrDb.from('installed_modules').select('*').eq('user_id', req.gcrUserId).order('position');

        res.json({ entity, profile, hours: hours || [], modules: modules || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/user/profile
router.put('/profile', async (req, res) => {
    try {
        const { gcrDb, entity } = await resolveEntity(req.gcrUserId);
        if (!entity) return res.status(404).json({ error: 'Entity not found' });

        const allowed = ['name', 'subtitle', 'phone', 'email', 'address_line_1', 'city', 'state', 'zip',
            'description', 'website_url', 'booking_url', 'reservation_url', 'order_url',
            'social_instagram', 'social_facebook', 'social_tiktok', 'hero_image_url', 'price_range'];
        const updates = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

        const { data, error } = await gcrDb.from('entity').update(updates).eq('id', entity.id).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── MENU ──────────────────────────────────────────────────────────────────

// GET /api/user/menu
router.get('/menu', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });

        const [sectionsRes, itemsRes, subRes] = await Promise.all([
            gcrDb.from('menu_sections').select('*').eq('entity_slug', entitySlug).order('sort_order'),
            gcrDb.from('menu_items').select('*').eq('entity_slug', entitySlug).order('sort_order'),
            gcrDb.from('menu_sub_sections').select('*').eq('entity_id', entityId).order('sort_order'),
        ]);
        res.json({
            sections: sectionsRes.data || [],
            sub_sections: subRes.data || [],
            items: itemsRes.data || [],
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/user/menu/sections
router.post('/menu/sections', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('menu_sections').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/menu/sections/:id
router.put('/menu/sections/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('menu_sections').update(req.body).eq('id', req.params.id).eq('entity_slug', entitySlug).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/user/menu/sections/:id
router.delete('/menu/sections/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        await gcrDb.from('menu_sections').delete().eq('id', req.params.id).eq('entity_slug', entitySlug);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/user/menu/items
router.post('/menu/items', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('menu_items').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/menu/items/:id
router.put('/menu/items/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('menu_items').update(req.body).eq('id', req.params.id).eq('entity_slug', entitySlug).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/user/menu/items/:id
router.delete('/menu/items/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        await gcrDb.from('menu_items').delete().eq('id', req.params.id).eq('entity_slug', entitySlug);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DRINKS ────────────────────────────────────────────────────────────────

// GET /api/user/drinks
router.get('/drinks', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const [sectionsRes, itemsRes] = await Promise.all([
            gcrDb.from('drink_sections').select('*').eq('entity_slug', entitySlug).order('sort_order'),
            gcrDb.from('drink_items').select('*').eq('entity_slug', entitySlug).order('sort_order'),
        ]);
        res.json({ sections: sectionsRes.data || [], items: itemsRes.data || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HAPPY HOUR ────────────────────────────────────────────────────────────

// GET /api/user/happy-hours
router.get('/happy-hours', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const [sectionsRes, itemsRes] = await Promise.all([
            gcrDb.from('happy_hour_sections').select('*').eq('entity_slug', entitySlug).order('sort_order'),
            gcrDb.from('happy_hour_items').select('*').eq('entity_slug', entitySlug).order('sort_order'),
        ]);
        res.json({ sections: sectionsRes.data || [], items: itemsRes.data || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/user/happy-hours/sections
router.post('/happy-hours/sections', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('happy_hour_sections').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/happy-hours/sections/:id
router.put('/happy-hours/sections/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('happy_hour_sections').update(req.body).eq('id', req.params.id).eq('entity_slug', entitySlug).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/user/happy-hours/items
router.post('/happy-hours/items', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('happy_hour_items').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/happy-hours/items/:id
router.put('/happy-hours/items/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('happy_hour_items').update(req.body).eq('id', req.params.id).eq('entity_slug', entitySlug).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/user/happy-hours/items/:id
router.delete('/happy-hours/items/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        await gcrDb.from('happy_hour_items').delete().eq('id', req.params.id).eq('entity_slug', entitySlug);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SPECIALS ──────────────────────────────────────────────────────────────

// GET /api/user/specials
router.get('/specials', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('entity_specials').select('*').eq('entity_slug', entitySlug).order('sort_order');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/user/specials
router.post('/specials', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('entity_specials').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/specials/:id
router.put('/specials/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('entity_specials').update(req.body).eq('id', req.params.id).eq('entity_slug', entitySlug).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/user/specials/:id
router.delete('/specials/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        await gcrDb.from('entity_specials').delete().eq('id', req.params.id).eq('entity_slug', entitySlug);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EVENTS ────────────────────────────────────────────────────────────────

// GET /api/user/events
router.get('/events', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('entity_events').select('*').eq('entity_slug', entitySlug).order('event_date');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/user/events
router.post('/events', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('entity_events').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/events/:id
router.put('/events/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('entity_events').update(req.body).eq('id', req.params.id).eq('entity_slug', entitySlug).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/user/events/:id
router.delete('/events/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        await gcrDb.from('entity_events').delete().eq('id', req.params.id).eq('entity_slug', entitySlug);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PHOTOS / MEDIA ────────────────────────────────────────────────────────

// GET /api/user/photos
router.get('/photos', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('entity_photos').select('*').eq('entity_slug', entitySlug).order('sort_order');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/user/photos
router.post('/photos', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data, error } = await gcrDb.from('entity_photos').insert({ ...req.body, entity_slug: entitySlug }).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/user/photos/:id
router.delete('/photos/:id', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        await gcrDb.from('entity_photos').delete().eq('id', req.params.id).eq('entity_slug', entitySlug);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HOURS ─────────────────────────────────────────────────────────────────

// GET /api/user/hours
router.get('/hours', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('entity_hours').select('*').eq('entity_slug', entitySlug).order('day_of_week');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/hours
router.put('/hours', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        // Replace the posted days atomically-ish: delete those days, insert
        // the new rows. (No unique index exists on (entity_slug, day_of_week)
        // because split hours — lunch + dinner rows for one day — are legal.)
        const rows = req.body.map(h => ({ ...h, entity_slug: entitySlug }));
        const days = [...new Set(rows.map(h => h.day_of_week).filter(d => d != null))];
        if (days.length) {
            await gcrDb.from('entity_hours').delete().eq('entity_slug', entitySlug).in('day_of_week', days);
        }
        const { data, error } = await gcrDb.from('entity_hours').insert(rows).select();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MODULES ───────────────────────────────────────────────────────────────

// GET /api/user/modules
router.get('/modules', async (req, res) => {
    try {
        const gcrDb = getGcrDb();
        const { data } = await gcrDb.from('installed_modules').select('*').eq('user_id', req.gcrUserId).order('position');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/user/modules
router.put('/modules', async (req, res) => {
    try {
        const gcrDb = getGcrDb();
        const { data, error } = await gcrDb.from('installed_modules').upsert(
            req.body.map(m => ({ ...m, user_id: req.gcrUserId })),
            { onConflict: 'user_id,module_id' }
        ).select();
        if (error) return res.status(400).json({ error: error.message });
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FLEET / RENTALS ───────────────────────────────────────────────────────

// GET /api/user/fleet
router.get('/fleet', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('fleet_items').select('*').eq('entity_id', entityId).order('sort_order');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BOOKINGS ──────────────────────────────────────────────────────────────

// GET /api/user/bookings
router.get('/bookings', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('bookings').select('*').eq('entity_slug', entitySlug).order('created_at', { ascending: false });
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FEATURES / TAGS ───────────────────────────────────────────────────────

// GET /api/user/features
router.get('/features', async (req, res) => {
    try {
        const { gcrDb, entityId, entitySlug } = await resolveEntity(req.gcrUserId);
        if (!entityId) return res.status(404).json({ error: 'Entity not found' });
        const { data } = await gcrDb.from('entity_features').select('*').eq('entity_id', entityId).order('sort_order');
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
