// ============================================================
// BOOKING CORE — availability and pricing, as pure functions.
// ============================================================
//
// Nothing in this file touches the database, the network or the clock
// (except through an injected `now`). Everything it needs is passed in.
// That is deliberate: this is the code that decides what a customer is
// charged and whether a seat exists, so it has to be testable without
// credentials, and `npm run test:booking` runs all of it offline.
//
// The one idea worth keeping in your head:
//
//   A VERTICAL IS DATA. A fishing charter and a parasail flight run
//   through the identical code path. They differ only in the columns on
//   their booking_products row — schedule_mode, capacity_mode, and the
//   rate rows hanging off them.
//
// So there is no `if (isCharter)` anywhere below, and there must never be.
// If a new kind of business cannot be expressed in these fields, the fix is
// a new field, not a new branch.
//
// ── Money ───────────────────────────────────────────────────────────────
//
// Every calculation is in integer cents. Dollars only exist at the edges,
// where a price comes out of Postgres `numeric` and where a total goes back
// out as JSON. `0.1 + 0.2` is a real bug in a payments path, and rounding a
// per-person rate across six passengers is exactly where it shows up.
// ============================================================

'use strict';

/* ── time and date helpers ──────────────────────────────────────────── */

/** 'HH:MM' or 'HH:MM:SS' or '6:00 AM' → minutes since midnight, else null. */
function toMinutes(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    const ampm = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
    if (ampm) {
        let hour = parseInt(ampm[1], 10) % 12;
        if (/^p/i.test(ampm[3])) hour += 12;
        return hour * 60 + (parseInt(ampm[2], 10) || 0);
    }
    const clock = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!clock) return null;
    const hour = parseInt(clock[1], 10);
    const minute = parseInt(clock[2], 10);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

/** minutes since midnight → 'HH:MM' (24h, the storage format). */
function toClock(minutes) {
    if (minutes == null || isNaN(minutes)) return null;
    const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return String(Math.floor(wrapped / 60)).padStart(2, '0') + ':' +
        String(wrapped % 60).padStart(2, '0');
}

/** Anything date-ish → 'YYYY-MM-DD', else null. */
function toDate(value) {
    const match = String(value == null ? '' : value).match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

/** Day of week for a date string, 0 = Sunday. UTC, so it never drifts. */
function dayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d.getUTCDay();
}

/** A date string plus n days, still a date string. */
function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Every date from start to end inclusive. Capped so a typo cannot hang us. */
function datesBetween(start, end, cap) {
    const first = toDate(start);
    if (!first) return [];
    const last = toDate(end) || first;
    const out = [];
    for (let d = first, i = 0; d <= last && i < (cap || 370); d = addDays(d, 1), i++) out.push(d);
    return out;
}

