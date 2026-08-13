// ============================================================
// OWNER AVAILABILITY — the business's own control over its inventory
// ============================================================
//
// Until now the only thing that could change a business's availability was the
// email parser. That is backwards in one specific and damaging way: the
// platform's rule is to lag toward caution — better to say "limited" than to
// send a family to a boat that left without them — and that rule assumes the
// owner can correct the number when the guess is wrong. They could not. There
// was no screen, and the only capacity endpoint was unauthenticated.
//
// Three things an owner needs, and nothing more:
//
//   capacity    the number every count is subtracted from. Set once, changed
//               rarely, and meaningless if anyone but the owner can set it.
//   correction  the parser missed a cancellation, or a walk-in was never
//               emailed. Fix today's number without inventing a booking.
//   block       "we are shut on the 14th." Not a full boat — a closed one.
//               Written to booking_calendar as an entity-wide block, which the
//               availability engine treats as a veto over every other source.
//
// Everything is scoped by ownerRequired, which resolves the slug from
// entity_owners server-side. No handler here reads a slug from the request.

const express = require('express');
const router = express.Router();
const db = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const AVAIL = require('./availability-engine');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The slot key the parser writes. Kept in one place so the two cannot drift. */
function slotKey(timeSlot) {
    const t = String(timeSlot || '').trim();
    return t || null;
}

function statusFor(remaining) {
    if (remaining === null || remaining === undefined) return 'available';
    if (remaining <= 0) return 'full';
    if (remaining <= 3) return 'limited';
    return 'available';
}

/* ── read ────────────────────────────────────────────────────────────────
 *
 * GET /api/business/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The owner's view of their own calendar: the merged answer the public sees,
 * plus the raw capacity rows behind it so a wrong number can be pointed at
 * and corrected. The merge comes from the same engine the widget and the
 * public search use — an owner looking at this screen is looking at exactly
 * what a tourist would see.
 */
