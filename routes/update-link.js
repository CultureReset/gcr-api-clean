/**
 * Daily Update Link — Full Mobile Editor
 *
 * Business owner gets a secure URL via SMS.
 * Opens on their phone — full editor with tabs:
 *   Specials | Menu | Drinks | Happy Hour | Events
 * Can add, edit, delete items and upload photos from their camera.
 * All saves hit instantly — no page reload.
 *
 * Admin routes (auth required):
 *   POST /api/update/generate
 *   POST /api/update/send-sms
 *   GET  /api/update/status/:entity_id
 *
 * Public routes (token = the secret, no login needed):
 *   GET  /update/:token              — redirect to cybercheck-links/menu-editor.html?token=
 *   GET  /update/:token/data         — load all entity data as JSON
 *   POST /update/:token/upload       — image upload → Supabase Storage
 *   POST /update/:token/specials     — add/update special
 *   DELETE /update/:token/specials/:id
 *   POST /update/:token/menu-items   — add/update menu item
 *   DELETE /update/:token/menu-items/:id
 *   POST /update/:token/menu-sections — add section
 *   POST /update/:token/drink-items  — add/update drink item
 *   DELETE /update/:token/drink-items/:id
 *   PUT  /update/:token/happy-hour   — update HH schedule
 *   POST /update/:token/hh-items     — add/update HH item
 *   DELETE /update/:token/hh-items/:id
 *   POST /update/:token/events       — add/update event
 *   DELETE /update/:token/events/:id
 */

const express  = require('express');
const crypto   = require('crypto');
const multer   = require('multer');
const getGcrDb = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const mainDb = require('../db'); // main Supabase — businesses/menu_items/specials/events

function db() { return getGcrDb(); }
const supabase = db(); // update_links lives in GCR

// Write-through: when owner saves to main DB, mirror to GCR entity if linked
async function syncToGcr(siteId, type, data) {
    try {
        const gcrDb = db();
        const { data: entity } = await gcrDb.from('entity')
            .select('id').eq('legacy_site_id', siteId).maybeSingle();
        if (!entity) return;
        const eid = entity.id;
        if (type === 'menu_item') {
            const itemType = data.item_type || 'food';
            if (itemType === 'drink') {
                const secName = data.category || 'Drinks';
                let { data: sec } = await gcrDb.from('drink_sections').select('id').eq('entity_id', eid).eq('section_name', secName).maybeSingle();
                if (!sec) { const ins = await gcrDb.from('drink_sections').insert({ entity_id: eid, section_name: secName }).select('id').single(); sec = ins.data; }
                if (sec) await gcrDb.from('drink_items').insert({ entity_id: eid, drink_section_id: sec.id, item_name: data.name, price: data.price || null, description: data.description || null, is_available: true });
            } else {
                await gcrDb.from('menu_items').insert({ entity_id: eid, item_name: data.name, price: data.price || null, description: data.description || null, is_available: true });
            }
        } else if (type === 'special') {
            await gcrDb.from('entity_specials').insert({
                entity_id: eid, special_name: data.special_name || data.name,
                discount_text: data.discount_text || '', description: data.description || null,
                days: data.days || null, start_time: data.start_time || null,
                end_time: data.end_time || null, is_active: true,
            });
        }
    } catch(e) { /* fire-and-forget */ }
}

function twilio() {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !tok) return null;
    return require('twilio')(sid, tok);
}
function fromNumber() { return process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER; }
function makeToken()  { return crypto.randomBytes(24).toString('hex'); }
function slugify(s) {
    return String(s || '').toLowerCase().trim()
        .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'business';
}
function linkUrl(tok, slug) {
    const base = (process.env.LINKS_BASE_URL || 'https://cybercheck-links.vercel.app').replace(/\/$/, '');
    if (slug) return `${base}/${slug}/edit?token=${tok}`;
    return `${base}/menu-editor.html?token=${tok}`;
}

// Mark link submitted (fire-and-forget)
function markSubmitted(token) {
    supabase.from('update_links').update({ submitted_at: new Date().toISOString() })
        .eq('token', token).is('submitted_at', null).then(() => {});
}

// ── Token validation middleware (for all public /:token/* routes) ─────────────
async function validateToken(req, res, next) {
    const token = req.params.token;
    const { data: link } = await supabase.from('update_links').select('*').eq('token', token).maybeSingle();
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link expired' });
    // Passcode check — skip for GET /update/:token (the redirect page itself)
    if (req.path !== '/') {
        const expected = link.passcode || '000000';
        const submitted = req.headers['x-link-passcode'] || req.query.passcode;
        if (submitted !== String(expected)) {
            return res.status(401).json({ error: 'Passcode required', requires_passcode: true });
        }
    }
    req.link = link;
    // site_id businesses are stored as "s:<site_id>" in the entity_id field.
    // Promote to GCR entity_id when entity.legacy_site_id is populated so writes
    // land in the GCR DB (single source of truth).
    if (link.entity_id && String(link.entity_id).startsWith('s:')) {
        const siteId = String(link.entity_id).slice(2);
        const { data: ent } = await db().from('entity').select('id').eq('legacy_site_id', siteId).maybeSingle();
        if (ent && ent.id) {
            req.entityId = ent.id;
        } else {
            req.siteId = siteId;
        }
    } else {
        req.entityId = link.entity_id;
    }
    if (req.method !== 'GET' && !link.submitted_at) markSubmitted(token);
    next();
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — Generate / send links
// ═══════════════════════════════════════════════════════════════

async function resolveSlug({ entity_id, site_id, biz_name }) {
    if (site_id) {
        const { data: biz } = await mainDb.from('businesses').select('name,slug').eq('site_id', site_id).maybeSingle();
        return slugify(biz?.slug || biz?.name || biz_name);
    }
    if (entity_id) {
        const { data: ent } = await db().from('entity').select('name,slug').eq('id', entity_id).single();
        return slugify(ent?.slug || ent?.name || biz_name);
    }
    return slugify(biz_name);
}

router.post('/generate', async (req, res) => {
    const { entity_id, site_id, biz_name, link_type = 'full', send_phone, passcode } = req.body;
    const storedId = site_id ? ('s:' + site_id) : entity_id;
    if (!storedId) return res.status(400).json({ error: 'entity_id or site_id required' });
    const today = new Date().toISOString().split('T')[0];
    const slug = await resolveSlug({ entity_id, site_id, biz_name });

    const { data: existing } = await supabase.from('update_links').select('*')
        .eq('entity_id', storedId).eq('link_type', link_type).eq('link_date', today).maybeSingle();

    if (existing) return res.json({ token: existing.token, url: linkUrl(existing.token, slug), existing: true });

    const token = makeToken();
    const { error } = await supabase.from('update_links').insert({
        entity_id: storedId, link_type, link_date: today, token,
        send_phone: send_phone || null,
        expires_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ token, url: linkUrl(token, slug), existing: false });
});

// PUT /api/update/links/:token/passcode — set or clear a passcode on a link
router.put('/links/:token/passcode', adminRequired, async (req, res) => {
    const { passcode } = req.body; // null or empty string = remove passcode
    const { error } = await supabase.from('update_links')
        .update({ passcode: passcode || null })
        .eq('token', req.params.token);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, protected: !!passcode });
});

