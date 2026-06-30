// ============================================
// AR Hunts — brand-sponsored GPS scavenger hunt locations
// Admin creates a hunt at a lat/lng with a hint, difficulty, and reward.
// Tourists discover and "capture" them via the public app.
// ============================================

const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

const CAPTURE_RADIUS_METERS = 35; // ~115ft — must be physically at the spot to capture
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 8; // per client per window, across all hunts

function distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function makeRewardCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// Best-effort client identifier for rate limiting — IP is what we have without
// requiring auth (this endpoint must work for anonymous tourists)
function clientKey(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

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
        maxCaptures: row.max_captures ?? null,
        startsAt: row.starts_at || null,
        endsAt: row.ends_at || null,
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
    const { brandName, imageData, latitude, longitude, hint, difficulty, reward, points, maxCaptures, startsAt, endsAt } = req.body;
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
        max_captures: maxCaptures != null && maxCaptures !== '' ? parseInt(maxCaptures, 10) : null,
        starts_at: startsAt || null,
        ends_at: endsAt || null,
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
    if (b.maxCaptures !== undefined) updates.max_captures = b.maxCaptures === '' || b.maxCaptures == null ? null : parseInt(b.maxCaptures, 10);
    if (b.startsAt !== undefined) updates.starts_at = b.startsAt || null;
    if (b.endsAt !== undefined) updates.ends_at = b.endsAt || null;
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

    const now = new Date();
    const nearby = (data || [])
        .map(h => ({ ...h, _distance: distanceMeters(lat, lng, h.lat, h.lng) }))
        .filter(h => h._distance <= radius)
        .sort((a, b) => a._distance - b._distance)
        .map(h => {
            const notStarted = h.starts_at && new Date(h.starts_at) > now;
            const ended = h.ends_at && new Date(h.ends_at) < now;
            const soldOut = h.max_captures != null && (h.capture_count || 0) >= h.max_captures;
            return {
                ...toClientShape(h),
                distanceMeters: Math.round(h._distance),
                soldOut,
                notStarted,
                ended,
            };
        });

    res.json(nearby);
});

// POST /api/ar-hunts/:id/capture — tourist captures a hunt item
// Body: { user_id?, lat, lng }
// SECURITY: distance is verified server-side against the hunt's real coordinates.
// The client-submitted lat/lng is never trusted for the "are you close enough" decision —
// it's only logged for the capture record. Faking GPS in devtools cannot earn a reward.
router.post('/:id/capture', async (req, res) => {
    const { user_id, lat, lng } = req.body;
    const key = clientKey(req);

    if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
    const userLat = parseFloat(lat), userLng = parseFloat(lng);
    if (Number.isNaN(userLat) || Number.isNaN(userLng)) return res.status(400).json({ error: 'Invalid coordinates' });

    // ── Rate limit: N attempts per client per rolling window, across all hunts ──
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { count: recentAttempts } = await supabase
        .from('ar_hunt_capture_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('client_key', key)
        .gte('attempted_at', windowStart);
    if ((recentAttempts || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    }

    const { data: hunt, error: huntErr } = await supabase
        .from('ar_hunts')
        .select('id, lat, lng, active, capture_count, max_captures, starts_at, ends_at')
        .eq('id', req.params.id)
        .single();
    if (huntErr || !hunt) return res.status(404).json({ error: 'Hunt not found' });

    const logAttempt = (success) =>
        supabase.from('ar_hunt_capture_attempts').insert({ client_key: key, hunt_id: hunt.id, success }).then(() => {});

    if (!hunt.active) { logAttempt(false); return res.status(403).json({ error: 'Hunt is not active' }); }

    const now = new Date();
    if (hunt.starts_at && new Date(hunt.starts_at) > now) { logAttempt(false); return res.status(403).json({ error: 'This hunt has not started yet' }); }
    if (hunt.ends_at && new Date(hunt.ends_at) < now) { logAttempt(false); return res.status(403).json({ error: 'This hunt has ended' }); }
    if (hunt.max_captures != null && (hunt.capture_count || 0) >= hunt.max_captures) {
        logAttempt(false);
        return res.status(409).json({ error: 'All rewards for this hunt have been claimed' });
    }

    // ── The actual security check: real distance from the hunt's real coordinates ──
    const dist = distanceMeters(userLat, userLng, hunt.lat, hunt.lng);
    if (dist > CAPTURE_RADIUS_METERS) {
        logAttempt(false);
        return res.status(403).json({ error: `You're too far away (${Math.round(dist)}m). Get closer to capture this item.` });
    }

    // Prevent the same device from re-capturing a hunt it already captured (best-effort —
    // user_id is optional/anonymous, so this is a courtesy check, not the only protection)
    if (user_id) {
        const { data: existing } = await supabase
            .from('ar_hunt_captures')
            .select('id, reward_code')
            .eq('hunt_id', hunt.id)
            .eq('user_id', user_id)
            .maybeSingle();
        if (existing) {
            logAttempt(false);
            return res.status(409).json({ error: 'You already captured this item', reward_code: existing.reward_code });
        }
    }

    const rewardCode = makeRewardCode();
    const { error: captureErr } = await supabase.from('ar_hunt_captures').insert({
        hunt_id: hunt.id,
        user_id: user_id || null,
        lat: userLat,
        lng: userLng,
        distance_meters: dist,
        reward_code: rewardCode,
    });
    if (captureErr) return res.status(500).json({ error: captureErr.message });

    await supabase.from('ar_hunts').update({ capture_count: (hunt.capture_count || 0) + 1 }).eq('id', hunt.id);
    logAttempt(true);

    res.json({ success: true, reward_code: rewardCode });
});

// POST /api/ar-hunts/redeem — business staff redeems a reward code at point of sale
// Body: { reward_code, redeemed_by? }  (redeemed_by = staff name/identifier, optional)
router.post('/redeem', authRequired, async (req, res) => {
    const { reward_code, redeemed_by } = req.body;
    if (!reward_code || !String(reward_code).trim()) return res.status(400).json({ error: 'reward_code required' });

    const code = String(reward_code).trim().toUpperCase();
    const { data: capture, error } = await supabase
        .from('ar_hunt_captures')
        .select('id, hunt_id, redeemed_at, captured_at, ar_hunts(brand_name, reward_description)')
        .eq('reward_code', code)
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!capture) return res.status(404).json({ error: 'Reward code not found' });
    if (capture.redeemed_at) {
        return res.status(409).json({
            error: 'This code has already been redeemed',
            redeemed_at: capture.redeemed_at,
        });
    }

    const { error: updateErr } = await supabase
        .from('ar_hunt_captures')
        .update({ redeemed_at: new Date().toISOString(), redeemed_by: redeemed_by || null })
        .eq('id', capture.id);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    res.json({
        success: true,
        brand_name: capture.ar_hunts?.brand_name,
        reward: capture.ar_hunts?.reward_description,
        captured_at: capture.captured_at,
    });
});

// GET /api/ar-hunts/:id/captures — admin view of who captured + redemption status
router.get('/:id/captures', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('ar_hunt_captures')
        .select('id, user_id, lat, lng, distance_meters, reward_code, redeemed_at, redeemed_by, captured_at')
        .eq('hunt_id', req.params.id)
        .order('captured_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

module.exports = router;
