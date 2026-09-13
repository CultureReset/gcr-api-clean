// ============================================================
// BOOKING PLATFORM API — /api/booking
// ============================================================
//
// Three surfaces, three different trust levels, and the difference is the
// whole security story of this file:
//
//   OWNER  (ownerRequired)  Everything that configures a business. The slug
//                           comes from the session via entity_owners and is
//                           never read from the URL, the query or the body.
//                           Every query carries .eq('entity_slug', slug).
//
//   PUBLIC (/public/:slug)  A customer looking at one named business and
//                           booking with it. The slug IS in the path, because
//                           a stranger has no session to resolve one from —
//                           and that is safe because these routes only read
//                           what the business publishes and only write a
//                           booking of the customer's own. Nothing here can
//                           change a price, a schedule or another booking.
//
//   WEBHOOK (/webhook/…)    Stripe. Signature-verified, replay-proof, and it
//                           trusts the signature rather than the payload.
//
// ── The rule that makes it modular ──────────────────────────────────────
//
// There is no per-vertical code in this file. A fishing charter, a parasail
// flight and a hair appointment all run the same handlers; they differ only
// in the booking_products row behind them. Adding a vertical is an INSERT
// into booking_templates. If you ever find yourself about to write
// `if (template_id === 'something')`, the field you need is missing.
//
// ── The rule that keeps the money honest ────────────────────────────────
//
// A browser posts quantities. The server posts back an amount. /quote and
// /checkout price the same cart through the same function in lib/
// bookingCore.js, and the charge is built from the server's number. There
// is no request shape that lets a customer name their own price.
// ============================================================

'use strict';

const express = require('express');
const crypto = require('crypto');

const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const core = require('../lib/bookingCore');
const connect = require('../lib/stripeConnect');
const channels = require('../lib/channelSync');

const router = express.Router();

/* ============================================================
 * SHARED
 * ============================================================ */

const HOLD_MINUTES = parseInt(process.env.BOOKING_HOLD_MINUTES || '30', 10);

function fail(res, status, message) {
    return res.status(status).json({ error: message });
}

/** Copy only the keys a caller is allowed to set. Everything else is dropped. */
function only(body, allowed) {
    const out = {};
    for (const key of allowed) {
        if (body && body[key] !== undefined) out[key] = body[key];
    }
    return out;
}

/** Wrap a handler so a thrown error is a 500 with a message, not a hang. */
function handle(fn) {
    return function (req, res) {
        Promise.resolve(fn(req, res)).catch(function (err) {
            console.error('[booking]', req.method, req.path, err && err.message);
            if (!res.headersSent) res.status(500).json({ error: err.message || 'Something went wrong.' });
        });
    };
}

async function entityBySlug(slug) {
    if (!slug) return null;
    const { data } = await supabase
        .from('entity')
        .select('id, slug, name, subtitle, phone, email, icon, logo_url, hero_image_url, theme, website_url, city')
        .eq('slug', slug)
        .maybeSingle();
    return data || null;
}

/**
 * Every date-claim that could block a booking, from every source at once.
 *
 * This is deliberately not "our bookings": it is booking_calendar, which
 * also holds FareHarbor syncs, iCal imports, email-parsed reservations and
 * manual blocks. A boat sold on another platform is sold here too.
 */
async function loadClaims(slug, from, to, productId) {
    let query = supabase
        .from('booking_calendar')
        .select('id, date, end_date, start_time, kind, source, status, party, product_id, resource_id, offering_id, booking_id')
        .eq('entity_slug', slug)
        .eq('status', 'active')
        .limit(5000);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data || [];
    if (!productId) return rows;
    // Keep claims for this product AND claims with no product (a manual
    // block, an external sync): those close the day for everything.
    return rows.filter(function (r) {
        return !r.product_id || String(r.product_id) === String(productId);
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A product with its rates, schedules and extras, in one round trip each. */
async function loadProduct(slug, productId, options) {
    // The `.or()` filters below interpolate this id into a PostgREST filter
    // string, so it is checked before it gets anywhere near one. An id that
    // is not a uuid cannot match a row anyway.
    if (!UUID_RE.test(String(productId || ''))) return null;

    const opts = options || {};
    const { data: product } = await supabase
        .from('booking_products')
        .select('*')
        .eq('entity_slug', slug)
        .eq('id', productId)
        .maybeSingle();
    if (!product) return null;
    if (opts.publicOnly && product.active === false) return null;

    const [rates, schedules, extras] = await Promise.all([
        supabase.from('booking_rates').select('*')
            .eq('entity_slug', slug).eq('product_id', productId)
            .order('sort_order', { ascending: true }),
        supabase.from('booking_schedules').select('*')
            .eq('entity_slug', slug).or('product_id.eq.' + productId + ',product_id.is.null')
            .limit(200),
        supabase.from('booking_extras').select('*')
            .eq('entity_slug', slug).or('product_id.eq.' + productId + ',product_id.is.null')
            .order('sort_order', { ascending: true }),
    ]);

    const activeOnly = function (rows) {
        return (rows || []).filter(function (r) { return !opts.publicOnly || r.active !== false; });
    };

    return {
        product: product,
        rates: activeOnly(rates.data),
        schedules: activeOnly(schedules.data),
        extras: activeOnly(extras.data),
    };
}

/**
 * A product's per-date prices and stay rules, as a map keyed by date.
 *
 * Empty is a valid answer and the common one: a product with no calendar
 * has no overrides, and every night falls back to its flat rate.
 */
async function loadRateCalendar(slug, productId, from, to) {
    if (!UUID_RE.test(String(productId || ''))) return {};
    let query = supabase
        .from('booking_rate_calendar')
        .select('date, price, min_nights, closed, closed_to_arrival, closed_to_departure')
        .eq('entity_slug', slug)
        .eq('product_id', productId)
        .limit(800);
    if (from) query = query.gte('date', core.toDate(from));
    if (to) query = query.lte('date', core.toDate(to));
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const map = {};
    (data || []).forEach(function (row) { map[core.toDate(row.date)] = row; });
    return map;
}

/** The HMAC that lets a customer open their own booking with no account. */
function manageToken(bookingId) {
    const secret = process.env.JWT_SECRET || process.env.SUPABASE_KEY || 'cc-booking';
    return crypto.createHmac('sha256', secret).update('booking:' + String(bookingId)).digest('hex').slice(0, 32);
}
function manageTokenOk(bookingId, candidate) {
    const expected = manageToken(bookingId);
    const given = String(candidate || '');
    if (given.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    } catch {
        return false;
    }
}

function confirmationCode() {
    return 'BK-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/** Mirror a booking into booking_calendar so every surface sees the claim. */
async function syncCalendar(booking) {
    if (!booking || !booking.date) return;
    const cancelled = ['cancelled', 'declined', 'expired', 'no-show'].indexOf(booking.status) !== -1;
    const entry = {
        entity_slug: booking.entity_slug,
        date: core.toDate(booking.date),
        end_date: core.toDate(booking.end_date),
        start_time: booking.start_time || null,
        end_time: booking.end_time || null,
        kind: 'booking',
        source: booking.source || 'direct',
        status: cancelled ? 'cancelled' : 'active',
        title: booking.customer_name || 'Booking',
        party: booking.party_size || 1,
        product_id: booking.product_id || null,
        resource_id: booking.resource_id || null,
        booking_id: booking.id,
        details: { confirmation_code: booking.confirmation_code, status: booking.status },
        updated_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase
        .from('booking_calendar').select('id').eq('booking_id', booking.id).maybeSingle();
    if (existing) await supabase.from('booking_calendar').update(entry).eq('id', existing.id);
    else await supabase.from('booking_calendar').insert(entry);
}

/**
 * Expire holds that were never paid.
 *
 * A seat held for a checkout that the customer abandoned has to come back,
 * or one closed browser tab takes a boat off sale forever. Run lazily on
 * read rather than on a timer: the only moment it matters that a hold is
 * gone is when someone is looking for a seat.
 */
async function releaseExpiredHolds(slug) {
    const now = new Date().toISOString();
    const { data } = await supabase
        .from('bookings')
        .select('id')
        .eq('entity_slug', slug)
        .eq('status', 'hold')
        .lt('hold_expires_at', now)
        .limit(200);
    if (!data || !data.length) return;
    const ids = data.map(function (r) { return r.id; });
    await supabase.from('bookings')
        .update({ status: 'expired', updated_at: now })
        .in('id', ids);
    await supabase.from('booking_calendar')
        .update({ status: 'cancelled', updated_at: now })
        .in('booking_id', ids);
}

/* ============================================================
 * OWNER — configuration. Slug from the session, always.
 * ============================================================ */

/** The vertical catalogue. Data, not code — see sql/booking_platform.sql. */
router.get('/templates', handle(async (_req, res) => {
    const { data, error } = await supabase
        .from('booking_templates')
        .select('id, name, category, icon, tagline, description, schedule_mode, defaults, rate_template, addon_template, question_template')
        .eq('active', true)
        .order('sort_order', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ templates: data || [] });
}));

/** Is this business set up to take bookings, and how is it doing? */
router.get('/summary', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    await releaseExpiredHolds(slug);
    const today = new Date().toISOString().slice(0, 10);

    const [products, account, upcoming, recent] = await Promise.all([
        supabase.from('booking_products').select('id, active').eq('entity_slug', slug),
        connect.getAccount(slug),
        supabase.from('bookings').select('id', { count: 'exact', head: true })
            .eq('entity_slug', slug).gte('date', today).in('status', ['pending', 'confirmed']),
        supabase.from('bookings')
            .select('id, date, start_time, customer_name, party_size, total_amount, amount_paid, status, payment_status')
            .eq('entity_slug', slug).order('created_at', { ascending: false }).limit(10),
    ]);

    const all = products.data || [];
    res.json({
        ready: all.some(function (p) { return p.active !== false; }) && connect.canAcceptPayments(account),
        stripe_configured: connect.configured(),
        products_total: all.length,
        products_active: all.filter(function (p) { return p.active !== false; }).length,
        payments: {
            connected: !!(account && account.account_id),
            charges_enabled: !!(account && account.charges_enabled),
            payouts_enabled: !!(account && account.payouts_enabled),
        },
        upcoming_bookings: upcoming.count || 0,
        recent: recent.data || [],
    });
}));

/* ── products ───────────────────────────────────────────────────────── */

const PRODUCT_FIELDS = [
    'name', 'description', 'image_url', 'schedule_mode', 'capacity_mode', 'duration_minutes',
    'capacity', 'min_party', 'max_party', 'lead_time_minutes', 'booking_window_days',
    'buffer_minutes', 'deposit_mode', 'deposit_value', 'tax_percent', 'currency',
    'cancellation_policy', 'requires_waiver', 'waiver_text', 'questions', 'settings',
    'active', 'sort_order', 'offering_id',
];

router.get('/products', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const { data: products, error } = await supabase
        .from('booking_products').select('*')
        .eq('entity_slug', slug)
        .order('sort_order', { ascending: true });
    if (error) throw new Error(error.message);

    const ids = (products || []).map(function (p) { return p.id; });
    if (!ids.length) return res.json({ products: [] });

    const [rates, schedules, extras] = await Promise.all([
        supabase.from('booking_rates').select('*').eq('entity_slug', slug).in('product_id', ids).order('sort_order'),
        supabase.from('booking_schedules').select('*').eq('entity_slug', slug).limit(500),
        supabase.from('booking_extras').select('*').eq('entity_slug', slug).order('sort_order'),
    ]);

    const group = function (rows, key) {
        const out = {};
        (rows || []).forEach(function (row) {
            const id = row[key];
            if (!out[id]) out[id] = [];
            out[id].push(row);
        });
        return out;
    };
    const ratesBy = group(rates.data, 'product_id');
    const schedulesBy = group(schedules.data, 'product_id');
    const extrasBy = group(extras.data, 'product_id');

    res.json({
        products: (products || []).map(function (p) {
            return Object.assign({}, p, {
                rates: ratesBy[p.id] || [],
                // a null product_id means "applies to every product"
                schedules: (schedulesBy[p.id] || []).concat(schedulesBy['null'] || []),
                extras: (extrasBy[p.id] || []).concat(extrasBy['null'] || []),
            });
        }),
    });
}));