router.post('/send-sms', adminRequired, async (req, res) => {
    const { entity_id, site_id, biz_name, phone, link_type = 'full' } = req.body;
    const storedId = site_id ? ('s:' + site_id) : entity_id;
    if (!storedId || !phone) return res.status(400).json({ error: 'entity_id/site_id and phone required' });

    const today = new Date().toISOString().split('T')[0];
    let { data: link } = await supabase.from('update_links').select('*')
        .eq('entity_id', storedId).eq('link_type', link_type).eq('link_date', today).maybeSingle();

    if (!link) {
        const token = makeToken();
        const ins = await supabase.from('update_links').insert({
            entity_id: storedId, link_type, link_date: today, token, send_phone: phone,
            expires_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
        }).select().single();
        link = ins.data;
    }

    let name = biz_name || 'your business';
    let slug = '';
    if (site_id) {
        const { data: biz } = await mainDb.from('businesses').select('name,slug').eq('site_id', site_id).maybeSingle();
        if (biz?.name) name = biz.name;
        slug = slugify(biz?.slug || biz?.name || biz_name);
    } else if (entity_id) {
        const { data: entity } = await db().from('entity').select('name,slug').eq('id', entity_id).single();
        if (entity?.name) name = entity.name;
        slug = slugify(entity?.slug || entity?.name || biz_name);
    }
    const url = linkUrl(link.token, slug);

    const tc = twilio();
    if (!tc) return res.json({ success: false, error: 'Twilio not configured', url, token: link.token });

    await tc.messages.create({
        body: `Hi! Here's your daily update link for ${name}:\n\n${url}\n\nUpdate your menu, specials, photos and more. Expires tonight.`,
        from: fromNumber(), to: phone,
    });

    res.json({ success: true, url, token: link.token, sent_to: phone });
});

router.get('/status/:entity_id', adminRequired, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase.from('update_links').select('*')
        .eq('entity_id', req.params.entity_id).eq('link_date', today);
    res.json({ links: data || [], today });
});