router.get('/', ownerRequired, async (req, res) => {
    try {
        const slug = req.entitySlug;
        const today = new Date().toISOString().slice(0, 10);
        const from = DATE_RE.test(req.query.from || '') ? req.query.from : today;
        const to = DATE_RE.test(req.query.to || '') ? req.query.to : from;

        const { data: entity } = await db
            .from('entity')
            .select('slug, name, daily_capacity, capacity_per_slot')
            .eq('slug', slug)
            .maybeSingle();

        const { data: rows } = await db
            .from('business_availability')
            .select('id, availability_date, time_slot, total_capacity, booked_count, remaining_spots, status, booking_type, last_updated')
            .eq('entity_slug', slug)
            .gte('availability_date', from)
            .lte('availability_date', to)
            .order('availability_date', { ascending: true });

        const { data: blocks } = await db
            .from('booking_calendar')
            .select('id, date, end_date, kind, status, source, title')
            .eq('entity_slug', slug)
            .eq('kind', 'block')
            .is('offering_id', null)
            .neq('status', 'cancelled')
            .gte('date', from)
            .lte('date', to);

        // What the public actually sees, so the owner is never guessing. Same
        // engine the widget and the public search call, with publicOnly set —
        // an owner viewing this screen sees precisely what a tourist would.
        let publicView = null;
        try {
            const dates = AVAIL.datesBetween(from, to, 120);
            const availability = await AVAIL.readAvailability({
                from, to, slugs: [slug], publicOnly: true,
            });
            publicView = AVAIL.expand(
                availability.get(slug),
                dates,
                entity?.daily_capacity ?? null,
            );
        } catch { /* the raw rows below are still worth returning */ }

        res.json({
            slug,
            name: entity?.name || null,
            daily_capacity: entity?.daily_capacity ?? null,
            capacity_per_slot: entity?.capacity_per_slot ?? null,
            capacity_known: entity?.daily_capacity != null,
            days: rows || [],
            blocks: blocks || [],
            public_view: publicView,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── capacity ────────────────────────────────────────────────────────────
 *
 * PUT /api/business/availability/capacity   { daily_capacity, capacity_per_slot? }
 *
 * The number the parser counts down from. Clearing it (null) is allowed and
 * meaningful: it puts the business back into "call to confirm", which is the
 * honest state for somebody who has not told us how many seats they have.
 */
router.put('/capacity', ownerRequired, async (req, res) => {
    try {
        const { daily_capacity, capacity_per_slot } = req.body || {};

        const cap = daily_capacity === null || daily_capacity === ''
            ? null
            : parseInt(daily_capacity, 10);
        if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 100000)) {
            return res.status(400).json({ error: 'Daily capacity must be a whole number.' });
        }

        const perSlot = capacity_per_slot === null || capacity_per_slot === '' || capacity_per_slot === undefined
            ? null
            : parseInt(capacity_per_slot, 10);
        if (perSlot !== null && (!Number.isFinite(perSlot) || perSlot < 0 || perSlot > 100000)) {
            return res.status(400).json({ error: 'Per-slot capacity must be a whole number.' });
        }

        const { error } = await db
            .from('entity')
            .update({
                daily_capacity: cap,
                capacity_per_slot: perSlot,
                updated_at: new Date().toISOString(),
            })
            .eq('slug', req.entitySlug);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ ok: true, daily_capacity: cap, capacity_per_slot: perSlot });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── correction ──────────────────────────────────────────────────────────
 *
 * PUT /api/business/availability/day   { date, time_slot?, booked_count, total_capacity? }
 *
 * "Two of those cancelled and nobody emailed us." The owner sets what is
 * actually taken; remaining and status are derived here rather than trusted
 * from the client, so the arithmetic cannot be wrong in one place and right
 * in another.
 */
router.put('/day', ownerRequired, async (req, res) => {
    try {
        const slug = req.entitySlug;
        const { date, time_slot, booked_count, total_capacity, booking_type } = req.body || {};

        if (!DATE_RE.test(String(date || ''))) {
            return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' });
        }
        const booked = parseInt(booked_count, 10);
        if (!Number.isFinite(booked) || booked < 0 || booked > 100000) {
            return res.status(400).json({ error: 'Booked count must be a whole number.' });
        }

        // Capacity for this row: what was sent, else what the row already had,
        // else the business default.
        let capacity = total_capacity === null || total_capacity === '' || total_capacity === undefined
            ? null
            : parseInt(total_capacity, 10);

        const slot = slotKey(time_slot);
        let existingQuery = db
            .from('business_availability')
            .select('id, total_capacity')
            .eq('entity_slug', slug)
            .eq('availability_date', date);
        existingQuery = slot === null
            ? existingQuery.is('time_slot', null)
            : existingQuery.eq('time_slot', slot);
        const { data: existing } = await existingQuery.maybeSingle();

        if (capacity === null) {
            if (existing?.total_capacity != null) {
                capacity = existing.total_capacity;
            } else {
                const { data: entity } = await db
                    .from('entity').select('daily_capacity').eq('slug', slug).maybeSingle();
                capacity = entity?.daily_capacity ?? null;
            }
        }

        const remaining = capacity != null ? Math.max(0, capacity - booked) : null;
        const status = capacity != null ? statusFor(remaining) : 'available';

        if (existing) {
            const { error } = await db
                .from('business_availability')
                .update({
                    booked_count: booked,
                    total_capacity: capacity,
                    remaining_spots: remaining,
                    status,
                    last_updated: new Date().toISOString(),
                })
                .eq('id', existing.id);
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ ok: true, id: existing.id, remaining_spots: remaining, status });
        }

        const { data: inserted, error } = await db
            .from('business_availability')
            .insert({
                entity_slug: slug,
                availability_date: date,
                time_slot: slot,
                total_capacity: capacity,
                booked_count: booked,
                remaining_spots: remaining,
                status,
                booking_type: booking_type || null,
                last_updated: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (error) return res.status(500).json({ error: error.message });
        res.json({ ok: true, id: inserted.id, remaining_spots: remaining, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── blocks ──────────────────────────────────────────────────────────────
 *
 * A block is not a full day, it is a closed one, and the availability engine
 * treats an entity-wide block as a veto over every capacity row beneath it.
 * That is the right behaviour and the reason this is a separate verb rather
 * than "set booked_count to capacity".
 */
router.post('/block', ownerRequired, async (req, res) => {
    try {
        const { date, end_date, title } = req.body || {};
        if (!DATE_RE.test(String(date || ''))) {
            return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' });
        }
        if (end_date && !DATE_RE.test(String(end_date))) {
            return res.status(400).json({ error: 'End date must be YYYY-MM-DD.' });
        }
        if (end_date && end_date < date) {
            return res.status(400).json({ error: 'End date cannot be before the start date.' });
        }

        const { data, error } = await db
            .from('booking_calendar')
            .insert({
                entity_slug: req.entitySlug,
                date,
                end_date: end_date || null,
                kind: 'block',
                offering_id: null,
                status: 'active',
                source: 'owner',
                title: title ? String(title).slice(0, 200) : 'Closed',
            })
            .select('id, date, end_date, title')
            .single();

        if (error) return res.status(500).json({ error: error.message });
        res.json({ ok: true, block: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/business/availability/block/:id
 *
 * Cancelled rather than deleted: a block that came from an Airbnb feed will
 * simply be rewritten on the next sync, and the record of what was closed
 * when is worth keeping. The engine already ignores cancelled rows.
 */
router.delete('/block/:id', ownerRequired, async (req, res) => {
    try {
        // Ownership is checked against the row, not taken from the URL.
        const { data: row } = await db
            .from('booking_calendar')
            .select('id, entity_slug')
            .eq('id', req.params.id)
            .maybeSingle();
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (row.entity_slug !== req.entitySlug) {
            return res.status(403).json({ error: 'Not your business.' });
        }

        const { error } = await db
            .from('booking_calendar')
            .update({ status: 'cancelled' })
            .eq('id', row.id);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