router.get('/products/:id', ownerRequired, handle(async (req, res) => {
    const loaded = await loadProduct(req.entitySlug, req.params.id);
    if (!loaded) return fail(res, 404, 'No such product.');
    res.json(loaded);
}));

/**
 * Create a product — from a template, or from nothing.
 *
 * With `template_id`, this is the whole "install a vertical" flow: one POST
 * writes the product, its price tiers, its extras and its opening hours,
 * and from then on they are ordinary rows the owner edits.
 */
router.post('/products', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const templateId = req.body && req.body.template_id;

    let productRow;
    let rateRows = [];
    let extraRows = [];
    let scheduleRows = [];

    if (templateId) {
        const { data: template } = await supabase
            .from('booking_templates').select('*').eq('id', templateId).maybeSingle();
        if (!template) return fail(res, 400, 'No such booking template.');
        const built = core.productFromTemplate(template, slug, only(req.body, PRODUCT_FIELDS));
        productRow = built.product;
        rateRows = built.rates;
        extraRows = built.extras;
        scheduleRows = built.schedules;
    } else {
        const fields = only(req.body, PRODUCT_FIELDS);
        if (!fields.name) return fail(res, 400, 'A product needs a name.');
        productRow = Object.assign({ entity_slug: slug }, fields);
    }

    const { data: product, error } = await supabase
        .from('booking_products').insert(productRow).select('*').single();
    if (error) throw new Error(error.message);

    const stamp = function (rows) {
        return rows.map(function (r) { return Object.assign({}, r, { entity_slug: slug, product_id: product.id }); });
    };
    if (rateRows.length) await supabase.from('booking_rates').insert(stamp(rateRows));
    if (extraRows.length) await supabase.from('booking_extras').insert(stamp(extraRows));
    if (scheduleRows.length) await supabase.from('booking_schedules').insert(stamp(scheduleRows));

    const loaded = await loadProduct(slug, product.id);
    res.status(201).json(loaded);
}));

router.patch('/products/:id', ownerRequired, handle(async (req, res) => {
    const patch = only(req.body, PRODUCT_FIELDS);
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change.');
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase
        .from('booking_products').update(patch)
        .eq('entity_slug', req.entitySlug).eq('id', req.params.id)
        .select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(res, 404, 'No such product.');
    res.json({ product: data });
}));

/**
 * Retire a product.
 *
 * Deactivates rather than deletes when bookings exist: a deleted product
 * takes its name off every past booking and its price off every receipt.
 */
router.delete('/products/:id', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const { count } = await supabase
        .from('bookings').select('id', { count: 'exact', head: true })
        .eq('entity_slug', slug).eq('product_id', req.params.id);

    if (count) {
        await supabase.from('booking_products')
            .update({ active: false, updated_at: new Date().toISOString() })
            .eq('entity_slug', slug).eq('id', req.params.id);
        return res.json({ ok: true, deactivated: true, bookings: count });
    }

    await supabase.from('booking_rates').delete().eq('entity_slug', slug).eq('product_id', req.params.id);
    await supabase.from('booking_schedules').delete().eq('entity_slug', slug).eq('product_id', req.params.id);
    await supabase.from('booking_extras').delete().eq('entity_slug', slug).eq('product_id', req.params.id);
    await supabase.from('booking_product_resources').delete().eq('entity_slug', slug).eq('product_id', req.params.id);
    await supabase.from('booking_products').delete().eq('entity_slug', slug).eq('id', req.params.id);
    res.json({ ok: true, deleted: true });
}));

/* ── the child collections ──────────────────────────────────────────── */
//
// Rates, schedules, extras and resources are the same CRUD four times over,
// so they are one generic factory rather than four near-identical copies.
// A security check written four times drifts until one copy has a hole —
// the same reasoning as lib/businessTables.js.

const COLLECTIONS = {
    rates: {
        table: 'booking_rates',
        fields: ['label', 'description', 'pricing_mode', 'amount', 'min_qty', 'max_qty',
            'age_min', 'age_max', 'weight_min_lb', 'weight_max_lb', 'occupies_capacity',
            'capacity_weight', 'season_start', 'season_end', 'days_of_week', 'active', 'sort_order'],
        requiresProduct: true,
        required: ['label'],
    },
    schedules: {
        table: 'booking_schedules',
        fields: ['kind', 'label', 'days_of_week', 'times', 'window_start', 'window_end',
            'slot_interval_minutes', 'specific_date', 'valid_from', 'valid_to',
            'capacity_override', 'active'],
        requiresProduct: false,
        required: [],
    },
    extras: {
        table: 'booking_extras',
        fields: ['name', 'description', 'price', 'pricing_mode', 'max_qty', 'required', 'active', 'sort_order', 'product_id'],
        requiresProduct: false,
        required: ['name'],
    },
    resources: {
        table: 'booking_resources',
        fields: ['name', 'resource_type', 'capacity', 'description', 'image_url', 'details', 'active', 'sort_order'],
        requiresProduct: false,
        required: ['name'],
    },
};