// GET /today — all links generated today across all entities (admin)
router.get('/today', adminRequired, async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const { data: links } = await supabase.from('update_links').select('*')
        .eq('link_date', today).order('created_at', { ascending: false });
    if (!links || !links.length) return res.json({ links: [], today });

    // Split site-based (s:<uuid>) from GCR-entity-based records
    const siteIds   = [];
    const entityIds = [];
    links.forEach(l => {
        const id = String(l.entity_id || '');
        if (id.startsWith('s:')) siteIds.push(id.slice(2));
        else if (id) entityIds.push(id);
    });

    const [entRes, bizRes] = await Promise.all([
        entityIds.length
            ? db().from('entity').select('id,name,icon,slug').in('id', entityIds)
            : Promise.resolve({ data: [] }),
        siteIds.length
            ? mainDb.from('businesses').select('site_id,name,slug,subdomain').in('site_id', siteIds)
            : Promise.resolve({ data: [] }),
    ]);
    const entMap = {};
    (entRes.data  || []).forEach(e => { entMap[e.id] = e; });
    const bizMap = {};
    (bizRes.data || []).forEach(b => { bizMap[b.site_id] = b; });

    const result = links.map(l => {
        const id = String(l.entity_id || '');
        if (id.startsWith('s:')) {
            const siteId = id.slice(2);
            const b = bizMap[siteId] || {};
            return {
                ...l,
                entity_name: b.name || 'Unknown',
                entity_icon: '🏪',
                entity_slug: b.slug || b.subdomain || '',
                site_id: siteId,
                url: linkUrl(l.token),
            };
        }
        const ent = entMap[id] || {};
        return {
            ...l,
            entity_name: ent.name || 'Unknown',
            entity_icon: ent.icon || '🏪',
            entity_slug: ent.slug || '',
            site_id: null,
            url: linkUrl(l.token),
        };
    });
    res.json({ links: result, today });
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC — Mobile editor
// ═══════════════════════════════════════════════════════════════

// GET /update/:token — redirect to correct cybercheck-links page by link_type
router.get('/:token', async (req, res) => {
    const { data: link } = await supabase.from('update_links').select('link_type, entity_id').eq('token', req.params.token).maybeSingle();
    if (!link) return res.status(404).json({ error: 'Link not found' });
    const base = (process.env.LINKS_BASE_URL || 'https://cybercheck-links.vercel.app').replace(/\/$/, '');
    // site_id businesses always use the new restaurant-editor
    if (link.entity_id && String(link.entity_id).startsWith('s:')) {
        return res.redirect(302, `${base}/restaurant-editor.html?token=${req.params.token}`);
    }
    const pageMap = { catch_of_day: 'daily-items.html', menu_setup: 'menu-setup.html' };
    const page = pageMap[link.link_type] || 'menu-editor.html';
    res.redirect(302, `${base}/${page}?token=${req.params.token}`);
});

// GET /update/:token/data — load all sections + items
router.get('/:token/data', validateToken, async (req, res) => {
    supabase.from('update_links').update({ opened_at: new Date().toISOString() })
        .eq('token', req.params.token).is('opened_at', null).then(() => {});

    // ── site_id path (new restaurant-editor) ──────────────────────────────
    if (req.siteId) {
        const sid = req.siteId;
        const [{ data: biz }, { data: items }, { data: specials }, { data: events }] = await Promise.all([
            mainDb.from('businesses').select('name, logo_url, tagline, metadata').eq('site_id', sid).maybeSingle(),
            mainDb.from('menu_items').select('*').eq('site_id', sid).order('category').order('sort_order', { ascending: true }),
            mainDb.from('specials').select('*').eq('site_id', sid),
            mainDb.from('events').select('*').eq('site_id', sid).order('event_date', { ascending: true }),
        ]);
        return res.json({
            entity: { name: biz?.name || '', logo_url: biz?.logo_url || '', tagline: biz?.tagline || '' },
            menu_items: items || [],
            specials: specials || [],
            events: events || [],
        });
    }

    const eid = req.entityId;
    const g = db();
    const [entity, specials, menuSections, menuItems, drinkSections, drinkItems, hhSections, hhItems, events, photos, sections, sectionItems] = await Promise.all([
        g.from('entity').select('name,icon,description,hh_days,hh_start,hh_end,hh_description,hero_image_url,slug').eq('id', eid).single(),
        g.from('entity_specials').select('*').eq('entity_id', eid).order('created_at'),
        g.from('menu_sections').select('*').eq('entity_id', eid).order('sort_order'),
        g.from('menu_items').select('*').eq('entity_id', eid).order('sort_order'),
        g.from('drink_sections').select('*').eq('entity_id', eid).order('created_at'),
        g.from('drink_items').select('*').eq('entity_id', eid).order('created_at'),
        g.from('happy_hour_sections').select('*').eq('entity_id', eid).order('created_at'),
        g.from('happy_hour_items').select('*').eq('entity_id', eid).order('created_at'),
        g.from('entity_events').select('*').eq('entity_id', eid).eq('is_active', true).order('event_date'),
        g.from('entity_photos').select('*').eq('entity_id', eid).order('sort_order').limit(20),
        g.from('entity_sections').select('*').eq('entity_id', eid).order('sort_order'),
        g.from('section_items').select('*,section_id(id,entity_id,section_type)').eq('entity_id', eid).order('sort_order'),
    ]);

    // Merge section_items into menu/drink/hh items
    const allSections = sections.data || [];
    const allSectionItems = sectionItems.data || [];

    const menuSectionIds = new Set(allSections.filter(s => s.section_type === 'menu' || s.section_type === 'grouped_items').map(s => s.id));
    const drinkSectionIds = new Set(allSections.filter(s => s.section_type === 'drinks').map(s => s.id));
    const hhSectionIds = new Set(allSections.filter(s => s.section_type === 'happy_hour').map(s => s.id));

    const mapSectionItemToMenuItem = (item) => ({
        id: item.id,
        entity_id: item.entity_id,
        menu_section_id: item.section_id,
        item_name: item.item_name,
        name: item.item_name,
        description: item.item_description || null,
        price: item.price_numeric,
        price_text: item.price_text,
        image_url: item.image_url,
        is_available: true,
        sort_order: item.sort_order,
    });

    const mergedMenuItems = [
        ...(menuItems.data || []),
        ...allSectionItems.filter(i => menuSectionIds.has(i.section_id)).map(mapSectionItemToMenuItem),
    ];

    const mergedDrinkItems = [
        ...(drinkItems.data || []),
        ...allSectionItems.filter(i => drinkSectionIds.has(i.section_id)).map(mapSectionItemToMenuItem),
    ];

    const mergedHhItems = [
        ...(hhItems.data || []),
        ...allSectionItems.filter(i => hhSectionIds.has(i.section_id)).map(mapSectionItemToMenuItem),
    ];

    const mergedMenuSections = [
        ...(menuSections.data || []),
        ...allSections.filter(s => s.section_type === 'menu' || s.section_type === 'grouped_items').map(s => ({
            id: s.id,
            entity_id: s.entity_id,
            section_name: s.section_label || s.section_type,
            sort_order: s.sort_order,
        })),
    ];

    const mergedDrinkSections = [
        ...(drinkSections.data || []),
        ...allSections.filter(s => s.section_type === 'drinks').map(s => ({
            id: s.id,
            entity_id: s.entity_id,
            section_name: s.section_label || 'Drinks',
            sort_order: s.sort_order,
        })),
    ];

    const mergedHhSections = [
        ...(hhSections.data || []),
        ...allSections.filter(s => s.section_type === 'happy_hour').map(s => ({
            id: s.id,
            entity_id: s.entity_id,
            section_name: s.section_label || 'Happy Hour',
            sort_order: s.sort_order,
        })),
    ];

    res.json({
        entity: entity.data,
        specials: specials.data || [],
        menu_sections: mergedMenuSections,
        menu_items: mergedMenuItems,
        drink_sections: mergedDrinkSections,
        drink_items: mergedDrinkItems,
        hh_sections: mergedHhSections,
        hh_items: mergedHhItems,
        events: events.data || [],
        photos: photos.data || [],
    });
});

// POST /update/:token/upload — image upload from phone camera/gallery
// ?save_photo=1 also inserts a row into entity_photos
router.post('/:token/upload', validateToken, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file' });
    const ext  = req.file.originalname.split('.').pop() || 'jpg';
    const name = `update-links/${req.entityId}/${Date.now()}.${ext}`;
    const g    = db();
    const { error } = await g.storage.from('entity-media').upload(name, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) return res.status(500).json({ error: error.message });
    const { data: { publicUrl } } = g.storage.from('entity-media').getPublicUrl(name);

    // If this is a standalone business photo (not an item image), persist it to entity_photos
    if (req.query.save_photo === '1') {
        const caption = req.body.caption || null;
        const { data: photo } = await g.from('entity_photos').insert({ entity_id: req.entityId, image_url: publicUrl, caption }).select().single();
        return res.json({ url: publicUrl, photo });
    }

    res.json({ url: publicUrl });
});

