// ============================================================
// ADMIN VIEW OVER THE UNIVERSAL BOOKING ENGINE
// ============================================================
// routes/platform.js owns the booking model and is scoped to ONE business —
// it resolves the slug from entity_owners using the signed-in user, which is
// exactly right for a business owner and useless for an operator who needs to
// see every business at once.
//
// This file adds that operator view. Same tables, same model, no new concepts:
//
//   offerings         the catalog — charters, cruises, rentals, rooms, addons
//   offering_prices   per-person / tiered pricing for an offering
//   bookings          ONE booking table for every booking-type app
//   booking_calendar  every date claim from every source (direct, manual
//                     block, airbnb, fareharbor, ical, email:<x>)
//   promos            discount codes
//   waivers           signed waivers
//   integrations      per-business third-party connections (fareharbor, …)
//
// Every route is adminRequired. The slug is a FILTER here rather than a
// security boundary, which is the whole difference from platform.js — so
// these routes must never be reachable with an owner token.
//
// Mounted in server.js as:
//   mount('/api/admin/platform', () => require('./routes/admin-platform'));

const express = require('express');
const { adminRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

/* ── helpers ─────────────────────────────────────────────────────────── */

const fail = (res, code, message) => res.status(code).json({ error: message });

/** Cap page size so a stray ?limit=999999 can't pull the whole table. */
function limitOf(req, fallback = 200, max = 1000) {
    const n = parseInt(req.query.limit, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

/**
 * Apply the filters every list route shares.
 * `slug` narrows to one business; absent means all of them.
 */
function applyCommon(query, req, { dateColumn } = {}) {
    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
    if (req.query.status) query = query.eq('status', req.query.status);
    if (dateColumn && req.query.from) query = query.gte(dateColumn, req.query.from);
    if (dateColumn && req.query.to) query = query.lte(dateColumn, req.query.to);
    return query;
}

/**
 * Attach business names to rows keyed by entity_slug, in one extra query.
 * Without this every list is a wall of slugs.
 */
async function withBusinessNames(rows) {
    const slugs = [...new Set((rows || []).map((r) => r.entity_slug).filter(Boolean))];
    if (slugs.length === 0) return rows || [];
    const { data } = await supabase.from('entity').select('slug, name').in('slug', slugs);
    const nameBySlug = Object.fromEntries((data || []).map((e) => [e.slug, e.name]));
    return (rows || []).map((r) => ({ ...r, entity_name: nameBySlug[r.entity_slug] || null }));
}

/** Only let through columns that exist, so a stray UI field can't 400 the write. */
function pick(body, allowed) {
    const out = {};
    for (const key of allowed) if (body[key] !== undefined) out[key] = body[key];
    return out;
}

/* ── bookings ────────────────────────────────────────────────────────── */
//
// The one table every booking-type app writes to. The unit (person, hour,
// day, night, ticket…) is data on the row, never a separate table.

const BOOKING_FIELDS = [
    'entity_slug', 'customer_name', 'phone', 'email', 'date', 'end_date',
    'start_time', 'party_size', 'adults', 'children', 'total_price',
    'deposit_paid', 'status', 'source', 'offering_id', 'qty', 'details',
];

router.get('/bookings', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('bookings')
            .select('*')
            .order('date', { ascending: false })
            .limit(limitOf(req));

        query = applyCommon(query, req, { dateColumn: 'date' });
        if (req.query.source) query = query.eq('source', req.query.source);
        if (req.query.offering_id) query = query.eq('offering_id', req.query.offering_id);
        if (req.query.q) {
            const q = String(req.query.q).replace(/[%,()]/g, '');
            query = query.or(`customer_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
        }

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);
        res.json({ bookings: await withBusinessNames(data), total: (data || []).length });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.get('/bookings/:id', adminRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
    if (error) return fail(res, 500, error.message);
    if (!data) return fail(res, 404, 'Booking not found');
    const [row] = await withBusinessNames([data]);
    res.json({ booking: row });
});

router.post('/bookings', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, BOOKING_FIELDS);
    if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
    if (!row.status) row.status = 'pending';
    if (!row.source) row.source = 'admin';

    const { data, error } = await supabase.from('bookings').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ booking: data });
});

router.patch('/bookings/:id', adminRequired, async (req, res) => {
    // entity_slug is deliberately not updatable — moving a booking between
    // businesses silently is never what anyone means.
    const row = pick(req.body || {}, BOOKING_FIELDS.filter((f) => f !== 'entity_slug'));
    if (Object.keys(row).length === 0) return fail(res, 400, 'Nothing to update');

    const { data, error } = await supabase
        .from('bookings')
        .update(row)
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Booking not found');
    res.json({ booking: data[0] });
});

router.delete('/bookings/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('bookings')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Booking not found');
    res.json({ success: true });
});

/* ── offerings ───────────────────────────────────────────────────────── */
//
// The catalog: a fishing charter, a dolphin cruise, a pontoon, a room, an
// add-on. `kind` and `section` say which app it belongs to; `details` keeps
// whatever that app stored.

const OFFERING_FIELDS = [
    'entity_slug', 'section', 'kind', 'name', 'description', 'unit',
    'price_from', 'capacity', 'active', 'details', 'sort_order',
];

/** The kinds platform.js writes, so the dashboard offers the same vocabulary. */
const OFFERING_KINDS = [
    'service', 'fleet', 'room', 'addon', 'item', 'gift_card', 'membership',
    'product', 'offering',
];

/** Units the booking engine understands. */
const OFFERING_UNITS = [
    'flat', 'person', 'hour', 'half_day', 'day', 'night', 'item', 'ticket',
];

router.get('/offering-meta', adminRequired, (_req, res) => {
    res.json({ kinds: OFFERING_KINDS, units: OFFERING_UNITS });
});

router.get('/offerings', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('offerings')
            .select('*')
            .order('entity_slug')
            .limit(limitOf(req, 500));

        if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
        if (req.query.kind) query = query.eq('kind', req.query.kind);
        if (req.query.section) query = query.eq('section', req.query.section);
        if (req.query.active === 'true') query = query.eq('active', true);
        if (req.query.active === 'false') query = query.eq('active', false);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);
        res.json({ offerings: await withBusinessNames(data), total: (data || []).length });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.post('/offerings', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, OFFERING_FIELDS);
    if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
    if (!row.name) return fail(res, 400, 'name is required');
    if (!row.kind) row.kind = 'offering';
    if (!row.unit) row.unit = 'flat';
    if (row.active === undefined) row.active = true;

    const { data, error } = await supabase.from('offerings').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ offering: data });
});

router.put('/offerings/:id', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, OFFERING_FIELDS.filter((f) => f !== 'entity_slug'));
    const { data, error } = await supabase
        .from('offerings')
        .update(row)
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Offering not found');
    res.json({ offering: data[0] });
});

router.delete('/offerings/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('offerings')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Offering not found');
    res.json({ success: true });
});

/* ── offering prices ─────────────────────────────────────────────────── */

const PRICE_FIELDS = ['offering_id', 'label', 'amount', 'unit', 'min_qty', 'max_qty', 'sort_order'];

router.get('/offerings/:id/prices', adminRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('offering_prices')
        .select('*')
        .eq('offering_id', req.params.id)
        .order('sort_order', { ascending: true });
    if (error) return fail(res, 500, error.message);
    res.json({ prices: data || [] });
});

router.post('/offerings/:id/prices', adminRequired, async (req, res) => {
    const row = { ...pick(req.body || {}, PRICE_FIELDS), offering_id: req.params.id };
    const { data, error } = await supabase.from('offering_prices').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ price: data });
});

router.put('/offering-prices/:id', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, PRICE_FIELDS.filter((f) => f !== 'offering_id'));
    const { data, error } = await supabase
        .from('offering_prices')
        .update(row)
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Price not found');
    res.json({ price: data[0] });
});

router.delete('/offering-prices/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('offering_prices')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Price not found');
    res.json({ success: true });
});

/* ── calendar ────────────────────────────────────────────────────────── */
//
// Every date claim, whatever made it. Availability is computed from this one
// table, so a manual block and a FareHarbor sync are the same kind of row.

const CALENDAR_FIELDS = [
    'entity_slug', 'offering_id', 'date', 'end_date', 'source', 'status',
    'booking_id', 'note', 'details',
];

router.get('/calendar', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('booking_calendar')
            .select('*')
            .order('date', { ascending: true })
            .limit(limitOf(req, 500));

        query = applyCommon(query, req, { dateColumn: 'date' });
        if (req.query.source) query = query.eq('source', req.query.source);
        if (req.query.offering_id) query = query.eq('offering_id', req.query.offering_id);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);
        res.json({ entries: await withBusinessNames(data), total: (data || []).length });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.post('/calendar', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, CALENDAR_FIELDS);
    if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
    if (!row.date) return fail(res, 400, 'date is required');
    if (!row.source) row.source = 'manual block';

    const { data, error } = await supabase.from('booking_calendar').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ entry: data });
});

router.delete('/calendar/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('booking_calendar')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Calendar entry not found');
    res.json({ success: true });
});

/* ── promos ──────────────────────────────────────────────────────────── */

const PROMO_FIELDS = ['entity_slug', 'code', 'type', 'amount', 'starts', 'ends', 'max_uses', 'used', 'active'];

router.get('/promos', adminRequired, async (req, res) => {
    let query = supabase.from('promos').select('*').limit(limitOf(req));
    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    res.json({ promos: await withBusinessNames(data), total: (data || []).length });
});

router.post('/promos', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, PROMO_FIELDS);
    if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
    if (!row.code) return fail(res, 400, 'code is required');
    row.code = String(row.code).trim().toUpperCase();

    const { data, error } = await supabase.from('promos').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ promo: data });
});

router.put('/promos/:id', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, PROMO_FIELDS.filter((f) => f !== 'entity_slug'));
    if (row.code) row.code = String(row.code).trim().toUpperCase();
    const { data, error } = await supabase.from('promos').update(row).eq('id', req.params.id).select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Promo not found');
    res.json({ promo: data[0] });
});

router.delete('/promos/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('promos')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Promo not found');
    res.json({ success: true });
});

/* ── waivers ─────────────────────────────────────────────────────────── */

router.get('/waivers', adminRequired, async (req, res) => {
    let query = supabase
        .from('waivers')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limitOf(req));
    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    res.json({ waivers: await withBusinessNames(data), total: (data || []).length });
});

/* ── integrations ────────────────────────────────────────────────────── */
//
// Which third parties each business is connected to. FareHarbor writes here
// via routes/fareharbor.js; anything else that connects should do the same,
// so this stays the one place to answer "what is this business using?".
//
// Credentials are stored encrypted by the integration that owns them and are
// never selected here — this route returns status only.

router.get('/integrations', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('integrations')
            .select('id, site_id, provider, status, created_at, updated_at, fh_shortname')
            .limit(limitOf(req, 500));
        if (req.query.provider) query = query.eq('provider', req.query.provider);
        if (req.query.status) query = query.eq('status', req.query.status);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);

        // integrations is keyed by site_id (the CyberCheck business), not by
        // entity_slug, so resolve names through the businesses table.
        const siteIds = [...new Set((data || []).map((r) => r.site_id).filter(Boolean))];
        let nameById = {};
        if (siteIds.length) {
            const { data: sites } = await supabase
                .from('businesses')
                .select('id, name, entity_slug')
                .in('id', siteIds);
            nameById = Object.fromEntries(
                (sites || []).map((s) => [s.id, { name: s.name, entity_slug: s.entity_slug }])
            );
        }

        res.json({
            integrations: (data || []).map((r) => ({
                ...r,
                business_name: nameById[r.site_id]?.name || null,
                entity_slug: nameById[r.site_id]?.entity_slug || null,
            })),
            total: (data || []).length,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── booking sources (email parser) ──────────────────────────────────── */
//
// Where the bookings actually come from.
//
// The platform does not hold live API connections to Peek Pro, FareHarbor,
// Thoroughbred and the rest — it receives their confirmation emails at
// gcr-<slug>@parse.gulfcoastradar.com and parses them. routes/email-parser.js
// recognises 24 platforms and writes every attempt to email_parser_log.
//
// That log is therefore the honest answer to "what is this business attached
// to?" — not a field someone remembered to fill in, but what has actually
// arrived. These routes aggregate it.
//
// NOTE: routes/email-parser.js has no auth at all, and its GET /log returns
// raw_text, customer_name, from_email and confirmation_no. These routes are
// adminRequired and omit raw_text by default, so the dashboard never needs the
// open one.

/**
 * The extractor list is read lazily from routes/email-parser.js. A top-level
 * require would mean a problem in that 1,400-line module takes this whole
 * router down with it, and everything else here works without it.
 */
function extractorNames() {
    try {
        const { EXTRACTORS } = require('./email-parser');
        return (EXTRACTORS || []).map((e) => e.name).filter(Boolean);
    } catch (err) {
        console.error('[admin-platform] could not read extractors:', err.message);
        return [];
    }
}

/** Human labels for the platforms the parser recognises. */
const PLATFORM_LABELS = {
    fareharbor: 'FareHarbor', peekpro: 'Peek Pro', boatbooker: 'BoatBooker',
    waverez: 'WaveRez', rezdy: 'Rezdy', bokun: 'Bókun', viator: 'Viator',
    getyourguide: 'GetYourGuide', airbnb: 'Airbnb', vrbo: 'VRBO',
    booking_com: 'Booking.com', opentable: 'OpenTable', resy: 'Resy',
    toast: 'Toast POS', vagaro: 'Vagaro', mindbody: 'MindBody',
    square: 'Square Appointments', honeybook: 'HoneyBook', acuity: 'Acuity',
    calendly: 'Calendly', booksy: 'Booksy', glossgenius: 'GlossGenius',
    yelp: 'Yelp Reservations', generic: 'Generic', unknown: 'Unrecognised',
};

router.get('/parser/platforms', adminRequired, (_req, res) => {
    const found = extractorNames();
    const names = found.length ? found : Object.keys(PLATFORM_LABELS);
    res.json({
        platforms: names.map((name) => ({ name, label: PLATFORM_LABELS[name] || name })),
        total: names.length,
    });
});

/**
 * Which platforms each business is actually attached to, derived from what has
 * arrived rather than from a field someone set.
 *
 * Returns one row per business with the platforms seen, volume, last received,
 * and how many failed to parse — plus every active business that has sent
 * nothing at all, which is the list worth acting on.
 */
router.get('/parser/sources', adminRequired, async (req, res) => {
    try {
        const since = req.query.since || null;

        let logQuery = supabase
            .from('email_parser_log')
            .select('entity_slug, platform, parsed, created_at, event_date')
            .order('created_at', { ascending: false })
            .limit(Math.min(parseInt(req.query.scan, 10) || 5000, 20000));
        if (since) logQuery = logQuery.gte('created_at', since);

        const [logs, entities] = await Promise.all([
            logQuery,
            supabase.from('entity').select('slug, name, entity_type, is_active').eq('is_active', true),
        ]);

        if (logs.error) return fail(res, 500, logs.error.message);

        const bySlug = new Map();
        for (const row of logs.data || []) {
            const slug = row.entity_slug || '(unaddressed)';
            if (!bySlug.has(slug)) {
                bySlug.set(slug, { entity_slug: slug, total: 0, failed: 0, last_seen: null, platforms: new Map() });
            }
            const entry = bySlug.get(slug);
            entry.total += 1;
            // `parsed` false means an email arrived that no extractor understood.
            if (row.parsed === false) entry.failed += 1;
            if (!entry.last_seen || row.created_at > entry.last_seen) entry.last_seen = row.created_at;

            const platform = row.platform || 'unknown';
            if (!entry.platforms.has(platform)) {
                entry.platforms.set(platform, { platform, label: PLATFORM_LABELS[platform] || platform, count: 0, last_seen: null });
            }
            const p = entry.platforms.get(platform);
            p.count += 1;
            if (!p.last_seen || row.created_at > p.last_seen) p.last_seen = row.created_at;
        }

        const nameBySlug = Object.fromEntries((entities.data || []).map((e) => [e.slug, e]));

        const sources = [...bySlug.values()].map((entry) => ({
            ...entry,
            entity_name: nameBySlug[entry.entity_slug]?.name || null,
            entity_type: nameBySlug[entry.entity_slug]?.entity_type || null,
            bcc_email: `gcr-${entry.entity_slug}@parse.gulfcoastradar.com`,
            platforms: [...entry.platforms.values()].sort((a, b) => b.count - a.count),
        })).sort((a, b) => b.total - a.total);

        // Active businesses the parser has never heard from.
        const seen = new Set(sources.map((s) => s.entity_slug));
        const unattached = (entities.data || [])
            .filter((e) => !seen.has(e.slug))
            .map((e) => ({
                entity_slug: e.slug,
                entity_name: e.name,
                entity_type: e.entity_type,
                bcc_email: `gcr-${e.slug}@parse.gulfcoastradar.com`,
            }));

        res.json({
            sources,
            unattached,
            scanned: (logs.data || []).length,
            active_businesses: (entities.data || []).length,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/**
 * The parse log, admin-scoped. `raw_text` is omitted unless explicitly asked
 * for — it holds the whole email body, which is customer correspondence.
 */
router.get('/parser/log', adminRequired, async (req, res) => {
    const columns = req.query.include_raw === 'true'
        ? '*'
        : 'id, entity_slug, platform, booking_type, event_date, event_time, party_size, customer_name, activity_name, confirmation_no, parsed, manual, subject, from_email, created_at';

    let query = supabase
        .from('email_parser_log')
        .select(columns)
        .order('created_at', { ascending: false })
        .limit(Math.min(parseInt(req.query.limit, 10) || 200, 1000));

    if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
    if (req.query.platform) query = query.eq('platform', req.query.platform);
    if (req.query.parsed === 'false') query = query.eq('parsed', false);
    if (req.query.parsed === 'true') query = query.eq('parsed', true);
    if (req.query.from) query = query.gte('created_at', req.query.from);

    const { data, error } = await query;
    if (error) return fail(res, 500, error.message);
    res.json({ logs: await withBusinessNames(data), total: (data || []).length });
});

/* ── inventory & capacity ────────────────────────────────────────────── */
//
// "What does this business actually have?" — five pontoons, two charters,
// forty covers. Two independent answers live in the schema and the dashboard
// needs both:
//
//   entity.daily_capacity / capacity_per_slot   the coarse number the email
//                                               parser subtracts from when a
//                                               confirmation lands
//   offerings (+ capacity)                      the itemised catalog
//
// Without a capacity on file the parser can log a booking but cannot say how
// many spots are left, so `remaining` stays null and nothing can be marketed
// as last-minute. That is exactly the gap this route makes visible.

router.get('/capacity', adminRequired, async (req, res) => {
    try {
        let entityQuery = supabase
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, phone, email, daily_capacity, capacity_per_slot, is_active')
            .order('name')
            .limit(limitOf(req, 1000, 5000));

        if (req.query.slug) entityQuery = entityQuery.eq('slug', req.query.slug);
        if (req.query.type) entityQuery = entityQuery.eq('entity_type', req.query.type);
        if (req.query.active !== 'false') entityQuery = entityQuery.eq('is_active', true);

        const [entities, offerings] = await Promise.all([
            entityQuery,
            supabase.from('offerings').select('entity_slug, kind, capacity, active').limit(5000),
        ]);
        if (entities.error) return fail(res, 500, entities.error.message);

        // offerings is optional — a deployment without the booking tables
        // still gets the capacity column, just with zeroed inventory.
        const byslug = {};
        for (const o of offerings.data || []) {
            if (!o.entity_slug) continue;
            const e = (byslug[o.entity_slug] ||= { offerings: 0, active_offerings: 0, seats: 0, kinds: {} });
            e.offerings += 1;
            if (o.active !== false) e.active_offerings += 1;
            if (o.capacity) e.seats += Number(o.capacity) || 0;
            if (o.kind) e.kinds[o.kind] = (e.kinds[o.kind] || 0) + 1;
        }

        const businesses = (entities.data || []).map((e) => {
            const inv = byslug[e.slug] || { offerings: 0, active_offerings: 0, seats: 0, kinds: {} };
            return {
                entity_slug: e.slug,
                entity_name: e.name,
                entity_type: e.entity_type,
                entity_subtype: e.entity_subtype,
                phone: e.phone,
                email: e.email,
                daily_capacity: e.daily_capacity ?? null,
                capacity_per_slot: e.capacity_per_slot ?? null,
                // The parser can only compute "spots left" once this is set.
                capacity_configured: !!e.daily_capacity,
                bcc_email: `gcr-${e.slug}@parse.gulfcoastradar.com`,
                offerings: inv.offerings,
                active_offerings: inv.active_offerings,
                offering_seats: inv.seats,
                offering_kinds: Object.entries(inv.kinds).map(([kind, count]) => ({ kind, count })),
            };
        });

        res.json({
            businesses,
            total: businesses.length,
            configured: businesses.filter((b) => b.capacity_configured).length,
            with_offerings: businesses.filter((b) => b.offerings > 0).length,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

// Set the capacity the parser counts down from. POST /api/email-parser/setup/
// :slug does the same write but has no auth on it at all, so the dashboard
// uses this instead.
router.put('/capacity/:slug', adminRequired, async (req, res) => {
    try {
        const { daily_capacity, capacity_per_slot } = req.body || {};
        const row = { updated_at: new Date().toISOString() };

        if (daily_capacity !== undefined) {
            const n = parseInt(daily_capacity, 10);
            // null clears it back to "unknown capacity", which is a real state.
            if (daily_capacity !== null && daily_capacity !== '' && !Number.isFinite(n)) {
                return fail(res, 400, 'daily_capacity must be a number or null');
            }
            row.daily_capacity = daily_capacity === null || daily_capacity === '' ? null : n;
        }
        if (capacity_per_slot !== undefined) {
            const n = parseInt(capacity_per_slot, 10);
            if (capacity_per_slot !== null && capacity_per_slot !== '' && !Number.isFinite(n)) {
                return fail(res, 400, 'capacity_per_slot must be a number or null');
            }
            row.capacity_per_slot = capacity_per_slot === null || capacity_per_slot === '' ? null : n;
        }
        if (Object.keys(row).length === 1) return fail(res, 400, 'Nothing to update');

        const { data, error } = await supabase
            .from('entity')
            .update(row)
            .eq('slug', req.params.slug)
            .select('slug, name, daily_capacity, capacity_per_slot');
        if (error) return fail(res, 400, error.message);
        if (!data || !data.length) return fail(res, 404, 'Business not found');

        res.json({
            business: {
                ...data[0],
                bcc_email: `gcr-${req.params.slug}@parse.gulfcoastradar.com`,
                capacity_configured: !!data[0].daily_capacity,
            },
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── availability ────────────────────────────────────────────────────── */
//
// business_availability is where capacity meets bookings: one row per
// (business, date, time slot) carrying total_capacity, booked_count and
// remaining_spots. The email parser writes it on every confirmation, the iCal
// importer blocks dates in it, and an admin can hand-edit a row.
//
// /api/admin/gcr/entities/:slug/availability already reads and writes ONE
// business. This is the same data across all of them, which is what an
// operator watching the whole coast needs.

const AVAILABILITY_FIELDS = [
    'entity_slug', 'availability_date', 'time_slot', 'resource_id',
    'total_capacity', 'booked_count', 'remaining_spots', 'status',
    'visible_on_profile', 'source_platform', 'booking_type',
    'last_minute_deal', 'last_minute_price', 'original_price',
];

router.get('/availability', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('business_availability')
            .select('*')
            .order('availability_date')
            .order('time_slot')
            .limit(limitOf(req, 500, 2000));

        query = applyCommon(query, req, { dateColumn: 'availability_date' });
        if (req.query.platform) query = query.eq('source_platform', req.query.platform);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);
        res.json({ availability: await withBusinessNames(data), total: (data || []).length });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

// Upsert one (slug, date, time_slot) row. Keyed rather than id-addressed
// because that triple is how every writer — parser, iCal, admin — finds it.
router.put('/availability', adminRequired, async (req, res) => {
    try {
        const row = pick(req.body || {}, AVAILABILITY_FIELDS);
        if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
        if (!row.availability_date) return fail(res, 400, 'availability_date is required');
        row.time_slot = row.time_slot || '00:00';
        row.last_updated = new Date().toISOString();

        // Keep remaining_spots consistent when the admin edits capacity or
        // bookings but not the derived number, so the deal engine and the
        // public profile never disagree with the row they read from.
        if (row.remaining_spots === undefined && row.total_capacity != null) {
            row.remaining_spots = Math.max(0, Number(row.total_capacity) - Number(row.booked_count || 0));
        }
        if (!row.status && row.remaining_spots != null) {
            row.status = row.remaining_spots === 0 ? 'full' : row.remaining_spots <= 3 ? 'limited' : 'available';
        }

        let find = supabase
            .from('business_availability')
            .select('id')
            .eq('entity_slug', row.entity_slug)
            .eq('availability_date', row.availability_date)
            .eq('time_slot', row.time_slot);
        find = row.resource_id ? find.eq('resource_id', row.resource_id) : find.is('resource_id', null);
        const { data: existing } = await find.maybeSingle();

        const write = existing
            ? await supabase.from('business_availability').update(row).eq('id', existing.id).select().single()
            : await supabase.from('business_availability').insert(row).select().single();
        if (write.error) return fail(res, 400, write.error.message);

        res.json({ availability: write.data, created: !existing });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.delete('/availability/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('business_availability')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Availability row not found');
    res.json({ success: true });
});

/* ── openings ────────────────────────────────────────────────────────── */
//
// The point of the whole parser pipeline: a boat that still has three seats
// on Saturday is a thing you can sell today. This route is the outreach
// worklist — near-term dates with spots left, each carrying the contact
// details needed to send an email or an SMS about it, and whether a deal has
// already been posted so nobody markets the same gap twice.

router.get('/openings', adminRequired, async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 30);
        const today = new Date().toISOString().slice(0, 10);
        const from = req.query.from || today;
        const to = req.query.to
            || new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * 86400000).toISOString().slice(0, 10);
        // Only dates with SOME spots left are sellable; "full" and "blocked"
        // are the opposite of an opening.
        const threshold = Math.min(Math.max(parseInt(req.query.threshold, 10) || 5, 1), 100);

        let query = supabase
            .from('business_availability')
            .select('*')
            .gte('availability_date', from)
            .lte('availability_date', to)
            .gt('remaining_spots', 0)
            .lte('remaining_spots', threshold)
            .order('availability_date')
            .order('remaining_spots')
            .limit(limitOf(req, 300, 1000));
        if (req.query.slug) query = query.eq('entity_slug', req.query.slug);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);

        const rows = data || [];
        const slugs = [...new Set(rows.map((r) => r.entity_slug).filter(Boolean))];

        // Contact details and any deal already live for the same (slug, date),
        // both in one query each rather than per row.
        const [entities, deals] = await Promise.all([
            slugs.length
                ? supabase.from('entity')
                    .select('slug, name, entity_type, entity_subtype, phone, email, booking_url, hero_image_url, price_from, price_unit')
                    .in('slug', slugs)
                : { data: [] },
            slugs.length
                ? supabase.from('gcr_deals')
                    .select('id, entity_slug, valid_date, headline, is_active, source, spots_remaining')
                    .in('entity_slug', slugs)
                    .gte('valid_date', from)
                    .lte('valid_date', to)
                : { data: [] },
        ]);

        const entityBySlug = Object.fromEntries((entities.data || []).map((e) => [e.slug, e]));
        const dealKey = (slug, date) => `${slug}|${date}`;
        const dealByKey = {};
        for (const d of deals.data || []) {
            // An inactive deal must not mask a gap that is open again.
            if (d.is_active === false) continue;
            dealByKey[dealKey(d.entity_slug, d.valid_date)] = d;
        }

        const openings = rows.map((r) => {
            const e = entityBySlug[r.entity_slug] || {};
            const deal = dealByKey[dealKey(r.entity_slug, r.availability_date)] || null;
            return {
                id: r.id,
                entity_slug: r.entity_slug,
                entity_name: e.name || null,
                entity_type: e.entity_type || null,
                entity_subtype: e.entity_subtype || null,
                date: r.availability_date,
                time_slot: r.time_slot,
                remaining_spots: r.remaining_spots,
                total_capacity: r.total_capacity,
                booked_count: r.booked_count,
                status: r.status,
                source_platform: r.source_platform,
                last_updated: r.last_updated,
                // everything outreach needs, so the UI never has to fan out
                phone: e.phone || null,
                email: e.email || null,
                booking_url: e.booking_url || null,
                image_url: e.hero_image_url || null,
                price_from: e.price_from ?? null,
                price_unit: e.price_unit || null,
                deal_posted: !!deal,
                deal: deal ? { id: deal.id, headline: deal.headline, source: deal.source } : null,
            };
        });

        res.json({
            openings,
            total: openings.length,
            from,
            to,
            threshold,
            unmarketed: openings.filter((o) => !o.deal_posted).length,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── external calendars (iCal) ───────────────────────────────────────── */
//
// The second ingestion path alongside the email parser. A business pastes the
// .ics export URL from Airbnb / VRBO / Google, a cron polls it hourly
// (GET /api/email-parser/ical-import/run) and every date the feed claims gets
// blocked here too. Owners manage their own feeds under /api/dashboard/ical/
// external; this is the operator's view of every feed at once.

const ICAL_FEED_FIELDS = ['entity_slug', 'source_label', 'provider', 'ical_url', 'resource_id'];

router.get('/calendars', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('entity_external_calendars')
            .select('id, entity_slug, source_label, provider, resource_id, ical_url, last_synced_at, last_sync_status, created_at')
            .order('entity_slug')
            .limit(limitOf(req, 500));
        if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
        if (req.query.provider) query = query.eq('provider', req.query.provider);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);

        const rows = await withBusinessNames(data);
        res.json({
            calendars: rows,
            total: rows.length,
            // last_sync_status is free text written by the sync job; anything
            // starting "error:" is a feed that needs attention.
            failing: rows.filter((r) => (r.last_sync_status || '').startsWith('error')).length,
            never_synced: rows.filter((r) => !r.last_synced_at).length,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.post('/calendars', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, ICAL_FEED_FIELDS);
    if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
    if (!row.ical_url) return fail(res, 400, 'ical_url is required');
    if (!/^https?:\/\//i.test(row.ical_url)) return fail(res, 400, 'ical_url must be an http(s) URL');
    if (!row.source_label) row.source_label = 'External Calendar';

    const { data, error } = await supabase.from('entity_external_calendars').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ calendar: data });
});

router.patch('/calendars/:id', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, ICAL_FEED_FIELDS.filter((f) => f !== 'entity_slug'));
    if (Object.keys(row).length === 0) return fail(res, 400, 'Nothing to update');
    if (row.ical_url && !/^https?:\/\//i.test(row.ical_url)) {
        return fail(res, 400, 'ical_url must be an http(s) URL');
    }

    const { data, error } = await supabase
        .from('entity_external_calendars')
        .update(row)
        .eq('id', req.params.id)
        .select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Calendar not found');
    res.json({ calendar: data[0] });
});

router.delete('/calendars/:id', adminRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('entity_external_calendars')
        .select('id, entity_slug')
        .eq('id', req.params.id)
        .maybeSingle();
    if (!row) return fail(res, 404, 'Calendar not found');

    const { error } = await supabase.from('entity_external_calendars').delete().eq('id', row.id);
    if (error) return fail(res, 400, error.message);

    // Free the dates this feed had claimed, exactly as the owner-side delete
    // does — a removed feed must not leave dates blocked forever.
    await supabase.from('booking_calendar')
        .delete()
        .eq('entity_slug', row.entity_slug)
        .eq('source', 'ical:' + row.id);

    res.json({ success: true });
});

// Sync one feed now. routes/email-parser.js owns the sync; it is required
// lazily and in-process, so a fault in that module can't take this router
// down at boot and there is no HTTP hop back to ourselves.
router.post('/calendars/:id/sync', adminRequired, async (req, res) => {
    try {
        const { data: row } = await supabase
            .from('entity_external_calendars')
            .select('*')
            .eq('id', req.params.id)
            .maybeSingle();
        if (!row) return fail(res, 404, 'Calendar not found');

        let sync;
        try {
            ({ syncExternalCalendar: sync } = require('./email-parser'));
        } catch (err) {
            return fail(res, 503, 'Calendar sync unavailable: ' + err.message);
        }
        if (typeof sync !== 'function') return fail(res, 503, 'Calendar sync unavailable');

        await sync(row);

        const { data: after } = await supabase
            .from('entity_external_calendars')
            .select('id, last_synced_at, last_sync_status')
            .eq('id', row.id)
            .maybeSingle();
        res.json({ success: true, calendar: after || null });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── deals ───────────────────────────────────────────────────────────── */
//
// gcr_deals is the outbound side: the parser auto-posts one when a date drops
// to a handful of spots (source 'email_parser'), the manual availability
// editor posts one too ('availability_sync'), and an operator can write one by
// hand. The dashboard needs to see and retire them, which nothing exposed.

const DEAL_FIELDS = [
    'entity_slug', 'entity_name', 'deal_type', 'headline', 'description',
    'deal_price', 'original_price', 'price_unit', 'valid_date',
    'valid_start_time', 'expires_at', 'is_today_only', 'spots_total',
    'spots_remaining', 'claim_type', 'claim_url', 'claim_phone', 'is_active',
    'is_featured', 'promoted_feed', 'promoted_sms', 'swipe_card', 'image_url',
];

router.get('/deals', adminRequired, async (req, res) => {
    try {
        let query = supabase
            .from('gcr_deals')
            .select('*')
            .order('valid_date', { ascending: false })
            .limit(limitOf(req, 300));

        if (req.query.slug) query = query.eq('entity_slug', req.query.slug);
        if (req.query.source) query = query.eq('source', req.query.source);
        if (req.query.active === 'true') query = query.eq('is_active', true);
        if (req.query.active === 'false') query = query.eq('is_active', false);
        if (req.query.from) query = query.gte('valid_date', req.query.from);
        if (req.query.to) query = query.lte('valid_date', req.query.to);

        const { data, error } = await query;
        if (error) return fail(res, 500, error.message);
        res.json({ deals: data || [], total: (data || []).length });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

router.post('/deals', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, DEAL_FIELDS);
    if (!row.entity_slug) return fail(res, 400, 'entity_slug is required');
    if (!row.headline) return fail(res, 400, 'headline is required');
    if (row.is_active === undefined) row.is_active = true;
    if (!row.deal_type) row.deal_type = 'last_minute';
    // 'admin' marks it as hand-written, so the auto-deal upserts (which key on
    // source) never overwrite or deactivate it.
    row.source = 'admin';
    row.posted_by = 'admin';
    row.created_at = new Date().toISOString();

    const { data, error } = await supabase.from('gcr_deals').insert(row).select().single();
    if (error) return fail(res, 400, error.message);
    res.status(201).json({ deal: data });
});

router.patch('/deals/:id', adminRequired, async (req, res) => {
    const row = pick(req.body || {}, DEAL_FIELDS.filter((f) => f !== 'entity_slug'));
    if (Object.keys(row).length === 0) return fail(res, 400, 'Nothing to update');
    row.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('gcr_deals').update(row).eq('id', req.params.id).select();
    if (error) return fail(res, 400, error.message);
    if (!data || !data.length) return fail(res, 404, 'Deal not found');
    res.json({ deal: data[0] });
});

router.delete('/deals/:id', adminRequired, async (req, res) => {
    const { error, count } = await supabase
        .from('gcr_deals')
        .delete({ count: 'exact' })
        .eq('id', req.params.id);
    if (error) return fail(res, 400, error.message);
    if (!count) return fail(res, 404, 'Deal not found');
    res.json({ success: true });
});

/* ── cross-board availability search ─────────────────────────────────── */
//
// "Pick a date. Show me everything open on it, in every industry."
//
// This is the operator's version of the tourist-facing
// POST /api/gcr/availability-search. Three differences, and each of them is
// the reason this route exists rather than reusing that one:
//
//   1. It returns businesses with NO availability data too, labelled as such.
//      A tourist doesn't want those; an operator very much does — a business
//      sending nothing is the thing to go chase.
//   2. It rolls units up to their complex. A condo building is one `entity`
//      with child entities hanging off `parent_entity_slug`, and "what does
//      this complex have free on the 15th" is a question about the children.
//   3. It reads rows a business has hidden from its public profile
//      (`visible_on_profile = false`), because the operator is not the public.
//
// The three-source merge itself lives in routes/availability-engine.js and is
// shared with the embed widget, so the calendar on a business's own website
// and this screen can never disagree.

const AVAIL = require('./availability-engine');

router.get('/verticals', adminRequired, (_req, res) => {
    // The industries the dashboard builds a page each from, so the nav and
    // the classifier can never disagree about what exists.
    const shape = (v) => ({
        id: v.id,
        label: v.label,
        default_coverage: v.coverage,
        unit_word: v.unit_word || 'spots',
    });
    res.json({
        verticals: AVAIL.VERTICAL_PATTERNS.map(shape).concat([shape(AVAIL.OTHER_VERTICAL)]),
        stay_types: AVAIL.STAY_TYPES,
    });
});

router.get('/search', adminRequired, async (req, res) => {
    try {
        const from = String(req.query.from || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail(res, 400, 'from is required (YYYY-MM-DD)');
        const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : from;
        if (to < from) return fail(res, 400, 'to must not be before from');

        const requestedDates = AVAIL.datesBetween(from, to, 120);
        const vertical = req.query.vertical && req.query.vertical !== 'all' ? String(req.query.vertical) : null;
        // Explicit coverage wins; otherwise the vertical decides, and a
        // mixed search falls back to "any open day", which is the only
        // sane default when stays and charters are in the same result set.
        const coverage = req.query.coverage === 'all' || req.query.coverage === 'any'
            ? req.query.coverage
            : (vertical ? AVAIL.coverageFor(vertical) : 'any');

        let entityQuery = supabase
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, city, phone, email, hero_image_url, booking_url, rating, price_from, price_unit, daily_capacity, capacity_per_slot, parent_slug:parent_entity_slug, is_active')
            .eq('is_active', true)
            .limit(limitOf(req, 1000, 4000));

        if (req.query.slug) entityQuery = entityQuery.eq('slug', req.query.slug);
        if (req.query.city) entityQuery = entityQuery.eq('city', req.query.city);
        if (req.query.type) entityQuery = entityQuery.eq('entity_type', req.query.type);
        if (req.query.q) {
            const q = String(req.query.q).replace(/[%,()]/g, '');
            entityQuery = entityQuery.or(`name.ilike.%${q}%,entity_subtype.ilike.%${q}%,city.ilike.%${q}%`);
        }

        const { data: entities, error } = await entityQuery;
        if (error) return fail(res, 500, error.message);

        const all = entities || [];
        const byVertical = new Map(all.map((e) => [e.slug, AVAIL.verticalOf(e)]));
        const scoped = vertical ? all.filter((e) => byVertical.get(e.slug) === vertical) : all;

        // Children are read even when the vertical filter excluded them, so a
        // complex can still report what its units have free.
        const scopedSlugs = new Set(scoped.map((e) => e.slug));
        const childrenOf = new Map();
        for (const e of all) {
            if (!e.parent_slug || !scopedSlugs.has(e.parent_slug)) continue;
            if (!childrenOf.has(e.parent_slug)) childrenOf.set(e.parent_slug, []);
            childrenOf.get(e.parent_slug).push(e);
        }

        const needed = new Set(scoped.map((e) => e.slug));
        for (const kids of childrenOf.values()) for (const k of kids) needed.add(k.slug);

        const availability = await AVAIL.readAvailability({
            from,
            to,
            slugs: [...needed],
            publicOnly: false,
        });

        const shape = (e) => {
            // Unclaimed dates count as open when we know a capacity, unknown
            // when we don't — a row only exists once something takes a date.
            // A condo unit is one unit whether or not anyone set the number.
            const isUnit = !!e.parent_slug && AVAIL.STAY_TYPES.includes(String(e.entity_type || '').toLowerCase());
            const fallback = e.daily_capacity ?? (isUnit ? 1 : null);
            const summary = AVAIL.summarise(availability.get(e.slug), requestedDates, coverage, fallback);
            return {
                entity_slug: e.slug,
                entity_name: e.name,
                entity_type: e.entity_type,
                entity_subtype: e.entity_subtype,
                vertical: byVertical.get(e.slug) || AVAIL.verticalOf(e),
                city: e.city,
                phone: e.phone,
                email: e.email,
                image_url: e.hero_image_url,
                booking_url: e.booking_url,
                rating: e.rating,
                price_from: e.price_from,
                price_unit: e.price_unit,
                daily_capacity: e.daily_capacity ?? null,
                parent_slug: e.parent_slug || null,
                ...summary,
            };
        };

        const results = scoped.map((e) => {
            const row = shape(e);
            const kids = childrenOf.get(e.slug) || [];
            if (kids.length) {
                row.units = kids.map(shape).sort((a, b) => (a.entity_name || '').localeCompare(b.entity_name || ''));
                row.unit_count = row.units.length;
                row.units_available = row.units.filter((u) => u.meets_coverage).length;
                // A complex is bookable if the building itself is, OR if any
                // of its units is. Rolling up matters because the parent
                // usually carries no availability of its own — the inventory
                // lives entirely on the children.
                if (row.units_available > 0) {
                    row.meets_coverage = true;
                    row.has_data = true;
                    const unitDates = new Set();
                    for (const u of row.units) for (const d of u.available_dates) unitDates.add(d);
                    row.available_dates = [...unitDates].sort();
                    row.open_days = row.available_dates.length;
                    row.covers_all_days = requestedDates.every((d) => unitDates.has(d));
                }
            }
            return row;
        });

        // A unit already appears nested under its complex, so listing it at the
        // top level too doubles every building in the results. Flat listing is
        // still available for "show me every individual condo on the 15th".
        const parentsShown = new Set(results.filter((r) => (r.unit_count || 0) > 0).map((r) => r.entity_slug));
        const includeUnits = req.query.include_units === 'true';
        const deduped = includeUnits
            ? results
            : results.filter((r) => !r.parent_slug || !parentsShown.has(r.parent_slug));

        const onlyAvailable = req.query.only_available === 'true';
        const visible = onlyAvailable ? deduped.filter((r) => r.meets_coverage) : deduped;

        // Rank: actually open first, then the ones we can at least reach, then
        // rating. A business with no data is not "unavailable" — it is
        // unknown, and it sorts last so it never masks a real opening.
        visible.sort((a, b) => {
            const rank = (r) => (r.meets_coverage ? 2 : r.has_data ? 1 : 0);
            if (rank(b) !== rank(a)) return rank(b) - rank(a);
            return (b.rating || 0) - (a.rating || 0);
        });

        const counts = {};
        for (const r of deduped) {
            const v = r.vertical;
            if (!counts[v]) counts[v] = { vertical: v, total: 0, available: 0, no_data: 0 };
            counts[v].total += 1;
            if (r.meets_coverage) counts[v].available += 1;
            if (!r.has_data) counts[v].no_data += 1;
        }

        res.json({
            from,
            to,
            dates: requestedDates,
            coverage,
            vertical: vertical || 'all',
            results: visible,
            total: visible.length,
            searched: deduped.length,
            available: deduped.filter((r) => r.meets_coverage).length,
            no_data: deduped.filter((r) => !r.has_data).length,
            // Businesses that came back "available" only because a capacity
            // number let us assume the unclaimed dates were free — nothing has
            // actually confirmed them.
            assumed_only: deduped.filter((r) => r.meets_coverage && !r.has_data).length,
            by_vertical: Object.values(counts).sort((a, b) => b.available - a.available),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── one business, one month ─────────────────────────────────────────── */
//
// The calendar behind a single business's own page. Same merge as everything
// else, but this is the operator's view rather than the public one, so it
// carries the parts the embed widget deliberately strips:
//
//   sources      what claimed each date — 'fareharbor', 'ical:c3', 'capacity'
//   assumed      nothing claimed it; it is open because capacity says so
//   blocked_by   which feed or manual block vetoed the date
//   hidden rows  visible_on_profile = false is included here
//
// Units come with it, so a condo building's page shows the building's rolled
// up month AND each unit's own row.

router.get('/business-calendar/:slug', adminRequired, async (req, res) => {
    try {
        const slug = String(req.params.slug || '');
        const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
            ? req.query.month
            : new Date().toISOString().slice(0, 10).slice(0, 7);
        const from = `${month}-01`;
        const lastDay = new Date(Date.UTC(
            parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10), 0,
        )).getUTCDate();
        const to = `${month}-${String(lastDay).padStart(2, '0')}`;
        const dates = AVAIL.datesBetween(from, to);

        const { data: entity, error } = await supabase
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, city, phone, email, booking_url, hero_image_url, daily_capacity, capacity_per_slot, parent_slug:parent_entity_slug, is_active')
            .eq('slug', slug)
            .maybeSingle();
        if (error) return fail(res, 500, error.message);
        if (!entity) return fail(res, 404, 'Business not found');

        const [unitsRes, feedsRes] = await Promise.all([
            supabase
                .from('entity')
                .select('slug, name, entity_subtype, daily_capacity, is_active')
                .eq('parent_entity_slug', slug)
                .order('name')
                .limit(500),
            // Shown beside the calendar because "why is the 14th blocked" is
            // almost always "this feed claimed it", and that answer should not
            // require a trip to another screen.
            supabase
                .from('entity_external_calendars')
                .select('id, source_label, provider, resource_id, last_synced_at, last_sync_status')
                .eq('entity_slug', slug)
                .limit(50),
        ]);

        const units = (unitsRes.data || []).filter((u) => u.is_active !== false);
        const slugs = [slug, ...units.map((u) => u.slug)];
        const availability = await AVAIL.readAvailability({ from, to, slugs, publicOnly: false });

        const vertical = AVAIL.verticalOf(entity);
        const coverage = AVAIL.coverageFor(vertical);
        const isUnit = !!entity.parent_slug && AVAIL.STAY_TYPES.includes(String(entity.entity_type || '').toLowerCase());

        const unitRows = units.map((u) => {
            const summary = AVAIL.summarise(
                availability.get(u.slug), dates, coverage, u.daily_capacity ?? 1,
            );
            return {
                entity_slug: u.slug,
                entity_name: u.name,
                entity_subtype: u.entity_subtype,
                daily_capacity: u.daily_capacity ?? null,
                available_dates: summary.available_dates,
                open_days: summary.open_days,
                claimed_days: summary.claimed_days,
                has_data: summary.has_data,
                days: summary.days,
            };
        });

        const own = AVAIL.expand(
            availability.get(slug),
            dates,
            entity.daily_capacity ?? (isUnit ? 1 : null),
        );

        // With units the parent's number IS the count of free units. Its own
        // capacity row, if it has one, describes the building and would double
        // count. Without units the parent's own numbers stand.
        const days = unitRows.length
            ? dates.map((date) => {
                const ownDay = own.find((d) => d.date === date);
                const free = unitRows.filter((u) => u.available_dates.includes(date));
                const blocked = ownDay && ownDay.status === 'blocked' && !ownDay.assumed;
                return {
                    date,
                    status: blocked ? 'blocked' : AVAIL.statusFor(free.length, unitRows.length),
                    remaining: blocked ? 0 : free.length,
                    total: unitRows.length,
                    // Assumed only if NOTHING real touched the day. Checking
                    // just the free units would call a day assumed when a
                    // unit was genuinely blocked on it — the block is exactly
                    // the real information that drove the count down.
                    assumed: !blocked && unitRows.every((u) => {
                        const d = (u.days || []).find((x) => x.date === date);
                        return !d || d.assumed;
                    }),
                    units: free.map((u) => ({ entity_slug: u.entity_slug, entity_name: u.entity_name })),
                    blocked_by: blocked ? ownDay.blocked_by : undefined,
                    sources: ownDay ? ownDay.sources : [],
                };
            })
            : own;

        const summary = AVAIL.summarise(
            availability.get(slug), dates, coverage, entity.daily_capacity ?? (isUnit ? 1 : null),
        );

        res.json({
            entity: {
                entity_slug: entity.slug,
                entity_name: entity.name,
                entity_type: entity.entity_type,
                entity_subtype: entity.entity_subtype,
                city: entity.city,
                phone: entity.phone,
                email: entity.email,
                booking_url: entity.booking_url,
                image_url: entity.hero_image_url,
                daily_capacity: entity.daily_capacity ?? null,
                capacity_per_slot: entity.capacity_per_slot ?? null,
                parent_slug: entity.parent_slug || null,
            },
            month,
            from,
            to,
            vertical,
            vertical_label: (AVAIL.verticalSpec(vertical) || {}).label || vertical,
            coverage,
            unit_word: unitRows.length ? AVAIL.unitWordFor(vertical) : AVAIL.unitWordFor(vertical),
            days,
            units: unitRows,
            unit_count: unitRows.length,
            feeds: feedsRes.data || [],
            capacity_known: unitRows.length > 0 || entity.daily_capacity != null,
            // How much of this month is real rather than inferred. The single
            // most useful number for judging whether to trust the calendar.
            claimed_days: unitRows.length
                ? unitRows.reduce((n, u) => Math.max(n, u.claimed_days), 0)
                : summary.claimed_days,
            open_days: days.filter((d) => d.status === 'available' || d.status === 'limited').length,
            bcc_email: `gcr-${slug}@parse.gulfcoastradar.com`,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── one industry, one month ─────────────────────────────────────────── */
//
// A page per industry: fishing charters, dolphin cruises, condos, hotels.
// Returns the month twice over — once as a per-day roll-up across the whole
// industry ("how many charters have something open on the 14th"), and once as
// a row per business so the same page can drill in without a second call.

router.get('/industry-calendar', adminRequired, async (req, res) => {
    try {
        const vertical = String(req.query.vertical || '');
        const spec = AVAIL.verticalSpec(vertical);
        if (!spec) return fail(res, 400, `Unknown industry "${vertical}"`);

        const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
            ? req.query.month
            : new Date().toISOString().slice(0, 7);
        const from = `${month}-01`;
        const lastDay = new Date(Date.UTC(
            parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10), 0,
        )).getUTCDate();
        const to = `${month}-${String(lastDay).padStart(2, '0')}`;
        const dates = AVAIL.datesBetween(from, to);
        const coverage = req.query.coverage === 'all' || req.query.coverage === 'any'
            ? req.query.coverage
            : spec.coverage;

        // Classified in JS rather than in the query: `verticalOf` is pattern
        // based and the patterns are the single definition of an industry.
        // Filtering in SQL would need that list duplicated and kept in step.
        let entityQuery = supabase
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, city, phone, email, hero_image_url, booking_url, rating, price_from, price_unit, daily_capacity, parent_slug:parent_entity_slug')
            .eq('is_active', true)
            .limit(limitOf(req, 2000, 5000));
        if (req.query.city) entityQuery = entityQuery.eq('city', req.query.city);

        const { data: entities, error } = await entityQuery;
        if (error) return fail(res, 500, error.message);

        const all = entities || [];
        const inIndustry = all.filter((e) => AVAIL.verticalOf(e) === vertical);

        // Children come along even if they classify elsewhere, so a complex
        // can report what its units have free.
        const parents = new Set(inIndustry.map((e) => e.slug));
        const children = all.filter((e) => e.parent_slug && parents.has(e.parent_slug));
        const childrenOf = new Map();
        for (const c of children) {
            if (!childrenOf.has(c.parent_slug)) childrenOf.set(c.parent_slug, []);
            childrenOf.get(c.parent_slug).push(c);
        }

        const slugs = [...new Set([...inIndustry.map((e) => e.slug), ...children.map((c) => c.slug)])];
        const availability = slugs.length
            ? await AVAIL.readAvailability({ from, to, slugs, publicOnly: false })
            : new Map();

        const isStay = spec.types && spec.types.some((t) => AVAIL.STAY_TYPES.includes(t));
        const fallbackFor = (e, child) => e.daily_capacity ?? (child && isStay ? 1 : null);

        const businesses = inIndustry.map((e) => {
            const kids = childrenOf.get(e.slug) || [];
            const summary = AVAIL.summarise(availability.get(e.slug), dates, coverage, fallbackFor(e, false));
            const units = kids.map((k) => ({
                entity_slug: k.slug,
                entity_name: k.name,
                ...AVAIL.summarise(availability.get(k.slug), dates, coverage, fallbackFor(k, true)),
            }));

            let openDates = new Set(summary.available_dates);
            if (units.length) {
                openDates = new Set();
                for (const u of units) for (const d of u.available_dates) openDates.add(d);
            }

            return {
                entity_slug: e.slug,
                entity_name: e.name,
                entity_subtype: e.entity_subtype,
                city: e.city,
                phone: e.phone,
                email: e.email,
                image_url: e.hero_image_url,
                booking_url: e.booking_url,
                rating: e.rating,
                price_from: e.price_from,
                price_unit: e.price_unit,
                daily_capacity: e.daily_capacity ?? null,
                unit_count: units.length || undefined,
                units_with_data: units.length ? units.filter((u) => u.has_data).length : undefined,
                available_dates: [...openDates].sort(),
                open_days: openDates.size,
                claimed_days: units.length
                    ? units.reduce((n, u) => Math.max(n, u.claimed_days), 0)
                    : summary.claimed_days,
                has_data: units.length ? units.some((u) => u.has_data) : summary.has_data,
                capacity_known: units.length > 0 || e.daily_capacity != null,
                min_remaining: summary.min_remaining,
            };
        });

        // A unit already counts through its complex, so listing it separately
        // double-counts every building on every day. Opt in for the flat view.
        const parentsListed = new Set(businesses.filter((b) => b.unit_count).map((b) => b.entity_slug));
        const parentBySlug = Object.fromEntries(all.map((e) => [e.slug, e.parent_slug || null]));
        const listed = req.query.include_units === 'true'
            ? businesses
            : businesses.filter((b) => {
                const parent = parentBySlug[b.entity_slug];
                return !parent || !parentsListed.has(parent);
            });

        // The industry's own month: for each day, how many businesses have
        // something open, and how much.
        const byDate = dates.map((date) => {
            const open = listed.filter((b) => b.available_dates.includes(date));
            return {
                date,
                open_businesses: open.length,
                total_businesses: listed.length,
                // Only counts we actually know get summed — adding a null
                // capacity as zero would understate the day.
                spots: open.reduce((n, b) => n + (b.min_remaining || 0), 0),
                slugs: open.map((b) => b.entity_slug),
            };
        });

        res.json({
            vertical,
            label: spec.label,
            unit_word: AVAIL.unitWordFor(vertical),
            month,
            from,
            to,
            coverage,
            days: byDate,
            businesses: listed.sort((a, b) => b.open_days - a.open_days || (b.rating || 0) - (a.rating || 0)),
            total: listed.length,
            with_data: listed.filter((b) => b.has_data).length,
            without_capacity: listed.filter((b) => !b.capacity_known).length,
            open_today: (byDate.find((d) => d.date === new Date().toISOString().slice(0, 10)) || {}).open_businesses ?? null,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── industry blueprints & structured listing data ───────────────────── */
//
// "A two bedroom two bath at Phoenix East on these dates."
// "A charter for eight people, at least eight hours, a 45ft boat with AC."
//
// Neither question can be answered from `entity` — those are facts about a
// specific unit or a specific boat, and nothing stored them. routes/
// industry-blueprints.js defines what each industry would store if you built
// its platform from scratch; `entity_attributes` holds the values; and
// /match below joins them to the availability engine so the answer is
// "matches the description AND is actually free".

const BP = require('./industry-blueprints');

/** Every field an industry defines. The dashboard renders its form from this. */
router.get('/blueprints', adminRequired, (_req, res) => {
    const out = {};
    for (const id of Object.keys(BP.BLUEPRINTS)) {
        const spec = AVAIL.verticalSpec(id);
        out[id] = {
            id,
            label: spec ? spec.label : id,
            unit_label: BP.BLUEPRINTS[id].unit_label,
            listing_fields: BP.BLUEPRINTS[id].listing.length,
            unit_fields: BP.BLUEPRINTS[id].unit.length,
        };
    }
    res.json({ blueprints: out });
});

router.get('/blueprint/:vertical', adminRequired, (req, res) => {
    const vertical = String(req.params.vertical);
    if (!BP.BLUEPRINTS[vertical]) return fail(res, 404, `No blueprint for "${vertical}"`);
    const spec = AVAIL.verticalSpec(vertical);
    res.json({
        vertical,
        label: spec ? spec.label : vertical,
        unit_label: BP.BLUEPRINTS[vertical].unit_label,
        fields: BP.fieldsFor(vertical),
        searchable: BP.searchableFor(vertical).map((f) => ({
            key: f.key, label: f.label, type: f.type, search: f.search,
            unit: f.unit, options: f.options, applies: f.applies,
        })),
    });
});

/**
 * One listing's stored attributes, with the blueprint for its industry so the
 * caller does not have to make a second request to know what the keys mean.
 * Unit children come along, because a condo building's answer is mostly its
 * units' answers.
 */
router.get('/attributes/:slug', adminRequired, async (req, res) => {
    try {
        const slug = String(req.params.slug);
        const { data: entity, error } = await supabase
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, parent_slug:parent_entity_slug')
            .eq('slug', slug)
            .maybeSingle();
        if (error) return fail(res, 500, error.message);
        if (!entity) return fail(res, 404, 'Business not found');

        const { data: units } = await supabase
            .from('entity')
            .select('slug, name, entity_subtype')
            .eq('parent_entity_slug', slug)
            .eq('is_active', true)
            .order('name')
            .limit(500);

        const slugs = [slug, ...(units || []).map((u) => u.slug)];
        const { data: rows } = await supabase
            .from('entity_attributes')
            .select('entity_slug, attr_key, value_text, value_num, value_bool, value_list')
            .in('entity_slug', slugs)
            .limit(5000);

        // A unit inherits its industry from its parent: a condo unit's
        // entity_subtype is 'condo_unit', which classifies as a stay, but the
        // parent is the authority on which blueprint applies.
        const vertical = AVAIL.verticalOf(entity);
        const flatten = (forSlug) => {
            const out = {};
            for (const r of rows || []) {
                if (r.entity_slug !== forSlug) continue;
                out[r.attr_key] = r.value_num ?? r.value_bool ?? r.value_list ?? r.value_text ?? null;
            }
            return out;
        };

        res.json({
            entity_slug: slug,
            entity_name: entity.name,
            vertical,
            unit_label: (BP.BLUEPRINTS[vertical] || BP.BLUEPRINTS.other).unit_label,
            fields: BP.fieldsFor(vertical),
            attributes: flatten(slug),
            units: (units || []).map((u) => ({
                entity_slug: u.slug,
                entity_name: u.name,
                entity_subtype: u.entity_subtype,
                attributes: flatten(u.slug),
            })),
            // Which required fields are still blank. A listing missing these
            // cannot be matched on the thing guests actually ask for.
            missing_required: BP.fieldsFor(vertical)
                .filter((f) => f.required && f.applies === 'listing')
                .filter((f) => flatten(slug)[f.key] == null)
                .map((f) => ({ key: f.key, label: f.label })),
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/**
 * Write attributes for one listing. The body is `{ key: value }`; every key is
 * validated against the blueprint and coerced to its declared type before it
 * is stored, because `bedrooms` landing in the text column would make every
 * `>= 2` filter silently match nothing.
 *
 * A null clears the attribute rather than storing a null row.
 */
router.put('/attributes/:slug', adminRequired, async (req, res) => {
    try {
        const slug = String(req.params.slug);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const patch = body.attributes && typeof body.attributes === 'object' ? body.attributes : body;

        const { data: entity } = await supabase
            .from('entity')
            .select('slug, entity_type, entity_subtype, parent_slug:parent_entity_slug')
            .eq('slug', slug)
            .maybeSingle();
        if (!entity) return fail(res, 404, 'Business not found');

        // A unit is described by its parent's blueprint — a condo unit holds
        // bedrooms and bathrooms, which only the stay blueprint defines.
        let vertical = AVAIL.verticalOf(entity);
        if (entity.parent_slug) {
            const { data: parent } = await supabase
                .from('entity')
                .select('entity_type, entity_subtype')
                .eq('slug', entity.parent_slug)
                .maybeSingle();
            if (parent) vertical = AVAIL.verticalOf(parent);
        }

        const writes = [];
        const clears = [];
        const errors = [];

        for (const [key, raw] of Object.entries(patch)) {
            const field = BP.fieldFor(vertical, key);
            if (!field) { errors.push(`Unknown field "${key}" for ${vertical}`); continue; }
            const result = BP.coerce(field, raw);
            if (result.error) { errors.push(result.error); continue; }
            if (result.cleared) { clears.push(key); continue; }

            writes.push({
                entity_slug: slug,
                attr_key: key,
                value_text: result.column === 'value_text' ? result.value : null,
                value_num: result.column === 'value_num' ? result.value : null,
                value_bool: result.column === 'value_bool' ? result.value : null,
                value_list: result.column === 'value_list' ? result.value : null,
                updated_at: new Date().toISOString(),
            });
        }

        if (errors.length) return fail(res, 400, errors.join('; '));

        if (clears.length) {
            await supabase.from('entity_attributes').delete().eq('entity_slug', slug).in('attr_key', clears);
        }
        if (writes.length) {
            const { error } = await supabase
                .from('entity_attributes')
                .upsert(writes, { onConflict: 'entity_slug,attr_key' });
            if (error) return fail(res, 400, error.message);
        }

        res.json({ entity_slug: slug, vertical, written: writes.length, cleared: clears.length });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── match: description + dates ──────────────────────────────────────── */
//
// The whole point. A guest describes what they want and when; this returns
// what matches BOTH — the attributes and the calendar. Either half alone is
// useless: a 2-bed 2-bath that is booked all week is not an answer, and a
// free week in a studio is not an answer either.
//
// POST body:
//   { vertical, from, to, coverage?, filters: { bedrooms: 2, has_ac: true,
//     boat_length: 45, species: ['red_snapper'] }, q?, limit? }
//
// Numeric filters read as "at least" or "at most" from the field's own
// `search` rule, so the caller sends `{ bedrooms: 2 }` and gets `>= 2` for
// bedrooms and `<= 400` for nightly_rate without having to know which is
// which.

router.post('/match', adminRequired, async (req, res) => {
    try {
        const body = req.body || {};
        const vertical = String(body.vertical || '');
        if (!BP.BLUEPRINTS[vertical]) return fail(res, 400, `Unknown industry "${vertical}"`);

        const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : null;
        const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || '') ? body.to : from;
        const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
        const limit = Math.min(parseInt(body.limit, 10) || 200, 1000);

        /* 1. Which listings match the description? */
        const active = Object.entries(filters).filter(([, v]) => v !== null && v !== undefined && v !== '');
        let matchedSlugs = null;   // null means "no attribute filter applied"
        const applied = [];

        for (const [key, value] of active) {
            const field = BP.fieldFor(vertical, key);
            if (!field || !field.search) return fail(res, 400, `"${key}" is not searchable for ${vertical}`);

            let query = supabase.from('entity_attributes').select('entity_slug').eq('attr_key', key).limit(5000);
            if (field.search === 'min') query = query.gte('value_num', Number(value));
            else if (field.search === 'max') query = query.lte('value_num', Number(value));
            else if (field.search === 'has') query = query.eq('value_bool', true);
            else if (field.search === 'eq') query = query.eq('value_text', String(value));
            else if (field.search === 'any') {
                const wanted = Array.isArray(value) ? value : [value];
                // `contains` is array containment: the listing must offer ALL
                // of what was asked for, which is the honest reading of
                // "8 hour trips targeting red snapper".
                query = field.type === 'multi'
                    ? query.contains('value_list', wanted)
                    : query.in('value_text', wanted.map(String));
            }

            const { data, error } = await query;
            if (error) return fail(res, 500, error.message);

            const found = new Set((data || []).map((r) => r.entity_slug));
            // Intersect, never union: every filter narrows. A guest asking for
            // 2 bedrooms AND air conditioning does not want either/or.
            matchedSlugs = matchedSlugs === null ? found : new Set([...matchedSlugs].filter((s) => found.has(s)));
            applied.push({ key, label: field.label, rule: field.search, value });
            if (matchedSlugs.size === 0) break;
        }

        /* 2. Which of those are in this industry, and what are they? */
        let entityQuery = supabase
            .from('entity')
            .select('slug, name, entity_type, entity_subtype, city, phone, email, hero_image_url, booking_url, rating, price_from, price_unit, daily_capacity, parent_slug:parent_entity_slug')
            .eq('is_active', true)
            .limit(limit * 4);
        if (matchedSlugs) {
            if (matchedSlugs.size === 0) {
                return res.json({ vertical, from, to, filters: applied, results: [], total: 0, reason: 'no listing matches the description' });
            }
            entityQuery = entityQuery.in('slug', [...matchedSlugs]);
        }
        if (body.q) {
            const q = String(body.q).replace(/[%,()]/g, '');
            entityQuery = entityQuery.or(`name.ilike.%${q}%,city.ilike.%${q}%`);
        }
        if (body.city) entityQuery = entityQuery.eq('city', body.city);

        const { data: entities, error: entError } = await entityQuery;
        if (entError) return fail(res, 500, entError.message);

        // A matched UNIT belongs to its parent's industry, so classify by the
        // parent when there is one — otherwise "2 bed 2 bath" matches unit
        // 1204 and then throws it away because a condo_unit isn't a condo.
        const rows = entities || [];
        const parentSlugs = [...new Set(rows.map((e) => e.parent_slug).filter(Boolean))];
        const { data: parents } = parentSlugs.length
            ? await supabase.from('entity').select('slug, name, entity_type, entity_subtype').in('slug', parentSlugs)
            : { data: [] };
        const parentBySlug = Object.fromEntries((parents || []).map((p) => [p.slug, p]));

        const inIndustry = rows.filter((e) => {
            const owner = e.parent_slug ? parentBySlug[e.parent_slug] : null;
            return AVAIL.verticalOf(owner || e) === vertical;
        });

        /* 3. Of those, which are actually free? */
        let withAvailability = inIndustry;
        let dates = [];
        let coverage = null;

        if (from) {
            dates = AVAIL.datesBetween(from, to, 120);
            coverage = body.coverage === 'all' || body.coverage === 'any'
                ? body.coverage
                : AVAIL.coverageFor(vertical);

            const availability = await AVAIL.readAvailability({
                from, to, slugs: inIndustry.map((e) => e.slug), publicOnly: false,
            });

            const isStay = ['condo', 'hotel'].includes(vertical);
            withAvailability = inIndustry.map((e) => {
                const fallback = e.daily_capacity ?? (e.parent_slug && isStay ? 1 : null);
                const summary = AVAIL.summarise(availability.get(e.slug), dates, coverage, fallback);
                return { entity: e, ...summary };
            });
            if (body.only_available !== false) {
                withAvailability = withAvailability.filter((r) => r.meets_coverage);
            }
        } else {
            withAvailability = inIndustry.map((e) => ({ entity: e }));
        }

        /* 4. Attach the attributes that were asked about, so the answer shows
              its work rather than asserting a match. */
        const finalSlugs = withAvailability.map((r) => r.entity.slug).slice(0, limit);
        const { data: attrRows } = finalSlugs.length
            ? await supabase.from('entity_attributes')
                .select('entity_slug, attr_key, value_text, value_num, value_bool, value_list')
                .in('entity_slug', finalSlugs)
                .limit(5000)
            : { data: [] };

        const attrsBySlug = {};
        for (const r of attrRows || []) {
            (attrsBySlug[r.entity_slug] ||= {})[r.attr_key] =
                r.value_num ?? r.value_bool ?? r.value_list ?? r.value_text ?? null;
        }

        const results = withAvailability.slice(0, limit).map((r) => {
            const e = r.entity;
            const parent = e.parent_slug ? parentBySlug[e.parent_slug] : null;
            return {
                entity_slug: e.slug,
                entity_name: e.name,
                entity_subtype: e.entity_subtype,
                city: e.city,
                phone: e.phone,
                email: e.email,
                image_url: e.hero_image_url,
                booking_url: e.booking_url,
                rating: e.rating,
                price_from: e.price_from,
                price_unit: e.price_unit,
                // For a unit, the building it belongs to — "unit 1204" alone
                // does not tell anyone it is at Phoenix West.
                parent_slug: e.parent_slug || null,
                parent_name: parent ? parent.name : null,
                attributes: attrsBySlug[e.slug] || {},
                available_dates: r.available_dates || [],
                open_days: r.open_days ?? null,
                covers_all_days: r.covers_all_days ?? null,
                has_data: r.has_data ?? null,
                capacity_known: r.capacity_known ?? null,
            };
        });

        res.json({
            vertical,
            from,
            to,
            dates,
            coverage,
            filters: applied,
            results,
            total: results.length,
            described: matchedSlugs ? matchedSlugs.size : null,
            in_industry: inIndustry.length,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

/* ── summary ─────────────────────────────────────────────────────────── */
//
// One call for the dashboard's headline numbers, so it doesn't need six.

router.get('/summary', adminRequired, async (req, res) => {
    const slug = req.query.slug || null;

    const countOf = async (table, extra) => {
        let query = supabase.from(table).select('*', { count: 'exact', head: true });
        if (slug) query = query.eq('entity_slug', slug);
        if (extra) query = extra(query);
        const { count, error } = await query;
        // A table that doesn't exist yet reports null rather than exploding the
        // whole summary — the dashboard renders what it got.
        return error ? null : count || 0;
    };

    try {
        const today = new Date().toISOString().slice(0, 10);
        const [bookings, upcoming, pending, offerings, activeOfferings, calendar, promos, waivers] =
            await Promise.all([
                countOf('bookings'),
                countOf('bookings', (q) => q.gte('date', today)),
                countOf('bookings', (q) => q.eq('status', 'pending')),
                countOf('offerings'),
                countOf('offerings', (q) => q.eq('active', true)),
                countOf('booking_calendar'),
                countOf('promos'),
                countOf('waivers'),
            ]);

        res.json({
            slug,
            bookings,
            upcoming_bookings: upcoming,
            pending_bookings: pending,
            offerings,
            active_offerings: activeOfferings,
            calendar_entries: calendar,
            promos,
            waivers,
        });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

module.exports = router;