Object.keys(COLLECTIONS).forEach(function (name) {
    const spec = COLLECTIONS[name];

    router.get('/' + name, ownerRequired, handle(async (req, res) => {
        let query = supabase.from(spec.table).select('*').eq('entity_slug', req.entitySlug).limit(1000);
        if (req.query.product_id) query = query.eq('product_id', req.query.product_id);
        const { data, error } = await query.order('sort_order', { ascending: true });
        if (error) throw new Error(error.message);
        res.json({ [name]: data || [] });
    }));

    router.post('/' + name, ownerRequired, handle(async (req, res) => {
        const row = only(req.body, spec.fields);
        for (const key of spec.required) {
            if (!row[key]) return fail(res, 400, 'Missing "' + key + '".');
        }
        row.entity_slug = req.entitySlug;

        const productId = req.body && req.body.product_id;
        if (spec.requiresProduct && !productId) return fail(res, 400, 'A product_id is required.');
        if (productId) {
            // Never take the caller's word that the product is theirs.
            const { data: owned } = await supabase.from('booking_products')
                .select('id').eq('entity_slug', req.entitySlug).eq('id', productId).maybeSingle();
            if (!owned) return fail(res, 404, 'No such product.');
            row.product_id = productId;
        }

        const { data, error } = await supabase.from(spec.table).insert(row).select('*').single();
        if (error) throw new Error(error.message);
        res.status(201).json({ [name.replace(/s$/, '')]: data });
    }));

    router.patch('/' + name + '/:id', ownerRequired, handle(async (req, res) => {
        const patch = only(req.body, spec.fields);
        if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change.');
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from(spec.table).update(patch)
            .eq('entity_slug', req.entitySlug).eq('id', req.params.id)
            .select('*').maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return fail(res, 404, 'Not found.');
        res.json({ [name.replace(/s$/, '')]: data });
    }));

    router.delete('/' + name + '/:id', ownerRequired, handle(async (req, res) => {
        const { error } = await supabase.from(spec.table).delete()
            .eq('entity_slug', req.entitySlug).eq('id', req.params.id);
        if (error) throw new Error(error.message);
        res.json({ ok: true });
    }));
});

/* ── the rate calendar ──────────────────────────────────────────────── */
//
// Per-date prices and stay rules. A lodging product lives or dies on this:
// one flat price is useless when a holiday weekend is worth triple a
// Tuesday in November. Any product may have one; only date_range products
// currently read the per-night side of it.

router.get('/products/:id/calendar', ownerRequired, handle(async (req, res) => {
    const from = core.toDate(req.query.from) || new Date().toISOString().slice(0, 10);
    const to = core.toDate(req.query.to) || core.addDays(from, 120);
    const calendar = await loadRateCalendar(req.entitySlug, req.params.id, from, to);
    res.json({ product_id: req.params.id, from: from, to: to, days: Object.values(calendar) });
}));

/**
 * Set a run of dates at once.
 *
 * Owners think in spans — "August is $320 a night, three-night minimum" —
 * not in individual days, so the API takes a span. Sending a null price
 * clears the override and the date falls back to the product's flat rate.
 */
router.put('/products/:id/calendar', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const productId = req.params.id;

    const { data: owned } = await supabase.from('booking_products')
        .select('id').eq('entity_slug', slug).eq('id', productId).maybeSingle();
    if (!owned) return fail(res, 404, 'No such product.');

    const from = core.toDate(req.body && req.body.from);
    const to = core.toDate(req.body && req.body.to) || from;
    if (!from) return fail(res, 400, 'A from date is required.');

    const dates = core.datesBetween(from, to, 400);
    if (!dates.length) return fail(res, 400, 'That date range is empty.');
    if (dates.length > 370) return fail(res, 400, 'Set at most a year at a time.');

    // Only weekdays named in `days_of_week`, when given — that is how a
    // weekend rate is set across a whole season in one call.
    const days = Array.isArray(req.body.days_of_week) && req.body.days_of_week.length
        ? req.body.days_of_week.map(Number)
        : null;
    const targets = days ? dates.filter(function (d) { return days.indexOf(core.dayOfWeek(d)) !== -1; }) : dates;
    if (!targets.length) return fail(res, 400, 'No dates in that range match those days.');

    const patch = only(req.body, ['price', 'min_nights', 'closed', 'closed_to_arrival', 'closed_to_departure', 'note']);
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to set.');

    const now = new Date().toISOString();
    const rows = targets.map(function (date) {
        return Object.assign({ entity_slug: slug, product_id: productId, date: date, updated_at: now }, patch);
    });

    const { error } = await supabase.from('booking_rate_calendar')
        .upsert(rows, { onConflict: 'product_id,date' });
    if (error) throw new Error(error.message);

    res.json({ ok: true, dates: targets.length, from: targets[0], to: targets[targets.length - 1] });
}));

router.delete('/products/:id/calendar', ownerRequired, handle(async (req, res) => {
    const from = core.toDate(req.query.from);
    const to = core.toDate(req.query.to) || from;
    if (!from) return fail(res, 400, 'A from date is required.');
    const { error } = await supabase.from('booking_rate_calendar').delete()
        .eq('entity_slug', req.entitySlug).eq('product_id', req.params.id)
        .gte('date', from).lte('date', to);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
}));

/* ── channels ───────────────────────────────────────────────────────── */
//
// Airbnb, Vrbo and Booking.com in both directions over iCal. See
// lib/channelSync.js for why iCal rather than a channel-manager contract.

const CHANNEL_FIELDS = ['name', 'direction', 'url', 'product_id', 'resource_id', 'active'];

router.get('/channels', ownerRequired, handle(async (req, res) => {
    const { data, error } = await supabase.from('booking_channels')
        .select('*').eq('entity_slug', req.entitySlug).order('created_at').limit(200);
    if (error) throw new Error(error.message);
    const base = channelBase(req);
    res.json({
        channels: (data || []).map(function (c) {
            return Object.assign({}, c, {
                // The export URL is derived, never stored as a secret —
                // and only ever shown to the owner it belongs to.
                feed_url: c.direction === 'export' && c.export_token
                    ? base + '/api/booking/ical/' + c.export_token + '.ics'
                    : null,
            });
        }),
    });
}));

router.post('/channels', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const row = only(req.body, CHANNEL_FIELDS);
    if (!row.name) return fail(res, 400, 'Give this channel a name, like "Airbnb".');

    row.direction = row.direction === 'export' ? 'export' : 'import';
    if (row.direction === 'import' && !row.url) {
        return fail(res, 400, 'Paste the calendar link you copied from that channel.');
    }
    if (row.product_id) {
        const { data: owned } = await supabase.from('booking_products')
            .select('id').eq('entity_slug', slug).eq('id', row.product_id).maybeSingle();
        if (!owned) return fail(res, 404, 'No such product.');
    }
    row.entity_slug = slug;
    row.kind = 'ical';

    const { data, error } = await supabase.from('booking_channels').insert(row).select('*').single();
    if (error) throw new Error(error.message);

    // An export channel's URL is a function of its id, so it can only be
    // written once the row exists.
    let channel = data;
    if (channel.direction === 'export') {
        const token = channels.exportToken(channel.id);
        const { data: withToken } = await supabase.from('booking_channels')
            .update({ export_token: token }).eq('id', channel.id).select('*').single();
        channel = withToken || channel;
    }

    // Pull it straight away: an owner who pastes a link wants to see it
    // work, not wait for a cron.
    let sync = null;
    if (channel.direction === 'import') sync = await channels.importChannel(channel);

    res.status(201).json({
        channel: Object.assign({}, channel, {
            feed_url: channel.export_token
                ? channelBase(req) + '/api/booking/ical/' + channel.export_token + '.ics'
                : null,
        }),
        sync: sync,
    });
}));

router.patch('/channels/:id', ownerRequired, handle(async (req, res) => {
    const patch = only(req.body, CHANNEL_FIELDS);
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change.');
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('booking_channels').update(patch)
        .eq('entity_slug', req.entitySlug).eq('id', req.params.id).select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(res, 404, 'No such channel.');
    res.json({ channel: data });
}));

router.delete('/channels/:id', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const { data: channel } = await supabase.from('booking_channels')
        .select('id, name').eq('entity_slug', slug).eq('id', req.params.id).maybeSingle();
    if (!channel) return fail(res, 404, 'No such channel.');

    // Its imported claims go with it, or dates stay blocked by a feed
    // nobody is reading any more.
    const source = 'ical:' + String(channel.name || 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    await supabase.from('booking_calendar').delete().eq('entity_slug', slug).eq('source', source);
    await supabase.from('booking_channels').delete().eq('entity_slug', slug).eq('id', req.params.id);
    res.json({ ok: true });
}));

router.post('/channels/:id/sync', ownerRequired, handle(async (req, res) => {
    const { data: channel } = await supabase.from('booking_channels')
        .select('*').eq('entity_slug', req.entitySlug).eq('id', req.params.id).maybeSingle();
    if (!channel) return fail(res, 404, 'No such channel.');
    if (channel.direction !== 'import') return fail(res, 400, 'That channel is an export — there is nothing to pull.');
    const result = await channels.importChannel(channel);
    res.json(result);
}));

function channelBase(req) {
    return (process.env.BOOKING_EMBED_BASE_URL || '').replace(/\/+$/, '') ||
        (req.protocol + '://' + req.get('host'));
}

/* ── orders ─────────────────────────────────────────────────────────── */

router.get('/orders', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    await releaseExpiredHolds(slug);

    let query = supabase.from('bookings').select('*').eq('entity_slug', slug);
    if (req.query.from) query = query.gte('date', core.toDate(req.query.from));
    if (req.query.to) query = query.lte('date', core.toDate(req.query.to));
    if (req.query.status) query = query.eq('status', String(req.query.status));
    if (req.query.product_id) query = query.eq('product_id', String(req.query.product_id));
    if (req.query.upcoming === 'true') query = query.gte('date', new Date().toISOString().slice(0, 10));

    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const { data, error } = await query
        .order('date', { ascending: req.query.upcoming === 'true' })
        .order('start_time', { ascending: true })
        .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ orders: data || [] });
}));

