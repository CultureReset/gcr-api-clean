const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// GET /api/services — list all active services
router.get('/', async (req, res) => {
  try {
    const { data: resources, error } = await db
      .from('bookable_resources')
      .select('*')
      .eq('is_active', true)
      .eq('resource_type', 'service')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(resources || []);
  } catch (err) {
    console.error('List services error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/:slug — get service details
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: resource, error } = await db
      .from('bookable_resources')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !resource) {
      return res.status(404).json({ error: 'Service not found' });
    }

    return res.json(resource);
  } catch (err) {
    console.error('Get service error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/:slug/availability — check available times
router.get('/:slug/availability', async (req, res) => {
  try {
    const { slug } = req.params;
    const { date, time } = req.query;

    const { data: resource, error: resourceError } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (resourceError || !resource) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Check for bookings on that date
    const { data: bookings } = await db
      .from('booking_events')
      .select('check_in_time')
      .eq('resource_id', resource.id)
      .eq('booking_status', 'confirmed')
      .eq('check_in_date', date);

    // Check for blocks
    const { data: blocks } = await db
      .from('availability_blocks')
      .select('id')
      .eq('resource_id', resource.id)
      .lte('block_date_start', date)
      .gte('block_date_end', date);

    const bookedTimes = bookings?.map(b => b.check_in_time) || [];
    const available = !blocks?.length;

    return res.json({
      available,
      date,
      booked_times: bookedTimes,
    });
  } catch (err) {
    console.error('Check availability error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/services/:slug/bookings — book service
router.post('/:slug/bookings', async (req, res) => {
  try {
    const { slug } = req.params;
    const {
      guest_name,
      guest_email,
      guest_phone,
      check_in_date,
      check_in_time,
      notes,
    } = req.body;

    const { data: resource, error: resourceError } = await db
      .from('bookable_resources')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (resourceError || !resource) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const total_price = resource.nightly_price || 0;

    const { data: booking, error: insertError } = await db
      .from('booking_events')
      .insert({
        site_id: slug,
        resource_id: resource.id,
        guest_name,
        guest_email: guest_email || null,
        guest_phone: guest_phone || null,
        num_guests: 1,
        check_in_date,
        check_out_date: check_in_date,
        check_in_time: check_in_time || null,
        num_nights: 0,
        nightly_rate: resource.nightly_price || 0,
        subtotal: total_price,
        cleaning_fee: 0,
        service_fee: 0,
        total_price,
        notes: notes || null,
        booking_status: 'pending',
        source_platform: 'cybercheck',
      })
      .select()
      .single();

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    return res.status(201).json({
      booking_id: booking.id,
      total_price: booking.total_price,
      message: 'Service booking requested',
    });
  } catch (err) {
    console.error('Create service booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/:slug/bookings/:booking_id — get individual booking
router.get('/:slug/bookings/:booking_id', async (req, res) => {
  try {
    const { slug, booking_id } = req.params;

    const { data: resource } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!resource) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const { data: booking, error } = await db
      .from('booking_events')
      .select('*')
      .eq('id', booking_id)
      .eq('resource_id', resource.id)
      .maybeSingle();

    if (error || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.json(booking);
  } catch (err) {
    console.error('Get booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/:slug/bookings — get service bookings (for owner)
router.get('/:slug/bookings', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: resource } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!resource) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const { data: bookings, error } = await db
      .from('booking_events')
      .select('*')
      .eq('resource_id', resource.id)
      .order('check_in_date', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(bookings || []);
  } catch (err) {
    console.error('Get bookings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/services/:slug/bookings/:booking_id — update service booking
router.patch('/:slug/bookings/:booking_id', authRequired, async (req, res) => {
  try {
    const { slug, booking_id } = req.params;
    const { booking_status } = req.body;

    const updateData = { booking_status };

    if (booking_status === 'confirmed') {
      updateData.checked_in_at = new Date().toISOString();
    } else if (booking_status === 'completed') {
      updateData.checked_out_at = new Date().toISOString();
    }

    const { data: booking, error } = await db
      .from('booking_events')
      .update(updateData)
      .eq('id', booking_id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json(booking);
  } catch (err) {
    console.error('Update booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
