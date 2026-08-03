// ============================================================
// AVAILABILITY ENGINE — one read, three sources
// ============================================================
//
// "What is open on this date?" has three answers in this database and they
// have to be merged in a specific order or the answer is wrong:
//
//   business_availability   the capacity model. The email parser subtracts a
//                           party size from entity.daily_capacity on every
//                           confirmation it reads; the iCal importer marks
//                           dates 'blocked'. This is the main source.
//   availability            per-resource slot rows written by the booking
//                           engine — a specific departure on a specific boat.
//   booking_calendar        every date claim from every source. Rows with
//                           kind='block' and no offering_id are entity-wide
//                           and VETO the date regardless of what the other
//                           two say, because a whole-business block means the
//                           business is shut, not that it has seats.
//
// The veto is the part that is easy to get wrong. A condo with a capacity row
// saying "1 unit free" and an Airbnb iCal block covering the same night is
// NOT free; the block wins.
//
// `routes/gcr.js` does this merge inline for the public search. This module
// exists so the admin search and the embeddable widget cannot drift from each
// other — they call the same function. gcr.js is deliberately left alone.

const db = require('../db');

/** Every YYYY-MM-DD from `from` to `to` inclusive, capped so a silly range can't hang. */
function datesBetween(from, to, cap = 400) {
    const out = [];
    let d = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (d <= end && out.length < cap) {
        out.push(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 86400000);
    }
    return out;
}

/**
 * Capacity-derived status, used when the row didn't carry one of its own.
 *
 * The threshold has to be proportional, not a flat number. A two-unit condo
 * building with both units free is wide open, but a flat "3 or fewer means
 * limited" rule paints it amber and tells a guest to hurry for no reason.
 * So: everything free is always `available`, and `limited` means a genuinely
 * small share of a bigger pool, or the last couple of spots in one.
 */
function statusFor(remaining, total = null) {
    if (remaining == null) return 'unknown';
    if (remaining <= 0) return 'full';
    if (total != null && remaining >= total) return 'available';
    if (remaining <= 2) return 'limited';
    if (total != null && remaining / total <= 0.25) return 'limited';
    if (total == null && remaining <= 3) return 'limited';
    return 'available';
}

/**
 * Merge the three sources for a date window.
 *
 * @param {object}   opts
 * @param {string}   opts.from            YYYY-MM-DD
 * @param {string}   opts.to              YYYY-MM-DD
 * @param {string[]} [opts.slugs]         Limit to these businesses. Omit to read
 *                                        every business that has data in range.
 * @param {boolean}  [opts.publicOnly]    Honour `visible_on_profile`. True for
 *                                        the embed widget, false for admin —
 *                                        an operator needs to see rows a
 *                                        business has chosen not to publish.
 * @param {number}   [opts.limit]
 * @returns {Promise<Map<string, {days: Map<string, object>}>>} keyed by entity_slug
 */