router.get('/orders/:id', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const { data: booking } = await supabase.from('bookings').select('*')
        .eq('entity_slug', slug).eq('id', req.params.id).maybeSingle();
    if (!booking) return fail(res, 404, 'No such booking.');

    const [items, payments] = await Promise.all([
        supabase.from('booking_line_items').select('*').eq('booking_id', booking.id).order('sort_order'),
        supabase.from('booking_payments').select('*').eq('booking_id', booking.id).order('created_at'),
    ]);
    res.json({
        booking: booking,
        line_items: items.data || [],
        payments: payments.data || [],
        manage_url: connect.publicBase() + '/book/manage/' + booking.id + '?t=' + manageToken(booking.id),
    });
}));

router.patch('/orders/:id', ownerRequired, handle(async (req, res) => {
    const patch = only(req.body, ['status', 'customer_notes', 'special_requests', 'resource_id', 'date', 'start_time', 'party_size']);
    if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to change.');
    if (patch.status === 'cancelled') patch.cancelled_at = new Date().toISOString();
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('bookings').update(patch)
        .eq('entity_slug', req.entitySlug).eq('id', req.params.id)
        .select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(res, 404, 'No such booking.');
    await syncCalendar(data);
    res.json({ booking: data });
}));

/**
 * Refund a booking.
 *
 * The default amount is whatever the product's own cancellation policy
 * says, computed server-side — but an owner who wants to refund more than
 * the policy always may. They are giving away their own money, and a
 * platform that refuses that is just in the way.
 */
router.post('/orders/:id/refund', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const { data: booking } = await supabase.from('bookings').select('*')
        .eq('entity_slug', slug).eq('id', req.params.id).maybeSingle();
    if (!booking) return fail(res, 404, 'No such booking.');

    const paidCents = core.toCents(booking.amount_paid) - core.toCents(booking.refunded_amount);
    if (paidCents <= 0) return fail(res, 400, 'Nothing has been paid on this booking.');

    let amountCents;
    if (req.body && req.body.amount != null) {
        amountCents = Math.min(paidCents, core.toCents(req.body.amount));
    } else {
        const { data: product } = await supabase.from('booking_products')
            .select('cancellation_policy').eq('id', booking.product_id).maybeSingle();
        amountCents = core.refundFor({
            product: product || {},
            paidCents: paidCents,
            date: booking.date,
            time: booking.start_time,
        }).refund_cents;
    }
    if (amountCents <= 0) {
        return fail(res, 400, 'The cancellation policy allows no refund at this point. Pass an explicit amount to override it.');
    }

    const { data: payment } = await supabase.from('booking_payments')
        .select('provider_object_id').eq('booking_id', booking.id).eq('kind', 'payment')
        .eq('status', 'succeeded').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!payment || !payment.provider_object_id) {
        return fail(res, 400, 'No Stripe payment is recorded against this booking.');
    }

    const refund = await connect.refundPayment({
        paymentIntentId: payment.provider_object_id,
        amountCents: amountCents,
        bookingId: booking.id,
        entitySlug: slug,
        reason: req.body && req.body.reason,
    });

    // The webhook writes the authoritative record; this makes the dashboard
    // correct immediately rather than a second later.
    const refundedCents = core.toCents(booking.refunded_amount) + amountCents;
    const { data: updated } = await supabase.from('bookings').update({
        refunded_amount: core.toDollars(refundedCents),
        payment_status: refundedCents >= core.toCents(booking.amount_paid) ? 'refunded' : 'partially_refunded',
        status: req.body && req.body.cancel === false ? booking.status : 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: (req.body && req.body.reason) || 'Refunded by the business',
        updated_at: new Date().toISOString(),
    }).eq('id', booking.id).select('*').maybeSingle();
    if (updated) await syncCalendar(updated);

    res.json({ ok: true, refunded: core.toDollars(amountCents), refund_id: refund.id });
}));

/** The owner's calendar: every claim, whatever created it. */
router.get('/calendar', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    await releaseExpiredHolds(slug);
    const from = core.toDate(req.query.from) || new Date().toISOString().slice(0, 10);
    const to = core.toDate(req.query.to) || core.addDays(from, 60);
    const claims = await loadClaims(slug, from, to);
    res.json({ from: from, to: to, entries: claims });
}));

/* ── payments (Stripe Connect) ──────────────────────────────────────── */

router.get('/payments/account', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    let account = await connect.getAccount(slug);
    // Refresh from Stripe when onboarding is unfinished — that is exactly
    // when the stored copy is most likely to be out of date.
    if (account && account.account_id && !account.charges_enabled) {
        account = await connect.syncAccount(slug);
    }
    const balance = account && account.charges_enabled ? await connect.accountSummary(slug) : null;

    res.json({
        stripe_configured: connect.configured(),
        connected: !!(account && account.account_id),
        account_id: (account && account.account_id) || null,
        charges_enabled: !!(account && account.charges_enabled),
        payouts_enabled: !!(account && account.payouts_enabled),
        details_submitted: !!(account && account.details_submitted),
        requirements: (account && account.requirements) || {},
        currency: (account && account.default_currency) || 'usd',
        livemode: !!(account && account.livemode),
        balance: balance,
    });
}));

router.post('/payments/account/onboard', ownerRequired, handle(async (req, res) => {
    if (!connect.configured()) return fail(res, 503, 'Stripe is not configured on this deployment yet.');
    const entity = await entityBySlug(req.entitySlug);
    const link = await connect.onboardingLink(req.entitySlug, entity, {
        returnUrl: req.body && req.body.return_url,
        refreshUrl: req.body && req.body.refresh_url,
    });
    res.json(link);
}));

router.post('/payments/account/refresh', ownerRequired, handle(async (req, res) => {
    const account = await connect.syncAccount(req.entitySlug);
    res.json({
        connected: !!(account && account.account_id),
        charges_enabled: !!(account && account.charges_enabled),
        payouts_enabled: !!(account && account.payouts_enabled),
        requirements: (account && account.requirements) || {},
    });
}));

router.post('/payments/account/login-link', ownerRequired, handle(async (req, res) => {
    const link = await connect.loginLink(req.entitySlug);
    res.json(link);
}));

/* ── settings ───────────────────────────────────────────────────────── */
//
// Kept in entity_modules under its own key, with no `manifest` field — so
// routes/platform.js, which only reconstructs rows that carry a manifest,
// leaves these alone and the two module systems never collide.

const SETTINGS_KEY = 'booking_platform';

router.get('/settings', ownerRequired, handle(async (req, res) => {
    const { data } = await supabase.from('entity_modules')
        .select('enabled, settings').eq('entity_slug', req.entitySlug)
        .eq('module_key', SETTINGS_KEY).maybeSingle();
    res.json({
        enabled: data ? data.enabled !== false : false,
        settings: (data && data.settings && data.settings.config) || {},
    });
}));

router.patch('/settings', ownerRequired, handle(async (req, res) => {
    const slug = req.entitySlug;
    const { data: existing } = await supabase.from('entity_modules')
        .select('id, settings').eq('entity_slug', slug).eq('module_key', SETTINGS_KEY).maybeSingle();

    const config = Object.assign(
        (existing && existing.settings && existing.settings.config) || {},
        (req.body && req.body.settings) || {},
    );
    const row = {
        enabled: req.body && req.body.enabled !== undefined ? !!req.body.enabled : true,
        settings: { config: config },
    };

    if (existing) await supabase.from('entity_modules').update(row).eq('id', existing.id);
    else await supabase.from('entity_modules').insert(Object.assign({ entity_slug: slug, module_key: SETTINGS_KEY }, row));

    res.json({ enabled: row.enabled, settings: config });
}));

/* ============================================================
 * THE WIDGET — somewhere for customers to actually book.
 * ============================================================ */
//
// A booking API with no front door is a booking API nobody uses. These two
// routes are that front door:
//
//   /api/booking/embed.js      a script tag for a site the business has
//   /api/booking/page/:slug    a hosted page for a business with no site
//
// Both serve the same widget from lib/bookingWidget.js, so the checkout has
// one implementation rather than two that drift. Neither takes a session:
// they are public assets, cached, and the widget itself only ever calls the
// /public/ routes below.

const widget = require('../lib/bookingWidget');

router.get('/embed.js', (_req, res) => {
    res.type('application/javascript');
    // Long cache, because this file changes on deploy and a stale copy for
    // an hour is better than a fetch on every page view of every business.
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    // Deliberately open: the whole point is that it loads from a business's
    // own Wix, Squarespace or WordPress site, none of which we know.
    res.set('Access-Control-Allow-Origin', '*');
    res.send(widget.WIDGET_JS);
});

router.get('/page/:slug', (req, res) => {
    const base = (process.env.BOOKING_EMBED_BASE_URL || '').replace(/\/+$/, '') ||
        (req.protocol + '://' + req.get('host'));
    res.type('html');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(widget.pageHtml(req.params.slug, base));
});

/* ============================================================
 * PUBLIC — a customer, one named business.
 * ============================================================ */

