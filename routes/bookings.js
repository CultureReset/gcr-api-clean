const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// Cache-control for GET requests
router.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  next();
});

// ─── GET /api/bookings/:slug/availability ─────────────────────────────────
// Check availability for a specific date
router.get('/:slug/availability', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ error: 'date query parameter required (YYYY-MM-DD)' });
    }

    const { data, error } = await db
      .from('entity_availability')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .eq('available_date', date)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: error.message });
    }

    // Return default availability if not found
    const availability = data || {
      available_date: date,
      available_slots: 1,
      booked_slots: 0,
      blocked: false,
      special_pricing: null
    };

    res.json(availability);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bookings/:slug/date-range ───────────────────────────────────
// Get availability for a date range
router.get('/:slug/date-range', async (req, res) => {
  try {
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'start_date and end_date query parameters required' });
    }

    const { data, error } = await db
      .from('entity_availability')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .gte('available_date', startDate)
      .lte('available_date', endDate)
      .order('available_date');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ availability: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/bookings/:slug ─────────────────────────────────────────────
// Create a new booking
router.post('/:slug', async (req, res) => {
  try {
    const { guest_name, guest_email, guest_phone, booking_date, booking_time, duration_hours, guest_count, service_id, total_price, special_requests } = req.body;

    if (!guest_name || !guest_email || !booking_date) {
      return res.status(400).json({ error: 'guest_name, guest_email, booking_date required' });
    }

    // Check availability
    const { data: availability } = await db
      .from('entity_availability')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .eq('available_date', booking_date)
      .single();

    if (availability && availability.blocked) {
      return res.status(409).json({ error: 'Date is blocked' });
    }

    const availableSlots = availability?.available_slots || 1;
    const bookedSlots = availability?.booked_slots || 0;
    if (bookedSlots >= availableSlots) {
      return res.status(409).json({ error: 'No availability for this date' });
    }

    const { data: booking, error } = await db
      .from('entity_bookings')
      .insert({
        entity_slug: req.params.slug,
        guest_name: guest_name.trim(),
        guest_email: guest_email.trim(),
        guest_phone: guest_phone?.trim() || null,
        booking_date,
        booking_time: booking_time || null,
        duration_hours: duration_hours || null,
        guest_count: guest_count || 1,
        service_id: service_id || null,
        total_price: total_price || null,
        special_requests: special_requests?.trim() || null,
        status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;

    // Update availability (increment booked_slots)
    if (availability) {
      await db
        .from('entity_availability')
        .update({ booked_slots: bookedSlots + 1 })
        .eq('id', availability.id);
    } else {
      await db
        .from('entity_availability')
        .insert({
          entity_slug: req.params.slug,
          available_date: booking_date,
          available_slots: 1,
          booked_slots: 1,
          blocked: false
        });
    }

    res.status(201).json({ ok: true, booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/bookings/:slug/:id ───────────────────────────────────────────
// Get booking details
router.get('/:slug/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('entity_bookings')
      .select('*')
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .single();

    if (error) return res.status(404).json({ error: 'Booking not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/bookings/:slug/:id ───────────────────────────────────────────
// Modify a booking
router.put('/:slug/:id', async (req, res) => {
  try {
    const { status, special_requests } = req.body;

    const { data, error } = await db
      .from('entity_bookings')
      .update({
        ...(status && { status }),
        ...(special_requests !== undefined && { special_requests: special_requests?.trim() || null }),
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, booking: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/bookings/:slug/:id ────────────────────────────────────────
// Cancel a booking
router.delete('/:slug/:id', async (req, res) => {
  try {
    const { data: booking } = await db
      .from('entity_bookings')
      .select('*')
      .eq('id', req.params.id)
      .eq('entity_slug', req.params.slug)
      .single();

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Delete booking
    await db
      .from('entity_bookings')
      .delete()
      .eq('id', req.params.id);

    // Decrement availability
    const { data: availability } = await db
      .from('entity_availability')
      .select('*')
      .eq('entity_slug', req.params.slug)
      .eq('available_date', booking.booking_date)
      .single();

    if (availability && availability.booked_slots > 0) {
      await db
        .from('entity_availability')
        .update({ booked_slots: availability.booked_slots - 1 })
        .eq('id', availability.id);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
