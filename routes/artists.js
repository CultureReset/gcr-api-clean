const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function genReqCode() {
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `REQ-${ts}${rand}`;
}

async function genReqCodeRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const code = genReqCode();
    const { data: existing } = await db
      .from('song_requests')
      .select('id')
      .eq('req_code', code)
      .maybeSingle();
    if (!existing) return code;
  }
  throw new Error('Failed to generate unique REQ code after retries');
}

// GET / — public, list all active artists
router.get('/', async (req, res) => {
  try {
    const { data: profiles, error } = await db
      .from('artist_profiles')
      .select(
        'id, artist_name, slug, bio, photo_url, cashtag, venmo, request_enabled, shoutout_enabled, default_min_request_amount, songs, events, instagram_url, spotify_url, youtube_url, booking_url'
      )
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(profiles || []);
  } catch (err) {
    console.error('List artists error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug — public, get artist profile
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { data: profile, error } = await db
      .from('artist_profiles')
      .select(
        'id, artist_name, slug, bio, photo_url, cashtag, venmo, request_enabled, shoutout_enabled, default_min_request_amount, songs, events, instagram_url, spotify_url, youtube_url, booking_url'
      )
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !profile) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    return res.json(profile);
  } catch (err) {
    console.error('Get artist error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:slug/request — public, create song request
router.post('/:slug/request', async (req, res) => {
  try {
    const { slug } = req.params;
    const {
      fan_name,
      fan_phone,
      song_title,
      note,
      amount,
      rush,
      request_type,
      site_id,
      entity_id,
      venue_name,
    } = req.body;

    // Get artist
    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id, site_id, cashtag, venmo, default_min_request_amount')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Validate required fields -- a song title only makes sense for an
    // actual song request; shoutouts need a message, tips need neither.
    if (request_type === 'shoutout' && !note) {
      return res.status(400).json({ error: 'note required for a shoutout' });
    }
    if ((!request_type || request_type === 'song') && !song_title) {
      return res.status(400).json({ error: 'song_title required' });
    }

    // Generate REQ code
    const req_code = await genReqCodeRetry();

    // Set default amount if not provided
    const finalAmount = amount || artist.default_min_request_amount || 5;
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

    // Create song request
    const { data: request, error: insertError } = await db
      .from('song_requests')
      .insert({
        artist_id: artist.id,
        fan_name,
        fan_phone: fan_phone || null,
        song_title,
        note: note || null,
        amount: finalAmount,
        rush: rush || false,
        request_type: request_type || 'song',
        req_code,
        payment_status: 'pending',
        request_status: 'submitted',
        site_id: site_id || null,
        entity_id: entity_id || null,
        venue_name: venue_name || null,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    return res.json({
      req_code,
      artist_name: artist.id, // Return artist ID so frontend can reference
      cashtag: artist.cashtag,
      venmo: artist.venmo,
      amount: finalAmount,
      song_title,
      request_id: request.id,
    });
  } catch (err) {
    console.error('Create request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug/queue — public, get live queue
router.get('/:slug/queue', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Get all non-expired, non-skipped requests, ordered by created_at
    const { data: queue, error: queueError } = await db
      .from('song_requests')
      .select('id, fan_name, song_title, payment_status, request_status, rush, created_at, amount, note')
      .eq('artist_id', artist.id)
      .neq('request_status', 'skipped')
      .neq('request_status', 'expired')
      .order('created_at', { ascending: true });

    if (queueError) {
      return res.status(400).json({ error: queueError.message });
    }

    return res.json(queue || []);
  } catch (err) {
    console.error('Get queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /:slug/queue/:id — authRequired, update request status
router.patch('/:slug/queue/:id', authRequired, async (req, res) => {
  try {
    const { slug, id } = req.params;
    const { status } = req.body;

    if (!['played', 'skipped', 'accepted'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id, site_id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Verify this request belongs to this artist
    const { data: request, error: reqError } = await db
      .from('song_requests')
      .select('artist_id')
      .eq('id', id)
      .maybeSingle();

    if (reqError || !request || request.artist_id !== artist.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Update status
    const updateData = { request_status: status };
    if (status === 'played') {
      updateData.played_at = new Date().toISOString();
    } else if (status === 'skipped') {
      updateData.skipped_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await db
      .from('song_requests')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    return res.json(updated);
  } catch (err) {
    console.error('Update request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST / — authRequired, create artist profile
router.post('/', authRequired, async (req, res) => {
  try {
    const { artist_name, slug, cashtag, venmo, bio, photo_url, site_id } = req.body;

    if (!artist_name || !slug) {
      return res.status(400).json({ error: 'artist_name and slug required' });
    }

    const { data: profile, error } = await db
      .from('artist_profiles')
      .insert({
        artist_name,
        slug,
        cashtag: cashtag || null,
        venmo: venmo || null,
        bio: bio || null,
        photo_url: photo_url || null,
        site_id: site_id || null,
        owner_user_id: req.userId || null,
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json(profile);
  } catch (err) {
    console.error('Create artist error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /:slug — authRequired, update artist profile
router.patch('/:slug', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const updates = req.body;

    // Remove sensitive fields
    delete updates.id;
    delete updates.created_at;

    const { data: profile, error } = await db
      .from('artist_profiles')
      .update(updates)
      .eq('slug', slug)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json(profile);
  } catch (err) {
    console.error('Update artist error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