/** Everything a booking page needs to render, in one call. */
router.get('/public/:slug', handle(async (req, res) => {
    const slug = String(req.params.slug || '');
    const entity = await entityBySlug(slug);
    if (!entity) return fail(res, 404, 'No such business.');
    await releaseExpiredHolds(slug);

    const [products, account, settings] = await Promise.all([
        supabase.from('booking_products').select('*')
            .eq('entity_slug', slug).eq('active', true).order('sort_order', { ascending: true }),
        connect.getAccount(slug),
        supabase.from('entity_modules').select('enabled, settings')
            .eq('entity_slug', slug).eq('module_key', SETTINGS_KEY).maybeSingle(),
    ]);

    const list = products.data || [];
    const ids = list.map(function (p) { return p.id; });
    const rates = ids.length
        ? await supabase.from('booking_rates').select('*')
            .eq('entity_slug', slug).eq('active', true).in('product_id', ids).order('sort_order')
        : { data: [] };
    const extras = await supabase.from('booking_extras').select('*')
        .eq('entity_slug', slug).eq('active', true).order('sort_order');

    const ratesBy = {};
    (rates.data || []).forEach(function (r) {
        (ratesBy[r.product_id] = ratesBy[r.product_id] || []).push(publicRate(r));
    });

    res.json({
        business: {
            slug: entity.slug,
            name: entity.name,
            tagline: entity.subtitle || '',
            phone: entity.phone || null,
            email: entity.email || null,
            logo: entity.logo_url || null,
            hero: entity.hero_image_url || null,
            accent: (entity.theme && entity.theme.accent) || '#22c3a6',
            city: entity.city || null,
        },
        accepts_payments: connect.canAcceptPayments(account),
        settings: (settings.data && settings.data.settings && settings.data.settings.config) || {},
        products: list.map(function (p) {
            return Object.assign(publicProduct(p), {
                rates: ratesBy[p.id] || [],
                extras: (extras.data || [])
                    .filter(function (e) { return !e.product_id || String(e.product_id) === String(p.id); })
                    .map(publicExtra),
            });
        }),
    });
}));

// The public shapes are explicit allow-lists rather than "the row minus a
// few fields". A column added to booking_products later must not silently
// become public because nobody remembered to exclude it.
function publicProduct(p) {
    return {
        id: p.id,
        name: p.name,
        description: p.description,
        image_url: p.image_url,
        template_id: p.template_id,
        schedule_mode: p.schedule_mode,
        capacity_mode: p.capacity_mode,
        duration_minutes: p.duration_minutes,
        min_party: p.min_party,
        max_party: p.max_party,
        currency: p.currency,
        deposit_mode: p.deposit_mode,
        deposit_value: p.deposit_value,
        tax_percent: p.tax_percent,
        requires_waiver: p.requires_waiver,
        cancellation_policy: p.cancellation_policy,
        questions: p.questions || [],
    };
}
function publicRate(r) {
    return {
        id: r.id, label: r.label, description: r.description, pricing_mode: r.pricing_mode,
        amount: Number(r.amount), min_qty: r.min_qty, max_qty: r.max_qty,
        age_min: r.age_min, age_max: r.age_max,
        weight_min_lb: r.weight_min_lb, weight_max_lb: r.weight_max_lb,
    };
}
function publicExtra(e) {
    return {
        id: e.id, name: e.name, description: e.description,
        price: Number(e.price), pricing_mode: e.pricing_mode,
        max_qty: e.max_qty, required: e.required,
    };
}

/** What is open, for one product, over a date range. */
router.get('/public/:slug/availability', handle(async (req, res) => {
    const slug = String(req.params.slug || '');
    const productId = String(req.query.product_id || '');
    if (!productId) return fail(res, 400, 'product_id is required.');

    const loaded = await loadProduct(slug, productId, { publicOnly: true });
    if (!loaded) return fail(res, 404, 'No such product.');
    await releaseExpiredHolds(slug);

    const from = core.toDate(req.query.from) || core.toDate(req.query.date) || new Date().toISOString().slice(0, 10);
    const to = core.toDate(req.query.to) || (req.query.date ? from : core.addDays(from, 30));
    const claims = await loadClaims(slug, from, core.addDays(to, 1), productId);

    // A stay is a different question from a day: "are these nights free
    // together", not "is each of them open". When the caller names both
    // ends, answer the question they actually asked.
    if (loaded.product.schedule_mode === 'date_range' && req.query.to && req.query.from) {
        const calendar = await loadRateCalendar(slug, productId, from, to);
        const stay = core.availabilityForStay({
            product: loaded.product,
            schedules: loaded.schedules,
            claims: claims,
            calendar: calendar,
            resourceId: req.query.resource_id || null,
            from: from,
            to: to,
        });
        return res.json({ product_id: productId, from: from, to: to, stay: stay });
    }

    const days = core.availabilityForRange({
        product: loaded.product,
        schedules: loaded.schedules,
        claims: claims,
        resourceId: req.query.resource_id || null,
        from: from,
        to: to,
    });

    res.json({ product_id: productId, from: from, to: to, days: days });
}));

/**
 * Price a cart. The customer sees this before they ever reach a card form.
 *
 * The same function prices the actual charge a moment later, so what is
 * quoted here and what is taken there cannot drift apart.
 */
router.post('/public/:slug/quote', handle(async (req, res) => {
    const result = await priceCart(String(req.params.slug || ''), req.body || {});
    if (!result.ok) return fail(res, result.status || 400, result.error);
    res.json(result.quote);
}));

/** Shared by /quote and /checkout so they can never disagree on a price. */
async function priceCart(slug, body) {
    const productId = String(body.product_id || '');
    if (!productId) return { ok: false, status: 400, error: 'product_id is required.' };

    const loaded = await loadProduct(slug, productId, { publicOnly: true });
    if (!loaded) return { ok: false, status: 404, error: 'No such product.' };

    let promo = null;
    if (body.promo_code) {
        const today = new Date().toISOString().slice(0, 10);
        const { data: rows } = await supabase.from('promos')
            .select('code, type, amount, starts, ends, active')
            .eq('entity_slug', slug).eq('active', true).limit(200);
        promo = (rows || []).find(function (p) {
            if (String(p.code || '').trim().toLowerCase() !== String(body.promo_code).trim().toLowerCase()) return false;
            if (p.starts && today < core.toDate(p.starts)) return false;
            if (p.ends && today > core.toDate(p.ends)) return false;
            return true;
        }) || null;
    }

    // Per-night rates price from the calendar, so a quote for the 4th of
    // July is not a quote for a Tuesday in November.
    const calendar = loaded.product.schedule_mode === 'date_range'
        ? await loadRateCalendar(slug, productId, body.date, body.end_date)
        : {};

    const quote = core.quote({
        product: loaded.product,
        rates: loaded.rates,
        extras: loaded.extras,
        promo: promo,
        calendar: calendar,
        cart: {
            date: body.date,
            end_date: body.end_date,
            items: body.items,
            extras: body.extras,
        },
    });
    if (!quote.ok) return { ok: false, status: 400, error: quote.error };
    if (body.promo_code && !promo) quote.promo_warning = 'That promo code is not valid, so it was not applied.';

    return { ok: true, quote: quote, loaded: loaded, promo: promo };
}

/**
 * Book it.
 *
 * The order matters and is the reason this is one handler rather than two:
 *
 *   1. price the cart server-side
 *   2. check the seats are still there
 *   3. write the booking as a HOLD, which claims the seats
 *   4. only then ask Stripe for a checkout session
 *
 * Claiming before charging means two people racing for the last seat get
 * one booking and one clear refusal, instead of two charges and an
 * apology. The hold expires by itself if the card form is abandoned.
 */
