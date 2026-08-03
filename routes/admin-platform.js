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