async function readAvailability({ from, to, slugs = null, publicOnly = false, limit = 5000 }) {
    let capacityQuery = db
        .from('business_availability')
        .select('entity_slug, availability_date, time_slot, end_time, status, remaining_spots, total_capacity, booking_type, source_platform, resource_id')
        .gte('availability_date', from)
        .lte('availability_date', to)
        .limit(limit);
    if (publicOnly) capacityQuery = capacityQuery.eq('visible_on_profile', true);
    if (slugs) capacityQuery = capacityQuery.in('entity_slug', slugs);

    let slotQuery = db
        .from('availability')
        .select('entity_slug, date, start_time, end_time, status, spots_total, spots_remaining')
        .gte('date', from)
        .lte('date', to)
        .limit(limit);
    if (slugs) slotQuery = slotQuery.in('entity_slug', slugs);

    // Blocks can start before the window and run into it, so there is no
    // lower bound here — only `date <= to`. Filtering on `date >= from` would
    // silently miss a week-long Airbnb stay that began last Friday.
    let blockQuery = db
        .from('booking_calendar')
        .select('entity_slug, date, end_date, kind, offering_id, status, source, title')
        .eq('kind', 'block')
        .is('offering_id', null)
        .neq('status', 'cancelled')
        .lte('date', to)
        .limit(limit);
    if (slugs) blockQuery = blockQuery.in('entity_slug', slugs);

    const [capacity, slots, blocks] = await Promise.all([capacityQuery, slotQuery, blockQuery]);

    const bySlug = new Map();
    const dayOf = (slug, date) => {
        if (!bySlug.has(slug)) bySlug.set(slug, { days: new Map() });
        const days = bySlug.get(slug).days;
        if (!days.has(date)) {
            days.set(date, { date, remaining: null, total: null, status: 'unknown', sources: [], slots: [] });
        }
        return days.get(date);
    };

    const merge = (slug, date, remaining, total, status, source, slot) => {
        const day = dayOf(slug, date);
        // Max, not sum: two rows for the same day are two views of the same
        // inventory (a per-slot row and a daily row), not two separate pools.
        if (remaining != null) day.remaining = day.remaining == null ? remaining : Math.max(day.remaining, remaining);
        if (total != null) day.total = day.total == null ? total : Math.max(day.total, total);
        if (status && status !== 'unknown' && day.status !== 'blocked') day.status = status;
        if (source && !day.sources.includes(source)) day.sources.push(source);
        if (slot) day.slots.push(slot);
    };

    for (const r of capacity.data || []) {
        merge(r.entity_slug, r.availability_date, r.remaining_spots, r.total_capacity, r.status,
            r.source_platform || 'capacity',
            r.time_slot && r.time_slot !== '00:00'
                ? { time: r.time_slot, end_time: r.end_time || null, remaining: r.remaining_spots, total: r.total_capacity }
                : null);
    }
    for (const r of slots.data || []) {
        merge(r.entity_slug, r.date, r.spots_remaining, r.spots_total, r.status || 'available', 'booking-engine',
            r.start_time ? { time: r.start_time, end_time: r.end_time || null, remaining: r.spots_remaining, total: r.spots_total } : null);
    }

    // Fill in a status for days that only ever carried numbers.
    for (const entry of bySlug.values()) {
        for (const day of entry.days.values()) {
            if (day.status === 'unknown') day.status = statusFor(day.remaining, day.total);
        }
    }

    // The veto, applied last so nothing can overwrite it.
    for (const b of blocks.data || []) {
        const start = b.date < from ? from : b.date;
        const rawEnd = b.end_date && b.end_date > b.date ? b.end_date : b.date;
        const end = rawEnd > to ? to : rawEnd;
        if (end < from) continue;
        for (const date of datesBetween(start, end)) {
            const day = dayOf(b.entity_slug, date);
            day.remaining = 0;
            day.status = 'blocked';
            day.blocked_by = b.source || b.title || 'block';
            if (!day.sources.includes('block')) day.sources.push('block');
        }
    }

    return bySlug;
}

/**
 * Fill in the dates nothing wrote a row for.
 *
 * This is the single most important rule in the whole model, and getting it
 * backwards makes every calendar wrong. Rows are only written when something
 * CLAIMS a date — a parsed confirmation, an iCal block, a hand edit. So the
 * absence of a row does not mean "we don't know", it means **nothing has
 * taken it**:
 *
 *   capacity known    → the date is open, with the full daily capacity free
 *   capacity unknown  → genuinely unknown; we have no number to report and
 *                       saying "available" would be a guess
 *
 * Treating a missing row as "full" would show a boat as sold out on every day
 * nobody has booked yet, which is the exact opposite of the truth.
 *
 * Filled-in days carry `assumed: true` so a caller can distinguish "counted
 * down from a real booking" from "nothing has claimed this".
 */
function expand(entry, dates, defaultCapacity = null) {
    return dates.map((date) => {
        const existing = entry && entry.days.get(date);
        if (existing) return existing;
        if (defaultCapacity != null) {
            return {
                date,
                remaining: defaultCapacity,
                total: defaultCapacity,
                status: statusFor(defaultCapacity, defaultCapacity),
                sources: [],
                slots: [],
                assumed: true,
            };
        }
        return { date, remaining: null, total: null, status: 'unknown', sources: [], slots: [], assumed: true };
    });
}

/**
 * Flatten one business's merged days into the summary every caller wants.
 *
 * `coverage` is the difference between a stay and everything else, and it is
 * not cosmetic: a condo has to be free EVERY night of a trip to be bookable,
 * while a charter only needs one open day in the window. Asking the wrong
 * question lists a condo as available for a week when it has one free night.
 *
 * `defaultCapacity` is `entity.daily_capacity`. Pass it and unclaimed dates
 * count as open; omit it and they count as unknown. See `expand`.
 */