router.post('/public/:slug/checkout', handle(async (req, res) => {
    const slug = String(req.params.slug || '');
    const body = req.body || {};

    const customer = {
        name: String(body.customer_name || '').trim().slice(0, 200),
        email: String(body.customer_email || '').trim().slice(0, 200),
        phone: String(body.customer_phone || '').trim().slice(0, 40),
    };
    if (!customer.name) return fail(res, 400, 'Please give a name for the booking.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) return fail(res, 400, 'Please give a valid email address.');

    const priced = await priceCart(slug, body);
    if (!priced.ok) return fail(res, priced.status || 400, priced.error);

    const { quote, loaded } = priced;
    const product = loaded.product;
    const date = core.toDate(body.date);
    const time = body.time ? core.toClock(core.toMinutes(body.time)) : null;

    // ── the seats have to still exist ──
    // ── a stay is checked night by night, not just on its arrival date ──
    //
    // availabilityForDate answers about ONE date. A booking that spans
    // nights needs every one of them free, and checking only the arrival
    // is how a five-night stay gets sold straight over a night that was
    // already taken in the middle.
    if (product.schedule_mode === 'date_range') {
        if (!date) return fail(res, 400, 'Please pick an arrival date.');
        const endDate = core.toDate(body.end_date);
        if (!endDate) return fail(res, 400, 'Please pick a departure date.');

        await releaseExpiredHolds(slug);
        const claims = await loadClaims(slug, date, core.addDays(endDate, 1), product.id);
        const calendar = await loadRateCalendar(slug, product.id, date, endDate);

        const stay = core.availabilityForStay({
            product: product,
            schedules: loaded.schedules,
            claims: claims,
            calendar: calendar,
            resourceId: body.resource_id || null,
            from: date,
            to: endDate,
        });
        if (!stay.ok) return fail(res, stay.reason === 'unavailable' ? 409 : 400, stay.error);
    } else if (product.schedule_mode !== 'request') {
        if (!date) return fail(res, 400, 'Please pick a date.');
        await releaseExpiredHolds(slug);
        const claims = await loadClaims(slug, date, core.addDays(date, 1), product.id);
        const day = core.availabilityForDate({
            product: product,
            schedules: loaded.schedules,
            claims: claims,
            resourceId: body.resource_id || null,
            date: date,
        });
        if (!day.bookable) {
            return fail(res, 409, day.reason === 'cutoff'
                ? 'Online booking has closed for that date — please call.'
                : 'That date is no longer available. Please pick another.');
        }
        const wantsTime = product.schedule_mode === 'fixed_times' || product.schedule_mode === 'duration_slots';
        const slot = wantsTime
            ? day.slots.find(function (s) { return s.time === time; })
            : day.slots[0];
        if (wantsTime && !slot) return fail(res, 400, 'Please pick a departure time.');
        if (!slot || !slot.available) return fail(res, 409, 'That time has just gone. Please pick another.');
        if (slot.remaining < quote.capacity_used) {
            return fail(res, 409, slot.remaining > 0
                ? 'Only ' + slot.remaining + ' place' + (slot.remaining === 1 ? '' : 's') + ' left at that time.'
                : 'That time is now full.');
        }
    }

    // ── answers to the product's own questions ──
    const answers = {};
    for (const question of product.questions || []) {
        const value = body.answers && body.answers[question.key];
        if (question.required && !value) return fail(res, 400, question.label + ' is required.');
        if (value != null) answers[question.key] = String(value).slice(0, 2000);
    }

    // ── 3. hold the seats ──
    const payNowCents = quote.pay_now_cents;
    const needsPayment = payNowCents > 0;
    const account = await connect.getAccount(slug);
    if (needsPayment && !connect.canAcceptPayments(account)) {
        return fail(res, 503, 'This business cannot take card payments yet. Please contact them directly.');
    }

    const bookingRow = {
        entity_slug: slug,
        product_id: product.id,
        template_id: product.template_id || null,
        customer_name: customer.name,
        email: customer.email,
        phone: customer.phone || null,
        date: date,
        end_date: core.toDate(body.end_date),
        start_time: time,
        end_time: time && product.duration_minutes
            ? core.toClock(core.toMinutes(time) + parseInt(product.duration_minutes, 10))
            : null,
        party_size: quote.party_size,
        resource_id: body.resource_id || null,
        currency: quote.currency,
        subtotal: quote.subtotal,
        discount_total: quote.discount,
        tax_total: quote.tax,
        total_amount: quote.total,
        total_price: quote.total,
        deposit_due: quote.deposit_due,
        balance_due: quote.balance_due,
        amount_paid: 0,
        promo_code: (priced.promo && priced.promo.code) || null,
        answers: answers,
        special_requests: String(body.notes || '').slice(0, 2000) || null,
        status: needsPayment ? 'hold' : 'pending',
        payment_status: needsPayment ? 'pending' : 'unpaid',
        payment_provider: needsPayment ? 'stripe' : null,
        stripe_account_id: (account && account.account_id) || null,
        source: 'booking_platform',
        confirmation_code: confirmationCode(),
        hold_expires_at: needsPayment
            ? new Date(Date.now() + HOLD_MINUTES * 60000).toISOString()
            : null,
        details: { quote_lines: quote.lines },
    };

    const { data: booking, error } = await supabase.from('bookings').insert(bookingRow).select('*').single();
    if (error) throw new Error(error.message);

    await supabase.from('booking_line_items').insert(quote.lines.map(function (line, i) {
        return {
            entity_slug: slug,
            booking_id: booking.id,
            kind: line.kind,
            ref_id: line.ref_id || null,
            label: line.label,
            unit_amount: line.unit_amount,
            quantity: line.quantity,
            amount: line.amount,
            sort_order: i,
        };
    }));
    await syncCalendar(booking);

    // ── nothing to charge: the business collects on the day ──
    if (!needsPayment) {
        await notifyNewBooking(slug, booking, product);
        return res.json({
            ok: true,
            booking_id: booking.id,
            confirmation_code: booking.confirmation_code,
            payment_required: false,
            manage_url: manageUrl(booking.id),
            total: quote.total,
        });
    }

    // ── 4. now, and only now, Stripe ──
    const feeCents = await connect.feeForCharge({
        entitySlug: slug,
        templateId: product.template_id,
        amountCents: payNowCents,
    });

    const base = connect.publicBase();
    let session;
    try {
        session = await connect.createCheckoutSession({
            account: account,
            amountCents: payNowCents,
            applicationFeeCents: feeCents,
            currency: quote.currency,
            bookingId: booking.id,
            entitySlug: slug,
            productId: product.id,
            templateId: product.template_id,
            customerEmail: customer.email,
            title: product.name,
            description: [date, time].filter(Boolean).join(' at ') +
                (quote.deposit_due < quote.total ? ' — deposit' : ''),
            successUrl: withParams(
                safeReturnUrl(body.success_url, base + '/book/manage/' + booking.id),
                't=' + manageToken(booking.id) + '&paid=1',
            ),
            cancelUrl: safeReturnUrl(body.cancel_url, base + '/book/' + slug + '?cancelled=1'),
            expiresAt: Math.floor(Date.now() / 1000) + Math.max(30, HOLD_MINUTES) * 60,
        });
    } catch (err) {
        // The hold must not outlive a checkout that never opened.
        await supabase.from('bookings').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', booking.id);
        await supabase.from('booking_calendar').update({ status: 'cancelled' }).eq('booking_id', booking.id);
        return fail(res, 502, 'Could not start the payment: ' + err.message);
    }

    await supabase.from('bookings').update({
        checkout_session_id: session.id,
        application_fee: core.toDollars(feeCents),
        updated_at: new Date().toISOString(),
    }).eq('id', booking.id);

    res.json({
        ok: true,
        booking_id: booking.id,
        confirmation_code: booking.confirmation_code,
        payment_required: true,
        checkout_url: session.url,
        pay_now: core.toDollars(payNowCents),
        total: quote.total,
        hold_expires_at: booking.hold_expires_at,
        manage_url: manageUrl(booking.id),
    });
}));

function manageUrl(bookingId) {
    return connect.publicBase() + '/book/manage/' + bookingId + '?t=' + manageToken(bookingId);
}

/**
 * Where Stripe may send a customer afterwards.
 *
 * The widget supplies this, and the widget runs on whatever site the
 * business embedded it in — so the value arrives from a browser and cannot
 * be trusted. Handed to Stripe unchecked it is an open redirect on the back
 * of a real payment: a customer who genuinely just paid is delivered to
 * somewhere of an attacker's choosing, at the exact moment they are most
 * willing to believe a page asking for card details again.
 *
 * So: http(s) only (no javascript:, no data:), a sane length, and anything
 * that fails falls back to the booking's own manage page rather than being
 * rejected — a payment must not fail over a bad return URL.
 */
function safeReturnUrl(candidate, fallback) {
    const raw = String(candidate || '').trim();
    if (!raw || raw.length > 500) return fallback;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
        return url.toString();
    } catch {
        return fallback;
    }
}

/** Append a query parameter to a URL that may or may not already have one. */
function withParams(url, params) {
    const joiner = url.includes('?') ? '&' : '?';
    return url + joiner + params;
}

/** Tell the business a booking landed. Best-effort — never blocks a sale. */
async function notifyNewBooking(slug, booking, product) {
    try {
        const entity = await entityBySlug(slug);
        if (!entity || !entity.phone) return;
        const { sendSms } = require('../utils/sms');
        const when = [booking.date, booking.start_time].filter(Boolean).join(' ');
        await sendSms(
            entity.phone,
            '[' + (entity.name || slug) + '] New booking: ' + (product.name || 'booking') +
            ' — ' + booking.customer_name + ', ' + booking.party_size + ' pax, ' + when +
            ' ($' + (booking.total_amount || 0) + ')',
            slug, 'booking_platform', booking.id,
        );
    } catch (err) {
        console.error('[booking] owner SMS failed:', err.message);
    }
}

/* ── self-serve management, no account needed ───────────────────────── */

async function loadManaged(req, res) {
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', req.params.id).maybeSingle();
    if (!booking) { fail(res, 404, 'No such booking.'); return null; }
    const token = (req.query && req.query.t) || (req.body && req.body.t);
    if (!manageTokenOk(booking.id, token)) { fail(res, 403, 'That link is not valid.'); return null; }
    return booking;
}

