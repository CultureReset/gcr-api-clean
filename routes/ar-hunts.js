// ============================================
// AR Hunts — brand-sponsored GPS scavenger hunt locations
// Admin creates a hunt at a lat/lng with a hint, difficulty, and reward.
// Tourists discover and "capture" them via the public app.
// ============================================

const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

// Map a DB row to the shape admin.html's inline hunt manager expects
// (matches the localStorage object it used to read/write directly)
function toClientShape(row) {
    return {
        id: row.id,
        brandName: row.brand_name,
        imageData: row.brand_image || null,
        latitude: row.lat,
        longitude: row.lng,
        hint: row.hint || '',
        difficulty: row.difficulty || 'medium',
        reward: row.reward_description || row.reward_value || '',
        points: row.points_value || 100,
        active: row.active !== false,
        captures: row.capture_count || 0,
        createdAt: row.created_at,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin / Dashboard — authenticated
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ar-hunts — list all hunts (admin sees everything)
router.get('/', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('ar_hunts')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(toClientShape));
});

// POST /api/ar-hunts — create a hunt
// Body matches admin.html's saveHunt(): { brandName, imageData, latitude, longitude, hint, difficulty, reward, points }
router.post('/', authRequired, async (req, res) => {
    const { brandName, imageData, latitude, longitude, hint, difficulty, reward, points } = req.body;
    if (!brandName || !String(brandName).trim()) return res.status(400).json({ error: 'brandName required' });
    if (latitude == null || longitude == null) return res.status(400).json({ error: 'latitude and longitude required' });

    const row = {
        brand_name: String(brandName).trim(),
        brand_image: imageData || null,
        lat: parseFloat(latitude),
        lng: parseFloat(longitude),
        hint: hint || null,
        difficulty: ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium',
        reward_description: reward || null,
        points_value: points != null ? parseInt(points, 10) : 100,
        active: true,
        capture_count: 0,
    };

    const { data, error } = await supabase.from('ar_hunts').insert(row).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, hunt: toClientShape(data) });
});

// PATCH /api/ar-hunts/:id — partial update (used for toggle active, edits)
router.patch('/:id', authRequired, async (req, res) => {
    const updates = {};
    const b = req.body;
    if (b.brandName !== undefined) updates.brand_name = b.brandName;
    if (b.imageData !== undefined) updates.brand_image = b.imageData;
    if (b.latitude !== undefined) updates.lat = parseFloat(b.latitude);
    if (b.longitude !== undefined) updates.lng = parseFloat(b.longitude);
    if (b.hint !== undefined) updates.hint = b.hint;
    if (b.difficulty !== undefined) updates.difficulty = b.difficulty;
    if (b.reward !== undefined) updates.reward_description = b.reward;
    if (b.points !== undefined) updates.points_value = parseInt(b.points, 10);
    if (b.active !== undefined) updates.active = !!b.active;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('ar_hunts')
        .update(updates)
        .eq('id', req.params.id)
        .select('*')
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, hunt: toClientShape(data) });
});

// DELETE /api/ar-hunts/:id
router.delete('/:id', authRequired, async (req, res) => {
    const { error } = await supabase.from('ar_hunts').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public — no auth (tourist-facing discovery + capture)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ar-hunts/nearby?lat=&lng=&radius=500 — active hunts within radius (meters)
router.get('/nearby', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 500;
    if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });

    const { data, error } = await supabase.from('ar_hunts').select('*').eq('active', true);
    if (error) return res.status(500).json({ error: error.message });

    const toRad = d => d * Math.PI / 180;
    const distMeters = (lat1, lon1, lat2, lon2) => {
        const R = 6371000;
        const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const nearby = (data || [])
        .map(h => ({ ...h, _distance: distMeters(lat, lng, h.lat, h.lng) }))
        .filter(h => h._distance <= radius)
        .sort((a, b) => a._distance - b._distance)
        .map(h => ({ ...toClientShape(h), distanceMeters: Math.round(h._distance) }));

    res.json(nearby);
});

// POST /api/ar-hunts/:id/capture — tourist captures a hunt item
// Body: { user_id?, lat, lng }
router.post('/:id/capture', async (req, res) => {
    const { user_id, lat, lng } = req.body;
    const { data: hunt, error: huntErr } = await supabase.from('ar_hunts').select('id, active, capture_count, reward_code').eq('id', req.params.id).single();
    if (huntErr || !hunt) return res.status(404).json({ error: 'Hunt not found' });
    if (!hunt.active) return res.status(403).json({ error: 'Hunt is not active' });

    const { error: captureErr } = await supabase.from('ar_hunt_captures').insert({
        hunt_id: hunt.id,
        user_id: user_id || null,
        lat: lat != null ? parseFloat(lat) : null,
        lng: lng != null ? parseFloat(lng) : null,
    });
    if (captureErr) return res.status(500).json({ error: captureErr.message });

    await supabase.from('ar_hunts').update({ capture_count: (hunt.capture_count || 0) + 1 }).eq('id', hunt.id);

    res.json({ success: true, reward_code: hunt.reward_code || null });
});

module.exports = router;
