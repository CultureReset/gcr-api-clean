const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { getArtist, listArtists, EDITABLE } = require('../lib/artist');

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

// GET / — public, every active artist with their next show.
//
// Reads artist_profiles and artists together, and gets the shows from
// entity_events. It used to read artist_profiles alone and hand back its
// `events` jsonb column, which is empty on all 390 rows — so no artist has
// ever shown a date, while 317 of them have real ones in entity_events.
router.get('/', async (req, res) => {
  try {
    return res.json({ artists: await listArtists() });
  } catch (err) {
    console.error('List artists error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug — public, the complete artist: profile, links, shows, setlist.
router.get('/:slug', async (req, res) => {
  try {
    const artist = await getArtist(req.params.slug);
    if (!artist || !artist.is_active) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    return res.json(artist);
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

/**
 * May this signed-in user edit this artist?
 *
 * Admins always. Otherwise the account has to be tied to the slug, by either
 * `users.artist_slug` or `artist_profiles.owner_user_id`. Neither is populated
 * on any row yet, so today only an admin passes — which matches reality: no
 * artist has a login. Linking an account to a slug is what turns that on.
 */
async function canEditArtist(req, slug) {
  if (req.role === 'admin') return true;
  if (!req.userId) return false;

  const { data: acct } = await db
    .from('users').select('artist_slug').eq('id', req.userId).maybeSingle();
  if (acct && acct.artist_slug === slug) return true;

  const { data: profile } = await db
    .from('artist_profiles').select('owner_user_id').eq('slug', slug).maybeSingle();
  return !!(profile && profile.owner_user_id && profile.owner_user_id === req.userId);
}

// PATCH /:slug — the artist's own dashboard writes here.
//
// One write target: artist_profiles, keyed by slug. Whatever the artist saves
// is what GET /:slug hands back, so the dashboard, the GCR Unified page and
// any embed of the link all move together. Fields not in EDITABLE are dropped
// rather than rejected, so a dashboard can post its whole form back.
router.patch('/:slug', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;

    if (!(await canEditArtist(req, slug))) {
      return res.status(403).json({ error: 'Not allowed to edit this artist' });
    }

    const updates = {};
    for (const key of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No editable fields supplied' });
    }
    updates.updated_at = new Date().toISOString();

    const { error } = await db
      .from('artist_profiles')
      .update(updates)
      .eq('slug', slug);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Hand back the same shape the public page reads, so the dashboard renders
    // what a fan will see rather than its own idea of it.
    return res.json(await getArtist(slug));
  } catch (err) {
    console.error('Update artist error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