// DELETE /update/:token/photos/:id
router.delete('/:token/photos/:id', validateToken, async (req, res) => {
    const { error } = await db().from('entity_photos').delete().eq('id', req.params.id).eq('entity_id', req.entityId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Specials ──────────────────────────────────────────────────
router.post('/:token/specials', validateToken, async (req, res) => {
    const { id, special_name, discount_text, description, days, start_time, end_time, image_url, is_active = true } = req.body;
    if (!special_name) return res.status(400).json({ error: 'special_name required' });
    let data, error;
    if (req.siteId) {
        if (id) {
            ({ data, error } = await mainDb.from('specials').update({ special_name, discount_text, description, days, start_time, end_time }).eq('id', id).eq('site_id', req.siteId).select().single());
        } else {
            ({ data, error } = await mainDb.from('specials').insert({ site_id: req.siteId, special_name, discount_text, description, days, start_time, end_time }).select().single());
        }
    } else {
        const g = db();
        if (id) {
            ({ data, error } = await g.from('entity_specials').update({ special_name, discount_text, description, days, start_time, end_time, image_url, is_active }).eq('id', id).eq('entity_id', req.entityId).select().single());
        } else {
            ({ data, error } = await g.from('entity_specials').insert({ entity_id: req.entityId, special_name, discount_text, description, days, start_time, end_time, image_url, is_active }).select().single());
        }
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/specials/:id', validateToken, async (req, res) => {
    const { error } = req.siteId
        ? (await mainDb.from('specials').delete().eq('id', req.params.id).eq('site_id', req.siteId))
        : (await db().from('entity_specials').delete().eq('id', req.params.id).eq('entity_id', req.entityId));
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Menu sections + items ─────────────────────────────────────
router.post('/:token/menu-sections', validateToken, async (req, res) => {
    const { section_name, available_days, available_start, available_end } = req.body;
    if (!section_name) return res.status(400).json({ error: 'section_name required' });
    const { data, error } = await db().from('menu_sections')
        .insert({ entity_id: req.entityId, section_name, available_days: available_days || null, available_start: available_start || null, available_end: available_end || null })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.put('/:token/menu-sections/:id', validateToken, async (req, res) => {
    const { section_name, available_days, available_start, available_end } = req.body;
    if (!section_name) return res.status(400).json({ error: 'section_name required' });
    const { data, error } = await db().from('menu_sections')
        .update({ section_name, available_days: available_days || null, available_start: available_start || null, available_end: available_end || null })
        .eq('id', req.params.id).eq('entity_id', req.entityId).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/menu-sections/:id', validateToken, async (req, res) => {
    const { error } = await db().from('menu_sections').delete().eq('id', req.params.id).eq('entity_id', req.entityId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.post('/:token/menu-items', validateToken, async (req, res) => {
    let data, error;
    if (req.siteId) {
        const { id, name, description, price, category, item_type = 'food', photo_url, modifiers, tags } = req.body;
        if (!name) return res.status(400).json({ error: 'name required' });
        const payload = {
            name, description: description || '', price: parseFloat(price) || 0,
            category: category || 'Menu Items', item_type, photo_url: photo_url || null,
            modifiers: Array.isArray(modifiers) ? modifiers : [],
            tags: Array.isArray(tags) ? tags : [],
        };
        if (id) {
            ({ data, error } = await mainDb.from('menu_items').update(payload).eq('id', id).eq('site_id', req.siteId).select().single());
        } else {
            ({ data, error } = await mainDb.from('menu_items').insert({ site_id: req.siteId, ...payload }).select().single());
        }
    } else {
        const { id, item_name, description, price, price_text, menu_section_id, image_url, is_available = true, is_featured = false, is_catch_of_day = false, is_on_tap = false, has_market_price = false, sort_order = 0 } = req.body;
        if (!item_name) return res.status(400).json({ error: 'item_name required' });
        const g = db();

        // Determine if section is from entity_sections (section_type) or menu_sections
        let targetTable = 'menu_items';
        let sectionField = 'menu_section_id';
        if (menu_section_id) {
            const { data: sec } = await g.from('entity_sections').select('id').eq('id', menu_section_id).maybeSingle();
            if (sec) {
                targetTable = 'section_items';
                sectionField = 'section_id';
            }
        }

        if (targetTable === 'section_items') {
            const payload = { item_name, item_description: description || null, price_numeric: price !== '' && price != null ? parseFloat(price) : null, price_text: price_text || null, section_id: menu_section_id || null, image_url: image_url || null, sort_order };
            if (id) {
                ({ data, error } = await g.from('section_items').update(payload).eq('id', id).eq('entity_id', req.entityId).select().single());
            } else {
                ({ data, error } = await g.from('section_items').insert({ entity_id: req.entityId, ...payload }).select().single());
            }
        } else {
            const payload = { item_name, description: description || null, price: price !== '' && price != null ? parseFloat(price) : null, price_text: price_text || null, menu_section_id: menu_section_id || null, image_url: image_url || null, is_available, is_featured, is_catch_of_day, is_on_tap, has_market_price, sort_order };
            if (id) {
                ({ data, error } = await g.from('menu_items').update(payload).eq('id', id).eq('entity_id', req.entityId).select().single());
            } else {
                ({ data, error } = await g.from('menu_items').insert({ entity_id: req.entityId, ...payload }).select().single());
            }
        }
    }
    if (error) return res.status(500).json({ error: error.message });
    if (req.siteId && !req.body.id) syncToGcr(req.siteId, 'menu_item', data).catch(() => {});
    res.json({ item: data });
});

router.delete('/:token/menu-items/:id', validateToken, async (req, res) => {
    if (req.siteId) {
        const { error } = await mainDb.from('menu_items').delete().eq('id', req.params.id).eq('site_id', req.siteId);
        if (error) return res.status(500).json({ error: error.message });
    } else {
        const g = db();
        const id = req.params.id;
        // Try section_items first (where new data goes), then menu_items (legacy)
        await g.from('section_items').delete().eq('id', id).eq('entity_id', req.entityId).then(() => {}).catch(() => {});
        await g.from('menu_items').delete().eq('id', id).eq('entity_id', req.entityId).then(() => {}).catch(() => {});
    }
    res.json({ success: true });
});

// ── Drink items ───────────────────────────────────────────────
router.post('/:token/drink-items', validateToken, async (req, res) => {
    const { id, item_name, description, price, price_text, drink_section_id, image_url, is_available = true } = req.body;
    if (!item_name) return res.status(400).json({ error: 'item_name required' });
    const g = db();

    // Determine if section is from entity_sections (section_type) or drink_sections
    let targetTable = 'drink_items';
    if (drink_section_id) {
        const { data: sec } = await g.from('entity_sections').select('id').eq('id', drink_section_id).maybeSingle();
        if (sec) {
            targetTable = 'section_items';
        }
    }

    let data, error;
    if (targetTable === 'section_items') {
        const payload = { item_name, item_description: description || null, price_numeric: price !== '' && price != null ? parseFloat(price) : null, price_text: price_text || null, section_id: drink_section_id || null, image_url: image_url || null, sort_order: 0 };
        if (id) {
            ({ data, error } = await g.from('section_items').update(payload).eq('id', id).eq('entity_id', req.entityId).select().single());
        } else {
            ({ data, error } = await g.from('section_items').insert({ entity_id: req.entityId, ...payload }).select().single());
        }
    } else {
        const payload = { item_name, description: description || null, price: price !== '' && price != null ? parseFloat(price) : null, price_text: price_text || null, drink_section_id: drink_section_id || null, image_url: image_url || null, is_available };
        if (id) {
            ({ data, error } = await g.from('drink_items').update(payload).eq('id', id).eq('entity_id', req.entityId).select().single());
        } else {
            ({ data, error } = await g.from('drink_items').insert({ entity_id: req.entityId, ...payload }).select().single());
        }
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/drink-items/:id', validateToken, async (req, res) => {
    const g = db();
    const id = req.params.id;
    // Try section_items first (where new data goes), then drink_items (legacy)
    await g.from('section_items').delete().eq('id', id).eq('entity_id', req.entityId).then(() => {}).catch(() => {});
    await g.from('drink_items').delete().eq('id', id).eq('entity_id', req.entityId).then(() => {}).catch(() => {});
    res.json({ success: true });
});

// ── Happy Hour ────────────────────────────────────────────────
router.put('/:token/happy-hour', validateToken, async (req, res) => {
    const { hh_days, hh_start, hh_end, hh_description } = req.body;
    const { error } = await db().from('entity').update({ hh_days, hh_start, hh_end, hh_description }).eq('id', req.entityId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.post('/:token/hh-items', validateToken, async (req, res) => {
    const { id, item_name, description, regular_price, hh_price, price_text, image_url } = req.body;
    if (!item_name) return res.status(400).json({ error: 'item_name required' });
    const payload = { item_name, description: description || null, regular_price: regular_price ? parseFloat(regular_price) : null, hh_price: hh_price ? parseFloat(hh_price) : null, price_text: price_text || null, image_url: image_url || null };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('happy_hour_items').update(payload).eq('id', id).eq('entity_id', req.entityId).select().single());
    } else {
        ({ data, error } = await g.from('happy_hour_items').insert({ entity_id: req.entityId, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/hh-items/:id', validateToken, async (req, res) => {
    const { error } = await db().from('happy_hour_items').delete().eq('id', req.params.id).eq('entity_id', req.entityId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Events ────────────────────────────────────────────────────
router.post('/:token/events', validateToken, async (req, res) => {
    const { id, event_name, description, event_date, start_time, end_time, image_url, cover_charge, is_active = true } = req.body;
    if (!event_name) return res.status(400).json({ error: 'event_name required' });
    const payload = { event_name, description: description || null, event_date: event_date || null, start_time: start_time || null, end_time: end_time || null, image_url: image_url || null, cover_charge: cover_charge || null, is_active };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('entity_events').update(payload).eq('id', id).eq('entity_id', req.entityId).select().single());
    } else {
        ({ data, error } = await g.from('entity_events').insert({ entity_id: req.entityId, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/events/:id', validateToken, async (req, res) => {
    const { error } = await db().from('entity_events').delete().eq('id', req.params.id).eq('entity_id', req.entityId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Catch of the Day ──────────────────────────────────────
// Finds or creates the "Catch of the Day" menu section, then upserts the item.
const CATCH_SECTION_NAME = 'Catch of the Day';

router.get('/:token/catch', validateToken, async (req, res) => {
    const eid = req.entityId;
    const g = db();
    const [sectionRes, itemsRes] = await Promise.all([
        g.from('menu_sections').select('*').eq('entity_id', eid).eq('section_name', CATCH_SECTION_NAME).maybeSingle(),
        g.from('menu_sections').select('id').eq('entity_id', eid).eq('section_name', CATCH_SECTION_NAME).maybeSingle(),
    ]);
    let section = sectionRes.data;
    if (!section) {
        const ins = await g.from('menu_sections').insert({ entity_id: eid, section_name: CATCH_SECTION_NAME }).select().single();
        section = ins.data;
    }
    const items = section
        ? (await g.from('menu_items').select('*').eq('entity_id', eid).eq('menu_section_id', section.id).order('created_at')).data || []
        : [];
    res.json({ section, items });
});

router.post('/:token/catch', validateToken, async (req, res) => {
    const { id, item_name, description, price, is_market_price, image_url } = req.body;
    if (!item_name) return res.status(400).json({ error: 'item_name required' });
    const eid = req.entityId;
    const g = db();

    // Find or create the Catch of the Day section
    let { data: section } = await g.from('menu_sections').select('id').eq('entity_id', eid).eq('section_name', CATCH_SECTION_NAME).maybeSingle();
    if (!section) {
        const ins = await g.from('menu_sections').insert({ entity_id: eid, section_name: CATCH_SECTION_NAME }).select().single();
        section = ins.data;
    }

    const payload = {
        item_name,
        description: description || null,
        price: is_market_price ? null : (price ? parseFloat(price) : null),
        price_text: is_market_price ? 'Market Price' : null,
        image_url: image_url || null,
        menu_section_id: section.id,
        is_available: true,
    };

    let data, error;
    if (id) {
        ({ data, error } = await g.from('menu_items').update(payload).eq('id', id).eq('entity_id', eid).select().single());
    } else {
        ({ data, error } = await g.from('menu_items').insert({ entity_id: eid, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/catch/:id', validateToken, async (req, res) => {
    const { error } = await db().from('menu_items').delete().eq('id', req.params.id).eq('entity_id', req.entityId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// DAILY ROTATING SECTIONS — owner picks which presets are live today
// Starts EMPTY each day (no carry-over). Owner taps options, submits.
// Writes picks + upserts GCR menu_items, removes yesterday's auto-rows.
// ═══════════════════════════════════════════════════════════════

router.get('/:token/daily-rotation', validateToken, async (req, res) => {
    const eid = req.entityId;
    if (!eid) return res.json({ sections: [] });
    const g = db();
    const { data: sections, error: sErr } = await g
        .from('daily_rotation_sections')
        .select('*')
        .eq('entity_id', eid)
        .order('sort_order', { ascending: true });
    if (sErr) return res.status(500).json({ error: sErr.message });
    if (!sections.length) return res.json({ sections: [] });

    const sectionIds = sections.map(s => s.id);
    const { data: options, error: oErr } = await g
        .from('daily_rotation_options')
        .select('*')
        .in('section_id', sectionIds)
        .order('sort_order', { ascending: true });
    if (oErr) return res.status(500).json({ error: oErr.message });

    const bySection = {};
    options.forEach(o => { (bySection[o.section_id] ||= []).push(o); });
    const out = sections.map(s => ({ ...s, options: bySection[s.id] || [] }));
    res.json({ sections: out });
});

// Body: { picks: [{ option_id, price_override?, description_override? }, ...] }
// Replaces any existing picks for today for this entity.
router.post('/:token/daily-rotation/submit', validateToken, async (req, res) => {
    const eid = req.entityId;
    if (!eid) return res.status(400).json({ error: 'daily rotation requires an entity-based link' });
    const picks = Array.isArray(req.body && req.body.picks) ? req.body.picks : [];
    const g = db();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Fetch options + their sections so we can resolve names/defaults for upsert
    let optionsMap = {};
    if (picks.length) {
        const optIds = picks.map(p => p.option_id).filter(Boolean);
        const { data: opts, error: oErr } = await g
            .from('daily_rotation_options')
            .select('id, name, default_price, default_description, section_id')
            .in('id', optIds);
        if (oErr) return res.status(500).json({ error: oErr.message });
        opts.forEach(o => { optionsMap[o.id] = o; });
    }

    const sectionIdsUsed = [...new Set(Object.values(optionsMap).map(o => o.section_id))];
    let sectionsMap = {};
    if (sectionIdsUsed.length) {
        const { data: secs } = await g
            .from('daily_rotation_sections')
            .select('id, name, emoji')
            .in('id', sectionIdsUsed);
        (secs || []).forEach(s => { sectionsMap[s.id] = s; });
    }

    // 1. Clear today's existing picks for this entity (replace semantics)
    const { error: delPicksErr } = await g
        .from('daily_rotation_picks')
        .delete()
        .eq('entity_id', eid)
        .eq('pick_date', today);
    if (delPicksErr) return res.status(500).json({ error: delPicksErr.message });

    // 2. Remove yesterday's auto-inserted rotation menu_items from GCR.
    //    We identify them by menu_section matching any rotation section name.
    const rotationSectionNames = Object.values(sectionsMap).map(s => s.name);
    // Fetch all rotation-sections sections (including any that were used yesterday but unused today)
    const { data: allRotSecs } = await g
        .from('daily_rotation_sections')
        .select('name')
        .eq('entity_id', eid);
    const allRotNames = [...new Set([...rotationSectionNames, ...(allRotSecs || []).map(s => s.name)])];
    let rotMenuSecIds = [];
    if (allRotNames.length) {
        const { data: menuSecs } = await g
            .from('menu_sections')
            .select('id, section_name')
            .eq('entity_id', eid)
            .in('section_name', allRotNames);
        rotMenuSecIds = (menuSecs || []).map(s => s.id);
        if (rotMenuSecIds.length) {
            await g.from('menu_items')
                .delete()
                .eq('entity_id', eid)
                .in('menu_section_id', rotMenuSecIds);
        }
    }

    if (!picks.length) {
        markSubmitted(req.params.token);
        return res.json({ ok: true, picks: 0, menu_items: 0 });
    }

    // 3. Insert today's picks
    const pickRows = picks.map(p => ({
        entity_id: eid,
        section_id: optionsMap[p.option_id]?.section_id,
        option_id: p.option_id,
        pick_date: today,
        price_override: p.price_override != null && p.price_override !== '' ? Number(p.price_override) : null,
        description_override: p.description_override || null,
    })).filter(r => r.section_id);

    const { error: insPicksErr } = await g.from('daily_rotation_picks').insert(pickRows);
    if (insPicksErr) return res.status(500).json({ error: insPicksErr.message });

    // 4. Ensure a menu_section exists for each rotation section used today,
    //    then insert menu_items for each pick.
    const secNameToId = {};
    for (const secId of sectionIdsUsed) {
        const sec = sectionsMap[secId];
        if (!sec) continue;
        let { data: menuSec } = await g
            .from('menu_sections')
            .select('id')
            .eq('entity_id', eid)
            .eq('section_name', sec.name)
            .maybeSingle();
        if (!menuSec) {
            const ins = await g.from('menu_sections')
                .insert({ entity_id: eid, section_name: sec.name })
                .select('id').single();
            menuSec = ins.data;
        }
        if (menuSec) secNameToId[sec.name] = menuSec.id;
    }

    const menuRows = pickRows.map(p => {
        const opt = optionsMap[p.option_id];
        const sec = sectionsMap[p.section_id];
        if (!opt || !sec) return null;
        return {
            entity_id: eid,
            menu_section_id: secNameToId[sec.name],
            item_name: opt.name,
            price: p.price_override != null ? p.price_override : (opt.default_price != null ? opt.default_price : null),
            description: p.description_override || opt.default_description || null,
            is_available: true,
        };
    }).filter(Boolean);

    let insertedMenuCount = 0;
    if (menuRows.length) {
        const { data: insMenu, error: insMenuErr } = await g.from('menu_items').insert(menuRows).select('id');
        if (insMenuErr) return res.status(500).json({ error: insMenuErr.message });
        insertedMenuCount = (insMenu || []).length;
    }

    // ── Main-DB write-through ───────────────────────────────────
    // Best-effort: mirror today's rotation picks into Main DB menu_items
    // so the QR table menu (which reads Main DB) sees them too.
    // Skipped silently if entity has no matching Main-DB business by slug.
    let mainInserted = 0, mainSkipReason = null;
    try {
        const { data: entitySlugRow } = await g.from('entity').select('slug').eq('id', eid).maybeSingle();
        const slug = entitySlugRow?.slug;
        if (!slug) { mainSkipReason = 'no entity slug'; }
        else {
            const { data: biz } = await mainDb.from('businesses').select('site_id').eq('subdomain', slug).maybeSingle();
            if (!biz) { mainSkipReason = 'no main-db business with subdomain=' + slug; }
            else {
                const siteId = biz.site_id;
                // Delete all rotation rows from Main DB (identified by category = any rotation section name)
                if (allRotNames.length) {
                    await mainDb.from('menu_items').delete().eq('site_id', siteId).in('category', allRotNames);
                }
                if (menuRows.length) {
                    const mainRows = pickRows.map(p => {
                        const opt = optionsMap[p.option_id];
                        const sec = sectionsMap[p.section_id];
                        if (!opt || !sec) return null;
                        return {
                            site_id: siteId,
                            name: opt.name,
                            category: sec.name,
                            item_type: 'food',
                            price: p.price_override != null ? Number(p.price_override) : (opt.default_price != null ? Number(opt.default_price) : 0),
                            description: p.description_override || opt.default_description || '',
                        };
                    }).filter(Boolean);
                    if (mainRows.length) {
                        const { data: insMain, error: insMainErr } = await mainDb.from('menu_items').insert(mainRows).select('id');
                        if (insMainErr) { mainSkipReason = 'main insert error: ' + insMainErr.message; }
                        else { mainInserted = (insMain || []).length; }
                    }
                }
            }
        }
    } catch (e) {
        mainSkipReason = 'exception: ' + (e.message || String(e));
    }
    if (mainSkipReason) console.warn('[daily-rotation write-through]', mainSkipReason);

    markSubmitted(req.params.token);
    res.json({ ok: true, picks: pickRows.length, menu_items: insertedMenuCount, main_menu_items: mainInserted, main_skip: mainSkipReason });
});

// ═══════════════════════════════════════════════════════════════
// MENU SETUP — AI-powered onboarding (link_type = 'menu_setup')
// ═══════════════════════════════════════════════════════════════

const { extractJsonFromImage } = require('./ai-provider');

// Text-only fallback for website parsing (no image).
async function callAIForMenuText(prompt, { provider, model } = {}) {
    const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
    if (!apiKey) throw new Error('XAI_API_KEY not configured');
    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model || 'grok-3-mini',
            messages: [
                { role: 'system', content: 'You are a professional menu digitizer. Extract complete menu data and return ONLY valid JSON — no markdown, no explanation, just the JSON object.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.1,
        }),
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(clean);
}

const MENU_EXTRACT_PROMPT = `Extract ALL menu sections and items from this menu.

Return ONLY this JSON structure:
{
  "sections": [
    {
      "section_name": "Breakfast",
      "available_days": "Monday-Sunday",
      "available_start": "7:00 AM",
      "available_end": "11:00 AM",
      "items": [
        {
          "item_name": "Eggs Benedict",
          "description": "Poached eggs, Canadian bacon, hollandaise sauce",
          "price": 14.99,
          "price_text": null
        }
      ]
    }
  ]
}

Rules:
- If no explicit sections exist, group items logically (Appetizers, Entrees, Desserts, Drinks, etc.)
- For items with no fixed price (market, seasonal), set price to null and price_text to "Market Price"
- Prices must be numbers, not strings
- Keep descriptions concise but informative
- Extract EVERY item visible — do not skip any`;

// POST /update/:token/setup/parse-image — upload menu photo → Grok Vision
router.post('/:token/setup/parse-image', validateToken, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const ext  = req.file.originalname.split('.').pop() || 'jpg';
    const name = `menu-setup/${req.entityId}/${Date.now()}.${ext}`;
    const g = db();
    const { error: upErr } = await g.storage.from('entity-media').upload(name, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const { data: { publicUrl } } = g.storage.from('entity-media').getPublicUrl(name);

    try {
        const { provider, model } = req.body || {};
        const { result, provider: used } = await extractJsonFromImage({
            imageBase64: req.file.buffer.toString('base64'),
            mimeType: req.file.mimetype,
            systemPrompt: 'You are a professional menu digitizer. Extract complete menu data and return ONLY valid JSON — no markdown, no explanation, just the JSON object.',
            userPrompt: MENU_EXTRACT_PROMPT,
            provider, model,
            maxTokens: 4096,
        });
        res.json({ ok: true, result, image_url: publicUrl, _provider: used });
    } catch (e) {
        res.status(500).json({ error: 'AI parse failed: ' + e.message });
    }
});

// POST /update/:token/setup/parse-website — fetch website → extract text → AI
router.post('/:token/setup/parse-website', validateToken, async (req, res) => {
    const { url, provider, model } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    let pageText = '';
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MenuBot/1.0)' }, signal: AbortSignal.timeout(10000) });
        const html = await r.text();
        pageText = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim()
            .substring(0, 12000);
    } catch (e) {
        return res.status(400).json({ error: 'Could not fetch website: ' + e.message });
    }

    try {
        const result = await callAIForMenuText(`${MENU_EXTRACT_PROMPT}\n\nWebsite text:\n${pageText}`, { provider, model });
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: 'AI parse failed: ' + e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// OWNER-EDITOR AI SCAN — token-auth, base64 JSON in, structured JSON out.
// These mirror the dashboard /menu/extract + /events/extract endpoints
// but are reachable from restaurant-editor.html using a token instead of login.
// All accept optional { provider, model } in the body.
// ═══════════════════════════════════════════════════════════════

const OWNER_MENU_PROMPT = `You are a menu extraction assistant. Analyze this restaurant menu image and extract ALL visible menu items into structured JSON.

Return ONLY valid JSON:
{
  "categories": [
    {
      "name": "Category Name",
      "item_type": "food",
      "items": [
        {
          "name": "Item Name", "price": 12.99, "description": "...", "tags": [],
          "modifiers": [ { "name": "Add Bacon", "price": 2 } ]
        }
      ],
      "section_modifiers": [ { "name": "Add Chicken", "price": 5 } ]
    }
  ]
}

Rules:
- Extract ALL items — menus span columns, don't stop at a column edge
- Group by section; if none, use "Menu Items"
- price is a number; 0 if not visible
- tags: only "vegetarian", "vegan", "gluten-free", "spicy", "popular", "new" if clearly indicated
- item_type: "drink" for beverages/cocktails/beer/wine; "happy_hour" for HH sections; else "food"
- modifiers (per-item): add-on upcharges like "Add bacon $2" / "+$2 egg" — one object per add-on, price is a number, empty array if none
- section_modifiers: upcharges printed above a whole section (e.g. "Add chicken +$5, shrimp +$6") that apply to every item — put them here, not repeated on each item
- Return ONLY the JSON object, no markdown`;

const OWNER_SPECIALS_PROMPT = `Extract specials/promotions from this image into structured JSON.

Return ONLY valid JSON:
{
  "items": [
    {
      "special_name": "Name of special",
      "discount_text": "$5 drafts / Half off / BOGO / etc",
      "description": "Any details",
      "days": "Mon-Fri / Weekends / Daily / etc",
      "start_time": "HH:MM in 24hr if time-based",
      "end_time": "HH:MM in 24hr if time-based"
    }
  ]
}

Rules:
- Extract ALL visible specials
- Return ONLY JSON, no markdown`;

const OWNER_CATCH_PROMPT = `Extract the daily "Catch of the Day" / seafood board items into structured JSON.

Return ONLY valid JSON:
{
  "items": [
    {
      "name": "Fish/seafood name",
      "description": "Preparation details if visible",
      "price": 28.00,
      "is_market_price": false
    }
  ]
}

Rules:
- If marked "Market Price" or no fixed price, set price=null and is_market_price=true
- price is a number or null
- Return ONLY JSON, no markdown`;

async function runOwnerScan(req, res, { systemPrompt, userPrompt, maxTokens = 2048 }) {
    const { image_base64, mime_type, provider, model } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: 'image_base64 required' });
    try {
        const { result, provider: used } = await extractJsonFromImage({
            imageBase64: image_base64, mimeType: mime_type,
            systemPrompt, userPrompt, provider, model, maxTokens,
        });
        res.json({ ok: true, ...result, _provider: used });
    } catch (e) {
        const msg = e.message || 'unknown error';
        if (msg.startsWith('AI returned non-JSON')) {
            return res.status(422).json({ error: 'Could not parse image. Try a clearer photo.' });
        }
        res.status(500).json({ error: 'AI extraction failed: ' + msg });
    }
}

router.post('/:token/scan/menu', validateToken, (req, res) =>
    runOwnerScan(req, res, {
        systemPrompt: 'You extract structured menu data from images. Return ONLY valid JSON.',
        userPrompt: OWNER_MENU_PROMPT, maxTokens: 4096,
    }));

router.post('/:token/scan/specials', validateToken, (req, res) =>
    runOwnerScan(req, res, {
        systemPrompt: 'You extract restaurant specials/deals from images. Return ONLY valid JSON.',
        userPrompt: OWNER_SPECIALS_PROMPT, maxTokens: 2048,
    }));

router.post('/:token/scan/catch', validateToken, (req, res) =>
    runOwnerScan(req, res, {
        systemPrompt: 'You extract catch-of-the-day / seafood board items from images. Return ONLY valid JSON.',
        userPrompt: OWNER_CATCH_PROMPT, maxTokens: 1024,
    }));

// GET /update/:token/vision-providers — which providers are configured
router.get('/:token/vision-providers', validateToken, (req, res) => {
    const { getVisionProvidersStatus } = require('./ai-provider');
    res.json(getVisionProvidersStatus());
});

// POST /update/:token/setup/finish — convert this link to a full daily editor
router.post('/:token/setup/finish', validateToken, async (req, res) => {
    const { error } = await supabase.from('update_links')
        .update({ link_type: 'daily', expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() })
        .eq('token', req.params.token);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// POST /update/:token/setup/create — bulk-create all sections + items from AI output
router.post('/:token/setup/create', validateToken, async (req, res) => {
    const { sections } = req.body;
    if (!Array.isArray(sections) || !sections.length) return res.status(400).json({ error: 'sections array required' });
    const eid = req.entityId;
    const g = db();
    let created = { sections: 0, items: 0 };

    for (const sec of sections) {
        const { data: secRow, error: secErr } = await g.from('menu_sections').insert({
            entity_id: eid,
            section_name: sec.section_name || 'Menu',
            available_days:  sec.available_days  || null,
            available_start: sec.available_start || null,
            available_end:   sec.available_end   || null,
        }).select().single();
        if (secErr) continue;
        created.sections++;

        const items = (sec.items || []).filter(i => i.item_name);
        if (!items.length) continue;
        const rows = items.map(i => ({
            entity_id: eid,
            menu_section_id: secRow.id,
            item_name:   i.item_name,
            description: i.description || null,
            price:       i.price != null ? parseFloat(i.price) : null,
            price_text:  i.price_text || null,
            is_available: true,
        }));
        const { error: itemErr } = await g.from('menu_items').insert(rows);
        if (!itemErr) created.items += rows.length;
    }

    res.json({ ok: true, created });
});

// ── Pricing Items ────────────────────────────────────────────────────────────
router.post('/:token/pricing-items', validateToken, async (req, res) => {
    const { id, tier_name, price_from, price_to, price_label, duration, capacity_min, capacity_max, minimum_age, booking_advance_days, description } = req.body;
    if (!tier_name) return res.status(400).json({ error: 'tier_name required' });
    const payload = { tier_name, price_from: price_from || null, price_to: price_to || null, price_label: price_label || null, duration: duration || null, capacity_min: capacity_min || null, capacity_max: capacity_max || null, minimum_age: minimum_age || null, booking_advance_days: booking_advance_days || null, description: description || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('pricing_items').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('pricing_items').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/pricing-items/:id', validateToken, async (req, res) => {
    const { error } = await db().from('pricing_items').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── What's Included ──────────────────────────────────────────────────────────
router.post('/:token/whats-included', validateToken, async (req, res) => {
    const { id, item_name, icon, description, category } = req.body;
    if (!item_name) return res.status(400).json({ error: 'item_name required' });
    const payload = { item_name, icon: icon || null, description: description || null, category: category || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('whats_included').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('whats_included').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/whats-included/:id', validateToken, async (req, res) => {
    const { error } = await db().from('whats_included').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── FAQs ─────────────────────────────────────────────────────────────────────
router.post('/:token/faqs', validateToken, async (req, res) => {
    const { id, question, answer, category } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    const payload = { question, answer, category: category || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('faqs').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('faqs').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/faqs/:id', validateToken, async (req, res) => {
    const { error } = await db().from('faqs').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Requirements ─────────────────────────────────────────────────────────────
router.post('/:token/requirements', validateToken, async (req, res) => {
    const { id, requirement_name, description, requirement_type, applies_to } = req.body;
    if (!requirement_name) return res.status(400).json({ error: 'requirement_name required' });
    const payload = { requirement_name, description: description || null, requirement_type: requirement_type || null, applies_to: applies_to || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('requirements').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('requirements').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/requirements/:id', validateToken, async (req, res) => {
    const { error } = await db().from('requirements').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Sides / Add-ons ──────────────────────────────────────────────────────────
router.post('/:token/sides', validateToken, async (req, res) => {
    const { id, side_name, description, price, icon, category } = req.body;
    if (!side_name) return res.status(400).json({ error: 'side_name required' });
    const payload = { side_name, description: description || null, price: price || null, icon: icon || null, category: category || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('entity_sides').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('entity_sides').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/sides/:id', validateToken, async (req, res) => {
    const { error } = await db().from('entity_sides').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Daily Features ──────────────────────────────────────────────────────────
router.post('/:token/daily-features', validateToken, async (req, res) => {
    const { id, feature_name, description, feature_type, day_of_week, start_time, end_time, price, discount_percent } = req.body;
    if (!feature_name) return res.status(400).json({ error: 'feature_name required' });
    const payload = { feature_name, description: description || null, feature_type: feature_type || null, day_of_week: day_of_week || null, start_time: start_time || null, end_time: end_time || null, price: price || null, discount_percent: discount_percent || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('entity_daily_features').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('entity_daily_features').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/daily-features/:id', validateToken, async (req, res) => {
    const { error } = await db().from('entity_daily_features').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Secondary Hours ─────────────────────────────────────────────────────────
router.post('/:token/secondary-hours', validateToken, async (req, res) => {
    const { id, hours_type, day_of_week, opens_at, closes_at, is_closed, description } = req.body;
    if (!hours_type || day_of_week == null) return res.status(400).json({ error: 'hours_type and day_of_week required' });
    const payload = { hours_type, day_of_week, opens_at: opens_at || null, closes_at: closes_at || null, is_closed: !!is_closed, description: description || null, is_active: true };
    const g = db();
    let data, error;
    if (id) {
        ({ data, error } = await g.from('entity_secondary_hours').update(payload).eq('id', id).eq('entity_slug', req.entitySlug).select().single());
    } else {
        ({ data, error } = await g.from('entity_secondary_hours').insert({ entity_slug: req.entitySlug, ...payload }).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ item: data });
});

router.delete('/:token/secondary-hours/:id', validateToken, async (req, res) => {
    const { error } = await db().from('entity_secondary_hours').delete().eq('id', req.params.id).eq('entity_slug', req.entitySlug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

module.exports = router;
