const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// POST /api/artist-bookings — public, request to book artist
router.post('/', async (req, res) => {
  try {
    const {
      artist_slug,
      entity_id,
      entity_name,
      booking_date,
      start_time,
      end_time,
      notes,
      requested_by_phone,
    } = req.body;

    // Get artist by slug
    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id')
      .eq('slug', artist_slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Create booking request
    const { data: booking, error: insertError } = await db
      .from('artist_bookings')
      .insert({
        artist_id: artist.id,
        entity_id,
        entity_name,
        booking_date,
        start_time: start_time || null,
        end_time: end_time || null,
        notes: notes || null,
        requested_by_phone: requested_by_phone || null,
        booking_status: 'pending',
      })
      .select()
      .single();

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    return res.status(201).json({
      booking_id: booking.id,
      message: 'Booking request sent to artist',
    });
  } catch (err) {
    console.error('Create booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/artist-bookings/:booking_id — get individual artist booking
router.get('/detail/:booking_id', async (req, res) => {
  try {
    const { booking_id } = req.params;

    const { data: booking, error } = await db
      .from('artist_bookings')
      .select('*')
      .eq('id', booking_id)
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

// GET /api/artist-bookings/:artist_slug — get artist's bookings (for dashboard)
router.get('/:artist_slug', authRequired, async (req, res) => {
  try {
    const { artist_slug } = req.params;

    const { data: artist } = await db
      .from('artist_profiles')
      .select('id')
      .eq('slug', artist_slug)
      .eq('is_active', true)
      .maybeSingle();

    if (!artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const { data: bookings, error } = await db
      .from('artist_bookings')
      .select('*')
      .eq('artist_id', artist.id)
      .order('booking_date', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(bookings || []);
  } catch (err) {
    console.error('Get bookings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/artist-bookings/:booking_id — accept/decline booking
router.patch('/:booking_id', authRequired, async (req, res) => {
  try {
    const { booking_id } = req.params;
    const { status } = req.body; // 'accepted' or 'declined'

    if (!['accepted', 'declined'].includes(status)) {
      return res.status(400).json({ error: 'Status must be accepted or declined' });
    }

    const updateData = {
      booking_status: status,
    };

    if (status === 'accepted') {
      updateData.accepted_at = new Date().toISOString();
    } else if (status === 'declined') {
      updateData.declined_at = new Date().toISOString();
    }

    const { data: booking, error } = await db
      .from('artist_bookings')
      .update(updateData)
      .eq('id', booking_id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({
      booking_id: booking.id,
      status: booking.booking_status,
      message: status === 'accepted' ? 'Booking accepted!' : 'Booking declined',
    });
  } catch (err) {
    console.error('Update booking error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
