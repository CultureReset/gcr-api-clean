// ============================================================
// MODULAR PLATFORM API — keyed by the SLUG, backed by REAL tables.
// ============================================================
// Backs the modular dashboard (cybercheck-login/modular-dashboard.html)
// and the public pages (gcr-unified biz.html / book.html / manage.html).
//
// THE MODEL (do not deviate):
// - A business IS an `entity` row, resolved by entity.slug. The dashboard
//   attaches to it through `entity_owners` (user_id → entity_slug).
// - Which sections a business switched on lives in `entity_modules`
//   (entity_slug, module_key, enabled, settings, sort_order). The install
//   snapshot {manifest, config, showOnPublic} is stored in settings.
// - ONE universal booking: every booking-type app writes the same
//   `bookings` table; the unit (person/hour/half_day/day/night/item/
//   ticket) is DATA, never a separate table.
// - Catalog rows (trips, rooms, services, fleet, add-ons, gift cards,
//   memberships, products) are `offerings`; per-person prices are
//   `offering_prices`; discounts are `promos`.
// - Every date-claim from every source lives in `booking_calendar`
//   (direct, manual block, airbnb, fareharbor, ical, email:<x>) —
//   availability is computed from that one table.
// - Content streams write their REAL tables: entity_photos, faqs,
//   entity_specials, entity_events, menu_items, waivers, entity_reviews.
//   Anything without a purpose-built table lands in the generic section
//   store (entity_sections + entity_section_items.metadata) — still
//   slug-keyed, still queryable, still RAG-readable.
// ============================================================

const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function last10(p) {
    return String(p || '').replace(/\D/g, '').slice(-10);
}
// "6:00 AM" / "12:30 pm" → minutes since midnight; null if not a clock time
function slotMinutes(t) {
    const m = String(t || '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return h * 60 + (parseInt(m[2], 10) || 0);
}
// "6:00 AM" → "06:00:00" (a real postgres time) — display string stays in details
function slotToTime(t) {
    const mins = slotMinutes(t);
    if (mins == null) {
        const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
        return m ? (('0' + m[1]).slice(-2) + ':' + m[2] + ':00') : null;
    }
    return ('0' + Math.floor(mins / 60)).slice(-2) + ':' + ('0' + (mins % 60)).slice(-2) + ':00';
}
function calDate(v) {
    const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
}

// ============================================================
// IDENTITY — the business is an entity, the owner claims it once
// ============================================================
async function entityBySlug(slug) {
    if (!slug) return null;
    const { data } = await supabase.from('entity')
        .select('id, slug, name, entity_type, entity_subtype, subtitle, phone, email, icon, hero_image_url, logo_url, theme, city, seo_keywords, website_url, social_instagram, social_facebook, social_tiktok')
        .eq('slug', slug).maybeSingle();
    return data || null;
}
async function ownedSlug(req) {
    const { data } = await supabase.from('entity_owners')
        .select('entity_slug').eq('user_id', req.siteId).maybeSingle();
    return (data && data.entity_slug) || null;
}
function bizShape(ent) {
    if (!ent) return {};
    const theme = ent.theme || {};
    return {
        name: ent.name || '',
        slug: ent.slug,
        type: ent.entity_type || '',
        tagline: ent.subtitle || '',
        emoji: ent.icon || '🏪',
        phone: ent.phone || '',
        email: ent.email || '',
        accent: theme.accent || '#22c3a6',
        hero: ent.hero_image_url || null,
        logo: ent.logo_url || null,
        website: ent.website_url || null,
        instagram: ent.social_instagram || null,
        facebook: ent.social_facebook || null,
        tiktok: ent.social_tiktok || null
    };
}

// installed map — reconstructed from entity_modules rows that carry a
// platform install snapshot (settings.manifest). Pre-existing GCR module
// rows (no manifest) are never touched.
async function loadInstalled(slug) {
    const { data } = await supabase.from('entity_modules')
        .select('module_key, enabled, settings, sort_order')
        .eq('entity_slug', slug).limit(300);
    const installed = {};
    const ordered = [];
    (data || []).forEach(function (r) {
        const s = r.settings || {};
        if (!s.manifest) return; // not a platform install
        installed[r.module_key] = {
            enabled: r.enabled !== false,
            showOnPublic: s.showOnPublic !== false,
            manifest: s.manifest,
            config: s.config || {}
        };
        ordered.push({ key: r.module_key, sort: r.sort_order == null ? 999 : r.sort_order });
    });
    ordered.sort(function (a, b) { return a.sort - b.sort; });
    return { installed: installed, page_order: ordered.map(function (o) { return o.key; }) };
}

// ============================================================
// DATA DISPATCH — dataKey → the REAL slug-keyed table.
// Adapters keep the app-facing record shape (the manifests' field
// names) while storing canonical columns for querying + RAG.
// ============================================================
const BOOKING_KEYS = ['bookings', 'charter_trips', 'boat_rentals', 'lodging_bookings', 'class_bookings',
    'photo_sessions', 'salon_bookings', 'reservations', 'tour_tickets', 'ride_requests', 'orders', 'appointments'];
const OFFERING_KINDS = {
    services: 'service', fleet_items: 'fleet', properties: 'room', addons: 'addon',
    inventory: 'item', gift_cards: 'gift_card', memberships: 'membership', products: 'product'
};
function isBookingKey(k) { return BOOKING_KEYS.indexOf(k) !== -1; }

function toBookingRow(slug, record) {
    return {
        entity_slug: slug,
        customer_name: record.customer || record.name || null,
        phone: record.phone || record.customer_phone || null,
        email: record.email || null,
        date: calDate(record.date),
        end_date: calDate(record.end_date),
        start_time: slotToTime(record.time || record.departure),
        party_size: parseInt(record.party, 10) || parseInt(record.guests, 10) || null,
        adults: parseInt(record.adults, 10) || null,
        children: parseInt(record.children || record.kids, 10) || null,
        // total_price is the amount OWED — server-computed by computeCheckoutTotal()
        // for checkout apps (see /submit below), never taken from the client.
        // amount_paid is only ever set after Stripe confirms an actual charge.
        total_price: record.total_price != null ? parseFloat(record.total_price) : null,
        deposit_paid: parseFloat(record.deposit_paid) || null,
        status: record.status || 'pending',
        source: record.source || 'dashboard',
        offering_id: record.resource_id || null,
        qty: parseInt(record.qty, 10) || null,
        details: record
    };
}
function fromBookingRow(row) {
    const rec = Object.assign({}, row.details || {});
    rec._id = row.id;
    rec.status = row.status || rec.status;
    if (!rec.date && row.date) rec.date = row.date;
    return rec;
}

// Authoritative checkout price. Built ONLY from server-known values — owner-
// configured tier prices (bc.party.tiers), a fetched offering's real rates,
// and a validated promo — never from anything the client submitted in the
// request body. This is what /create-payment-intent charges; the client's
// own idea of the total is display-only and must never be trusted for money.
function computeCheckoutTotal(bc, record, resourceRow, nightCount, addonsTotal, promo) {
    let subtotal = 0;
    let priced = false;

    if (bc.party && Array.isArray(bc.party.tiers) && bc.party.tiers.length) {
        bc.party.tiers.forEach(function (t) {
            const qty = parseInt(record[t.key], 10) || 0;
            if (qty && t.price) { subtotal += qty * t.price; priced = true; }
        });
    }

    if (!priced && resourceRow) {
        const d = resourceRow.details || {};
        const rateNight = parseFloat(d.rate_night);
        const rateHourly = parseFloat(d.rate_hourly);
        const rateFull = parseFloat(d.rate_full) || parseFloat(resourceRow.price_from);
        const hours = parseFloat(record.hours);
        if (nightCount > 0 && !isNaN(rateNight)) {
            subtotal = rateNight * nightCount;
            priced = true;
        } else if (hours > 0 && !isNaN(rateHourly)) {
            subtotal = rateHourly * hours;
            priced = true;
        } else if (!isNaN(rateFull)) {
            subtotal = rateFull;
            priced = true;
        }
    }

    if (addonsTotal) { subtotal += addonsTotal; priced = true; }
    if (!priced) return null;

    if (promo) {
        if (promo.percent) subtotal = subtotal * (1 - promo.percent / 100);
        else if (promo.amount) subtotal = Math.max(0, subtotal - promo.amount);
    }

    return Math.max(0, Math.round(subtotal * 100) / 100);
}
function toOfferingRow(slug, dataKey, record, unit) {
    return {
        entity_slug: slug,
        section: dataKey,
        kind: OFFERING_KINDS[dataKey] || 'offering',
        name: record.name || record.item || record.title || 'Option',
        description: record.desc || record.description || null,
        unit: unit || record.per || record.unit || 'flat',
        price_from: parseFloat(record.price || record.rate_full || record.rate_night || record.rate_hourly) || null,
        capacity: parseInt(record.capacity || record.sleeps, 10) || null,
        // uploaded photos land in the record's url/image field — mirror to the
        // real image_url column so offering images actually display publicly
        image_url: (record.url && /^https?:/i.test(record.url) ? record.url : null) || record.image_url || record.image || null,
        active: !record.status || ['retired', 'maintenance', 'inactive'].indexOf(record.status) === -1,
        details: record
    };
}
function fromOfferingRow(row) {
    const rec = Object.assign({}, row.details || {});
    rec._id = row.id;
    return rec;
}

// generic section store: entity_sections(module_key=dataKey) holding
// entity_section_items with metadata = the full record. is_active=false
// keeps engine streams (scheduled_sms, logs) off the public page.
async function genericSection(slug, dataKey, displayable) {
    const { data: sec } = await supabase.from('entity_sections')
        .select('id').eq('entity_slug', slug).eq('module_key', dataKey).maybeSingle();
    if (sec) return sec.id;
    const { data: created, error } = await supabase.from('entity_sections')
        .insert({ entity_slug: slug, module_key: dataKey, section_type: 'app_data', section_name: dataKey.replace(/_/g, ' '), is_active: !!displayable, sort_order: 999 })
        .select('id').single();
    if (error) throw error;
    return created.id;
}
const ENGINE_KEYS = { scheduled_sms: 1, automation_log: 1, redemptions: 1 };

// ── RAG hook: content writes become ai_facts, so the concierge always
// knows the business's current offerings/specials/hours-adjacent data.
// Bookings (customer PII) and engine streams never become facts.
const RAG_SKIP = { bookings: 1, waivers: 1, photos: 1, blocks: 1, scheduled_sms: 1, automation_log: 1, redemptions: 1, ugc_videos: 1, leads: 1, automations: 1 };
async function ragFact(slug, dataKey, record) {
    try {
        if (RAG_SKIP[dataKey] || isBookingKey(dataKey)) return;
        const name = record.name || record.title || record.q || record.question || record.item || null;
        if (!name) return;
        const bits = [];
        if (record.price) bits.push('$' + String(record.price).replace(/^\$/, ''));
        if (record.desc || record.description) bits.push(record.desc || record.description);
        if (record.a || record.answer) bits.push(record.a || record.answer);
        if (record.days) bits.push('(' + record.days + ')');
        if (record.date) bits.push('on ' + record.date);
        const value = bits.join(' — ').slice(0, 500);
        const factKey = (dataKey + ':' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 120);
        const row = {
            entity_slug: slug,
            fact_key: factKey,
            fact_value: value || String(name),
            source_module: 'platform',
            module: dataKey,
            content: String(name) + (value ? ' — ' + value : '')
        };
        const { data: existing } = await supabase.from('ai_facts')
            .select('id').eq('entity_slug', slug).eq('fact_key', factKey).maybeSingle();
        if (existing) await supabase.from('ai_facts').update(row).eq('id', existing.id);
        else await supabase.from('ai_facts').insert(row);
    } catch (e) { console.error('[rag] fact upsert failed:', e.message); }
}

// insert a record for a dataKey → { id }
async function insertRecord(slug, dataKey, record) {
    ragFact(slug, dataKey, record).catch(function () {});
    if (isBookingKey(dataKey)) {
        const { data, error } = await supabase.from('bookings').insert(toBookingRow(slug, record)).select('id').single();
        if (error) throw error;
        return { id: data.id, table: 'bookings' };
    }
    if (OFFERING_KINDS[dataKey]) {
        const { data, error } = await supabase.from('offerings').insert(toOfferingRow(slug, dataKey, record)).select('id').single();
        if (error) throw error;
        return { id: data.id, table: 'offerings' };
    }
    switch (dataKey) {
        case 'photos': {
            const { data, error } = await supabase.from('entity_photos')
                .insert({ entity_slug: slug, url: record.url || null, caption: record.caption || null, photo_type: 'gallery' })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'entity_photos' };
        }
        case 'specials': {
            const { data, error } = await supabase.from('entity_specials')
                .insert({ entity_slug: slug, special_name: record.name || record.title || 'Special', description: record.desc || record.description || null, discount_text: record.price ? ('$' + record.price) : (record.off || null), days: record.days || null, is_active: true })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'entity_specials' };
        }
        case 'events': {
            const { data, error } = await supabase.from('entity_events')
                .insert({ entity_slug: slug, event_name: record.name || record.title || 'Event', description: record.desc || record.description || null, event_date: calDate(record.date), start_time: slotToTime(record.time), is_active: true })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'entity_events' };
        }
        case 'menu_items': {
            const { data, error } = await supabase.from('menu_items')
                .insert({ entity_slug: slug, item_name: record.name || record.item || 'Item', description: record.desc || record.description || null, price: parseFloat(record.price) || null, is_available: true })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'menu_items' };
        }
        case 'faqs': {
            const { data, error } = await supabase.from('faqs')
                .insert({ entity_slug: slug, question: record.q || record.question || '', answer: record.a || record.answer || '' })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'faqs' };
        }
        case 'waivers': {
            const { data, error } = await supabase.from('waivers')
                .insert({ entity_slug: slug, customer_name: record.customer || record.name || '', customer_phone: record.phone || null, waiver_text: record.booking || record.text || null, token: record.booking_ref || null, signed_at: new Date().toISOString() })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'waivers' };
        }
        case 'blocks': {
            const { data, error } = await supabase.from('booking_calendar')
                .insert({ entity_slug: slug, date: calDate(record.date) || new Date().toISOString().slice(0, 10), end_date: calDate(record.end_date), kind: 'block', source: 'manual', status: 'active', title: record.note || record.title || 'Blocked', details: record })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'booking_calendar' };
        }
        case 'coupons': {
            const off = String(record.off || '').trim();
            const pct = off.match(/^(\d+(?:\.\d+)?)\s*%$/);
            const amt = off.match(/^\$?\s*(\d+(?:\.\d+)?)$/);
            const { data, error } = await supabase.from('promos')
                .insert({ entity_slug: slug, code: record.code || null, type: pct ? 'percent' : 'amount', amount: pct ? parseFloat(pct[1]) : (amt ? parseFloat(amt[1]) : 0), ends: calDate(record.until), active: true })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'promos' };
        }
        case 'reviews': {
            const { data, error } = await supabase.from('entity_reviews')
                .insert({ entity_slug: slug, reviewer_name: record.name || 'Guest', rating: parseInt(record.stars, 10) || 0, body: record.text || '', verified_purchase: !!record.booking_id, approved: true })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'entity_reviews' };
        }
        default: {
            const secId = await genericSection(slug, dataKey, !ENGINE_KEYS[dataKey]);
            const { data, error } = await supabase.from('entity_section_items')
                .insert({ section_id: secId, entity_slug: slug, item_name: String(record.name || record.title || dataKey).slice(0, 200), metadata: record })
                .select('id').single();
            if (error) throw error;
            return { id: data.id, table: 'entity_section_items' };
        }
    }
}