router.get('/public/booking/:id', handle(async (req, res) => {
    const booking = await loadManaged(req, res);
    if (!booking) return;

    const [entity, product, items] = await Promise.all([
        entityBySlug(booking.entity_slug),
        booking.product_id
            ? supabase.from('booking_products').select('*').eq('id', booking.product_id).maybeSingle()
            : Promise.resolve({ data: null }),
        supabase.from('booking_line_items').select('kind, label, quantity, amount').eq('booking_id', booking.id).order('sort_order'),
    ]);

    const paidCents = core.toCents(booking.amount_paid) - core.toCents(booking.refunded_amount);
    const refund = core.refundFor({
        product: product.data || {},
        paidCents: paidCents,
        date: booking.date,
        time: booking.start_time,
    });

    res.json({
        booking: {
            id: booking.id,
            confirmation_code: booking.confirmation_code,
            status: booking.status,
            payment_status: booking.payment_status,
            date: booking.date,
            end_date: booking.end_date,
            start_time: booking.start_time,
            party_size: booking.party_size,
            customer_name: booking.customer_name,
            total: Number(booking.total_amount || 0),
            paid: Number(booking.amount_paid || 0),
            balance: Number(booking.balance_due || 0),
            refunded: Number(booking.refunded_amount || 0),
            waiver_signed: !!booking.waiver_signed_at,
        },
        product: product.data ? publicProduct(product.data) : null,
        business: entity ? { slug: entity.slug, name: entity.name, phone: entity.phone, email: entity.email } : null,
        line_items: items.data || [],
        cancellation: {
            refundable: refund.refund_cents,
            refundable_amount: core.toDollars(refund.refund_cents),
            percent: refund.percent,
        },
    });
}));

router.post('/public/booking/:id/cancel', handle(async (req, res) => {
    const booking = await loadManaged(req, res);
    if (!booking) return;
    if (['cancelled', 'expired'].indexOf(booking.status) !== -1) {
        return res.json({ ok: true, already: true, status: booking.status });
    }

    const { data: product } = booking.product_id
        ? await supabase.from('booking_products').select('*').eq('id', booking.product_id).maybeSingle()
        : { data: null };

    const paidCents = core.toCents(booking.amount_paid) - core.toCents(booking.refunded_amount);
    const refund = core.refundFor({
        product: product || {},
        paidCents: paidCents,
        date: booking.date,
        time: booking.start_time,
    });

    let refunded = 0;
    if (refund.refund_cents > 0) {
        const { data: payment } = await supabase.from('booking_payments')
            .select('provider_object_id').eq('booking_id', booking.id).eq('kind', 'payment')
            .eq('status', 'succeeded').order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (payment && payment.provider_object_id) {
            try {
                await connect.refundPayment({
                    paymentIntentId: payment.provider_object_id,
                    amountCents: refund.refund_cents,
                    bookingId: booking.id,
                    entitySlug: booking.entity_slug,
                    reason: 'requested_by_customer',
                });
                refunded = core.toDollars(refund.refund_cents);
            } catch (err) {
                // Cancel anyway. A seat held by someone who has walked away
                // helps nobody; the refund becomes the business's to settle.
                console.error('[booking] refund on cancel failed:', err.message);
            }
        }
    }

    const { data: updated } = await supabase.from('bookings').update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancel_reason: String((req.body && req.body.reason) || 'Cancelled by the customer').slice(0, 500),
        refunded_amount: core.toDollars(core.toCents(booking.refunded_amount) + core.toCents(refunded)),
        updated_at: new Date().toISOString(),
    }).eq('id', booking.id).select('*').maybeSingle();
    if (updated) await syncCalendar(updated);

    res.json({ ok: true, refunded: refunded, policy: refund.reason });
}));

/* ============================================================
 * THE OUTBOUND FEED — what Airbnb and Vrbo poll.
 * ============================================================ */
//
// Unauthenticated by necessity: a channel polls this on a schedule with
// no way to hold a credential. The token in the path is the whole guard,
// which is what every platform does with these links — and the body says
// only that dates are taken, never who took them.

router.get('/ical/:token.ics', handle(async (req, res) => {
    const token = String(req.params.token || '').replace(/\.ics$/, '');
    if (!/^[0-9a-f]{32}$/.test(token)) return fail(res, 404, 'Not found.');

    const { data: channel } = await supabase.from('booking_channels')
        .select('*').eq('export_token', token).maybeSingle();
    if (!channel || channel.active === false) return fail(res, 404, 'Not found.');

    const body = await channels.exportCalendar(channel);
    res.type('text/calendar');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Disposition', 'attachment; filename="bookings.ics"');
    res.send(body);
}));

/**
 * Pull every import feed. Called by a scheduler, not a person.
 *
 * Guarded by a shared secret rather than a session, because a cron has no
 * session — and left open when no secret is set would let anyone make
 * this deployment hammer other people's servers.
 */
router.get('/cron/sync-channels', handle(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return fail(res, 503, 'CRON_SECRET is not set, so scheduled syncing is off.');
    const given = req.get('authorization') === 'Bearer ' + secret || req.query.key === secret;
    if (!given) return fail(res, 403, 'Not authorised.');

    const results = await channels.syncAll({ limit: parseInt(req.query.limit, 10) || 200 });
    res.json({
        ok: true,
        channels: results.length,
        imported: results.reduce(function (total, r) { return total + (r.imported || 0); }, 0),
        failed: results.filter(function (r) { return !r.ok; }).length,
        results: results,
    });
}));

/* ============================================================
 * ADMIN — the verticals themselves.
 * ============================================================ */
//
// "A vertical is a row" is only true if somebody can write the row. This
// is that: platform_admins can add, edit and retire booking templates
// from a form instead of a SQL console.
//
// Checked against platform_admins server-side, the same way
// middleware/ownerAuth.js does it — an admin claim in a request is worth
// nothing on its own.

async function adminRequired(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return fail(res, 401, 'Not signed in.');
    try {
        const { data, error } = await supabase.auth.getUser(header.slice(7));
        if (error || !data?.user) return fail(res, 401, 'That session is not valid.');
        const { data: admin } = await supabase.from('platform_admins')
            .select('user_id').eq('user_id', data.user.id).maybeSingle();
        if (!admin) return fail(res, 403, 'This is an admin-only area.');
        req.adminUserId = data.user.id;
        return next();
    } catch {
        return fail(res, 401, 'That session is not valid.');
    }
}

const TEMPLATE_FIELDS = ['id', 'name', 'category', 'icon', 'tagline', 'description',
    'schedule_mode', 'defaults', 'rate_template', 'addon_template', 'question_template',
    'active', 'sort_order'];

router.get('/admin/templates', adminRequired, handle(async (_req, res) => {
    const { data, error } = await supabase.from('booking_templates')
        .select('*').order('sort_order').limit(500);
    if (error) throw new Error(error.message);
    res.json({ templates: data || [] });
}));

/**
 * Add or replace a vertical.
 *
 * The template is instantiated before it is saved. A template that cannot
 * produce a working product is a broken button in every business's
 * dashboard, and the cheapest place to find that out is here.
 */
router.put('/admin/templates/:id', adminRequired, handle(async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!/^[a-z0-9_]{2,60}$/.test(id)) {
        return fail(res, 400, 'An id is lowercase letters, numbers and underscores, like "horseback_rides".');
    }

    const row = only(req.body, TEMPLATE_FIELDS);
    row.id = id;
    if (!row.name) return fail(res, 400, 'A template needs a name.');

    const MODES = ['fixed_times', 'duration_slots', 'date_range', 'open_date', 'request'];
    if (row.schedule_mode && MODES.indexOf(row.schedule_mode) === -1) {
        return fail(res, 400, 'schedule_mode must be one of: ' + MODES.join(', '));
    }

    // Prove it works before it reaches anyone's App Store.
    try {
        const built = core.productFromTemplate(row, '__preflight__');
        if (!built.product.name) throw new Error('it produced a product with no name');
        const rates = built.rates.map(function (r, i) { return Object.assign({ id: 'preflight-' + i }, r); });
        if (rates.length) {
            const priced = core.quote({
                product: built.product,
                rates: rates,
                extras: [],
                cart: { date: core.addDays(new Date().toISOString().slice(0, 10), 30), items: [{ rate_id: 'preflight-0', qty: 1 }] },
            });
            if (!priced.ok) throw new Error('a booking of one could not be priced — ' + priced.error);
        }
    } catch (err) {
        return fail(res, 400, 'That template would not work: ' + err.message);
    }

    const { data, error } = await supabase.from('booking_templates')
        .upsert(row, { onConflict: 'id' }).select('*').single();
    if (error) throw new Error(error.message);
    res.json({ template: data });
}));

/**
 * Retire a vertical.
 *
 * Deactivates rather than deletes: products already created from it carry
 * its id, and fee rules can be scoped to it.
 */
router.delete('/admin/templates/:id', adminRequired, handle(async (req, res) => {
    const { data, error } = await supabase.from('booking_templates')
        .update({ active: false }).eq('id', req.params.id).select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail(res, 404, 'No such template.');
    res.json({ ok: true, deactivated: true });
}));

/* ============================================================
 * WEBHOOK — Stripe's word on what actually happened.
 * ============================================================ */
//
// The booking is confirmed HERE, not when the browser comes back from
// Stripe. A customer who pays and closes the tab is still booked; a
// customer who fakes a redirect is not. The redirect is a convenience,
// the webhook is the truth.
//
// Mounted with express.raw in server.js: the signature covers the exact
// bytes Stripe sent, so a re-serialised body cannot be verified.