function summarise(entry, requestedDates, coverage = 'any', defaultCapacity = null) {
    const days = expand(entry, requestedDates, defaultCapacity);
    // `unknown` is deliberately NOT open. With no capacity on file and nothing
    // claiming the date there is no basis for saying it is free, and counting
    // it would put businesses we know nothing about at the top of a search for
    // what is available — the single most misleading thing this could do.
    const open = days.filter(
        (d) => d.status !== 'full' && d.status !== 'blocked' && d.status !== 'unknown' && (d.remaining == null || d.remaining > 0),
    );
    const openDates = [...new Set(open.map((d) => d.date))].sort();
    const coversAll = requestedDates.length > 0 && requestedDates.every((d) => openDates.includes(d));
    const remainings = open.map((d) => d.remaining).filter((n) => n != null);

    return {
        days: days.sort((a, b) => (a.date < b.date ? -1 : 1)),
        available_dates: openDates,
        open_days: openDates.length,
        covers_all_days: coversAll,
        meets_coverage: coverage === 'all' ? coversAll : openDates.length > 0,
        min_remaining: remainings.length ? Math.min(...remainings) : null,
        max_remaining: remainings.length ? Math.max(...remainings) : null,
        // Whether we know a capacity at all. Without one, "available" means
        // "nothing has blocked it", not "there are seats" — a real difference
        // and one the UI has to be able to state.
        capacity_known: days.some((d) => d.total != null),
        // Whether anything has actually claimed a date in this window, as
        // opposed to every day being filled in from capacity. A business
        // sending nothing looks identical to a quiet week otherwise.
        has_data: days.some((d) => !d.assumed),
        claimed_days: days.filter((d) => !d.assumed).length,
    };
}

/**
 * Which vertical a business belongs to.
 *
 * Deliberately derived from entity_type/entity_subtype rather than stored, so
 * a new subtype lands in the right bucket without a migration. `stay` is an
 * entity_type family; the rest are subtype patterns.
 */
const STAY_TYPES = ['hotel', 'condo', 'vacation-rental', 'resort'];

/**
 * Order matters — the first match wins, so the specific patterns sit above the
 * general ones. `rental` in particular would swallow "vacation rental" and
 * "condo rental" if it ran before the stay types, which is why those are
 * matched on entity_type first.
 *
 * Condos and hotels are separate industries rather than one "stays" bucket:
 * they are run by different people, they are searched separately, and each
 * gets its own page.
 */
const VERTICAL_PATTERNS = [
    { id: 'condo', label: 'Condos & vacation rentals', types: ['condo', 'vacation-rental'], coverage: 'all', unit_word: 'units' },
    { id: 'hotel', label: 'Hotels & resorts', types: ['hotel', 'resort'], coverage: 'all', unit_word: 'rooms' },
    { id: 'charter', label: 'Fishing charters', pattern: /charter|fishing|deep.?sea|offshore/i, coverage: 'any', unit_word: 'spots' },
    { id: 'cruise', label: 'Dolphin & sunset cruises', pattern: /cruise|dolphin|sunset|sightsee|tour(?!ism)/i, coverage: 'any', unit_word: 'spots' },
    { id: 'watersport', label: 'Parasailing & watersports', pattern: /parasail|jet.?ski|wave.?runner|snorkel|scuba|dive|kayak|paddle|surf|banana.?boat/i, coverage: 'any', unit_word: 'spots' },
    { id: 'rental', label: 'Boat & gear rentals', pattern: /rental|rent-|marina|pontoon|boat.?rent|bike|golf.?cart/i, coverage: 'any', unit_word: 'units' },
    { id: 'session', label: 'Photographers & sessions', pattern: /photograph|photo|guide|instructor|lesson|spa|salon|massage|charter.?fish/i, coverage: 'any', unit_word: 'sessions' },
    { id: 'venue', label: 'Venues & events', pattern: /venue|event|wedding|banquet|golf.?course/i, coverage: 'any', unit_word: 'slots' },
];

/** Shown alongside the real industries so nothing falls off the list silently. */
const OTHER_VERTICAL = { id: 'other', label: 'Everything else', coverage: 'any', unit_word: 'spots' };

function verticalOf(entity) {
    const type = String(entity.entity_type || '').toLowerCase();
    const subtype = String(entity.entity_subtype || '').toLowerCase();
    for (const v of VERTICAL_PATTERNS) {
        if (v.types && v.types.includes(type)) return v.id;
    }
    for (const v of VERTICAL_PATTERNS) {
        if (v.pattern && (v.pattern.test(subtype) || v.pattern.test(type))) return v.id;
    }
    return 'other';
}

/** The type/subtype filter for one industry, for narrowing a query up front. */
function verticalSpec(id) {
    return VERTICAL_PATTERNS.find((v) => v.id === id) || (id === 'other' ? OTHER_VERTICAL : null);
}

/** "spots" / "units" / "rooms" — what a remaining count means in this industry. */
function unitWordFor(vertical) {
    const spec = verticalSpec(vertical);
    return (spec && spec.unit_word) || 'spots';
}

/** Default coverage rule — stays need every night, the rest any open day. */
function coverageFor(vertical) {
    const spec = verticalSpec(vertical);
    return spec ? spec.coverage : 'any';
}

module.exports = {
    readAvailability,
    summarise,
    expand,
    datesBetween,
    statusFor,
    verticalOf,
    verticalSpec,
    unitWordFor,
    coverageFor,
    VERTICAL_PATTERNS,
    OTHER_VERTICAL,
    STAY_TYPES,
};