// read one dataKey stream → array of app-shaped records (newest last)
async function readRecords(slug, dataKey, limit) {
    limit = limit || 500;
    if (isBookingKey(dataKey)) {
        const { data } = await supabase.from('bookings')
            .select('id, date, status, details').eq('entity_slug', slug)
            .order('created_at', { ascending: true }).limit(limit);
        return (data || []).map(fromBookingRow);
    }
    if (OFFERING_KINDS[dataKey]) {
        const { data } = await supabase.from('offerings')
            .select('id, details').eq('entity_slug', slug).eq('section', dataKey)
            .order('sort_order', { ascending: true }).limit(limit);
        return (data || []).map(fromOfferingRow);
    }
    switch (dataKey) {
        case 'photos': {
            const { data } = await supabase.from('entity_photos')
                .select('id, url, caption').eq('entity_slug', slug).order('sort_order', { ascending: true }).limit(limit);
            return (data || []).map(function (r) { return { _id: r.id, url: r.url, caption: r.caption || '' }; });
        }
        case 'specials': {
            const { data } = await supabase.from('entity_specials')
                .select('id, special_name, description, discount_text, days, is_active').eq('entity_slug', slug).limit(limit);
            return (data || []).filter(function (r) { return r.is_active !== false; })
                .map(function (r) { return { _id: r.id, name: r.special_name, desc: r.description || '', price: String(r.discount_text || '').replace(/^\$/, ''), days: r.days || '' }; });
        }
        case 'events': {
            const { data } = await supabase.from('entity_events')
                .select('id, event_name, description, event_date, start_time, is_active').eq('entity_slug', slug).limit(limit);
            return (data || []).filter(function (r) { return r.is_active !== false; })
                .map(function (r) { return { _id: r.id, name: r.event_name, title: r.event_name, desc: r.description || '', date: r.event_date, time: r.start_time }; });
        }
        case 'menu_items': {
            const { data } = await supabase.from('menu_items')
                .select('id, item_name, description, price, is_available').eq('entity_slug', slug).limit(Math.max(limit, 800));
            return (data || []).filter(function (r) { return r.is_available !== false; })
                .map(function (r) { return { _id: r.id, name: r.item_name, item: r.item_name, desc: r.description || '', price: r.price != null ? String(r.price) : '' }; });
        }
        case 'faqs': {
            const { data } = await supabase.from('faqs')
                .select('id, question, answer').eq('entity_slug', slug).order('sort_order', { ascending: true }).limit(limit);
            return (data || []).map(function (r) { return { _id: r.id, q: r.question, question: r.question, a: r.answer, answer: r.answer }; });
        }
        case 'waivers': {
            const { data } = await supabase.from('waivers')
                .select('id, customer_name, customer_phone, waiver_text, token, signed_at').eq('entity_slug', slug).limit(limit);
            return (data || []).map(function (r) { return { _id: r.id, customer: r.customer_name, phone: r.customer_phone, booking: r.waiver_text || '', booking_ref: r.token || '', date: (r.signed_at || '').slice(0, 10), status: 'signed' }; });
        }
        case 'blocks': {
            const { data } = await supabase.from('booking_calendar')
                .select('id, date, end_date, title, details').eq('entity_slug', slug).eq('kind', 'block').eq('status', 'active').limit(limit);
            return (data || []).map(function (r) { const rec = Object.assign({ kind: 'blocked' }, r.details || {}); rec._id = r.id; rec.date = rec.date || r.date; rec.note = rec.note || r.title; return rec; });
        }
        case 'coupons': {
            const { data } = await supabase.from('promos')
                .select('id, code, type, amount, ends, active').eq('entity_slug', slug).limit(limit);
            return (data || []).filter(function (r) { return r.active !== false; })
                .map(function (r) { return { _id: r.id, code: r.code, off: r.type === 'percent' ? (r.amount + '%') : ('$' + r.amount), until: r.ends || '' }; });
        }
        case 'reviews': {
            const { data } = await supabase.from('entity_reviews')
                .select('id, reviewer_name, rating, body, verified_purchase, created_at').eq('entity_slug', slug)
                .eq('approved', true).order('created_at', { ascending: false }).limit(limit);
            return (data || []).map(function (r) {
                return { _id: r.id, name: r.reviewer_name || 'Guest', stars: r.rating, text: r.body || '', badge: r.verified_purchase ? 'Verified Booking' : 'Unverified Opinion', when: r.created_at };
            });
        }
        default: {
            const { data: sec } = await supabase.from('entity_sections')
                .select('id').eq('entity_slug', slug).eq('module_key', dataKey).maybeSingle();
            if (!sec) return [];
            const { data } = await supabase.from('entity_section_items')
                .select('id, metadata').eq('section_id', sec.id).order('sort_order', { ascending: true }).limit(limit);
            return (data || []).map(function (r) { const rec = Object.assign({}, r.metadata || {}); rec._id = r.id; return rec; });
        }
    }
}

// update / delete a record by id within its stream
async function updateRecord(slug, dataKey, id, record) {
    ragFact(slug, dataKey, record).catch(function () {});
    if (isBookingKey(dataKey)) {
        const row = toBookingRow(slug, record); delete row.entity_slug;
        await supabase.from('bookings').update(row).eq('id', id).eq('entity_slug', slug);
        return 'bookings';
    }
    if (OFFERING_KINDS[dataKey]) {
        const row = toOfferingRow(slug, dataKey, record); delete row.entity_slug;
        row.updated_at = new Date().toISOString();
        await supabase.from('offerings').update(row).eq('id', id).eq('entity_slug', slug);
        return 'offerings';
    }
    switch (dataKey) {
        case 'photos':
            await supabase.from('entity_photos').update({ url: record.url, caption: record.caption || null }).eq('id', id).eq('entity_slug', slug); return 'entity_photos';
        case 'specials':
            await supabase.from('entity_specials').update({ special_name: record.name || 'Special', description: record.desc || null, discount_text: record.price ? ('$' + record.price) : null, days: record.days || null }).eq('id', id).eq('entity_slug', slug); return 'entity_specials';
        case 'events':
            await supabase.from('entity_events').update({ event_name: record.name || record.title || 'Event', description: record.desc || null, event_date: calDate(record.date), start_time: slotToTime(record.time) }).eq('id', id).eq('entity_slug', slug); return 'entity_events';
        case 'menu_items':
            await supabase.from('menu_items').update({ item_name: record.name || 'Item', description: record.desc || null, price: parseFloat(record.price) || null }).eq('id', id).eq('entity_slug', slug); return 'menu_items';
        case 'faqs':
            await supabase.from('faqs').update({ question: record.q || record.question || '', answer: record.a || record.answer || '' }).eq('id', id).eq('entity_slug', slug); return 'faqs';
        case 'coupons': {
            const off = String(record.off || '').trim();
            const pct = off.match(/^(\d+(?:\.\d+)?)\s*%$/);
            const amt = off.match(/^\$?\s*(\d+(?:\.\d+)?)$/);
            await supabase.from('promos').update({ code: record.code || null, type: pct ? 'percent' : 'amount', amount: pct ? parseFloat(pct[1]) : (amt ? parseFloat(amt[1]) : 0), ends: calDate(record.until) }).eq('id', id).eq('entity_slug', slug); return 'promos';
        }
        case 'blocks':
            await supabase.from('booking_calendar').update({ date: calDate(record.date) || undefined, end_date: calDate(record.end_date), title: record.note || record.title || 'Blocked', details: record, updated_at: new Date().toISOString() }).eq('id', id).eq('entity_slug', slug); return 'booking_calendar';
        default:
            await supabase.from('entity_section_items').update({ metadata: record, item_name: String(record.name || record.title || dataKey).slice(0, 200) }).eq('id', id).eq('entity_slug', slug); return 'entity_section_items';
    }
}
async function deleteRecord(slug, dataKey, id) {
    if (isBookingKey(dataKey)) { await supabase.from('bookings').delete().eq('id', id).eq('entity_slug', slug); return; }
    if (OFFERING_KINDS[dataKey]) { await supabase.from('offerings').delete().eq('id', id).eq('entity_slug', slug); return; }
    const t = { photos: 'entity_photos', specials: 'entity_specials', events: 'entity_events', menu_items: 'menu_items', faqs: 'faqs', coupons: 'promos', blocks: 'booking_calendar', waivers: 'waivers', reviews: 'entity_reviews' }[dataKey] || 'entity_section_items';
    await supabase.from(t).delete().eq('id', id).eq('entity_slug', slug);
}
// fetch a single booking (app-shaped) by id
async function bookingById(id) {
    const { data } = await supabase.from('bookings')
        .select('id, entity_slug, date, end_date, start_time, status, details, party_size, phone, email, customer_name, offering_id')
        .eq('id', id).maybeSingle();
    return data || null;
}

// ============================================================
// AUTOMATION ENGINE — manifest automations + text-built automations,
// both stored per-business (entity_modules), fired on real events.
// ============================================================
async function runAutomations(slug, dataKey, record, ctx) {
    try {
        let installed = ctx && ctx.installed;
        let business = ctx && ctx.business;
        if (!installed) { const st = await loadInstalled(slug); installed = st.installed; }
        if (!business) { business = bizShape(await entityBySlug(slug)); }
        const runs = [];
        Object.keys(installed).forEach(function (id) {
            const inst = installed[id];
            const man = inst && inst.manifest;
            if (!man || man.type !== 'automation' || !man.automation) return;
            if (inst.enabled === false) return;
            if (man.automation.trigger !== dataKey) return;
            const tpl = (inst.config && inst.config.template) || man.automation.template || '';
            const msg = tpl.replace(/\{(\w+)\}/g, function (_, k) {
                if (k === 'business') return business.name || 'our business';
                return record[k] != null ? String(record[k]) : '';
            });
            runs.push({ app: man.name, appId: id, action: man.automation.action, message: msg });
        });
        for (const run of runs) {
            if (run.action === 'sms') {
                try {
                    const { sendSms } = require('../utils/sms');
                    const to = record.phone || record.customer_phone || business.phone;
                    if (to) await sendSms(to, run.message, slug, 'automation', null);
                } catch (e) { console.error('automation sms failed:', e.message); }
            } else if (run.action === 'email') {
                try {
                    const { sendEmail } = require('../utils/email');
                    const to = record.email || business.email;
                    if (to) await sendEmail({ to: to, subject: (business.name || 'Update'), html: '<p>' + run.message + '</p>' });
                } catch (e) { console.error('automation email failed:', e.message); }
            }
            insertRecord(slug, 'automation_log', { when: new Date().toISOString(), app: run.app, appId: run.appId, action: run.action, message: run.message }).catch(function () {});
        }
    } catch (e) { console.error('runAutomations error:', e.message); }
}