router.post('/webhook/stripe', handle(async (req, res) => {
    let event;
    try {
        event = connect.constructEvent(req.body, req.headers['stripe-signature']);
    } catch (err) {
        console.error('[booking webhook] rejected:', err.message);
        return res.status(400).json({ error: 'Signature verification failed.' });
    }

    // Idempotency: claim the id before doing anything. A duplicate delivery
    // loses the insert and stops here, which is the only safe outcome when
    // the work includes moving money.
    const { error: claimError } = await supabase.from('booking_webhook_events').insert({
        id: event.id,
        type: event.type,
        account_id: event.account || null,
        livemode: !!event.livemode,
        payload: event.data && event.data.object ? { object_id: event.data.object.id } : null,
    });
    if (claimError) {
        // A unique violation means we have seen this event already.
        return res.json({ received: true, duplicate: true });
    }

    try {
        await processEvent(event);
        await supabase.from('booking_webhook_events')
            .update({ processed_at: new Date().toISOString() }).eq('id', event.id);
    } catch (err) {
        console.error('[booking webhook]', event.type, event.id, err.message);
        // Release the claim so Stripe's retry of this same event id is
        // processed rather than waved through as a duplicate, and answer 500
        // so that retry actually comes.
        await supabase.from('booking_webhook_events').delete().eq('id', event.id);
        return res.status(500).json({ error: 'Handler failed; please retry.' });
    }

    res.json({ received: true });
}));

async function processEvent(event) {
    const object = (event.data && event.data.object) || {};

    switch (event.type) {
        case 'checkout.session.completed':
            return onCheckoutCompleted(object);
        case 'checkout.session.expired':
            return onCheckoutExpired(object);
        case 'payment_intent.payment_failed':
            return onPaymentFailed(object);
        case 'charge.refunded':
            return onChargeRefunded(object);
        case 'account.updated':
            return onAccountUpdated(object);
        default:
            return null;
    }
}

async function onCheckoutCompleted(session) {
    const bookingId = (session.metadata && session.metadata.booking_id) || session.client_reference_id;
    if (!bookingId) return;

    const { data: booking } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (!booking) return;

    const paidCents = session.amount_total || 0;
    const totalCents = core.toCents(booking.total_amount);
    const alreadyCents = core.toCents(booking.amount_paid);
    const nowPaidCents = alreadyCents + paidCents;

    await supabase.from('booking_payments').insert({
        entity_slug: booking.entity_slug,
        booking_id: booking.id,
        kind: 'payment',
        provider: 'stripe',
        provider_object_id: session.payment_intent || session.id,
        stripe_account_id: booking.stripe_account_id || null,
        amount: core.toDollars(paidCents),
        application_fee: Number(booking.application_fee || 0),
        currency: (session.currency || 'usd').toLowerCase(),
        status: 'succeeded',
        raw: { session_id: session.id, payment_intent: session.payment_intent },
    });

    const { data: updated } = await supabase.from('bookings').update({
        status: 'confirmed',
        payment_status: nowPaidCents >= totalCents ? 'paid' : 'deposit_paid',
        payment_id: session.payment_intent || session.id,
        payment_provider: 'stripe',
        amount_paid: core.toDollars(nowPaidCents),
        balance_due: core.toDollars(Math.max(0, totalCents - nowPaidCents)),
        hold_expires_at: null,
        updated_at: new Date().toISOString(),
    }).eq('id', booking.id).select('*').maybeSingle();

    if (updated) {
        await syncCalendar(updated);
        const { data: product } = updated.product_id
            ? await supabase.from('booking_products').select('name').eq('id', updated.product_id).maybeSingle()
            : { data: null };
        await notifyNewBooking(updated.entity_slug, updated, product || {});
        await notifyCustomer(updated, product || {});
    }
}

async function onCheckoutExpired(session) {
    const bookingId = (session.metadata && session.metadata.booking_id) || session.client_reference_id;
    if (!bookingId) return;
    const { data: booking } = await supabase.from('bookings')
        .select('id, status, entity_slug').eq('id', bookingId).maybeSingle();
    if (!booking || booking.status !== 'hold') return;
    await supabase.from('bookings')
        .update({ status: 'expired', payment_status: 'abandoned', updated_at: new Date().toISOString() })
        .eq('id', booking.id);
    await supabase.from('booking_calendar').update({ status: 'cancelled' }).eq('booking_id', booking.id);
}

async function onPaymentFailed(intent) {
    const bookingId = intent.metadata && intent.metadata.booking_id;
    if (!bookingId) return;
    await supabase.from('booking_payments').insert({
        entity_slug: (intent.metadata && intent.metadata.entity_slug) || '',
        booking_id: bookingId,
        kind: 'payment',
        provider: 'stripe',
        provider_object_id: intent.id,
        amount: core.toDollars(intent.amount || 0),
        currency: (intent.currency || 'usd').toLowerCase(),
        status: 'failed',
        failure_reason: (intent.last_payment_error && intent.last_payment_error.message) || null,
        raw: { payment_intent: intent.id },
    });
    await supabase.from('bookings')
        .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', bookingId);
}

async function onChargeRefunded(charge) {
    const bookingId = charge.metadata && charge.metadata.booking_id;
    if (!bookingId) return;
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (!booking) return;

    const refundedCents = charge.amount_refunded || 0;
    const paidCents = core.toCents(booking.amount_paid);

    await supabase.from('booking_payments').insert({
        entity_slug: booking.entity_slug,
        booking_id: booking.id,
        kind: 'refund',
        provider: 'stripe',
        provider_object_id: charge.id,
        amount: core.toDollars(refundedCents),
        currency: (charge.currency || 'usd').toLowerCase(),
        status: 'succeeded',
        raw: { charge: charge.id },
    });

    const { data: updated } = await supabase.from('bookings').update({
        refunded_amount: core.toDollars(refundedCents),
        payment_status: refundedCents >= paidCents ? 'refunded' : 'partially_refunded',
        updated_at: new Date().toISOString(),
    }).eq('id', booking.id).select('*').maybeSingle();
    if (updated && refundedCents >= paidCents && updated.status !== 'cancelled') {
        const { data: cancelled } = await supabase.from('bookings')
            .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
            .eq('id', booking.id).select('*').maybeSingle();
        if (cancelled) await syncCalendar(cancelled);
    }
}

/** Onboarding finished, or Stripe asked for more — either way, record it. */
async function onAccountUpdated(account) {
    const slug = (account.metadata && account.metadata.entity_slug) || await connect.slugForAccount(account.id);
    if (!slug) return;
    const patch = {
        charges_enabled: !!account.charges_enabled,
        payouts_enabled: !!account.payouts_enabled,
        details_submitted: !!account.details_submitted,
        requirements: account.requirements || {},
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    if (account.charges_enabled) patch.onboarded_at = new Date().toISOString();
    await supabase.from('payment_accounts').update(patch)
        .eq('entity_slug', slug).eq('provider', 'stripe');
}

/** The customer's confirmation. Best-effort: a failed email is not a failed sale. */
async function notifyCustomer(booking, product) {
    try {
        const entity = await entityBySlug(booking.entity_slug);
        const when = [booking.date, booking.start_time].filter(Boolean).join(' at ');
        const lines = [
            '<h2>You are booked</h2>',
            '<p>' + (booking.customer_name || '') + ', your booking with <strong>' +
                ((entity && entity.name) || booking.entity_slug) + '</strong> is confirmed.</p>',
            '<p><strong>' + (product.name || 'Booking') + '</strong><br>' + when +
                '<br>' + booking.party_size + ' guest' + (booking.party_size === 1 ? '' : 's') + '</p>',
            '<p>Confirmation: <strong>' + booking.confirmation_code + '</strong><br>',
            'Paid: $' + (booking.amount_paid || 0) +
                (Number(booking.balance_due) > 0 ? ' — $' + booking.balance_due + ' due on the day' : '') + '</p>',
            '<p><a href="' + manageUrl(booking.id) + '">View or cancel this booking</a></p>',
        ];
        if (booking.email) {
            const { sendEmail } = require('../utils/email');
            await sendEmail({
                to: booking.email,
                subject: 'Booking confirmed — ' + ((entity && entity.name) || 'your trip'),
                html: lines.join('\n'),
                replyTo: (entity && entity.email) || undefined,
            });
        }
        if (booking.phone) {
            const { sendSms } = require('../utils/sms');
            await sendSms(
                booking.phone,
                '[' + ((entity && entity.name) || 'Booking') + '] Confirmed for ' + when +
                '. Ref ' + booking.confirmation_code + '. Manage: ' + manageUrl(booking.id),
                booking.entity_slug, 'booking_confirmation', booking.id,
            );
        }
    } catch (err) {
        console.error('[booking] customer notification failed:', err.message);
    }
}

module.exports = router;
// Exported for scripts/test-booking-routes.js, which checks these two
// directly rather than only through a request.
module.exports.manageToken = manageToken;
module.exports.safeReturnUrl = safeReturnUrl;
