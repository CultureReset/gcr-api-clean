const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// GET /api/rentals — list all active rentals
router.get('/', async (req, res) => {
  try {
    const { data: resources, error } = await db
      .from('bookable_resources')
      .select('*')
      .eq('is_active', true)
      .eq('resource_type', 'condo')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(resources || []);
  } catch (err) {
    console.error('List rentals error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rentals/:slug — get rental details
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
      return res.status(404).json({ error: 'Rental not found' });
    }

    return res.json(resource);
  } catch (err) {
    console.error('Get rental error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rentals/:slug/availability — check available dates
router.get('/:slug/availability', async (req, res) => {
  try {
    const { slug } = req.params;
    const { check_in, check_out } = req.query;

    const { data: resource, error: resourceError } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (resourceError || !resource) {
      return res.status(404).json({ error: 'Rental not found' });
    }

    // Check for bookings in date range
    const { data: conflictingBookings, error: bookingError } = await db
      .from('booking_events')
      .select('id')
      .eq('resource_id', resource.id)
      .eq('booking_status', 'confirmed')
      .gte('check_out_date', check_in)
      .lte('check_in_date', check_out);

    // Check for manual blocks
    const { data: blocks, error: blockError } = await db
      .from('availability_blocks')
      .select('id')
      .eq('resource_id', resource.id)
      .gte('block_date_end', check_in)
      .lte('block_date_start', check_out);

    const available = !conflictingBookings?.length && !blocks?.length;

    return res.json({
      available,
      check_in,
      check_out,
      conflicts: conflictingBookings?.length || 0,
      blocks: blocks?.length || 0,
    });
  } catch (err) {
    console.error('Check availability error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rentals/:slug/bookings — create booking
router.post('/:slug/bookings', async (req, res) => {
  try {
    const { slug } = req.params;
    const {
      guest_name,
      guest_email,
      guest_phone,
      num_guests,
      check_in_date,
      check_out_date,
      check_in_time,
      nightly_rate,
      cleaning_fee,
      service_fee,
      notes,
    } = req.body;

    // Get resource
    const { data: resource, error: resourceError } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (resourceError || !resource) {
      return res.status(404).json({ error: 'Rental not found' });
    }

    // Calculate nights
    const start = new Date(check_in_date);
    const end = new Date(check_out_date);
    const num_nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    const subtotal = (nightly_rate || 100) * num_nights;
    const total_price = subtotal + (cleaning_fee || 0) + (service_fee || 0);

    // Create booking
    const { data: booking, error: insertError } = await db
      .from('booking_events')
      .insert({
        site_id: slug,
        resource_id: resource.id,
        guest_name,
        guest_email: guest_email || null,
        guest_phone: guest_phone || null,
        num_guests: num_guests || 1,
        check_in_date,
        check_out_date,
        check_in_time: check_in_time || null,
        num_nights,
        nightly_rate: nightly_rate || 100,
        subtotal,
        cleaning_fee: cleaning_fee || 0,
        service_fee: service_fee || 0,
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
      message: 'Booking created. Awaiting payment.',
    });
  } catch (err) {
    console.error('Create booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rentals/:slug/bookings/:booking_id — get individual booking
//
// Behind a token. This returns the whole booking_events row — the guest's
// name, email, phone and what they paid — and the booking id was the only
// thing standing in front of it. No frontend in any of the four repos calls
// this route, so requiring a token costs nothing and closes a public read of
// somebody else's customer.
//
// A token is not yet proof that the caller owns THIS slug — see the note on
// the list route below.
router.get('/:slug/bookings/:booking_id', authRequired, async (req, res) => {
  try {
    const { slug, booking_id } = req.params;

    const { data: resource } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!resource) {
      return res.status(404).json({ error: 'Rental not found' });
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

// GET /api/rentals/:slug/bookings — get bookings (for owner dashboard)
//
// OPEN: "for owner dashboard" is the intent, not what is enforced.
// authRequired proves a token is valid; it does not prove the token owns this
// slug. It is also broader than it looks — middleware/auth.js falls through to
// "any valid Supabase user in this project" and assigns role 'owner', and
// tourist accounts are Supabase users in that same project. So a tourist
// signup can read every guest name, email and phone on this route.
//
// Closing it needs one decision first: bookable_resources.slug is a resource
// slug, and entity_owners is keyed by entity_slug, so the ownership path has
// to be settled before a guard can be written. Same applies to the PATCH
// below and to the matching routes in services.js and bookings.js.
router.get('/:slug/bookings', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: resource } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!resource) {
      return res.status(404).json({ error: 'Rental not found' });
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

// PATCH /api/rentals/:slug/bookings/:booking_id — update booking
router.patch('/:slug/bookings/:booking_id', authRequired, async (req, res) => {
  try {
    const { slug, booking_id } = req.params;
    const { booking_status, check_in_sent, check_out_sent } = req.body;

    const updateData = {};
    if (booking_status) updateData.booking_status = booking_status;
    if (check_in_sent !== undefined) updateData.check_in_sent = check_in_sent;
    if (check_out_sent !== undefined) updateData.check_out_sent = check_out_sent;

    if (booking_status === 'checked_in') updateData.checked_in_at = new Date().toISOString();
    if (booking_status === 'checked_out') updateData.checked_out_at = new Date().toISOString();

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

// POST /api/rentals/:slug/availability-blocks — create availability block
router.post('/:slug/availability-blocks', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const { block_date_start, block_date_end, block_type, reason } = req.body;

    const { data: resource } = await db
      .from('bookable_resources')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!resource) {
      return res.status(404).json({ error: 'Rental not found' });
    }

    const { data: block, error } = await db
      .from('availability_blocks')
      .insert({
        resource_id: resource.id,
        block_date_start,
        block_date_end,
        block_type: block_type || 'blocked',
        reason: reason || null,
        created_by: 'dashboard',
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json(block);
  } catch (err) {
    console.error('Create block error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