/** Nights between two dates (check-in to check-out). Same day = 1. */
function nightsBetween(start, end) {
    const a = toDate(start);
    const b = toDate(end);
    if (!a) return 1;
    if (!b || b <= a) return 1;
    return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/** A date + clock time as a real instant, in UTC. */
function instantOf(dateStr, timeStr) {
    const date = toDate(dateStr);
    if (!date) return null;
    const minutes = toMinutes(timeStr);
    return new Date(new Date(date + 'T00:00:00Z').getTime() + (minutes || 0) * 60000);
}

/* ── money ──────────────────────────────────────────────────────────── */

/** Dollars (number, string or Postgres numeric) → integer cents. */
function toCents(amount) {
    const n = typeof amount === 'number' ? amount : parseFloat(amount);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
}

/** Integer cents → a number of dollars, to two places, for JSON. */
function toDollars(cents) {
    return Math.round(cents || 0) / 100;
}

/* ── schedules → the slots a date actually offers ───────────────────── */

/**
 * Does a schedule row apply to this date?
 *
 * Blackouts are handled by the caller (they remove a date rather than
 * supply one), so this only answers for 'weekly' and 'date' rows.
 */
function scheduleCoversDate(schedule, dateStr) {
    if (!schedule || schedule.active === false) return false;
    if (schedule.valid_from && dateStr < toDate(schedule.valid_from)) return false;
    if (schedule.valid_to && dateStr > toDate(schedule.valid_to)) return false;

    if (schedule.kind === 'date') return toDate(schedule.specific_date) === dateStr;
    if (schedule.kind === 'blackout') return false;

    // weekly: an empty or absent day list means every day
    const days = schedule.days_of_week;
    if (!Array.isArray(days) || !days.length) return true;
    return days.indexOf(dayOfWeek(dateStr)) !== -1;
}

/** Is this date blacked out by any 'blackout' row? */
function isBlackedOut(schedules, dateStr) {
    return (schedules || []).some(function (s) {
        if (!s || s.kind !== 'blackout' || s.active === false) return false;
        if (s.specific_date) return toDate(s.specific_date) === dateStr;
        const from = toDate(s.valid_from);
        const to = toDate(s.valid_to);
        if (from && to) return dateStr >= from && dateStr <= to;
        if (from) return dateStr === from;
        return false;
    });
}

/**
 * The clock times a product offers on one date, before availability.
 *
 * Every schedule_mode lands here, and the mode is the only thing that
 * decides the shape of the answer:
 *
 *   fixed_times     the `times` arrays on the matching schedules
 *   duration_slots  a window sliced at slot_interval_minutes
 *   open_date       one slot with no time at all
 *   date_range      one slot, the range's start
 *   request         nothing — this product has no calendar
 */
function slotTimesForDate(product, schedules, dateStr) {
    const mode = (product && product.schedule_mode) || 'fixed_times';
    if (mode === 'request') return [];
    if (isBlackedOut(schedules, dateStr)) return [];

    const applicable = (schedules || []).filter(function (s) {
        return s.kind !== 'blackout' && scheduleCoversDate(s, dateStr);
    });

    if (mode === 'open_date' || mode === 'date_range') {
        // A schedule row is still allowed to close the day; if rows exist for
        // this product and none matches, the day is not offered.
        const gated = (schedules || []).some(function (s) { return s.kind !== 'blackout'; });
        if (gated && !applicable.length) return [];
        return [{ time: null, capacityOverride: capacityOverrideOf(applicable) }];
    }

    const out = [];
    const seen = Object.create(null);

    function push(time, override) {
        const clock = toClock(toMinutes(time));
        if (!clock || seen[clock]) return;
        seen[clock] = true;
        out.push({ time: clock, capacityOverride: override == null ? null : override });
    }

    for (const schedule of applicable) {
        const override = schedule.capacity_override == null ? null : schedule.capacity_override;

        if (Array.isArray(schedule.times) && schedule.times.length) {
            schedule.times.forEach(function (t) { push(t, override); });
            continue;
        }

        // A window with an interval: slice it. This is how a jet ski shop
        // gets 09:00, 10:00, 11:00 … without typing them out, and how the
        // same shop switches to 30-minute slots by changing one number.
        const start = toMinutes(schedule.window_start);
        const end = toMinutes(schedule.window_end);
        const step = parseInt(schedule.slot_interval_minutes, 10) ||
            parseInt(product && product.duration_minutes, 10) || 60;
        if (start == null || end == null || step <= 0) continue;

        const ride = parseInt(product && product.duration_minutes, 10) || step;
        // Stop early enough that the last slot still finishes inside the
        // window — a 5pm close does not sell a 5pm two-hour rental.
        for (let t = start, guard = 0; t + ride <= end && guard < 200; t += step, guard++) {
            push(toClock(t), override);
        }
    }

    out.sort(function (a, b) { return toMinutes(a.time) - toMinutes(b.time); });
    return out;
}

function capacityOverrideOf(schedules) {
    for (const s of schedules || []) {
        if (s && s.capacity_override != null) return s.capacity_override;
    }
    return null;
}

/* ── capacity ───────────────────────────────────────────────────────── */

/**
 * How much of a slot is already taken.
 *
 * `claims` are booking_calendar-shaped rows: { date, end_date, start_time,
 * status, kind, party, offering_id, product_id, resource_id }. They come
 * from every source at once — this platform's own checkouts, a FareHarbor
 * sync, an iCal feed, a manual block — which is the whole point of keeping
 * one calendar table. A date sold on Airbnb is unavailable here too.
 */
function usedCapacity(claims, options) {
    const opts = options || {};
    const date = toDate(opts.date);
    const time = opts.time ? toClock(toMinutes(opts.time)) : null;
    let used = 0;

    for (const claim of claims || []) {
        if (!claim) continue;
        if (claim.status && claim.status !== 'active' && claim.status !== 'confirmed' && claim.status !== 'pending') continue;
        if (claim.kind === 'block') continue;

        // Does the claim cover this date?
        //
        // `endExclusive` is the lodging convention, and it is worth real
        // money: a stay of the 4th to the 8th occupies the nights of the
        // 4th, 5th, 6th and 7th, and the guest leaves on the morning of
        // the 8th — so the 8th is available to the next arrival. Counting
        // it as occupied loses a night on every single turnover.
        //
        // It is also exactly what iCal means by DTEND on an all-day event,
        // which is how Airbnb, Vrbo and Booking.com describe a stay, so an
        // imported reservation lands on the right nights without
        // translation.
        //
        // Everything else keeps the inclusive reading: a three-day jet ski
        // hire on the 4th to the 6th does occupy the 6th.
        const claimStart = toDate(claim.date);
        if (!claimStart) continue;
        const rawEnd = toDate(claim.end_date);
        const claimEnd = rawEnd
            ? (opts.endExclusive ? addDays(rawEnd, -1) : rawEnd)
            : claimStart;
        // A cleaning or turnover gap extends the claim: the nights after a
        // stay that cannot be sold. Applied to the claim rather than to
        // the request, so it holds for reservations arriving from a
        // channel too — an Airbnb guest leaving on Sunday still earns the
        // cleaner their Monday.
        const blockedUntil = opts.turnoverDays > 0 ? addDays(claimEnd, opts.turnoverDays) : claimEnd;
        if (date < claimStart || date > blockedUntil) continue;

        // Scoped to a product? Then only that product's claims count. A
        // claim with no product is a legacy or external one and counts
        // against everything, which is the safe direction to be wrong in.
        if (opts.productId && claim.product_id && String(claim.product_id) !== String(opts.productId)) continue;

        // Scoped to a time? Only for products that have times at all.
        if (time) {
            const claimTime = claim.start_time ? toClock(toMinutes(claim.start_time)) : null;
            if (claimTime && claimTime !== time) continue;
        }

        used += Math.max(1, parseInt(claim.party, 10) || 1);
    }
    return used;
}

/** Is a named resource (this boat, this guide) already committed? */
function resourceBusy(claims, resourceId, dateStr, timeStr) {
    if (!resourceId) return false;
    const time = timeStr ? toClock(toMinutes(timeStr)) : null;
    return (claims || []).some(function (claim) {
        if (!claim || String(claim.resource_id || claim.offering_id || '') !== String(resourceId)) return false;
        if (claim.status && claim.status !== 'active' && claim.status !== 'confirmed' && claim.status !== 'pending') return false;
        const start = toDate(claim.date);
        if (!start) return false;
        const end = toDate(claim.end_date) || start;
        if (dateStr < start || dateStr > end) return false;
        if (!time) return true;
        const claimTime = claim.start_time ? toClock(toMinutes(claim.start_time)) : null;
        return !claimTime || claimTime === time;
    });
}

/**
 * What is bookable on one date: every slot, with seats left on each.
 *
 * capacity_mode decides what "full" means:
 *   seats      capacity is a head count shared by the slot
 *   units      capacity is a count of machines, boards or carts
 *   exclusive  one booking takes the slot, whatever its size
 */
function availabilityForDate(input) {
    const product = input.product || {};
    const schedules = input.schedules || [];
    const claims = input.claims || [];
    const date = toDate(input.date);
    const now = input.now ? new Date(input.now) : new Date();

    if (!date) return { date: null, bookable: false, reason: 'no_date', slots: [] };

    const today = now.toISOString().slice(0, 10);
    if (date < today) return { date: date, bookable: false, reason: 'past', slots: [] };

    const windowDays = parseInt(product.booking_window_days, 10);
    if (windowDays > 0 && date > addDays(today, windowDays)) {
        return { date: date, bookable: false, reason: 'beyond_window', slots: [] };
    }
    if (isBlackedOut(schedules, date)) {
        return { date: date, bookable: false, reason: 'closed', slots: [] };
    }

    const leadMinutes = parseInt(product.lead_time_minutes, 10) || 0;
    const earliest = new Date(now.getTime() + leadMinutes * 60000);
    const baseCapacity = Math.max(1, parseInt(product.capacity, 10) || 1);
    const exclusive = product.capacity_mode === 'exclusive';

    const slots = slotTimesForDate(product, schedules, date).map(function (slot) {
        const capacity = exclusive
            ? 1
            : Math.max(1, parseInt(slot.capacityOverride, 10) || baseCapacity);

        const used = usedCapacity(claims, {
            date: date,
            time: slot.time,
            productId: product.id,
        });

        // Lead time: a slot whose departure has already passed the cutoff is
        // not sold online, even though the date is fine. For a product with
        // no clock time, the cutoff runs against the end of the day.
        const starts = slot.time ? instantOf(date, slot.time) : new Date(date + 'T23:59:59Z');
        const tooLate = starts != null && starts < earliest;

        const busy = input.resourceId && resourceBusy(claims, input.resourceId, date, slot.time);

        const remaining = tooLate || busy ? 0 : Math.max(0, capacity - used);
        return {
            time: slot.time,
            end_time: slot.time && product.duration_minutes
                ? toClock(toMinutes(slot.time) + parseInt(product.duration_minutes, 10))
                : null,
            capacity: capacity,
            used: used,
            remaining: remaining,
            available: remaining > 0,
            reason: tooLate ? 'cutoff' : busy ? 'resource_busy' : remaining > 0 ? null : 'full',
        };
    });

    return {
        date: date,
        bookable: slots.some(function (s) { return s.available; }),
        reason: slots.length ? null : 'no_slots',
        slots: slots,
    };
}

/* ── stays ──────────────────────────────────────────────────────────── */

/**
 * A whole stay, checked night by night.
 *
 * This exists because `availabilityForDate` answers about ONE date, and a
 * booking that spans nights needs every one of them free. Checking only
 * the arrival date is the classic double-booking: a five-night stay sails
 * straight over a night that was already sold in the middle.
 *
 * It also enforces the rules that only make sense across a span, all of
 * which are columns on the product or rows in its rate calendar:
 *
 *   min_nights / max_nights     how long a stay may be
 *   arrival_days                which weekdays a stay may begin on
 *   departure_days              which weekdays it may end on
 *   closed_to_arrival           the same, for one specific date
 *   closed_to_departure
 *   closed                      that date is not sold at all
 *   min_nights (per date)       a holiday weekend demanding three nights
 *   turnover_days               the cleaning gap after the stay before
 *
 * `calendar` is a map of 'YYYY-MM-DD' → rate-calendar row, and may be
 * empty: a product with no calendar simply has no per-date overrides.
 */
function availabilityForStay(input) {
    const product = input.product || {};
    const calendar = input.calendar || {};
    const claims = input.claims || [];
    const now = input.now ? new Date(input.now) : new Date();

    const from = toDate(input.from);
    const to = toDate(input.to);
    if (!from) return stayNo('no_date', 'Please pick an arrival date.');
    if (!to) return stayNo('no_end_date', 'Please pick a departure date.');
    if (to <= from) return stayNo('bad_range', 'The departure date has to be after the arrival date.');

    const nights = datesBetween(from, addDays(to, -1), 370);
    const nightCount = nights.length;

    // ── how long ──
    const minNights = Math.max(
        parseInt(product.min_nights, 10) || 1,
        parseInt(calendar[from] && calendar[from].min_nights, 10) || 0,
    );
    const maxNights = parseInt(product.max_nights, 10) || 0;
    if (nightCount < minNights) {
        return stayNo('min_nights', 'This one takes a minimum of ' + minNights + ' night' + (minNights === 1 ? '' : 's') + '.');
    }
    if (maxNights && nightCount > maxNights) {
        return stayNo('max_nights', 'This one takes a maximum of ' + maxNights + ' nights.');
    }

    // ── when you may arrive and leave ──
    const arrivalDays = product.arrival_days;
    if (Array.isArray(arrivalDays) && arrivalDays.length && arrivalDays.indexOf(dayOfWeek(from)) === -1) {
        return stayNo('closed_to_arrival', 'Stays cannot begin on that day. Try ' + dayNames(arrivalDays) + '.');
    }
    const departureDays = product.departure_days;
    if (Array.isArray(departureDays) && departureDays.length && departureDays.indexOf(dayOfWeek(to)) === -1) {
        return stayNo('closed_to_departure', 'Stays cannot end on that day. Try ' + dayNames(departureDays) + '.');
    }
    if (calendar[from] && calendar[from].closed_to_arrival) {
        return stayNo('closed_to_arrival', 'No arrivals on ' + from + '.');
    }
    if (calendar[to] && calendar[to].closed_to_departure) {
        return stayNo('closed_to_departure', 'No departures on ' + to + '.');
    }

    // ── the booking window and the cutoff ──
    const today = now.toISOString().slice(0, 10);
    if (from < today) return stayNo('past', 'That arrival date has passed.');
    const windowDays = parseInt(product.booking_window_days, 10);
    if (windowDays > 0 && from > addDays(today, windowDays)) {
        return stayNo('beyond_window', 'That is further ahead than bookings are open.');
    }
    const leadMinutes = parseInt(product.lead_time_minutes, 10) || 0;
    if (leadMinutes > 0) {
        const earliest = new Date(now.getTime() + leadMinutes * 60000);
        if (new Date(from + 'T23:59:59Z') < earliest) {
            return stayNo('cutoff', 'Online booking has closed for that arrival date — please call.');
        }
    }

    // ── every night, one at a time ──
    const capacity = product.capacity_mode === 'exclusive'
        ? 1
        : Math.max(1, parseInt(product.capacity, 10) || 1);
    const turnoverDays = parseInt(product.turnover_days, 10) || 0;
    const unavailable = [];
    const detail = [];

    for (const night of nights) {
        const row = calendar[night] || null;
        if (row && row.closed) {
            unavailable.push(night);
            detail.push({ date: night, available: false, reason: 'closed', remaining: 0 });
            continue;
        }
        if (isBlackedOut(input.schedules, night)) {
            unavailable.push(night);
            detail.push({ date: night, available: false, reason: 'closed', remaining: 0 });
            continue;
        }

        const used = usedCapacity(claims, {
            date: night,
            productId: product.id,
            endExclusive: true,
            turnoverDays: turnoverDays,
        });
        const busy = input.resourceId && resourceBusy(claims, input.resourceId, night, null);
        const remaining = busy ? 0 : Math.max(0, capacity - used);

        if (remaining <= 0) unavailable.push(night);
        detail.push({
            date: night,
            available: remaining > 0,
            remaining: remaining,
            reason: remaining > 0 ? null : busy ? 'resource_busy' : 'full',
            price: row && row.price != null ? Number(row.price) : null,
        });
    }

    if (unavailable.length) {
        return {
            ok: false,
            reason: 'unavailable',
            error: unavailable.length === 1
                ? 'The night of ' + unavailable[0] + ' is already taken.'
                : unavailable.length + ' of those nights are already taken, starting ' + unavailable[0] + '.',
            nights: detail,
            unavailable: unavailable,
            night_count: nightCount,
        };
    }

    return {
        ok: true,
        reason: null,
        error: null,
        nights: detail,
        unavailable: [],
        night_count: nightCount,
        min_nights: minNights,
        max_nights: maxNights || null,
    };
}

function stayNo(reason, message) {
    return { ok: false, reason: reason, error: message, nights: [], unavailable: [], night_count: 0 };
}

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayNames(days) {
    const names = (days || []).map(function (d) { return DAY_LABELS[d]; }).filter(Boolean);
    if (names.length <= 1) return names[0] || 'another day';
    return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
}

/** availabilityForDate across a range, for painting a month on a calendar. */
function availabilityForRange(input) {
    const dates = datesBetween(input.from, input.to, 120);
    return dates.map(function (date) {
        return availabilityForDate(Object.assign({}, input, { date: date }));
    });
}

/* ── pricing ────────────────────────────────────────────────────────── */

/** Is a rate on sale for this date? Seasons and weekday rules live here. */
function rateAppliesOn(rate, dateStr) {
    if (!rate || rate.active === false) return false;
    if (!dateStr) return true;
    if (rate.season_start && dateStr < toDate(rate.season_start)) return false;
    if (rate.season_end && dateStr > toDate(rate.season_end)) return false;
    if (Array.isArray(rate.days_of_week) && rate.days_of_week.length) {
        if (rate.days_of_week.indexOf(dayOfWeek(dateStr)) === -1) return false;
    }
    return true;
}

/**
 * How many times a rate's amount is charged, beyond its quantity.
 *
 * per_person / per_group / per_unit are charged once per unit sold.
 * per_hour multiplies by the product's own duration.
 * per_day and per_night multiply by the length of the stay.
 */
function rateMultiplier(rate, context) {
    switch ((rate && rate.pricing_mode) || 'per_person') {
        case 'per_hour': {
            const minutes = parseInt(context.durationMinutes, 10) || 60;
            return minutes / 60;
        }
        case 'per_day':
            return Math.max(1, context.days || 1);
        case 'per_night':
            return Math.max(1, context.nights || 1);
        default:
            return 1;
    }
}

function extraMultiplier(extra, context) {
    switch ((extra && extra.pricing_mode) || 'per_booking') {
        case 'per_person':
            return Math.max(1, context.partySize || 1);
        case 'per_day':
            return Math.max(1, context.days || 1);
        case 'per_night':
            return Math.max(1, context.nights || 1);
        default:
            return 1;
    }
}

/**
 * Price a cart. This is the only place a total is ever produced.
 *
 * The public checkout posts quantities and gets an amount back; it never
 * posts an amount. Anything a browser could tamper with — a price, a
 * discount, a deposit — is recomputed here from rows the owner controls.
 *
 * Returns { ok, error, currency, party_size, capacity_used, lines,
 *           subtotal, discount, tax, total, deposit_due, balance_due }
 * with every money field in dollars, and `*_cents` alongside for the
 * caller that is about to talk to Stripe.
 */
function quote(input) {
    const product = input.product || {};
    const rates = input.rates || [];
    const extras = input.extras || [];
    const cart = input.cart || {};
    const promo = input.promo || null;

    const calendar = input.calendar || {};
    const date = toDate(cart.date);
    const endDate = toDate(cart.end_date);
    const isStay = product.schedule_mode === 'date_range';
    const days = isStay ? datesBetween(date, endDate, 370).length || 1 : 1;
    const nights = isStay ? nightsBetween(date, endDate) : 1;

    // The actual nights slept in, arrival up to but not including
    // departure — the same span availabilityForStay checks and the same
    // one a rate calendar prices.
    const stayNights = isStay && date && endDate && endDate > date
        ? datesBetween(date, addDays(endDate, -1), 370)
        : [];

    const byId = Object.create(null);
    rates.forEach(function (r) { byId[String(r.id)] = r; });
    const extraById = Object.create(null);
    extras.forEach(function (e) { extraById[String(e.id)] = e; });

    const lines = [];
    let subtotalCents = 0;
    let partySize = 0;
    let capacityUsed = 0;

    // ── rate lines ──
    const requested = Array.isArray(cart.items) ? cart.items : [];
    for (const item of requested) {
        const rate = byId[String(item && item.rate_id)];
        if (!rate) return fail('That price option is no longer offered.');
        if (!rateAppliesOn(rate, date)) return fail('"' + rate.label + '" is not available on that date.');

        const qty = Math.floor(Number(item.qty) || 0);
        if (qty <= 0) continue;
        if (rate.max_qty != null && qty > rate.max_qty) {
            return fail('"' + rate.label + '" is limited to ' + rate.max_qty + '.');
        }
        if (rate.min_qty && qty < rate.min_qty) {
            return fail('"' + rate.label + '" requires at least ' + rate.min_qty + '.');
        }

        // A per-night rate is priced night by night, because a rate
        // calendar is the whole point of a lodging product: the 4th of
        // July is not worth what a Tuesday in November is. With no
        // calendar every night falls back to the rate's own amount, which
        // is the flat-rate behaviour unchanged.
        let unitCents;
        let amountCents;
        let multiplier = rateMultiplier(rate, { durationMinutes: product.duration_minutes, days: days, nights: nights });

        if (rate.pricing_mode === 'per_night' && stayNights.length) {
            let perStayCents = 0;
            for (const night of stayNights) {
                const row = calendar[night];
                const nightCents = row && row.price != null ? toCents(row.price) : toCents(rate.amount);
                perStayCents += nightCents;
            }
            unitCents = Math.round(perStayCents / stayNights.length); // the average, for display
            amountCents = perStayCents * qty;
            multiplier = stayNights.length;
        } else {
            unitCents = toCents(rate.amount);
            amountCents = Math.round(unitCents * qty * multiplier);
        }
        subtotalCents += amountCents;

        if (rate.pricing_mode === 'per_person') partySize += qty;
        if (rate.occupies_capacity !== false) {
            const weight = rate.capacity_weight == null ? 1 : Number(rate.capacity_weight);
            capacityUsed += qty * (isFinite(weight) ? weight : 1);
        }

        lines.push({
            kind: 'rate',
            ref_id: rate.id,
            label: rate.label + (multiplier !== 1 ? ' × ' + trimNumber(multiplier) : ''),
            unit_amount: toDollars(unitCents),
            unit_amount_cents: unitCents,
            quantity: qty,
            amount: toDollars(amountCents),
            amount_cents: amountCents,
        });
    }

    if (!lines.length) return fail('Choose at least one option.');

    // A party of zero per-person tiers (a whole-boat charter, an
    // appointment) still counts as one party for per-person add-ons.
    if (!partySize) partySize = Math.max(1, Math.ceil(capacityUsed) || 1);

    const minParty = parseInt(product.min_party, 10) || 1;
    const maxParty = parseInt(product.max_party, 10) || 0;
    if (partySize < minParty) return fail('This booking takes at least ' + minParty + ' people.');
    if (maxParty && partySize > maxParty) return fail('This booking takes at most ' + maxParty + ' people.');

    // ── extra guests ──
    //
    // Lodging is priced for a base occupancy and charges above it: "sleeps
    // 6, $40 a night for guests 5 and 6". Both fields default to off, so a
    // product that does not work that way never sees this line.
    const baseOccupancy = parseInt(product.base_occupancy, 10) || 0;
    const extraGuestCents = toCents(product.extra_guest_fee);
    if (baseOccupancy > 0 && extraGuestCents > 0 && partySize > baseOccupancy) {
        const extraGuests = partySize - baseOccupancy;
        const perNight = stayNights.length || 1;
        const amountCents = extraGuestCents * extraGuests * perNight;
        subtotalCents += amountCents;
        lines.push({
            kind: 'rate',
            ref_id: null,
            label: 'Extra guest' + (extraGuests > 1 ? 's' : '') + ' (' + extraGuests + ' over ' + baseOccupancy + ')' +
                (perNight > 1 ? ' × ' + perNight + ' nights' : ''),
            unit_amount: toDollars(extraGuestCents),
            unit_amount_cents: extraGuestCents,
            quantity: extraGuests * perNight,
            amount: toDollars(amountCents),
            amount_cents: amountCents,
        });
    }

    // ── extras ──
    const context = { partySize: partySize, days: days, nights: nights };
    const chosen = Array.isArray(cart.extras) ? cart.extras : [];
    for (const pick of chosen) {
        const extra = extraById[String(pick && pick.extra_id)];
        if (!extra || extra.active === false) continue;
        const qty = Math.floor(Number(pick.qty) || 0);
        if (qty <= 0) continue;
        if (extra.max_qty && qty > extra.max_qty) {
            return fail('"' + extra.name + '" is limited to ' + extra.max_qty + '.');
        }
        const multiplier = extraMultiplier(extra, context);
        const unitCents = toCents(extra.price);
        const amountCents = Math.round(unitCents * qty * multiplier);
        subtotalCents += amountCents;
        lines.push({
            kind: 'extra',
            ref_id: extra.id,
            label: extra.name + (multiplier !== 1 ? ' × ' + trimNumber(multiplier) : ''),
            unit_amount: toDollars(unitCents),
            unit_amount_cents: unitCents,
            quantity: qty,
            amount: toDollars(amountCents),
            amount_cents: amountCents,
        });
    }

    // Required extras are not optional — if one was left out, add it.
    for (const extra of extras) {
        if (!extra || !extra.required || extra.active === false) continue;
        if (extra.product_id && String(extra.product_id) !== String(product.id)) continue;
        if (lines.some(function (l) { return l.kind === 'extra' && String(l.ref_id) === String(extra.id); })) continue;
        const multiplier = extraMultiplier(extra, context);
        const unitCents = toCents(extra.price);
        const amountCents = Math.round(unitCents * multiplier);
        subtotalCents += amountCents;
        lines.push({
            kind: 'extra',
            ref_id: extra.id,
            label: extra.name + (multiplier !== 1 ? ' × ' + trimNumber(multiplier) : ''),
            unit_amount: toDollars(unitCents),
            unit_amount_cents: unitCents,
            quantity: 1,
            amount: toDollars(amountCents),
            amount_cents: amountCents,
        });
    }

    // ── discount ──
    let discountCents = 0;
    if (promo) {
        if (promo.type === 'percent') {
            discountCents = Math.round(subtotalCents * (Number(promo.amount) || 0) / 100);
        } else {
            discountCents = toCents(promo.amount);
        }
        discountCents = Math.min(discountCents, subtotalCents);
        if (discountCents > 0) {
            lines.push({
                kind: 'discount',
                ref_id: null,
                label: 'Promo ' + (promo.code || ''),
                unit_amount: toDollars(-discountCents),
                unit_amount_cents: -discountCents,
                quantity: 1,
                amount: toDollars(-discountCents),
                amount_cents: -discountCents,
            });
        }
    }

    // ── tax ──
    const taxable = subtotalCents - discountCents;
    const taxPercent = Number(product.tax_percent) || 0;
    const taxCents = taxPercent > 0 ? Math.round(taxable * taxPercent / 100) : 0;
    if (taxCents > 0) {
        lines.push({
            kind: 'tax',
            ref_id: null,
            label: 'Tax (' + trimNumber(taxPercent) + '%)',
            unit_amount: toDollars(taxCents),
            unit_amount_cents: taxCents,
            quantity: 1,
            amount: toDollars(taxCents),
            amount_cents: taxCents,
        });
    }

    const totalCents = Math.max(0, taxable + taxCents);
    const depositCents = depositFor(product, totalCents);

    return {
        ok: true,
        currency: (product.currency || 'usd').toLowerCase(),
        party_size: partySize,
        capacity_used: Math.ceil(capacityUsed) || partySize,
        days: days,
        nights: nights,
        lines: lines,
        subtotal: toDollars(subtotalCents),
        subtotal_cents: subtotalCents,
        discount: toDollars(discountCents),
        discount_cents: discountCents,
        tax: toDollars(taxCents),
        tax_cents: taxCents,
        total: toDollars(totalCents),
        total_cents: totalCents,
        deposit_due: toDollars(depositCents),
        deposit_due_cents: depositCents,
        balance_due: toDollars(totalCents - depositCents),
        balance_due_cents: totalCents - depositCents,
        pay_now_cents: depositCents,
    };
}

/**
 * What has to be paid to hold the booking.
 *
 *   none     nothing online; the business collects on the day
 *   full     the whole amount
 *   percent  a share of the total
 *   amount   a flat figure, never more than the total
 */
function depositFor(product, totalCents) {
    const mode = (product && product.deposit_mode) || 'full';
    const value = Number(product && product.deposit_value) || 0;
    if (mode === 'none') return 0;
    if (mode === 'percent') return Math.min(totalCents, Math.round(totalCents * value / 100));
    if (mode === 'amount') return Math.min(totalCents, toCents(value));
    return totalCents;
}

/**
 * What a cancellation is worth back, from the product's own policy.
 *
 * policy: { free_until_hours, partial_until_hours, partial_percent }
 * Outside every window, nothing is refundable — which is a real answer,
 * not a failure, and the caller shows it to the customer before they act.
 */
function refundFor(input) {
    const policy = (input.product && input.product.cancellation_policy) || {};
    const paidCents = Math.max(0, parseInt(input.paidCents, 10) || 0);
    const start = instantOf(input.date, input.time);
    const now = input.now ? new Date(input.now) : new Date();

    if (!start) return { refund_cents: paidCents, percent: 100, reason: 'no_start_time' };
    const hoursOut = (start.getTime() - now.getTime()) / 3600000;

    if (policy.free_until_hours != null && hoursOut >= Number(policy.free_until_hours)) {
        return { refund_cents: paidCents, percent: 100, reason: 'free_window' };
    }
    if (policy.partial_until_hours != null && hoursOut >= Number(policy.partial_until_hours)) {
        const percent = Number(policy.partial_percent) || 0;
        return { refund_cents: Math.round(paidCents * percent / 100), percent: percent, reason: 'partial_window' };
    }
    return { refund_cents: 0, percent: 0, reason: 'no_refund_window' };
}

/**
 * The platform's cut, in cents, from the fee rules table.
 *
 * Most specific rule wins: a rule naming this business beats one naming
 * its template, which beats the global one. A business on 0% is a row.
 */
function applicationFee(input) {
    const rules = (input.rules || []).filter(function (r) { return r && r.active !== false; });
    const slug = input.entitySlug;
    const templateId = input.templateId;

    const rule =
        rules.find(function (r) { return r.scope === 'entity' && r.entity_slug === slug; }) ||
        rules.find(function (r) { return r.scope === 'template' && r.template_id === templateId; }) ||
        rules.find(function (r) { return r.scope === 'global'; }) ||
        null;

    if (!rule) {
        // No rules configured at all: fall back to the deployment's env var,
        // so an install that never opens this table still behaves.
        const percent = Number(input.fallbackPercent) || 0;
        return clampFee(Math.round((input.amountCents || 0) * percent / 100), {}, input.amountCents);
    }

    const raw = Math.round((input.amountCents || 0) * (Number(rule.percent) || 0) / 100) +
        (parseInt(rule.fixed_cents, 10) || 0);
    return clampFee(raw, rule, input.amountCents);
}

function clampFee(cents, rule, amountCents) {
    let fee = Math.max(0, cents);
    const min = parseInt(rule.min_cents, 10) || 0;
    const max = rule.max_cents == null ? null : parseInt(rule.max_cents, 10);
    if (min && fee < min) fee = min;
    if (max != null && fee > max) fee = max;
    // Stripe rejects a fee larger than the charge, and rightly so.
    return Math.min(fee, Math.max(0, amountCents || 0));
}

/* ── template instantiation ─────────────────────────────────────────── */

/**
 * A template row → the rows that make a working product.
 *
 * This is what "modular" means in practice: picking "Parasailing" writes a
 * booking_products row, its booking_rates rows, its booking_extras rows and
 * one booking_schedules row, and from that moment the vertical has no
 * further existence. The owner edits normal rows.
 */
function productFromTemplate(template, entitySlug, overrides) {
    const defaults = (template && template.defaults) || {};
    const extra = overrides || {};

    const product = {
        entity_slug: entitySlug,
        template_id: template.id,
        name: extra.name || template.name,
        description: extra.description || template.description || template.tagline || null,
        schedule_mode: extra.schedule_mode || template.schedule_mode || 'fixed_times',
        capacity_mode: pick(extra.capacity_mode, defaults.capacity_mode, 'seats'),
        duration_minutes: numOrNull(pick(extra.duration_minutes, defaults.duration_minutes, null)),
        capacity: parseInt(pick(extra.capacity, defaults.capacity, 1), 10) || 1,
        min_party: parseInt(pick(extra.min_party, defaults.min_party, 1), 10) || 1,
        max_party: numOrNull(pick(extra.max_party, defaults.max_party, null)),
        lead_time_minutes: parseInt(pick(extra.lead_time_minutes, defaults.lead_time_minutes, 0), 10) || 0,
        booking_window_days: parseInt(pick(extra.booking_window_days, defaults.booking_window_days, 365), 10) || 365,
        buffer_minutes: parseInt(pick(extra.buffer_minutes, defaults.buffer_minutes, 0), 10) || 0,
        deposit_mode: pick(extra.deposit_mode, defaults.deposit_mode, 'full'),
        deposit_value: Number(pick(extra.deposit_value, defaults.deposit_value, 0)) || 0,
        tax_percent: Number(pick(extra.tax_percent, defaults.tax_percent, 0)) || 0,
        currency: (pick(extra.currency, defaults.currency, 'usd') || 'usd').toLowerCase(),
        cancellation_policy: pick(extra.cancellation_policy, defaults.cancellation_policy, {}),
        requires_waiver: !!pick(extra.requires_waiver, defaults.requires_waiver, false),
        questions: template.question_template || [],
        settings: {},
        active: true,
    };

    const rates = (template.rate_template || []).map(function (r, i) {
        return {
            entity_slug: entitySlug,
            label: r.label,
            description: r.description || null,
            pricing_mode: r.pricing_mode || 'per_person',
            amount: Number(r.amount) || 0,
            min_qty: parseInt(r.min_qty, 10) || 0,
            max_qty: numOrNull(r.max_qty),
            age_min: numOrNull(r.age_min),
            age_max: numOrNull(r.age_max),
            weight_min_lb: numOrNull(r.weight_min_lb),
            weight_max_lb: numOrNull(r.weight_max_lb),
            occupies_capacity: r.occupies_capacity !== false,
            capacity_weight: r.capacity_weight == null ? 1 : Number(r.capacity_weight),
            active: r.active !== false,
            sort_order: r.sort_order == null ? i : r.sort_order,
        };
    });

    const extras = (template.addon_template || []).map(function (a, i) {
        return {
            entity_slug: entitySlug,
            name: a.name,
            description: a.description || null,
            price: Number(a.price) || 0,
            pricing_mode: a.pricing_mode || 'per_booking',
            max_qty: parseInt(a.max_qty, 10) || 1,
            required: !!a.required,
            active: a.active !== false,
            sort_order: a.sort_order == null ? i : a.sort_order,
        };
    });

    const source = defaults.schedule || null;
    const schedules = source ? [{
        entity_slug: entitySlug,
        kind: source.kind || 'weekly',
        days_of_week: source.days_of_week || null,
        times: source.times || null,
        window_start: source.window_start || null,
        window_end: source.window_end || null,
        slot_interval_minutes: numOrNull(source.slot_interval_minutes),
        active: true,
    }] : [];

    return { product: product, rates: rates, extras: extras, schedules: schedules };
}

/* ── small helpers ──────────────────────────────────────────────────── */

function pick() {
    for (const value of arguments) {
        if (value !== undefined && value !== null) return value;
    }
    return null;
}
function numOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return isFinite(n) ? n : null;
}
function trimNumber(n) {
    return String(Math.round(Number(n) * 100) / 100);
}
function fail(message) {
    return { ok: false, error: message, lines: [], total: 0, total_cents: 0 };
}

module.exports = {
    // time
    toMinutes, toClock, toDate, dayOfWeek, addDays, datesBetween, nightsBetween, instantOf,
    // money
    toCents, toDollars,
    // availability
    scheduleCoversDate, isBlackedOut, slotTimesForDate, usedCapacity, resourceBusy,
    availabilityForDate, availabilityForRange, availabilityForStay,
    // pricing
    rateAppliesOn, rateMultiplier, extraMultiplier, quote, depositFor, refundFor, applicationFee,
    // templates
    productFromTemplate,
};
