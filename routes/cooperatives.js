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
      .from('cooperative_contributions')
      .select('id')
      .eq('req_code', code)
      .maybeSingle();
    if (!existing) return code;
  }
  throw new Error('Failed to generate unique REQ code after retries');
}

// POST /:slug/cooperatives — authRequired, create cooperative
router.post('/:slug/cooperatives', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const { song_title, target_amount, goal_date } = req.body;

    if (!song_title || !target_amount) {
      return res.status(400).json({ error: 'song_title and target_amount required' });
    }

    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const { data: coop, error } = await db
      .from('song_cooperatives')
      .insert({
        artist_id: artist.id,
        song_title,
        target_amount: parseFloat(target_amount),
        goal_date: goal_date || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json(coop);
  } catch (err) {
    console.error('Create cooperative error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug/cooperatives — public, list cooperatives
router.get('/:slug/cooperatives', async (req, res) => {
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

    const { data: coops, error } = await db
      .from('song_cooperatives')
      .select('*')
      .eq('artist_id', artist.id)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json(coops || []);
  } catch (err) {
    console.error('Get cooperatives error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug/cooperatives/:id — public, get cooperative details
router.get('/:slug/cooperatives/:id', async (req, res) => {
  try {
    const { slug, id } = req.params;

    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const { data: coop, error: coopError } = await db
      .from('song_cooperatives')
      .select('*')
      .eq('id', id)
      .eq('artist_id', artist.id)
      .maybeSingle();

    if (coopError || !coop) {
      return res.status(404).json({ error: 'Cooperative not found' });
    }

    // Get contributions (without phone numbers for public view)
    const { data: contributions } = await db
      .from('cooperative_contributions')
      .select('id, fan_name, amount, payment_status, paid_at')
      .eq('coop_id', id)
      .eq('payment_status', 'paid')
      .order('paid_at', { ascending: false });

    return res.json({
      ...coop,
      contributions: contributions || [],
    });
  } catch (err) {
    console.error('Get cooperative error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:slug/cooperatives/:id/contribute — public, add funds to cooperative
router.post('/:slug/cooperatives/:id/contribute', async (req, res) => {
  try {
    const { slug, id } = req.params;
    const { fan_name, fan_phone, amount } = req.body;

    if (!amount) {
      return res.status(400).json({ error: 'amount required' });
    }

    const { data: artist, error: artistError } = await db
      .from('artist_profiles')
      .select('id')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (artistError || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const { data: coop, error: coopError } = await db
      .from('song_cooperatives')
      .select('*')
      .eq('id', id)
      .eq('artist_id', artist.id)
      .maybeSingle();

    if (coopError || !coop) {
      return res.status(404).json({ error: 'Cooperative not found' });
    }

    if (coop.status === 'funded' || coop.status === 'cancelled') {
      return res.status(400).json({ error: `Cooperative is ${coop.status}` });
    }

    const req_code = await genReqCodeRetry();

    const { data: contribution, error } = await db
      .from('cooperative_contributions')
      .insert({
        coop_id: id,
        fan_name: fan_name || null,
        fan_phone: fan_phone || null,
        amount: parseFloat(amount),
        req_code,
        payment_status: 'pending',
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({
      req_code,
      contribution_id: contribution.id,
      song_title: coop.song_title,
      target_amount: coop.target_amount,
      current_amount: coop.current_amount,
      amount,
    });
  } catch (err) {
    console.error('Contribute to cooperative error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
