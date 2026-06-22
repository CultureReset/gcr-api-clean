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
      .from('goal_contributions')
      .select('id')
      .eq('req_code', code)
      .maybeSingle();
    if (!existing) return code;
  }
  throw new Error('Failed to generate unique REQ code after retries');
}

// POST /:slug/goals — authRequired, create goal
router.post('/:slug/goals', authRequired, async (req, res) => {
  try {
    const { slug } = req.params;
    const { goal_name, goal_type, description, target_amount, deadline } = req.body;

    if (!goal_name || !target_amount) {
      return res.status(400).json({ error: 'goal_name and target_amount required' });
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

    const { data: goal, error } = await db
      .from('artist_goals')
      .insert({
        artist_id: artist.id,
        goal_name,
        goal_type: goal_type || 'personal',
        description: description || null,
        target_amount: parseFloat(target_amount),
        deadline: deadline || null,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json(goal);
  } catch (err) {
    console.error('Create goal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug/goals — public, list goals
router.get('/:slug/goals', async (req, res) => {
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

    const { data: goals, error } = await db
      .from('artist_goals')
      .select('*')
      .eq('artist_id', artist.id)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json(goals || []);
  } catch (err) {
    console.error('Get goals error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:slug/goals/:id — public, get goal details
router.get('/:slug/goals/:id', async (req, res) => {
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

    const { data: goal, error: goalError } = await db
      .from('artist_goals')
      .select('*')
      .eq('id', id)
      .eq('artist_id', artist.id)
      .maybeSingle();

    if (goalError || !goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    // Get contributions (without phone numbers for public view)
    const { data: contributions } = await db
      .from('goal_contributions')
      .select('id, fan_name, amount, payment_status, paid_at')
      .eq('goal_id', id)
      .eq('payment_status', 'paid')
      .order('paid_at', { ascending: false });

    return res.json({
      ...goal,
      contributions: contributions || [],
    });
  } catch (err) {
    console.error('Get goal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:slug/goals/:id/contribute — public, add funds to goal
router.post('/:slug/goals/:id/contribute', async (req, res) => {
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

    const { data: goal, error: goalError } = await db
      .from('artist_goals')
      .select('*')
      .eq('id', id)
      .eq('artist_id', artist.id)
      .maybeSingle();

    if (goalError || !goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    if (goal.status === 'reached' || goal.status === 'expired' || goal.status === 'cancelled') {
      return res.status(400).json({ error: `Goal is ${goal.status}` });
    }

    const req_code = await genReqCodeRetry();

    const { data: contribution, error } = await db
      .from('goal_contributions')
      .insert({
        goal_id: id,
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
      goal_name: goal.goal_name,
      target_amount: goal.target_amount,
      current_amount: goal.current_amount,
      amount,
    });
  } catch (err) {
    console.error('Contribute to goal error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