// ============================================================
// STATE — the business's dashboard (business, installed, page order)
// ============================================================
router.get('/state', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.json({ business: { name: '', emoji: '🏪', accent: '#22c3a6', slug: '' }, installed: {}, page_order: [], fresh: true });
        const ent = await entityBySlug(slug);
        const st = await loadInstalled(slug);
        res.json({ business: bizShape(ent), installed: st.installed, page_order: st.page_order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/state', authRequired, async (req, res) => {
    try {
        const { business, installed, page_order } = req.body;
        const biz = business || {};
        let slug = await ownedSlug(req);

        if (!slug) {
            // first save = claim/create the entity for this owner
            slug = slugify(biz.slug || biz.name);
            if (!slug) return res.status(400).json({ error: 'Business name required' });
            let ent = await entityBySlug(slug);
            if (ent) {
                // slug taken: claimed by someone else → disambiguate; unclaimed → attach
                const { data: owner } = await supabase.from('entity_owners')
                    .select('user_id').eq('entity_slug', slug).maybeSingle();
                if (owner && owner.user_id !== req.siteId) {
                    slug = slug + '-' + String(req.siteId).replace(/-/g, '').slice(0, 4);
                    ent = null;
                }
            }
            if (!ent) {
                const { error } = await supabase.from('entity').insert({
                    slug: slug, name: biz.name || slug,
                    entity_type: (biz.type || 'service').toLowerCase(),
                    subtitle: biz.tagline || null, phone: biz.phone || null,
                    icon: biz.emoji || '🏪', is_active: true,
                    website_url: biz.website || null,
                    social_instagram: biz.instagram || null,
                    social_facebook: biz.facebook || null,
                    social_tiktok: biz.tiktok || null,
                    theme: { accent: biz.accent || '#22c3a6' }
                });
                if (error) throw error;
                ent = await entityBySlug(slug);
            }
            await supabase.from('entity_owners').insert({ user_id: req.siteId, entity_id: ent.id, entity_slug: slug, role: 'owner' });
        } else {
            // update the entity's own fields from the dashboard
            await supabase.from('entity').update({
                name: biz.name || undefined,
                subtitle: biz.tagline != null ? biz.tagline : undefined,
                phone: biz.phone != null ? biz.phone : undefined,
                icon: biz.emoji || undefined,
                theme: biz.accent ? { accent: biz.accent } : undefined,
                website_url: biz.website != null ? biz.website : undefined,
                social_instagram: biz.instagram != null ? biz.instagram : undefined,
                social_facebook: biz.facebook != null ? biz.facebook : undefined,
                social_tiktok: biz.tiktok != null ? biz.tiktok : undefined,
                updated_at: new Date().toISOString()
            }).eq('slug', slug);
        }

        // sync installs into entity_modules — only rows WE manage
        // (settings.manifest present). Pre-existing GCR module rows are
        // never modified or deleted.
        const want = installed || {};
        const order = page_order || Object.keys(want);
        const { data: existing } = await supabase.from('entity_modules')
            .select('id, module_key, settings').eq('entity_slug', slug).limit(300);
        const mine = {};
        (existing || []).forEach(function (r) { if ((r.settings || {}).manifest) mine[r.module_key] = r.id; });

        for (const key of Object.keys(want)) {
            const inst = want[key] || {};
            const row = {
                enabled: inst.enabled !== false,
                settings: { manifest: inst.manifest || {}, config: inst.config || {}, showOnPublic: inst.showOnPublic !== false },
                sort_order: order.indexOf(key) !== -1 ? order.indexOf(key) : 999
            };
            if (mine[key]) await supabase.from('entity_modules').update(row).eq('id', mine[key]);
            else await supabase.from('entity_modules').insert(Object.assign({ entity_slug: slug, module_key: key }, row));
        }
        for (const key of Object.keys(mine)) {
            if (!want[key]) await supabase.from('entity_modules').delete().eq('id', mine[key]);
        }

        res.json({ success: true, slug: slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// REGISTRY — the 69 file-based apps ARE the catalog for now.
// (A community registry returns as a slug-keyed table when needed.)
// ============================================================
router.get('/registry', async (_req, res) => {
    res.json([]); // static apps ship with the dashboard; nothing server-side yet
});
router.post('/registry', authRequired, async (_req, res) => {
    res.status(503).json({ error: 'Community publishing is being rebuilt on the new data model — coming back soon.' });
});
router.delete('/registry/:id', authRequired, async (_req, res) => {
    res.status(503).json({ error: 'Community publishing is being rebuilt on the new data model — coming back soon.' });
});

// ============================================================
// RECORDS — every app's data, in its REAL table
// ============================================================
const DASHBOARD_KEYS = ['bookings', 'photos', 'specials', 'events', 'menu_items', 'faqs', 'waivers', 'blocks',
    'coupons', 'reviews', 'services', 'fleet_items', 'properties', 'addons', 'inventory', 'gift_cards', 'memberships',
    'automations', 'leads', 'song_requests', 'reward_offers', 'ugc_videos', 'shoutouts', 'contributions',
    'loyalty_members', 'client_galleries', 'links', 'locations', 'steps', 'features', 'checklist_items', 'staff'];

router.get('/records', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.json({});
        // pull the streams the business actually uses (installed dataKeys) +
        // the core set, so the dashboard always sees its data
        const st = await loadInstalled(slug);
        const keys = {};
        DASHBOARD_KEYS.forEach(function (k) { keys[k] = 1; });
        Object.keys(st.installed).forEach(function (id) {
            const dk = (st.installed[id].manifest || {}).dataKey;
            if (dk) keys[dk] = 1;
        });
        const grouped = {};
        for (const k of Object.keys(keys)) {
            const rows = await readRecords(slug, k, 500);
            if (rows.length) grouped[k] = rows.reverse(); // newest first, like before
        }
        // text-built automations live in entity_modules — surface them so the
        // dashboard (and "list") can show them alongside everything else
        const autos = await loadUserAutomations(slug);
        if (autos.list.length) grouped.automations = autos.list.map(function (a, i) {
            return Object.assign({ _id: 'auto-' + i }, a);
        });
        res.json(grouped);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/records/:dataKey', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.status(400).json({ error: 'Set up your business first' });
        const record = req.body.record || {};
        const out = await insertRecord(slug, req.params.dataKey, record);
        runAutomations(slug, req.params.dataKey, record).catch(function () {});
        if (isBookingKey(req.params.dataKey)) calendarSyncBooking(slug, out.id, record).catch(function () {});
        res.json({ success: true, id: out.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/records/:dataKey/:id', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.status(400).json({ error: 'Set up your business first' });
        await updateRecord(slug, req.params.dataKey, req.params.id, req.body.record || {});
        if (isBookingKey(req.params.dataKey)) calendarSyncBooking(slug, req.params.id, req.body.record || {}).catch(function () {});
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/records/:dataKey/:id', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.status(400).json({ error: 'Set up your business first' });
        await deleteRecord(slug, req.params.dataKey, req.params.id);
        if (isBookingKey(req.params.dataKey)) {
            await supabase.from('booking_calendar').delete().eq('booking_id', req.params.id);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Image upload: any business, any app — base64 in, public URL out. ──
router.post('/upload', authRequired, async (req, res) => {
    try {
        const b64 = String(req.body.image || '');
        const mime = String(req.body.mime || 'image/jpeg').slice(0, 40);
        if (!b64) return res.status(400).json({ error: 'image (base64) required' });
        if (b64.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Image too large — keep it under ~6MB' });
        if (!/^image\//.test(mime)) return res.status(400).json({ error: 'Only images can be uploaded' });
        const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg';
        const slug = (await ownedSlug(req)) || 'unclaimed';
        const fileName = 'platform/' + slug + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        const buffer = Buffer.from(b64, 'base64');
        const { error } = await supabase.storage.from('entity-media')
            .upload(fileName, buffer, { contentType: mime, upsert: false });
        if (error) throw new Error(error.message);
        const { data } = supabase.storage.from('entity-media').getPublicUrl(fileName);
        res.json({ success: true, url: data.publicUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// BOOKING CALENDAR — every date-claim, one slug-keyed table.
// A date taken on ANY platform blocks the direct checkout too.
// ============================================================
async function calendarSyncBooking(slug, bookingId, record) {
    try {
        const date = calDate(record.date);
        if (!date) return;
        const cancelled = ['cancelled', 'declined', 'no-show'].indexOf(record.status) !== -1;
        const entry = {
            entity_slug: slug,
            date: date,
            end_date: calDate(record.end_date),
            start_time: slotToTime(record.time || record.departure),
            kind: 'booking',
            source: record.source === 'public_page' ? 'direct' : 'manual',
            status: cancelled ? 'cancelled' : 'active',
            title: record.service || record.trip || record.boat || record.session || record.item || record.title || (record.customer || 'booking'),
            party: parseInt(record.party || record.guests || record.adults, 10) || null,
            offering_id: record.resource_id || null,
            booking_id: bookingId,
            details: record,
            updated_at: new Date().toISOString()
        };
        const { data: existing } = await supabase.from('booking_calendar')
            .select('id').eq('booking_id', bookingId).maybeSingle();
        if (existing) await supabase.from('booking_calendar').update(entry).eq('id', existing.id);
        else await supabase.from('booking_calendar').insert(entry);
    } catch (e) { console.error('[calendar] sync failed:', e.message); }
}

// ── Self-serve booking management: HMAC-signed links, no login needed ──
const crypto = require('crypto');
function manageToken(recordId) {
    const secret = process.env.JWT_SECRET || process.env.SUPABASE_KEY || 'cc-manage';
    return crypto.createHmac('sha256', secret).update('manage:' + String(recordId)).digest('hex').slice(0, 24);
}
function manageTokenOk(recordId, t) {
    try { return crypto.timingSafeEqual(Buffer.from(manageToken(recordId)), Buffer.from(String(t || ''))); }
    catch (e) { return false; }
}
function publicBase() {
    return (process.env.PUBLIC_PAGE_BASE_URL || 'https://gulfcoastradar.com').replace(/\/$/, '');
}
function instByDataKey(installed, dataKey) {
    let hit = null;
    Object.keys(installed || {}).forEach(function (id) {
        const inst = installed[id];
        if (inst && inst.manifest && inst.manifest.dataKey === dataKey && inst.enabled !== false) hit = { id: id, inst: inst };
    });
    return hit;
}
function waiverApp(installed) {
    let hit = null;
    Object.keys(installed || {}).forEach(function (id) {
        const inst = installed[id];
        const man = inst && inst.manifest;
        if (man && inst.enabled !== false && (man.provides === 'waivers' || man.dataKey === 'waivers')) hit = inst;
    });
    return hit;
}
function bookingStart(record) {
    if (!record || !record.date) return null;
    const mins = slotMinutes(record.time || record.departure || '');
    return new Date(new Date(record.date + 'T00:00:00Z').getTime() + (mins == null ? 0 : mins * 60e3));
}

// ── Booking behavior comes from the app's manifest + install config ──
function bookingCfg(inst) {
    const man = (inst && inst.manifest) || {};
    const cfg = (inst && inst.config) || {};
    const b = man.booking || {};
    const slots = String(cfg.slot_times || b.slots || '')
        .split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    let party = null;
    if (b.party && Array.isArray(b.party.tiers) && b.party.tiers.length) {
        party = {
            seats: b.party.seats !== false,
            tiers: b.party.tiers.map(function (t) {
                const cfgKey = t.cfgPrice || ('price_' + t.key);
                const p = parseFloat(cfg[cfgKey]);
                return { key: t.key, label: t.label || t.key, price: isNaN(p) ? (parseFloat(t.def) || 0) : p };
            })
        };
    }
    return {
        mode: b.mode || 'date',
        slots: slots,
        slotCap: parseInt(cfg.slot_capacity, 10) || parseInt(b.slot_capacity, 10) || 1,
        resourceKey: b.resource || null,
        party: party,
        addonsKey: b.addons || null,
        // respect an explicit 0 (owner turned the cutoff off)
        cutoffHours: (function () {
            const raw = (cfg.cutoff_hours != null && cfg.cutoff_hours !== '') ? cfg.cutoff_hours
                : (b.cutoff_hours != null ? b.cutoff_hours : 0);
            const n = parseFloat(raw);
            return isNaN(n) ? 0 : n;
        })(),
        maxParty: parseInt(cfg.max_party, 10) || parseInt(b.max_party, 10) || 0
    };
}

function cutoffEarliest(hours) { return hours > 0 ? new Date(Date.now() + hours * 3600e3) : null; }
function dateEndsBefore(ds, when) { return when && new Date(ds + 'T23:59:59Z') < when; }
function slotPast(ds, t, when) {
    if (!when) return false;
    const mins = slotMinutes(t);
    if (mins == null) return dateEndsBefore(ds, when);
    return new Date(ds + 'T00:00:00Z').getTime() + mins * 60e3 < when.getTime();
}

async function getAvailability(slug, installed, month, opts) {
    opts = opts || {};
    // ONE source of truth: booking_calendar.
    const { data: entries } = await supabase.from('booking_calendar')
        .select('date, end_date, kind, status, start_time, party, offering_id, details')
        .eq('entity_slug', slug).eq('status', 'active').limit(3000);

    let capacity = null;
    Object.keys(installed || {}).forEach(function (id) {
        const inst = installed[id];
        if (inst && inst.manifest && inst.manifest.dataKey === 'blocks' && inst.config && inst.config.capacity) {
            const c = parseInt(inst.config.capacity, 10);
            if (c > 0) capacity = c;
        }
    });

    const blocked = [];
    const counts = {};
    function eachDate(e, fn) {
        const start = new Date(e.date + 'T00:00:00Z');
        const end = e.end_date ? new Date(e.end_date + 'T00:00:00Z') : start;
        for (let d = new Date(start), i = 0; d <= end && i < 60; d.setUTCDate(d.getUTCDate() + 1), i++) {
            fn(d.toISOString().slice(0, 10));
        }
    }
    const slotCounts = {};   // 'date|display time' -> seats used
    const resourceBusy = {}; // date -> [offering_id, ...]
    (entries || []).forEach(function (e) {
        const rec = e.details || {};
        if (e.kind === 'block') eachDate(e, function (ds) { if (blocked.indexOf(ds) === -1) blocked.push(ds); });
        else eachDate(e, function (ds) {
            counts[ds] = (counts[ds] || 0) + 1;
            const t = rec.time || e.start_time;
            if (t) slotCounts[ds + '|' + t] = (slotCounts[ds + '|' + t] || 0) + (parseInt(e.party || rec.party, 10) || 1);
            const rid = e.offering_id || rec.resource_id;
            if (rid) {
                if (!resourceBusy[ds]) resourceBusy[ds] = [];
                if (resourceBusy[ds].indexOf(String(rid)) === -1) resourceBusy[ds].push(String(rid));
            }
        });
    });
    let full = capacity ? Object.keys(counts).filter(function (d) { return counts[d] >= capacity; }) : [];
    let b = blocked;

    if (opts.resource) {
        Object.keys(resourceBusy).forEach(function (ds) {
            if (resourceBusy[ds].indexOf(String(opts.resource)) !== -1 && b.indexOf(ds) === -1) b = b.concat([ds]);
        });
    }
    let slots = null;
    const earliest = cutoffEarliest(opts.cutoffHours);
    if (opts.slots && opts.slots.length && opts.date) {
        slots = opts.slots.map(function (t) {
            let used = slotCounts[opts.date + '|' + t] || 0;
            if (opts.resource) {
                used = (entries || []).some(function (e) {
                    const rec = e.details || {};
                    return e.kind !== 'block' && e.date === opts.date &&
                        (rec.time || e.start_time) === t && String(e.offering_id || rec.resource_id || '') === String(opts.resource);
                }) ? opts.slotCap : used;
            }
            let remaining = Math.max(0, (opts.slotCap || 1) - used);
            if (slotPast(opts.date, t, earliest)) remaining = 0;
            return { time: t, remaining: remaining };
        });
    }
    if (earliest) {
        const todayIsh = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
        [0, 1, 2, 3].forEach(function (i) {
            const d = new Date(new Date(todayIsh + 'T00:00:00Z').getTime() + i * 86400e3).toISOString().slice(0, 10);
            if (dateEndsBefore(d, earliest) && b.indexOf(d) === -1) b = b.concat([d]);
        });
    }
    if (month) {
        b = b.filter(function (d) { return d.slice(0, 7) === month; });
        full = full.filter(function (d) { return d.slice(0, 7) === month; });
    }
    return { blocked: b, full: full, capacity: capacity, counts: counts, slots: slots };
}

// Owner's calendar — every source, one view
router.get('/calendar', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.json({ entries: [] });
        let q = supabase.from('booking_calendar')
            .select('id, date, end_date, start_time, kind, source, status, title, party, booking_id, external_uid, details')
            .eq('entity_slug', slug).order('date', { ascending: true }).limit(2000);
        if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
            const m = req.query.month;
            const lastD = new Date(Date.UTC(parseInt(m.slice(0, 4), 10), parseInt(m.slice(5, 7), 10), 0)).toISOString().slice(0, 10);
            q = q.gte('date', m + '-01').lte('date', lastD);
        }
        const { data: entries } = await q;
        // the dashboard reads e.ref_id + e.record — keep those names
        res.json({ entries: (entries || []).map(function (e) {
            e.ref_id = e.booking_id; e.record = e.details; return e;
        }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// External sources push normalized entries here (email parser, FareHarbor,
// iCal, manual imports). Upserts on (source, external_uid): no duplicates.
router.post('/calendar/import', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.status(400).json({ error: 'Set up your business first' });
        const entries = Array.isArray(req.body.entries) ? req.body.entries : [req.body];
        let imported = 0, skipped = 0;
        for (const e of entries.slice(0, 500)) {
            const date = calDate(e.date);
            const source = String(e.source || '').slice(0, 60);
            const uid = String(e.external_uid || '').slice(0, 120);
            if (!date || !source || !uid) { skipped++; continue; }
            const row = {
                entity_slug: slug,
                date: date,
                end_date: calDate(e.end_date),
                start_time: slotToTime(e.start_time),
                end_time: slotToTime(e.end_time),
                kind: e.kind === 'block' ? 'block' : 'booking',
                source: source,
                status: e.status === 'cancelled' ? 'cancelled' : 'active',
                title: e.title ? String(e.title).slice(0, 200) : source,
                party: parseInt(e.party, 10) || null,
                external_uid: uid,
                details: e.record || {},
                updated_at: new Date().toISOString()
            };
            const { data: existing } = await supabase.from('booking_calendar')
                .select('id').eq('entity_slug', slug).eq('source', source).eq('external_uid', uid).maybeSingle();
            if (existing) await supabase.from('booking_calendar').update(row).eq('id', existing.id);
            else await supabase.from('booking_calendar').insert(row);
            imported++;
        }
        res.json({ success: true, imported: imported, skipped: skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/page/:slug/availability', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Page not found' });
        const st = await loadInstalled(ent.slug);
        const inst = st.installed[req.query.app];
        const bc = bookingCfg(inst);
        const avail = await getAvailability(ent.slug, st.installed, req.query.month, {
            resource: req.query.resource || null,
            date: req.query.date || null,
            slots: bc.slots, slotCap: bc.slotCap, cutoffHours: bc.cutoffHours
        });
        avail.mode = bc.mode;
        res.json(avail);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Owner one-tap status change: confirm / decline / complete ──
router.post('/records/:dataKey/:id/status', authRequired, async (req, res) => {
    try {
        const slug = await ownedSlug(req);
        if (!slug) return res.status(400).json({ error: 'Set up your business first' });
        const status = String(req.body.status || '');
        if (!status) return res.status(400).json({ error: 'status required' });
        const row = await bookingById(req.params.id);
        if (!row || row.entity_slug !== slug) return res.status(404).json({ error: 'Not found' });

        const record = row.details || {};
        record.status = status;
        await supabase.from('bookings')
            .update({ status: status, details: record })
            .eq('id', req.params.id).eq('entity_slug', slug);
        calendarSyncBooking(slug, req.params.id, record).catch(function () {});
        if (status === 'completed' || status === 'cancelled') {
            record._mid = req.params.id;
            runUserAutomations(slug, status, record).catch(function () {});
        }

        const ent = await entityBySlug(slug);
        const biz = bizShape(ent);
        const st = await loadInstalled(slug);

        // notify the customer
        const phone = record.phone || record.customer_phone;
        if (phone) {
            try {
                const bizName = biz.name || 'the business';
                const { sendSms } = require('../utils/sms');
                let msg = null;
                if (req.params.dataKey === 'ugc_videos') msg = null;
                else if (status === 'confirmed') {
                    msg = '[' + bizName + '] You\'re confirmed' + (record.date ? ' for ' + record.date : '') + (record.time ? ' at ' + record.time : '') + '. See you then!';
                    const owner = instByDataKey(st.installed, req.params.dataKey);
                    const bcOwn = owner ? bookingCfg(owner.inst) : null;
                    if (record.date && bcOwn && bcOwn.mode !== 'none') {
                        msg += ' Change plans? ' + publicBase() + '/manage/' + req.params.id + '?t=' + manageToken(req.params.id);
                        if (waiverApp(st.installed)) {
                            msg += ' · Sign your waiver: ' + publicBase() + '/waiver/' + slug + '?b=' + req.params.id + '&t=' + manageToken(req.params.id);
                        }
                    }
                }
                else if (status === 'declined' || status === 'cancelled') msg = '[' + bizName + '] Sorry — we couldn\'t take your request' + (record.date ? ' for ' + record.date : '') + '. Reply here and we\'ll find another time.';
                else if (status === 'completed') {
                    const rbase = (process.env.REVIEW_BASE_URL || process.env.PUBLIC_PAGE_BASE_URL || 'https://gulfcoastradar.com').replace(/\/$/, '');
                    const link = rbase + '/r/' + slug + '?t=' + req.params.id;
                    msg = '[' + bizName + '] Thanks for coming out' + (record.customer || record.name ? ', ' + (record.customer || record.name) : '') + '! How was it? Leave a quick review: ' + link + ' — it really helps us.';
                }
                if (msg) await sendSms(phone, msg, slug, 'status_' + status, req.params.id);
            } catch (e) { console.error('status sms failed:', e.message); }
        }

        // ── co-op loyalty hooks (fire-and-forget) ──
        (async () => {
            try {
                const custPhone = record.phone || record.customer_phone;
                const bizName = biz.name || 'the business';
                const { sendSms } = require('../utils/sms');
                if (req.params.dataKey === 'ugc_videos' && status === 'confirmed') {
                    const uploader = await touristByPhone(custPhone);
                    if (uploader) {
                        const pts = await platformAward(uploader.user_id, 'video', slug);
                        if (pts && custPhone) await sendSms(custPhone, '[' + bizName + '] Your video was approved — +' + pts + ' points! 🎥', slug, 'points_video', req.params.id);
                    }
                } else if (status === 'completed') {
                    const customer = await touristByPhone(custPhone);
                    if (customer) {
                        const pts = await platformAward(customer.user_id, 'booking_completed', slug);
                        if (pts && custPhone) await sendSms(custPhone, '[' + bizName + '] +' + pts + ' points added to your Gulf Perks wallet! 🎁', slug, 'points_booking', req.params.id);
                    }
                    if (record.ref) {
                        const { data: refT } = await supabase.from('tourist_profiles')
                            .select('user_id, phone').eq('ref_code', record.ref).maybeSingle();
                        const same = refT && last10(refT.phone) === last10(custPhone);
                        if (refT && !same) {
                            const pts = await platformAward(refT.user_id, 'referral', slug);
                            if (pts && refT.phone) await sendSms(refT.phone, 'Someone booked through your link at ' + bizName + ' — +' + pts + ' points! 🤝', slug, 'points_referral', req.params.id);
                        }
                    }
                }
            } catch (e) { console.error('[loyalty] hook error:', e.message); }
        })();

        res.json({ success: true, status: status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CO-OP LOYALTY — the ledger lives in cyber check's own
// tourist_points / points_config (they were always there).
// ============================================================
const POINT_DEFAULTS = { booking_completed: 100, referral: 200, video: 100, review: 50 };

async function platformAward(userId, reason, slug) {
    if (!userId || !reason) return 0;
    try {
        const { data: cfg } = await supabase.from('points_config').select('earn').eq('id', 1).maybeSingle();
        const delta = parseInt((cfg && cfg.earn && cfg.earn[reason]) != null ? cfg.earn[reason] : POINT_DEFAULTS[reason], 10) || 0;
        if (!delta) return 0;
        await supabase.from('tourist_points').insert({ user_id: userId, delta: delta, reason: reason, entity_slug: slug || null });
        return delta;
    } catch (e) { console.error('[loyalty] award failed:', e.message); return 0; }
}

async function touristByPhone(phone) {
    const p = last10(phone);
    if (p.length < 10) return null;
    for (const candidate of ['+1' + p, p, '1' + p]) {
        const { data } = await supabase.from('tourist_profiles')
            .select('user_id, phone, ref_code, share_enabled, name')
            .eq('phone', candidate).maybeSingle();
        if (data) return data;
    }
    return null;
}

// ============================================================
// TOURIST WALLET — matched by verified phone (the identity anchor)
// ============================================================
async function touristAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    try {
        const { data, error } = await supabase.auth.getUser(header.split(' ')[1]);
        if (error || !data || !data.user) return res.status(401).json({ error: 'Invalid token' });
        req.touristId = data.user.id;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

router.get('/my-bookings', touristAuth, async (req, res) => {
    try {
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('phone').eq('user_id', req.touristId).maybeSingle();
        const phone = last10(prof && prof.phone);
        if (!phone || phone.length < 10) return res.json({ bookings: [] });

        const { data: rows } = await supabase.from('bookings')
            .select('id, entity_slug, date, start_time, status, party_size, phone, created_at, details')
            .order('created_at', { ascending: false }).limit(2000);
        const mine = (rows || []).filter(function (r) {
            return last10(r.phone || (r.details || {}).phone) === phone;
        });
        if (!mine.length) return res.json({ bookings: [] });

        const slugs = [];
        mine.forEach(function (r) { if (slugs.indexOf(r.entity_slug) === -1) slugs.push(r.entity_slug); });
        const { data: ents } = await supabase.from('entity').select('slug, name').in('slug', slugs);
        const nameMap = {};
        (ents || []).forEach(function (e) { nameMap[e.slug] = e.name; });

        res.json({ bookings: mine.map(function (r) {
            const rec = r.details || {};
            return {
                id: r.id,
                when: r.created_at,
                stream: 'bookings',
                business: nameMap[r.entity_slug] || 'Business',
                slug: r.entity_slug,
                title: rec.service || rec.trip || rec.boat || rec.session || rec.item || rec.title || 'Booking',
                date: r.date || rec.date || null,
                time: rec.time || rec.departure || null,
                party: r.party_size || rec.party || rec.guests || null,
                status: r.status || rec.status || null,
                amount_paid: rec.amount_paid || null
            };
        }) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Share & earnings: every tourist is a referrer ──
router.get('/my-share', touristAuth, async (req, res) => {
    try {
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('ref_code, share_enabled, name').eq('user_id', req.touristId).maybeSingle();
        if (!prof) return res.status(404).json({ error: 'No profile' });
        let code = prof.ref_code;
        if (!code) {
            const base = String(prof.name || 'GC').replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase() || 'GC';
            code = base + Math.random().toString(36).slice(2, 6).toUpperCase();
            const { error } = await supabase.from('tourist_profiles')
                .update({ ref_code: code }).eq('user_id', req.touristId);
            if (error) {
                code = base + Math.random().toString(36).slice(2, 8).toUpperCase();
                await supabase.from('tourist_profiles').update({ ref_code: code }).eq('user_id', req.touristId);
            }
        }
        const { data: hist } = await supabase.from('tourist_points')
            .select('delta, reason, entity_slug, created_at')
            .eq('user_id', req.touristId)
            .order('created_at', { ascending: false }).limit(100);
        res.json({ ref_code: code, share_enabled: !!prof.share_enabled, earnings: hist || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/my-share', touristAuth, async (req, res) => {
    try {
        await supabase.from('tourist_profiles')
            .update({ share_enabled: !!req.body.share_enabled }).eq('user_id', req.touristId);
        res.json({ success: true, share_enabled: !!req.body.share_enabled });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Guest videos: attach to a COMPLETED booking you own → moderation → points ──
router.post('/my/videos', touristAuth, async (req, res) => {
    try {
        const { booking_id, url } = req.body;
        if (!booking_id || !url || !/^https?:/i.test(url)) {
            return res.status(400).json({ error: 'booking_id and a valid video URL are required' });
        }
        const b = await bookingById(booking_id);
        if (!b) return res.status(404).json({ error: 'Booking not found' });
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('phone').eq('user_id', req.touristId).maybeSingle();
        const mine = prof && last10(prof.phone) === last10(b.phone || (b.details || {}).phone);
        if (!mine) return res.status(403).json({ error: 'That booking is not yours' });
        if ((b.status || (b.details || {}).status) !== 'completed') {
            return res.status(400).json({ error: 'Videos can be added once the trip is completed' });
        }
        await insertRecord(b.entity_slug, 'ugc_videos', { url: String(url).slice(0, 500), booking_id: booking_id, phone: prof.phone, status: 'pending', source: 'tourist' });
        res.json({ success: true, status: 'pending', note: 'Points are awarded when the business approves it' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rewards: business-funded offers; redemption debits the ledger ──
router.get('/rewards/:slug', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Not found' });
        const offers = await readRecords(ent.slug, 'reward_offers', 50);
        res.json({
            business: ent.name || '',
            offers: offers.map(function (o) {
                return { id: o._id, title: o.title || '', points: parseInt(o.points, 10) || 0, detail: o.detail || '' };
            }).filter(function (o) { return o.title && o.points > 0; })
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/redeem', touristAuth, async (req, res) => {
    try {
        const { data: item } = await supabase.from('entity_section_items')
            .select('id, entity_slug, metadata').eq('id', req.body.offer_id).maybeSingle();
        const offer = item && item.metadata;
        if (!offer || !(parseInt(offer.points, 10) > 0)) return res.status(404).json({ error: 'Offer not found' });
        const cost = parseInt(offer.points, 10);
        const { data: rows } = await supabase.from('tourist_points').select('delta').eq('user_id', req.touristId);
        const balance = (rows || []).reduce(function (sum, r) { return sum + (r.delta || 0); }, 0);
        if (balance < cost) return res.status(400).json({ error: 'Not enough points — you have ' + balance + ', this needs ' + cost });
        const code = 'GC-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        await supabase.from('tourist_points').insert({
            user_id: req.touristId, delta: -cost, reason: 'redeem', entity_slug: item.entity_slug
        });
        await insertRecord(item.entity_slug, 'redemptions', { code: code, offer: offer.title, points: cost, status: 'issued' });
        res.json({ success: true, code: code, offer: offer.title, points: cost });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Public user share page: only what they chose to share ──
router.get('/u/:code', async (req, res) => {
    try {
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('name, ref_code, share_enabled, phone')
            .eq('ref_code', req.params.code).maybeSingle();
        if (!prof || !prof.share_enabled) return res.status(404).json({ error: 'Page not found' });
        const phone = last10(prof.phone);
        const { data: rows } = await supabase.from('bookings')
            .select('entity_slug, phone, status, details')
            .eq('status', 'completed').limit(2000);
        const slugs = [];
        (rows || []).forEach(function (r) {
            if (last10(r.phone || (r.details || {}).phone) === phone && slugs.indexOf(r.entity_slug) === -1) slugs.push(r.entity_slug);
        });
        let businesses = [];
        if (slugs.length) {
            const { data: ents } = await supabase.from('entity')
                .select('name, slug, icon, subtitle').in('slug', slugs);
            businesses = (ents || []).map(function (e) {
                return { name: e.name, slug: e.slug, emoji: e.icon || '🏪', tagline: e.subtitle || '' };
            });
        }
        res.json({ name: String(prof.name || 'A Gulf Coast local').split(' ')[0], ref_code: prof.ref_code, businesses: businesses });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// CYBERCHECK REVIEWS — verified reviews live in entity_reviews,
// the SAME table the directory's 10,444 real reviews live in.
// A review token IS a completed booking id.
// ============================================================
router.get('/review-token/:id', async (req, res) => {
    try {
        const b = await bookingById(req.params.id);
        if (!b || (b.status || (b.details || {}).status) !== 'completed') {
            return res.status(404).json({ valid: false, error: 'This review link is not valid.' });
        }
        if ((b.details || {}).reviewed) {
            return res.status(409).json({ valid: false, error: 'A review was already left for this booking — thank you!' });
        }
        const ent = await entityBySlug(b.entity_slug);
        const biz = bizShape(ent);
        const rec = b.details || {};
        res.json({
            valid: true,
            business: { name: biz.name || '', slug: biz.slug || '', emoji: biz.emoji || '🏪', accent: biz.accent || '#22c3a6' },
            title: rec.service || rec.trip || rec.boat || rec.session || rec.item || 'your visit',
            date: b.date || rec.date || null,
            reviewer: String(rec.customer || rec.name || '').split(' ')[0] || '',
            badge: 'Verified Booking'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/reviews', async (req, res) => {
    try {
        const { token, stars, text, name } = req.body;
        const rating = parseInt(stars, 10);
        if (!token || !rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'A rating between 1 and 5 is required.' });
        }
        const b = await bookingById(token);
        if (!b || (b.status || (b.details || {}).status) !== 'completed') {
            return res.status(404).json({ error: 'This review link is not valid.' });
        }
        const rec = b.details || {};
        if (rec.reviewed) return res.status(409).json({ error: 'A review was already left for this booking.' });

        const reviewerName = String(name || rec.customer || rec.name || 'Verified guest').slice(0, 80);
        const { error } = await supabase.from('entity_reviews').insert({
            entity_slug: b.entity_slug,
            reviewer_name: reviewerName,
            rating: rating,
            body: String(text || '').slice(0, 2000),
            verified_purchase: true,
            approved: true
        });
        if (error) throw error;
        rec.reviewed = new Date().toISOString();
        await supabase.from('bookings').update({ details: rec }).eq('id', b.id);

        let pointsAwarded = 0;
        const reviewer = await touristByPhone(rec.phone || rec.customer_phone || b.phone);
        if (reviewer) pointsAwarded = await platformAward(reviewer.user_id, 'review', b.entity_slug);

        res.json({ success: true, badge: 'Verified Booking', points: pointsAwarded });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public review wall (feeds the embeddable widget) — REAL reviews
router.get('/reviews/:slug', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Not found' });
        const { data: rows } = await supabase.from('entity_reviews')
            .select('reviewer_name, rating, body, verified_purchase, created_at')
            .eq('entity_slug', ent.slug).eq('approved', true)
            .order('created_at', { ascending: false }).limit(200);
        const reviews = (rows || []).map(function (r) {
            return {
                name: r.reviewer_name || 'Guest',
                stars: r.rating || 0,
                text: r.body || '',
                badge: r.verified_purchase ? 'Verified Booking' : 'Unverified Opinion',
                when: r.created_at
            };
        }).filter(function (r) { return r.stars > 0; });
        const avg = reviews.length ? reviews.reduce(function (s, r) { return s + r.stars; }, 0) / reviews.length : 0;
        const biz = bizShape(ent);
        res.json({
            business: { name: biz.name || '', slug: biz.slug || '', emoji: biz.emoji || '🏪', tagline: biz.tagline || '', accent: biz.accent || '#22c3a6' },
            average: Math.round(avg * 10) / 10,
            count: reviews.length,
            verified_count: reviews.filter(function (r) { return r.badge === 'Verified Booking'; }).length,
            reviews: reviews
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// PUBLIC PAGE — one URL per business, rendered from installed blocks
// ============================================================
router.get('/page/:slug', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Page not found' });
        const st = await loadInstalled(ent.slug);
        const installed = st.installed;
        const order = st.page_order.filter(function (id) {
            const inst = installed[id];
            return inst && inst.enabled !== false && inst.showOnPublic && inst.manifest && inst.manifest.block;
        });

        // publicData: only streams whose manifest says publicData:true
        const publicKeys = [];
        order.forEach(function (id) {
            const man = installed[id].manifest;
            if (man.publicData && man.dataKey && publicKeys.indexOf(man.dataKey) === -1) publicKeys.push(man.dataKey);
            if (man.cart && man.cart.source && publicKeys.indexOf(man.cart.source) === -1) publicKeys.push(man.cart.source);
        });
        const publicData = {};
        for (const k of publicKeys) {
            const rows = await readRecords(ent.slug, k, 500);
            if (rows.length) publicData[k] = rows.map(function (r) { const c = Object.assign({}, r); delete c._id; return c; });
        }

        const blocks = [];
        for (const id of order) {
            const inst = installed[id];
            const man = inst.manifest;
            const cfg = inst.config || {};
            const bc = bookingCfg(inst);
            const block = {
                id: id,
                icon: man.icon || '📦',
                title: cfg.label || man.block.title || man.name,
                sub: man.block.sub || '',
                url: cfg.url || null,
                dataKey: man.dataKey || null,
                publicData: !!man.publicData,
                checkout: !!man.checkout,
                booking: man.checkout ? { mode: bc.mode, slots: bc.slots, resource: bc.resourceKey, party: bc.party, maxParty: bc.maxParty || undefined } : undefined,
                cart: man.cart || undefined,
                section: man.section || undefined,
                content: man.section ? cfg : undefined,
                fields: (man.fields || []).filter(function (f) { return f.key !== 'status'; })
                    .map(function (f) {
                        if (!f.optionsFrom) return f;
                        var raw = cfg[f.optionsFrom] != null ? cfg[f.optionsFrom] : '';
                        if (!raw) {
                            var sd = (man.setup || []).filter(function (s) { return s.key === f.optionsFrom; })[0];
                            raw = (sd && sd.def) || '';
                        }
                        var opts = String(raw).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
                        var out = {}; Object.keys(f).forEach(function (k) { out[k] = f[k]; });
                        out.options = opts;
                        return out;
                    })
            };
            // upsells: the add-ons this checkout offers (offerings kind=addon)
            if (man.checkout && bc.addonsKey) {
                const ax = await readRecords(ent.slug, bc.addonsKey, 30);
                block.addons = ax.map(function (rec) {
                    if (!rec.name || !(parseFloat(rec.price) > 0)) return null;
                    return { id: rec._id, name: rec.name, price: parseFloat(rec.price), per: rec.per || 'booking', desc: rec.desc || '', url: rec.url && /^https?:/i.test(rec.url) ? rec.url : null };
                }).filter(Boolean);
            }
            // resource-linked checkout: pickable resources = offerings
            if (man.checkout && bc.resourceKey) {
                const rs = await readRecords(ent.slug, bc.resourceKey, 50);
                block.resources = rs.map(function (rec) {
                    if (rec.status && ['retired', 'maintenance', 'inactive'].indexOf(rec.status) !== -1) return null;
                    return {
                        id: rec._id,
                        name: rec.name || rec.item || 'Option',
                        desc: [rec.type, rec.sleeps ? 'sleeps ' + rec.sleeps : null, rec.capacity ? 'up to ' + rec.capacity : null, rec.role].filter(Boolean).join(' · '),
                        url: rec.url && /^https?:/i.test(rec.url) ? rec.url : null,
                        rate_hourly: parseFloat(rec.rate_hourly) || null,
                        rate_full: parseFloat(rec.rate_full) || null,
                        rate_night: parseFloat(rec.rate_night) || null
                    };
                }).filter(Boolean);
                // owner-defined per-offering price tiers (offering_prices —
                // adult/kid/senior/under-2-free, seasonal, age-ranged) override
                // the manifest's fixed tiers for that offering at checkout
                if (block.resources.length) {
                    const ids = block.resources.map(function (r) { return r.id; });
                    const { data: tierRows } = await supabase.from('offering_prices')
                        .select('id, offering_id, label, price, age_min, age_max, season, duration_label, sort_order')
                        .eq('entity_slug', ent.slug).in('offering_id', ids).order('sort_order');
                    const byOffering = {};
                    (tierRows || []).forEach(function (t) {
                        (byOffering[t.offering_id] = byOffering[t.offering_id] || []).push({
                            id: t.id, label: t.label, price: parseFloat(t.price) || 0,
                            age_min: t.age_min, age_max: t.age_max, season: t.season || null,
                            duration_label: t.duration_label || null
                        });
                    });
                    block.resources.forEach(function (r) { if (byOffering[r.id]) r.tiers = byOffering[r.id]; });
                }
            }
            blocks.push(block);
        }

        let payment = null;
        let seo = null;
        Object.keys(installed).forEach(function (id) {
            const inst = installed[id];
            const man = inst && inst.manifest;
            if (!man || inst.enabled === false) return;
            if (man.provides === 'payments' || man.id === 'payments') {
                const cfg = inst.config || {};
                if (cfg.mode && cfg.mode !== 'No payment (pay on site)') {
                    payment = { mode: cfg.mode, deposit: parseFloat(cfg.deposit) || 0 };
                }
            }
            if (man.provides === 'seo' || man.id === 'seo') {
                seo = inst.config || {};
            }
        });

        res.json({
            business: bizShape(ent),
            site_id: ent.slug, // legacy field name; the slug IS the id now
            payment: payment,
            seo: seo,
            blocks: blocks,
            data: publicData
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── promo codes — the promos table, slug-keyed ──
async function findPromo(slug, code) {
    if (!code) return null;
    const { data: recs } = await supabase.from('promos')
        .select('id, code, type, amount, starts, ends, active')
        .eq('entity_slug', slug).eq('active', true).limit(200);
    const today = new Date().toISOString().slice(0, 10);
    const hit = (recs || []).filter(function (r) {
        if (String(r.code || '').trim().toLowerCase() !== String(code).trim().toLowerCase()) return false;
        if (r.ends && r.ends < today) return false;
        if (r.starts && r.starts > today) return false;
        return true;
    })[0];
    if (!hit) return null;
    return {
        code: hit.code,
        off: hit.type === 'percent' ? (hit.amount + '%') : ('$' + hit.amount),
        percent: hit.type === 'percent' ? parseFloat(hit.amount) : null,
        amount: hit.type !== 'percent' ? parseFloat(hit.amount) : null
    };
}
router.get('/page/:slug/promo/:code', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Page not found' });
        const promo = await findPromo(ent.slug, req.params.code);
        if (!promo) return res.status(404).json({ valid: false, error: 'That code isn\'t valid.' });
        res.json({ valid: true, code: promo.code, off: promo.off, percent: promo.percent, amount: promo.amount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public form submission — a booking, lead, song request, etc.
router.post('/page/:slug/submit/:appId', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Page not found' });
        const st = await loadInstalled(ent.slug);
        const inst = st.installed[req.params.appId];
        if (!inst || inst.enabled === false || !inst.manifest || !inst.manifest.dataKey) {
            return res.status(400).json({ error: 'This form is not accepting submissions' });
        }

        const record = {};
        const allowed = (inst.manifest.fields || []).map(function (f) { return f.key; });
        allowed.forEach(function (k) {
            if (req.body[k] != null) record[k] = String(req.body[k]).slice(0, 2000);
        });
        record.source = 'public_page';
        record.status = record.status || 'pending';
        if (req.body.ref) {
            const code = String(req.body.ref).slice(0, 24);
            const { data: refT } = await supabase.from('tourist_profiles')
                .select('user_id').eq('ref_code', code).maybeSingle();
            if (refT) record.ref = code;
        }
        if (req.body.payment_intent_id) record.payment_id = String(req.body.payment_intent_id).slice(0, 100);
        // informational only — NEVER used as the authoritative price, see computeCheckoutTotal() below
        if (req.body.amount_paid) record.amount_paid = String(req.body.amount_paid).slice(0, 20);

        const bc = bookingCfg(inst);
        // resource = an offering row
        let resourceRow = null;
        if (req.body.resource_id && bc.resourceKey) {
            const { data: rr } = await supabase.from('offerings')
                .select('id, name, capacity, details, price_from').eq('id', String(req.body.resource_id))
                .eq('entity_slug', ent.slug).maybeSingle();
            if (rr) {
                resourceRow = rr;
                record.resource_id = rr.id;
                record.resource = rr.name || (rr.details || {}).name || '';
            }
        }
        if (bc.mode === 'range' && req.body.end_date) {
            const ed = String(req.body.end_date).match(/^\d{4}-\d{2}-\d{2}/);
            if (ed) record.end_date = ed[0];
        }
        if (bc.mode === 'slots' && req.body.time) record.time = String(req.body.time).slice(0, 40);

        // owner-defined offering_prices tiers (adult/kid/senior/under-2-free…)
        // — quantities arrive as tier_qty: { <offering_price_id>: qty }. Each
        // id is validated against the DB scoped to this entity (and to the
        // selected offering when there is one); prices come from the DB rows,
        // never the client. When present these take priority over the
        // manifest's fixed party tiers.
        let dbTierTotal = null;
        if (req.body.tier_qty && typeof req.body.tier_qty === 'object') {
            const ids = Object.keys(req.body.tier_qty).slice(0, 20);
            if (ids.length) {
                let tq = supabase.from('offering_prices')
                    .select('id, label, price, offering_id')
                    .eq('entity_slug', ent.slug).in('id', ids);
                const { data: tierRows } = await tq;
                const valid = (tierRows || []).filter(function (t) {
                    return !record.resource_id || String(t.offering_id) === String(record.resource_id);
                });
                if (valid.length) {
                    let people = 0, money = 0;
                    const parts = [];
                    valid.forEach(function (t) {
                        const q = Math.max(0, Math.min(99, parseInt(req.body.tier_qty[t.id], 10) || 0));
                        if (!q) return;
                        people += q;
                        money += q * (parseFloat(t.price) || 0);
                        parts.push(q + '× ' + (t.label || 'Guest'));
                    });
                    if (people > 0) {
                        record.party = people;
                        record.tier_breakdown = parts.join(', ');
                        dbTierTotal = Math.round(money * 100) / 100;
                    }
                }
            }
        }

        // per-person tiers → seats (manifest-config tiers; skipped when
        // owner-defined DB tiers already set the party above)
        if (bc.party && !record.party) {
            let total = 0;
            bc.party.tiers.forEach(function (t) {
                const q = Math.max(0, Math.min(99, parseInt(req.body[t.key], 10) || 0));
                if (q) record[t.key] = String(q);
                total += q;
            });
            if (total < 1) return res.status(400).json({ error: 'Please add at least one person.' });
            record.party = total;
        }
        const partySize = record.party || Math.max(0, parseInt(record.guests, 10) || 0) || 1;
        if (bc.maxParty && partySize > bc.maxParty) {
            return res.status(400).json({ error: 'Maximum party size is ' + bc.maxParty + '.' });
        }

        // add-ons: only real offering rows count
        if (bc.addonsKey && Array.isArray(req.body.addons) && req.body.addons.length) {
            const ax = await readRecords(ent.slug, bc.addonsKey, 50);
            const picked = ax.filter(function (a) {
                return req.body.addons.map(String).indexOf(String(a._id)) !== -1;
            });
            if (picked.length) {
                let addonTotal = 0;
                const names = picked.map(function (rec) {
                    const p = parseFloat(rec.price) || 0;
                    const mult = rec.per === 'person' ? partySize
                        : (rec.per === 'day' && record.end_date)
                            ? Math.max(1, Math.round((new Date(record.end_date) - new Date(record.date)) / 86400e3))
                            : 1;
                    addonTotal += p * mult;
                    return rec.name;
                });
                record.addons = names.join(', ');
                record.addons_total = addonTotal.toFixed(2);
            }
        }

        // promo: only stored if it's a real, unexpired code
        let appliedPromo = null;
        if (req.body.promo) {
            appliedPromo = await findPromo(ent.slug, req.body.promo);
            if (appliedPromo) { record.promo = appliedPromo.code; record.promo_off = appliedPromo.off; }
        }

        // availability enforcement
        let nightCount = 0;
        if (record.date && bc.mode !== 'none') {
            const earliest = cutoffEarliest(bc.cutoffHours);
            if (earliest) {
                const tooLate = bc.mode === 'slots'
                    ? slotPast(record.date, record.time || '', earliest)
                    : dateEndsBefore(record.date, earliest);
                if (tooLate) return res.status(409).json({ error: 'Online booking closes ' + bc.cutoffHours + ' hours before start — call the business to squeeze in.' });
            }
            const avail = await getAvailability(ent.slug, st.installed, null, {
                resource: record.resource_id || null,
                date: record.date,
                slots: bc.slots, slotCap: bc.slotCap
            });
            const nights = [];
            {
                const start = new Date(record.date + 'T00:00:00Z');
                const end = record.end_date ? new Date(record.end_date + 'T00:00:00Z') : start;
                for (let d = new Date(start), i = 0; d <= end && i < 60; d.setUTCDate(d.getUTCDate() + 1), i++) {
                    nights.push(d.toISOString().slice(0, 10));
                }
            }
            nightCount = Math.max(0, nights.length - (record.end_date ? 1 : 0));
            for (const ds of nights) {
                if (avail.blocked.indexOf(ds) !== -1) {
                    return res.status(409).json({ error: (record.resource ? record.resource + ' is' : 'That date is') + ' unavailable on ' + ds + ' — please pick different dates.' });
                }
                if (avail.full.indexOf(ds) !== -1) {
                    return res.status(409).json({ error: ds + ' is fully booked — please pick different dates.' });
                }
            }
            if (bc.mode === 'slots') {
                if (!record.time || bc.slots.indexOf(record.time) === -1) {
                    return res.status(400).json({ error: 'Please pick a time.' });
                }
                const slot = (avail.slots || []).filter(function (x) { return x.time === record.time; })[0];
                const need = (bc.party && bc.party.seats) ? partySize : 1;
                if (!slot || slot.remaining < need) {
                    const left = slot ? slot.remaining : 0;
                    return res.status(409).json({ error: left > 0
                        ? 'Only ' + left + ' spot' + (left > 1 ? 's' : '') + ' left at ' + record.time + ' — reduce your party or pick another time.'
                        : record.time + ' is fully booked — please pick another time.' });
                }
            }
        }

        // resource limits: capacity + minimum nights from the offering itself
        if (resourceRow && bc.resourceKey) {
            const rrec = resourceRow.details || {};
            const cap = resourceRow.capacity || parseInt(rrec.capacity, 10) || parseInt(rrec.sleeps, 10) || 0;
            if (cap && partySize > cap) {
                return res.status(400).json({ error: record.resource + ' fits up to ' + cap + ' — your party of ' + partySize + ' won\'t fit. Pick a bigger option.' });
            }
            const minN = parseInt(rrec.min_nights, 10) || 0;
            if (minN && bc.mode === 'range' && record.end_date) {
                const n = Math.max(1, Math.round((new Date(record.end_date) - new Date(record.date)) / 86400e3));
                if (n < minN) return res.status(400).json({ error: record.resource + ' has a ' + minN + '-night minimum stay.' });
            }
        }

        // Authoritative price. Built server-side ONLY — see computeCheckoutTotal().
        // This, not anything the client sent, is what /create-payment-intent charges.
        // Owner-defined offering_prices tiers (dbTierTotal) take priority over the
        // manifest's fixed tier prices; add-ons and promo apply on top either way.
        if (inst.manifest.checkout) {
            const addonsTotal = parseFloat(record.addons_total) || 0;
            let computed;
            if (dbTierTotal != null) {
                let subtotal = dbTierTotal + addonsTotal;
                if (appliedPromo) {
                    if (appliedPromo.percent) subtotal = subtotal * (1 - appliedPromo.percent / 100);
                    else if (appliedPromo.amount) subtotal = Math.max(0, subtotal - appliedPromo.amount);
                }
                computed = Math.max(0, Math.round(subtotal * 100) / 100);
            } else {
                computed = computeCheckoutTotal(bc, record, resourceRow, nightCount, addonsTotal, appliedPromo);
            }
            if (computed != null) record.total_price = computed.toFixed(2);
        }

        // checkout submissions land in the ONE bookings table; content
        // submissions (song requests, leads) land in their own stream.
        const dataKey = inst.manifest.checkout ? 'bookings' : inst.manifest.dataKey;
        const inserted = await insertRecord(ent.slug, dataKey, record);

        runAutomations(ent.slug, inst.manifest.dataKey, record, { installed: st.installed, business: bizShape(ent) }).catch(function () {});
        if (inst.manifest.checkout) {
            record._mid = inserted.id;
            runUserAutomations(ent.slug, 'new_booking', record).catch(function () {});
        }
        if (inst.manifest.checkout && bc.mode !== 'none') calendarSyncBooking(ent.slug, inserted.id, record).catch(function () {});

        // Notify the owner by SMS
        try {
            const bizPhone = ent.phone;
            if (bizPhone) {
                const { sendSms } = require('../utils/sms');
                const summary = allowed.slice(0, 4).map(function (k) { return record[k]; }).filter(Boolean).join(' · ');
                await sendSms(bizPhone, '[' + (ent.name || 'Your page') + '] New ' + (inst.manifest.name || 'submission') + ': ' + summary, ent.slug, 'platform_lead', null);
            }
        } catch (e) { console.error('owner sms failed:', e.message); }

        // id is required by callers that proceed to payment
        // (POST /api/stripe/create-payment-intent expects booking_id).
        res.json({ success: true, id: inserted.id, total_price: record.total_price || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// SELF-SERVE MANAGE — cancel / reschedule via the SMS link
// ============================================================
async function loadManaged(req, res) {
    const row = await bookingById(req.params.id);
    if (!row) { res.status(404).json({ error: 'Booking not found' }); return null; }
    if (!manageTokenOk(row.id, req.query.t || req.body.t)) { res.status(403).json({ error: 'Bad link' }); return null; }
    const ent = await entityBySlug(row.entity_slug);
    const st = await loadInstalled(row.entity_slug);
    // which installed app owns bookings? (any checkout app)
    let owner = null;
    Object.keys(st.installed).forEach(function (id) {
        const inst = st.installed[id];
        if (inst && inst.manifest && inst.manifest.checkout && inst.enabled !== false) owner = { id: id, inst: inst };
    });
    return { row: row, ent: ent, installed: st.installed, owner: owner, bc: owner ? bookingCfg(owner.inst) : bookingCfg(null) };
}
function cancelWindow(owner) {
    const cfg = (owner && owner.inst && owner.inst.config) || {};
    const man = (owner && owner.inst && owner.inst.manifest) || {};
    const h = parseFloat(cfg.cancel_hours);
    if (!isNaN(h)) return h;
    const mh = parseFloat((man.booking || {}).cancel_hours);
    return isNaN(mh) ? 24 : mh;
}
function canModify(record, owner) {
    if (['cancelled', 'declined', 'completed', 'no-show'].indexOf(record.status || '') !== -1) return false;
    const start = bookingStart(record);
    if (!start) return false;
    return start.getTime() - Date.now() > cancelWindow(owner) * 3600e3;
}

router.get('/manage/:id', async (req, res) => {
    try {
        const ctx = await loadManaged(req, res); if (!ctx) return;
        const rec = Object.assign({}, ctx.row.details || {}, { status: ctx.row.status || (ctx.row.details || {}).status });
        const biz = bizShape(ctx.ent);
        res.json({
            business: { name: biz.name, slug: biz.slug, phone: biz.phone, accent: biz.accent, emoji: biz.emoji, logo: biz.logo, hero: biz.hero },
            appId: ctx.owner ? ctx.owner.id : null,
            mode: ctx.bc.mode,
            slots: ctx.bc.slots,
            seats: !!(ctx.bc.party && ctx.bc.party.seats),
            booking: {
                customer: rec.customer || rec.name || '', date: rec.date || ctx.row.date || null, end_date: rec.end_date || null,
                time: rec.time || null, party: rec.party || rec.guests || null, resource: rec.resource || null,
                addons: rec.addons || null, status: rec.status || 'pending', title: rec.service || rec.trip || rec.boat || rec.class || ''
            },
            canModify: canModify(rec, ctx.owner),
            cancelHours: cancelWindow(ctx.owner)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/manage/:id/cancel', async (req, res) => {
    try {
        const ctx = await loadManaged(req, res); if (!ctx) return;
        const rec = Object.assign({}, ctx.row.details || {}, { status: ctx.row.status || (ctx.row.details || {}).status });
        if (!canModify(rec, ctx.owner)) {
            return res.status(409).json({ error: 'This booking can no longer be cancelled online (' + cancelWindow(ctx.owner) + 'h policy). Call the business instead.' });
        }
        rec.status = 'cancelled';
        rec.cancelled_by = 'guest';
        await supabase.from('bookings').update({ status: 'cancelled', details: rec }).eq('id', ctx.row.id);
        calendarSyncBooking(ctx.row.entity_slug, ctx.row.id, rec).catch(function () {});
        const biz = bizShape(ctx.ent);
        try {
            const { sendSms } = require('../utils/sms');
            if (biz.phone) await sendSms(biz.phone, '[' + (biz.name || 'Your page') + '] ' + (rec.customer || rec.name || 'A guest') + ' cancelled ' + (rec.date || '') + (rec.time ? ' ' + rec.time : '') + ' — the spot is open again.', ctx.row.entity_slug, 'guest_cancel', ctx.row.id);
            const gp = rec.phone || rec.customer_phone;
            if (gp) await sendSms(gp, '[' + (biz.name || '') + '] Your booking' + (rec.date ? ' for ' + rec.date : '') + ' is cancelled. Book again any time: ' + publicBase() + '/p/' + (biz.slug || ''), ctx.row.entity_slug, 'guest_cancel_ack', ctx.row.id);
        } catch (e) { console.error('cancel sms failed:', e.message); }
        res.json({ success: true, status: 'cancelled' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/manage/:id/reschedule', async (req, res) => {
    try {
        const ctx = await loadManaged(req, res); if (!ctx) return;
        const rec = Object.assign({}, ctx.row.details || {}, { status: ctx.row.status || (ctx.row.details || {}).status });
        if (!canModify(rec, ctx.owner)) {
            return res.status(409).json({ error: 'This booking can no longer be changed online (' + cancelWindow(ctx.owner) + 'h policy). Call the business instead.' });
        }
        const nd = String(req.body.date || '').match(/^\d{4}-\d{2}-\d{2}$/);
        if (!nd) return res.status(400).json({ error: 'Pick a new date.' });
        const bc = ctx.bc;
        if (bc.mode === 'slots' && (!req.body.time || bc.slots.indexOf(req.body.time) === -1)) {
            return res.status(400).json({ error: 'Pick a new time.' });
        }
        // the booking's own calendar entry must not block its own move
        await supabase.from('booking_calendar').delete().eq('booking_id', ctx.row.id);
        const avail = await getAvailability(ctx.row.entity_slug, ctx.installed, null, {
            resource: rec.resource_id || null, date: nd[0],
            slots: bc.slots, slotCap: bc.slotCap, cutoffHours: bc.cutoffHours
        });
        const need = (bc.party && bc.party.seats) ? (parseInt(rec.party, 10) || 1) : 1;
        let conflict = null;
        const newEnd = bc.mode === 'range' && req.body.end_date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.end_date) ? req.body.end_date : null;
        const span = [];
        {
            const start = new Date(nd[0] + 'T00:00:00Z');
            const end = newEnd ? new Date(newEnd + 'T00:00:00Z') : start;
            for (let d = new Date(start), i = 0; d <= end && i < 60; d.setUTCDate(d.getUTCDate() + 1), i++) span.push(d.toISOString().slice(0, 10));
        }
        for (const ds of span) {
            if (avail.blocked.indexOf(ds) !== -1) conflict = ds + ' is unavailable.';
            else if (avail.full.indexOf(ds) !== -1) conflict = ds + ' is fully booked.';
            if (conflict) break;
        }
        if (!conflict && bc.mode === 'slots') {
            const slot = (avail.slots || []).filter(function (x) { return x.time === req.body.time; })[0];
            if (!slot || slot.remaining < need) conflict = req.body.time + ' doesn\'t have room.';
        }
        if (conflict) {
            calendarSyncBooking(ctx.row.entity_slug, ctx.row.id, rec).catch(function () {}); // restore
            return res.status(409).json({ error: conflict + ' Pick something else.' });
        }
        const oldWhen = (rec.date || '') + (rec.time ? ' ' + rec.time : '');
        rec.date = nd[0];
        if (newEnd) rec.end_date = newEnd;
        if (bc.mode === 'slots') rec.time = req.body.time;
        rec.rescheduled = 'guest';
        await supabase.from('bookings').update({
            date: rec.date, end_date: rec.end_date || null,
            start_time: slotToTime(rec.time), details: rec
        }).eq('id', ctx.row.id);
        calendarSyncBooking(ctx.row.entity_slug, ctx.row.id, rec).catch(function () {});
        const biz = bizShape(ctx.ent);
        try {
            const { sendSms } = require('../utils/sms');
            if (biz.phone) await sendSms(biz.phone, '[' + (biz.name || 'Your page') + '] ' + (rec.customer || 'A guest') + ' moved ' + oldWhen + ' → ' + rec.date + (rec.time ? ' ' + rec.time : ''), ctx.row.entity_slug, 'guest_reschedule', ctx.row.id);
        } catch (e) { console.error('reschedule sms failed:', e.message); }
        res.json({ success: true, date: rec.date, end_date: rec.end_date || null, time: rec.time || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// WAIVERS — signed from the SMS link, stored in the waivers table
// ============================================================
router.get('/waiver-info/:slug', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Page not found' });
        const st = await loadInstalled(ent.slug);
        const wapp = waiverApp(st.installed);
        if (!wapp) return res.status(404).json({ error: 'This business doesn\'t use digital waivers.' });
        if (!req.query.b || !manageTokenOk(req.query.b, req.query.t)) return res.status(403).json({ error: 'Bad link' });
        const bk = await bookingById(String(req.query.b));
        const rec = (bk && bk.details) || {};
        const { data: signed } = await supabase.from('waivers')
            .select('id').eq('entity_slug', ent.slug).eq('token', String(req.query.b)).maybeSingle();
        res.json({
            business: { name: ent.name, accent: (ent.theme || {}).accent },
            text: (wapp.config || {}).text || ((wapp.manifest.setup || []).filter(function (s) { return s.key === 'text'; })[0] || {}).def || 'I acknowledge the risks involved and release the business from liability.',
            booking: { customer: rec.customer || rec.name || '', date: rec.date || (bk && bk.date) || null, time: rec.time || null, title: rec.service || rec.trip || rec.boat || rec.class || '' },
            signed: !!signed
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/waiver-sign/:slug', async (req, res) => {
    try {
        const ent = await entityBySlug(req.params.slug);
        if (!ent) return res.status(404).json({ error: 'Page not found' });
        const st = await loadInstalled(ent.slug);
        const wapp = waiverApp(st.installed);
        if (!wapp) return res.status(404).json({ error: 'No waivers here.' });
        if (!req.body.b || !manageTokenOk(req.body.b, req.body.t)) return res.status(403).json({ error: 'Bad link' });
        const name = String(req.body.name || '').trim().slice(0, 120);
        if (!name) return res.status(400).json({ error: 'Type your full legal name to sign.' });
        const bk = await bookingById(String(req.body.b));
        const rec = (bk && bk.details) || {};
        await supabase.from('waivers').insert({
            entity_slug: ent.slug,
            customer_name: name,
            customer_phone: rec.phone || rec.customer_phone || null,
            waiver_text: [rec.service || rec.trip || rec.boat || rec.class, rec.date, rec.time].filter(Boolean).join(' · ') || 'Booking',
            token: String(req.body.b),
            signed_at: new Date().toISOString()
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TIMED REMINDERS — Vercel cron hits this hourly.
// ============================================================
router.get('/cron/reminders', async (req, res) => {
    try {
        if (process.env.CRON_SECRET && (req.headers.authorization || '') !== 'Bearer ' + process.env.CRON_SECRET) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
        const { data: entries } = await supabase.from('booking_calendar')
            .select('id, entity_slug, date, start_time, title, booking_id, details')
            .eq('date', tomorrow).eq('status', 'active').eq('kind', 'booking').limit(500);
        let sent = 0;
        const bySlug = {};
        (entries || []).forEach(function (e) { (bySlug[e.entity_slug] = bySlug[e.entity_slug] || []).push(e); });
        for (const slug of Object.keys(bySlug)) {
            const ent = await entityBySlug(slug);
            if (!ent) continue;
            const st = await loadInstalled(slug);
            let template = null;
            Object.keys(st.installed).forEach(function (id) {
                const inst = st.installed[id];
                const man = inst && inst.manifest;
                if (man && inst.enabled !== false && man.automation && man.automation.trigger === 'before_start_24h') {
                    template = (inst.config && inst.config.template) || man.automation.template ||
                        '[{business}] Reminder: {title} tomorrow{time}. See you then!';
                }
            });
            const { sendSms } = require('../utils/sms');
            // text-built 'before_24h' automations also fire
            for (const e of bySlug[slug]) {
                const rec = e.details || {};
                if (rec._user_reminded || ['cancelled', 'declined', 'no-show'].indexOf(rec.status || '') !== -1) continue;
                if (!(rec.phone || rec.customer_phone)) continue;
                rec._mid = e.booking_id;
                await runUserAutomations(slug, 'before_24h', rec);
            }
            if (!template) continue;
            for (const e of bySlug[slug]) {
                const rec = e.details || {};
                if (rec.reminded) continue;
                const phone = rec.phone || rec.customer_phone;
                if (!phone) continue;
                if (['cancelled', 'declined', 'no-show'].indexOf(rec.status || '') !== -1) continue;
                const msg = template
                    .replace(/\{business\}/g, ent.name || 'Your booking')
                    .replace(/\{name\}/g, rec.customer || rec.name || 'there')
                    .replace(/\{title\}/g, e.title || 'your booking')
                    .replace(/\{date\}/g, e.date)
                    .replace(/\{time\}/g, rec.time ? ' at ' + rec.time : '')
                    .replace(/\{manage\}/g, publicBase() + '/manage/' + e.booking_id + '?t=' + manageToken(e.booking_id));
                try {
                    await sendSms(phone, msg, slug, 'reminder_24h', e.booking_id);
                    rec.reminded = new Date().toISOString().slice(0, 10);
                    if (e.booking_id) await supabase.from('bookings').update({ details: rec }).eq('id', e.booking_id);
                    await supabase.from('booking_calendar').update({ details: rec }).eq('id', e.id);
                    sent++;
                    if (sent >= 200) break;
                } catch (err2) { console.error('[reminders] send failed:', err2.message); }
            }
            if (sent >= 200) break;
        }

        // drain due delayed sends (the 'wait' steps of text-built automations)
        let drained = 0;
        const nowIso = new Date().toISOString();
        const { data: due } = await supabase.from('entity_section_items')
            .select('id, entity_slug, metadata')
            .not('metadata->>send_at', 'is', null)
            .eq('metadata->>status', 'pending').limit(300);
        for (const row of (due || [])) {
            const r = row.metadata || {};
            if (r.status !== 'pending' || !r.send_at || r.send_at > nowIso) continue;
            try {
                const { sendSms } = require('../utils/sms');
                if (r.to) await sendSms(r.to, r.body, row.entity_slug, 'automation_delayed', null);
                r.status = 'sent'; r.sent_at = nowIso;
                await supabase.from('entity_section_items').update({ metadata: r }).eq('id', row.id);
                drained++;
            } catch (e) { console.error('[scheduled_sms] send failed:', e.message); }
        }

        res.json({ success: true, sent: sent, drained: drained, date: tomorrow });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TEXT-YOUR-DASHBOARD — a business owner texts one number and,
// in plain English, creates automations, posts content, or asks.
// The business IS an entity: matched by entity.phone.
// ============================================================
async function businessByPhone(phone) {
    const p10 = last10(phone);
    if (!p10) return null;
    const { data } = await supabase.from('entity')
        .select('slug, name, phone').not('phone', 'is', null).limit(4000);
    return (data || []).find(function (r) {
        return last10(r.phone) === p10;
    }) || null;
}

function renderTpl(tpl, record, business) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (_, k) {
        if (k === 'business') return (business && business.name) || 'our business';
        if (k === 'title') return record.service || record.trip || record.class || record.title || 'your booking';
        if (k === 'time') return record.time ? ' at ' + record.time : '';
        if (k === 'manage') return publicBase() + '/manage/' + (record._mid || '') + '?t=' + manageToken(record._mid || '');
        return record[k] != null ? String(record[k]) : '';
    });
}

// Deterministic natural-language command parser (AI layer optional)
function parseBusinessCommand(text) {
    const t = String(text || '').trim();
    const low = t.toLowerCase();
    if (!t) return { action: 'help' };
    if (/^(help|\?|commands|what can you do)/.test(low)) return { action: 'help' };
    if (/^(list|my automations|show automations)/.test(low)) return { action: 'list' };

    let m = low.match(/^(?:pause|turn off|disable|stop)\s+(.+)/);
    if (m) return { action: 'pause', name: m[1].trim() };

    if (/\bremind(er)?\b/.test(low)) {
        return {
            action: 'automation',
            auto: {
                name: 'Day-before reminder',
                trigger: 'before_24h',
                steps: [{ type: 'sms', template: '[{business}] Reminder: {title} tomorrow{time}. Reply to change. {manage}' }]
            },
            reply: 'Reminder is ON — everyone with a booking tomorrow gets a text the day before.'
        };
    }
    if (/(thank|thanks|confirm).*(book|appoint|reserv)|after (a |an )?(book|appoint)/.test(low)) {
        return {
            action: 'automation',
            auto: {
                name: 'Thank-you on booking',
                trigger: 'new_booking',
                steps: [{ type: 'sms', template: 'Thanks for booking with {business}! We\'ll be in touch. Manage anytime: {manage}' }]
            },
            reply: 'Done — every new booking now gets an instant thank-you text.'
        };
    }
    if (/(review|feedback).*(after|complete|done)|ask.*review/.test(low)) {
        return {
            action: 'automation',
            auto: { name: 'Review request', trigger: 'completed', steps: [{ type: 'sms', template: '[{business}] Thanks for coming out! How\'d we do? Leave a quick review — it really helps.' }] },
            reply: 'Set — after you mark a booking complete, the customer gets a review request.'
        };
    }
    m = t.match(/^(?:add\s+)?special[:\s]+(.+)/i);
    if (m) return { action: 'add', dataKey: 'specials', record: parseItem(m[1]), reply: 'Added to your specials — it\'s live on your page.' };
    m = t.match(/^(?:add\s+)?event[:\s]+(.+)/i);
    if (m) return { action: 'add', dataKey: 'events', record: parseItem(m[1]), reply: 'Added to your events — it\'s live on your page.' };
    m = t.match(/^(?:add\s+)?(?:menu\s+)?item[:\s]+(.+)/i);
    if (m) return { action: 'add', dataKey: 'menu_items', record: parseItem(m[1]), reply: 'Added to your menu.' };

    if (/how many|bookings? (today|this)|today.?s? (bookings?|schedule)|what.?s? (on |my )?(today|schedule)/.test(low)) {
        return { action: 'query', kind: 'today' };
    }
    return { action: 'unknown' };
}
// "Fish Tacos $9" → { name, price }
function parseItem(s) {
    const price = (s.match(/\$\s*(\d+(?:\.\d{1,2})?)/) || [])[1];
    const name = s.replace(/\$\s*\d+(?:\.\d{1,2})?/, '').trim();
    const rec = { name: name || s.trim(), source: 'sms' };
    if (price) rec.price = price;
    return rec;
}

// automations live in entity_modules (module_key 'automations').settings.list
async function loadUserAutomations(slug) {
    const { data } = await supabase.from('entity_modules')
        .select('id, settings').eq('entity_slug', slug).eq('module_key', 'automations').maybeSingle();
    return { rowId: data ? data.id : null, list: (data && data.settings && data.settings.list) || [] };
}
async function saveUserAutomations(slug, rowId, list) {
    if (rowId) {
        const { data } = await supabase.from('entity_modules').select('settings').eq('id', rowId).maybeSingle();
        const s = (data && data.settings) || {};
        s.list = list;
        await supabase.from('entity_modules').update({ settings: s, enabled: true }).eq('id', rowId);
    } else {
        await supabase.from('entity_modules').insert({ entity_slug: slug, module_key: 'automations', enabled: true, settings: { list: list }, sort_order: 999 });
    }
}

async function scheduleAutomationSteps(slug, steps, record, business) {
    let delayMin = 0;
    for (const step of (steps || [])) {
        if (step.type === 'wait') { delayMin += parseInt(step.minutes, 10) || 0; continue; }
        if (step.type !== 'sms') continue;
        const to = record.phone || record.customer_phone;
        if (!to) continue;
        const body = renderTpl(step.template, record, business);
        if (delayMin <= 0) {
            try { const { sendSms } = require('../utils/sms'); await sendSms(to, body, slug, 'automation', record._mid || null); }
            catch (e) { console.error('automation sms failed:', e.message); }
        } else {
            const sendAt = new Date(Date.now() + delayMin * 60000).toISOString();
            await insertRecord(slug, 'scheduled_sms', { to: to, body: body, send_at: sendAt, status: 'pending' });
        }
    }
}

async function runUserAutomations(slug, triggerEvent, record) {
    try {
        const ent = await entityBySlug(slug);
        const business = { name: (ent && ent.name) || '' };
        const autos = await loadUserAutomations(slug);
        for (const auto of autos.list) {
            if (auto.enabled === false) continue;
            if (auto.trigger !== triggerEvent) continue;
            await scheduleAutomationSteps(slug, auto.steps, record, business);
        }
    } catch (e) { console.error('[user-automations]', e.message); }
}

// Inbound webhook for the BUSINESS number (point a Twilio number here).
router.post('/sms/business', express.urlencoded({ extended: false }), async (req, res) => {
    function reply(msg) {
        res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' +
            String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</Message></Response>');
    }
    try {
        const from = req.body.From || req.body.from || '';
        const body = (req.body.Body || req.body.body || '').trim();
        const biz = await businessByPhone(from);
        if (!biz) return reply('This number isn\'t linked to a business yet. Add your phone in your CyberCheck dashboard, then text again.');
        const bizName = biz.name || 'your business';
        const cmd = parseBusinessCommand(body);

        if (cmd.action === 'help' || cmd.action === 'unknown') {
            return reply('Hi from ' + bizName + '! Text me things like:\n• "Remind everyone with a booking tomorrow"\n• "Thank customers after they book"\n• "Add special: Fish Tacos $9"\n• "How many bookings today?"\n• "List" to see your automations');
        }
        if (cmd.action === 'automation') {
            const autos = await loadUserAutomations(biz.slug);
            autos.list.push({ name: cmd.auto.name, trigger: cmd.auto.trigger, steps: cmd.auto.steps, enabled: true, source: 'sms' });
            await saveUserAutomations(biz.slug, autos.rowId, autos.list);
            return reply('✅ ' + cmd.reply + '\n(Text "list" to see all, or "pause ' + cmd.auto.name.toLowerCase() + '" to turn off.)');
        }
        if (cmd.action === 'add') {
            await insertRecord(biz.slug, cmd.dataKey, cmd.record);
            return reply('✅ ' + cmd.reply + (cmd.record.name ? ' (' + cmd.record.name + (cmd.record.price ? ' $' + cmd.record.price : '') + ')' : ''));
        }
        if (cmd.action === 'list') {
            const autos = await loadUserAutomations(biz.slug);
            const active = autos.list.filter(function (r) { return r && r.enabled !== false; });
            if (!active.length) return reply('No automations yet. Try: "Remind everyone with a booking tomorrow".');
            return reply('Your automations:\n' + active.map(function (r) { return '• ' + r.name; }).join('\n') + '\n\nText "pause <name>" to turn one off.');
        }
        if (cmd.action === 'pause') {
            const autos = await loadUserAutomations(biz.slug);
            const hit = autos.list.find(function (r) { return r.name && r.name.toLowerCase().indexOf(cmd.name) !== -1; });
            if (!hit) return reply('Couldn\'t find an automation matching "' + cmd.name + '". Text "list" to see them.');
            hit.enabled = false;
            await saveUserAutomations(biz.slug, autos.rowId, autos.list);
            return reply('⏸️ Paused "' + hit.name + '". Text it again any time to turn it back on.');
        }
        if (cmd.action === 'query' && cmd.kind === 'today') {
            const today = new Date().toISOString().slice(0, 10);
            const { data: cal } = await supabase.from('booking_calendar')
                .select('title, start_time, party, status, details').eq('entity_slug', biz.slug).eq('date', today).eq('kind', 'booking');
            const active = (cal || []).filter(function (e) { return ['cancelled', 'declined'].indexOf(e.status) === -1; });
            if (!active.length) return reply('Nothing on the schedule for today — it\'s open.');
            const heads = active.reduce(function (n, e) { return n + (parseInt(e.party, 10) || 1); }, 0);
            return reply('📅 Today at ' + bizName + ': ' + active.length + ' booking' + (active.length > 1 ? 's' : '') + ' · ' + heads + ' guest' + (heads > 1 ? 's' : '') + '\n' +
                active.slice(0, 8).map(function (e) { return '• ' + (((e.details || {}).time) || e.start_time || 'all day') + ' — ' + (e.title || 'booking') + (e.party ? ' (' + e.party + ')' : ''); }).join('\n'));
        }
        return reply('Got it. Text "help" to see what I can do.');
    } catch (err) {
        console.error('[sms/business]', err.message);
        return reply('Something hiccuped on our end — try that again in a moment.');
    }
});

module.exports = router;
