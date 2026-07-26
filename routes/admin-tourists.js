/**
 * Admin — view/edit tourist users (trip-swipe signups).
 * All routes require admin JWT.
 *
 *   GET    /api/admin/tourists                 — list (summary with counts)
 *   GET    /api/admin/tourists/:user_id        — detail (profile + saves + itinerary + auth)
 *   DELETE /api/admin/tourists/:user_id/saves/:save_id
 *   DELETE /api/admin/tourists/:user_id/itinerary/:itin_id
 *   DELETE /api/admin/tourists/:user_id        — delete auth user (cascades profile/saves/itinerary)
 */

const express = require('express');
const mainDb = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

// Reuse the same GCR Supabase client every write path (tourist-auth.js,
// sms.js, tourist.js) already uses -- service-role, so it can also do
// sb.auth.admin.* calls. This used to build its own client from
// SUPABASE_URL/SUPABASE_SERVICE_KEY, which aren't the env vars actually
// configured for this project (GCR_SUPABASE_URL/GCR_SUPABASE_SERVICE_KEY
// are, per .env.example and every other file in this repo), so every
// route below was very likely failing to connect at all.
function admin() {
    return mainDb;
}

router.get('/', adminRequired, async (req, res) => {
    const sb = admin();
    const [{ data: profiles }, { data: savesCounts }, { data: itinCounts }] = await Promise.all([
        sb.from('tourist_profiles').select('*'),
        sb.from('tourist_saves').select('user_id'),
        sb.from('tourist_itineraries').select('user_id'),
    ]);

    // Auth users via admin API
    const { data: authList } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const authUsers = authList?.users || [];

    const savesByUser = {};
    (savesCounts || []).forEach(r => { savesByUser[r.user_id] = (savesByUser[r.user_id] || 0) + 1; });
    const itinByUser = {};
    (itinCounts || []).forEach(r => { itinByUser[r.user_id] = (itinByUser[r.user_id] || 0) + 1; });
    const profByUser = {};
    (profiles || []).forEach(p => { profByUser[p.user_id] = p; });

    // Only include users who have any tourist_* record (so we don't show non-tourist auth users)
    const touristIds = new Set([
        ...Object.keys(savesByUser),
        ...Object.keys(itinByUser),
        ...Object.keys(profByUser),
    ]);

    const tourists = authUsers
        .filter(u => touristIds.has(u.id))
        .map(u => {
            const p = profByUser[u.id] || {};
            return {
                user_id: u.id,
                email: u.email,
                email_confirmed: !!u.email_confirmed_at,
                created_at: u.created_at,
                last_sign_in_at: u.last_sign_in_at,
                name: p.name || null,
                phone: p.phone || null,
                sms_opt_in: !!p.sms_opt_in,
                signup_channel: p.phone ? 'phone' : 'email',
                destination: p.destination || null,
                arrival: p.arrival || null,
                departure: p.departure || null,
                trip_days: p.trip_days || null,
                group_type: p.group_type || null,
                saves_count: savesByUser[u.id] || 0,
                itineraries_count: itinByUser[u.id] || 0,
                setup_complete: !!p.setup_complete,
            };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ tourists });
});

router.get('/:user_id', adminRequired, async (req, res) => {
    const sb = admin();
    const uid = req.params.user_id;
    const [{ data: profile }, { data: saves }, { data: itineraries }, { data: authUser }] = await Promise.all([
        sb.from('tourist_profiles').select('*').eq('user_id', uid).maybeSingle(),
        sb.from('tourist_saves').select('*').eq('user_id', uid).order('saved_at', { ascending: false }),
        sb.from('tourist_itineraries').select('*').eq('user_id', uid).order('updated_at', { ascending: false }),
        sb.auth.admin.getUserById(uid).then(r => ({ data: r.data?.user })).catch(() => ({ data: null })),
    ]);
    if (!authUser && !profile) return res.status(404).json({ error: 'Tourist not found' });
    res.json({
        user: authUser ? {
            id: authUser.id, email: authUser.email,
            email_confirmed: !!authUser.email_confirmed_at,
            created_at: authUser.created_at, last_sign_in_at: authUser.last_sign_in_at,
        } : { id: uid },
        profile: profile || null,
        saves: saves || [],
        itineraries: itineraries || [],
    });
});

router.delete('/:user_id/saves/:save_id', adminRequired, async (req, res) => {
    const { error } = await admin().from('tourist_saves')
        .delete().eq('id', req.params.save_id).eq('user_id', req.params.user_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.delete('/:user_id/itinerary/:itin_id', adminRequired, async (req, res) => {
    const { error } = await admin().from('tourist_itineraries')
        .delete().eq('id', req.params.itin_id).eq('user_id', req.params.user_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.delete('/:user_id', adminRequired, async (req, res) => {
    // Deleting the auth user cascades delete to tourist_* tables via FK
    const { error } = await admin().auth.admin.deleteUser(req.params.user_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// GET /api/admin/tourists/:user_id/preferences — full preference scores for one tourist
router.get('/:user_id/preferences', adminRequired, async (req, res) => {
    const db = admin();
    const uid = req.params.user_id;

    const [scoresRes, swipeRes, savesRes] = await Promise.all([
        db.from('user_preference_scores').select('tag, score, updated_at').eq('user_id', uid).order('score', { ascending: false }),
        db.from('tourist_swipe_events').select('direction').eq('tourist_id', uid),
        db.from('tourist_saves').select('id').eq('user_id', uid),
    ]);

    const all = scoresRes.data || [];
    const counts = { like: 0, nope: 0, super: 0 };
    for (const s of (swipeRes.data || [])) counts[s.direction] = (counts[s.direction] || 0) + 1;

    res.json({
        loves:        all.filter(s => s.score >= 20),
        likes:        all.filter(s => s.score > 0 && s.score < 20),
        dislikes:     all.filter(s => s.score < 0),
        total_tags:   all.length,
        swipe_counts: counts,
        saves_count:  (savesRes.data || []).length,
        top_tags:     all.filter(s => s.score > 0).slice(0, 20).map(s => s.tag),
    });
});

// POST /api/admin/tourists/:user_id/recompute-preferences — rebuild scores from full history
router.post('/:user_id/recompute-preferences', adminRequired, async (req, res) => {
    const uid = req.params.user_id;
    res.json({ ok: true, message: 'Recomputing in background…' });
    // Import the recompute function from tourist.js by calling the endpoint internally
    // We trigger it by calling the shared logic directly
    try {
        const touristRouter = require('./tourist');
        if (typeof touristRouter._recomputeAllPreferences === 'function') {
            touristRouter._recomputeAllPreferences(uid).catch(() => {});
        }
    } catch {}
});

module.exports = router;
