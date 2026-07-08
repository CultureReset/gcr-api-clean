/**
 * Tourist endpoints — for trip-swipe users (signed in via Supabase auth).
 *
 *  Tourist-facing (requires Supabase JWT from the tourist):
 *    GET    /api/tourist/me          — profile + saves + itinerary (bundle)
 *    GET    /api/tourist/saves       — list saved places
 *    POST   /api/tourist/saves       — upsert a save { entity_slug, business_name, ... }
 *    DELETE /api/tourist/saves/:slug — remove a save
 *    GET    /api/tourist/profile
 *    PUT    /api/tourist/profile     — upsert profile { name, destination, ... }
 *    GET    /api/tourist/itinerary   — latest itinerary
 *    PUT    /api/tourist/itinerary   — upsert { destination, days }
 *
 *  Admin-facing (requires admin JWT):
 *    GET    /api/admin/tourists                — list all tourists (summary)
 *    GET    /api/admin/tourists/:user_id       — detail (profile + saves + itinerary)
 *    DELETE /api/admin/tourists/:user_id/saves/:save_id
 *    DELETE /api/admin/tourists/:user_id       — delete a tourist (auth user + cascades)
 */

const express = require('express');
const multer = require('multer');
const twilio = require('twilio');
const mainDb = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

// Same Twilio number/credentials used everywhere else in the app (sms.js,
// tourist-auth.js) — one provider, one number, no separate config to manage.
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER || '+12513135464';
function sendTwilioText(to, body) {
    return twilio(TWILIO_SID, TWILIO_TOKEN).messages.create({ from: TWILIO_FROM, to, body });
}

// Tourist media (photo/video) uploads — held in memory, capped at 50MB for short video clips
const touristUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Tourist middleware: verify Supabase JWT, attach tourist user id ─────────
async function touristAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    const token = header.split(' ')[1];
    try {
        const { data, error } = await mainDb.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });
        req.touristId = data.user.id;
        req.touristEmail = data.user.email;
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Guest-tolerant variant: a real Supabase Bearer token still resolves to
// the real touristId exactly as touristAuth does, but a signed-out visitor
// can instead identify with an X-Guest-Id header (a UUID the client
// generates once and keeps in localStorage). None of tourist_swipe_events/
// tourist_seen/tourist_saves/user_preference_scores have a foreign key back
// to auth.users, so writing rows keyed by that guest UUID is safe — it just
// means a visitor's swipes/saves/preference signals get recorded from their
// very first interaction instead of only after they create an account.
// backfillAnonymousActivity() (tourist-auth.js) reassigns those rows to the
// real user id once they do sign up, using the same guest id as
// anonymous_visitor_id.
async function touristAuthOptional(req, res, next) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        const token = header.split(' ')[1];
        try {
            const { data, error } = await mainDb.auth.getUser(token);
            if (!error && data?.user) {
                req.touristId = data.user.id;
                req.touristEmail = data.user.email;
                req.isGuest = false;
                return next();
            }
        } catch (e) { /* fall through to guest id */ }
    }
    const guestId = req.headers['x-guest-id'];
    if (guestId && UUID_RE.test(guestId)) {
        req.touristId = guestId;
        req.isGuest = true;
        return next();
    }
    return res.status(401).json({ error: 'No token or guest id provided' });
}

// ═══════════════════════════════════════════════════════════════════════════
// Backfill anonymous activity to user (explicit endpoint for frontend)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/setup-questions', (req, res) => {
    res.json({
        questions: [
            { key: 'name', field_name: 'name', label: "What's your name?", input_type: 'text', placeholder: 'Your first name', required: true },
            { key: 'arrival', field_name: 'arrival', label: 'When are you visiting?', input_type: 'daterange', required: false },
            { key: 'group_type', field_name: 'group_type', label: "Who's joining you?", input_type: 'radio', required: false, options: [
                { value: 'solo', label: 'Solo', icon: '🙋' },
                { value: 'couple', label: 'Couple', icon: '👫' },
                { value: 'family', label: 'Family', icon: '👨‍👩‍👧' },
                { value: 'friends', label: 'Friends', icon: '👯' },
            ]},
            { key: 'interests', field_name: 'interests', label: 'What are you into?', input_type: 'tags', required: false, options: [
                { value: 'food', label: '🍽️ Food & Dining' },
                { value: 'nightlife', label: '🍻 Nightlife' },
                { value: 'beach', label: '🏖️ Beach' },
                { value: 'activities', label: '🎯 Activities' },
                { value: 'shopping', label: '🛍️ Shopping' },
                { value: 'music', label: '🎵 Live Music' },
                { value: 'family', label: '👨‍👩‍👧 Family Fun' },
                { value: 'nature', label: '🌿 Nature' },
            ]},
        ],
    });
});

router.post('/backfill-anonymous', touristAuth, async (req, res) => {
    const { anonymous_visitor_id } = req.body;
    if (!anonymous_visitor_id) {
        return res.status(400).json({ error: 'anonymous_visitor_id required' });
    }

    try {
        const results = await Promise.all([
            mainDb.from('gcr_page_views')
                .update({ user_id: req.touristId })
                .eq('visitor_id', anonymous_visitor_id)
                .is('user_id', null)
                .select('id', { count: 'exact' }),
            mainDb.from('session_events')
                .update({ user_id: req.touristId })
                .eq('visitor_id', anonymous_visitor_id)
                .is('user_id', null)
                .select('id', { count: 'exact' }),
            mainDb.from('qr_scans')
                .update({ user_id: req.touristId })
                .eq('visitor_id', anonymous_visitor_id)
                .is('user_id', null)
                .select('id', { count: 'exact' }),
        ]);

        res.json({
            ok: true,
            backfilled: {
                page_views: results[0]?.length || 0,
                session_events: results[1]?.length || 0,
                qr_scans: results[2]?.length || 0,
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// TOURIST — own data
// ═══════════════════════════════════════════════════════════════════════════

router.get('/me', touristAuth, async (req, res) => {
    const [{ data: profile }, { data: saves }, { data: itin }] = await Promise.all([
        mainDb.from('tourist_profiles').select('*').eq('user_id', req.touristId).maybeSingle(),
        mainDb.from('tourist_saves').select('id,entity_slug,entity_id,business_name,hero_image_url,subtitle,category,rating,price_range,is_super_like,saved_at').eq('user_id', req.touristId).order('saved_at', { ascending: false }),
        mainDb.from('tourist_itineraries').select('*').eq('user_id', req.touristId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    res.json({
        user: { id: req.touristId, email: req.touristEmail },
        profile: profile || null,
        saves: saves || [],
        itinerary: itin || null,
    });
});

// DELETE /api/tourist/seen — clear all seen slugs (reset swipe deck)
// DELETE /api/tourist/seen — clear all seen slugs (reset swipe deck)
router.delete('/seen', touristAuthOptional, async (req, res) => {
    const { error } = await mainDb.from('tourist_seen').delete().eq('tourist_id', req.touristId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// POST /api/tourist/seen — record swiped (seen) slugs so they don't reappear.
// Was previously a no-op stub (returned {ok:true} without touching the DB at
// all) despite tourist_seen already existing as a real table — every "seen"
// slug the frontend has ever sent has silently gone nowhere. Dedupes against
// what's already recorded so re-sending the same slug list doesn't pile up
// duplicate rows (tourist_seen has no unique constraint of its own).
router.post('/seen', touristAuthOptional, async (req, res) => {
    const { slugs } = req.body || {};
    if (!Array.isArray(slugs) || slugs.length === 0) return res.json({ ok: true, count: 0 });

    const { data: existing } = await mainDb.from('tourist_seen')
        .select('entity_slug').eq('tourist_id', req.touristId).in('entity_slug', slugs);
    const already = new Set((existing || []).map(r => r.entity_slug));
    const rows = [...new Set(slugs)].filter(s => !already.has(s)).map(entity_slug => ({
        tourist_id: req.touristId,
        entity_slug,
    }));
    if (rows.length === 0) return res.json({ ok: true, count: 0 });

    const { error } = await mainDb.from('tourist_seen').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: rows.length });
});

// tourist_saves.user_id has a real foreign key to auth.users (confirmed
// against the live DB — unlike tourist_swipe_events/tourist_seen/
// user_preference_scores, which don't) — a guest UUID with no matching
// auth.users row would fail every insert with a FK violation, so this one
// stays real-login-only. Saves still work fine locally (same browser) for
// a guest via localStorage; they just don't reach the server pre-signup.
router.get('/saves', touristAuth, async (req, res) => {
    const { data, error } = await mainDb.from('tourist_saves')
        .select('*').eq('user_id', req.touristId).order('saved_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ saves: data || [] });
});

router.post('/saves', touristAuth, async (req, res) => {
    const { entity_slug, entity_id, business_name, hero_image_url, subtitle, category, rating, price_range, is_super_like } = req.body || {};
    if (!entity_slug) return res.status(400).json({ error: 'entity_slug required' });
    const row = {
        user_id: req.touristId,
        entity_slug,
        entity_id: entity_id && /^[0-9a-f-]{36}$/i.test(String(entity_id)) ? entity_id : null,
        business_name: business_name || null,
        hero_image_url: hero_image_url || null,
        subtitle: subtitle || null,
        category: category || null,
        rating: rating ?? null,
        price_range: price_range || null,
        is_super_like: !!is_super_like,
    };
    let { data, error } = await mainDb.from('tourist_saves')
        .upsert(row, { onConflict: 'user_id,entity_slug' })
        .select().single();
    // If is_super_like column doesn't exist yet, retry without it
    if (error && error.message?.includes('is_super_like')) {
        const { is_super_like: _dropped, ...rowWithout } = row;
        ({ data, error } = await mainDb.from('tourist_saves')
            .upsert(rowWithout, { onConflict: 'user_id,entity_slug' })
            .select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ save: data });
});

// DELETE /api/tourist/super-likes/:slug — remove Must Do flag, keep save
router.delete('/super-likes/:slug', touristAuth, async (req, res) => {
    const { error } = await mainDb.from('tourist_saves')
        .update({ is_super_like: false })
        .eq('user_id', req.touristId)
        .eq('entity_slug', req.params.slug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// POST /api/tourist/swipes — record swipe direction per business for analytics
// POST /api/tourist/swipes — record swipe direction per business for analytics.
// The live tourist_swipe_events table is keyed by tourist_id/entity_name, not
// user_id/business_name — this insert was silently failing on every call
// (confirmed: the table had zero rows despite real signed-up tourists having
// used the app). Fixed to match the actual schema.
router.post('/swipes', touristAuthOptional, async (req, res) => {
    const { events } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) return res.status(400).json({ error: 'events array required' });
    const rows = events
        .filter(e => e.slug && e.direction)
        .map(e => ({
            tourist_id: req.touristId,
            entity_slug: e.slug,
            entity_name: e.business_name || null,
            category: e.category || null,
            direction: e.direction, // 'like' | 'nope' | 'super'
        }));
    if (rows.length === 0) return res.json({ ok: true, count: 0 });
    try {
        const { error } = await mainDb.from('tourist_swipe_events').insert(rows);
        if (error) {
            // Auto-create table if missing (shouldn't fire against the live
            // DB — the table already exists there — but keeps this endpoint
            // self-healing against a fresh/local DB with no migrations run).
            if (error.code === '42P01') {
                await mainDb.rpc('exec_sql', { sql: `
                    CREATE TABLE IF NOT EXISTS tourist_swipe_events (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        tourist_id UUID NOT NULL,
                        entity_slug TEXT NOT NULL,
                        entity_name TEXT,
                        category TEXT,
                        direction TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_tse_tourist ON tourist_swipe_events(tourist_id);
                    CREATE INDEX IF NOT EXISTS idx_tse_slug ON tourist_swipe_events(entity_slug);
                    CREATE INDEX IF NOT EXISTS idx_tse_dir ON tourist_swipe_events(direction);
                ` }).catch(() => {});
                await mainDb.from('tourist_swipe_events').insert(rows).catch((e) => {
                    console.error('[swipe] Retry after table create failed:', e?.message);
                    throw e;
                });
            } else {
                console.error('[swipe] Insert error:', error?.message);
                throw error;
            }
        }
        res.json({ ok: true, count: rows.length });

        // Fire-and-forget: update preference scores from swipe events
        updatePreferenceScores(req.touristId, rows).catch((err) => {
            console.error('[swipe] Preference update failed:', err?.message);
        });

    } catch (e) {
        console.error('[swipe] Request failed:', e?.message);
        return res.status(500).json({ error: 'Failed to save swipes', details: e?.message });
    }
});

// Score weights per swipe direction
const SWIPE_WEIGHTS = { like: 5, nope: -4, super: 15, save: 8, book: 20, view: 2, maybe: 1 };

// Fetch entity tags from the correct GCR tables (entity + entity_tags)
async function fetchEntityTagMap(slugs) {
    if (!slugs?.length) return {};
    const gcrDb = require('../db');
    const tagMap = {}; // slug → string[]

    try {
        // Fetch entity rows — correct table is 'entity' not 'entities'
        const { data: entities } = await gcrDb
            .from('entity')
            .select('id, slug, entity_type, entity_subtype')
            .in('slug', slugs);

        if (!entities?.length) return tagMap;

        const entityIds = entities.map(e => e.id);
        const entityById = Object.fromEntries(entities.map(e => [e.id, e]));
        const entityBySlug = Object.fromEntries(entities.map(e => [e.slug, e]));

        // Fetch tags from entity_tags table — this is where real tags live
        const { data: tagRows } = await gcrDb
            .from('entity_tags')
            .select('entity_id, tag')
            .in('entity_id', entityIds);

        // Build tag map per slug
        for (const e of entities) {
            const tags = new Set();
            if (e.entity_type)    tags.add(e.entity_type.toLowerCase().trim());
            if (e.entity_subtype) tags.add(e.entity_subtype.toLowerCase().trim());
            tagMap[e.slug] = tags;
        }

        for (const row of (tagRows || [])) {
            const entity = entityById[row.entity_id];
            if (!entity || !row.tag) continue;
            // Tags can be JSON-encoded strings
            let tagVal = row.tag;
            try { const p = JSON.parse(tagVal); tagVal = p?.tag || tagVal; } catch {}
            if (tagVal) tagMap[entity.slug]?.add(tagVal.toLowerCase().trim());
        }

        // Convert Sets to arrays
        for (const slug of Object.keys(tagMap)) {
            tagMap[slug] = [...tagMap[slug]].filter(Boolean);
        }
    } catch (err) {
        console.error('[preference] tag fetch error:', err?.message);
    }

    return tagMap;
}

// Write accumulated score deltas — uses RPC with clamping, falls back to SQL increment
async function applyScoreDeltas(touristId, updates) {
    // Aggregate deltas per tag so we do one write per tag
    const totals = {};
    for (const { tag, delta } of updates) {
        totals[tag] = (totals[tag] || 0) + delta;
    }

    for (const [tag, delta] of Object.entries(totals)) {
        const { error } = await mainDb.rpc('upsert_preference_score', {
            p_tourist_id: touristId,
            p_tag:        tag,
            p_delta:      delta,
        });
        if (error) console.error('[preference] upsert_preference_score failed:', error.message);
    }
}

async function updatePreferenceScores(touristId, swipeRows) {
    if (!touristId || !swipeRows?.length) return;

    const slugs = [...new Set(swipeRows.map(r => r.entity_slug).filter(Boolean))];
    const tagMap = await fetchEntityTagMap(slugs);

    const scoreUpdates = [];
    for (const row of swipeRows) {
        const weight = SWIPE_WEIGHTS[row.direction] || 0;
        if (!weight) continue;

        const tags = new Set(tagMap[row.entity_slug] || []);
        // Always score the category from the swipe event itself as a signal
        if (row.category) tags.add(row.category.toLowerCase().trim());

        for (const tag of tags) {
            scoreUpdates.push({ tag, delta: weight });
        }
    }

    if (!scoreUpdates.length) return;
    await applyScoreDeltas(touristId, scoreUpdates);
}

// Full recompute from swipe history — applies time decay so recent swipes matter more
// decay factor: swipes older than 30 days lose 20% weight, older than 90 days lose 50%
async function recomputeAllPreferences(touristId) {
    if (!touristId) return;

    // Wipe existing scores so we recompute clean
    await mainDb.from('user_preference_scores').delete().eq('user_id', touristId).catch(() => {});

    // Load full swipe history
    const { data: events } = await mainDb
        .from('tourist_swipe_events')
        .select('entity_slug, direction, category, created_at')
        .eq('tourist_id', touristId)
        .order('created_at', { ascending: false });

    if (!events?.length) return;

    const now = Date.now();
    const slugs = [...new Set(events.map(e => e.entity_slug).filter(Boolean))];
    const tagMap = await fetchEntityTagMap(slugs);

    const scoreUpdates = [];
    for (const ev of events) {
        const baseWeight = SWIPE_WEIGHTS[ev.direction] || 0;
        if (!baseWeight) continue;

        // Time decay
        const ageDays = (now - new Date(ev.created_at).getTime()) / (1000 * 60 * 60 * 24);
        const decay = ageDays > 90 ? 0.5 : ageDays > 30 ? 0.8 : 1.0;
        const weight = Math.round(baseWeight * decay);
        if (!weight) continue;

        const tags = new Set(tagMap[ev.entity_slug] || []);
        if (ev.category) tags.add(ev.category.toLowerCase().trim());

        for (const tag of tags) {
            scoreUpdates.push({ tag, delta: weight });
        }
    }

    // Also score saves (stronger signal than swipes)
    const { data: saves } = await mainDb
        .from('tourist_saves')
        .select('entity_slug, category, is_super_like, saved_at')
        .eq('user_id', touristId);

    for (const save of (saves || [])) {
        const baseWeight = save.is_super_like ? SWIPE_WEIGHTS.super : SWIPE_WEIGHTS.save;
        const ageDays = (now - new Date(save.saved_at).getTime()) / (1000 * 60 * 60 * 24);
        const decay = ageDays > 90 ? 0.5 : ageDays > 30 ? 0.8 : 1.0;
        const weight = Math.round(baseWeight * decay);

        const tags = new Set(tagMap[save.entity_slug] || []);
        if (save.category) tags.add(save.category.toLowerCase().trim());
        for (const tag of tags) scoreUpdates.push({ tag, delta: weight });
    }

    if (scoreUpdates.length) await applyScoreDeltas(touristId, scoreUpdates);
}

// GET /api/tourist/preferences — full preference profile for this user.
// touristAuthOptional so a guest's live deck can personalize from their own
// in-session swipes/saves too, not just after they create an account.
router.get('/preferences', touristAuthOptional, async (req, res) => {
    const touristId = req.touristId;

    const { data: scores } = await mainDb
        .from('user_preference_scores')
        .select('tag, score, updated_at')
        .eq('user_id', touristId)
        .order('score', { ascending: false });

    const all = scores || [];
    const loves    = all.filter(s => s.score >= 20).slice(0, 15);
    const likes    = all.filter(s => s.score > 0 && s.score < 20).slice(0, 10);
    const dislikes = all.filter(s => s.score < 0).slice(0, 10);

    // Swipe counts for context
    const { data: swipeStats } = await mainDb
        .from('tourist_swipe_events')
        .select('direction')
        .eq('tourist_id', touristId);

    const counts = { like: 0, nope: 0, super: 0 };
    for (const s of (swipeStats || [])) counts[s.direction] = (counts[s.direction] || 0) + 1;

    res.json({
        loves,
        likes,
        dislikes,
        total_tags: all.length,
        swipe_counts: counts,
        top_tags: loves.concat(likes).map(s => s.tag),
    });
});

// POST /api/tourist/recompute-preferences — rebuild all scores from full swipe history
router.post('/recompute-preferences', touristAuth, async (req, res) => {
    res.json({ ok: true, message: 'Recomputing in background…' });
    recomputeAllPreferences(req.touristId).catch(err =>
        console.error('[preference] recompute error:', err?.message)
    );
});

// GET /api/tourist/analytics — swipe trends and engagement metrics
router.get('/analytics', touristAuth, async (req, res) => {
    const touristId = req.touristId;

    try {
        const { data: events } = await mainDb
            .from('tourist_swipe_events')
            .select('direction, category, created_at')
            .eq('tourist_id', touristId)
            .order('created_at', { ascending: false });

        const { data: saves } = await mainDb
            .from('tourist_saves')
            .select('category, saved_at')
            .eq('user_id', touristId);

        // Calculate stats
        const directionCounts = { like: 0, nope: 0, super: 0 };
        const categoryCounts = {};
        const dailySwipes = {};

        for (const ev of (events || [])) {
            directionCounts[ev.direction] = (directionCounts[ev.direction] || 0) + 1;
            categoryCounts[ev.category] = (categoryCounts[ev.category] || 0) + 1;

            const date = new Date(ev.created_at).toISOString().split('T')[0];
            dailySwipes[date] = (dailySwipes[date] || 0) + 1;
        }

        const saveCounts = {};
        for (const s of (saves || [])) {
            saveCounts[s.category] = (saveCounts[s.category] || 0) + 1;
        }

        const totalSwipes = events?.length || 0;
        const likeRate = totalSwipes > 0 ? (directionCounts.like / totalSwipes * 100).toFixed(1) : 0;
        const avgSwipesPerDay = totalSwipes > 0 ? (totalSwipes / (Object.keys(dailySwipes).length || 1)).toFixed(1) : 0;

        res.json({
            total_swipes: totalSwipes,
            total_saves: saves?.length || 0,
            swipe_breakdown: directionCounts,
            like_rate: parseFloat(likeRate),
            category_distribution: categoryCounts,
            category_saves: saveCounts,
            daily_swipes: dailySwipes,
            avg_swipes_per_day: parseFloat(avgSwipesPerDay),
            first_swipe: events?.[events.length - 1]?.created_at || null,
            last_swipe: events?.[0]?.created_at || null,
        });
    } catch (e) {
        console.error('[analytics] Error:', e?.message);
        return res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// GET /api/tourist/recommendations — personalized businesses based on swipe + save history
router.get('/recommendations', touristAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '12'), 100);
    const exclude_saved = req.query.exclude_saved !== 'false';

    try {
        // Get user's saves and swipes to build preference weights
        const [{ data: saves }, { data: swipes }, { data: profile }] = await Promise.all([
            mainDb.from('tourist_saves')
                .select('category, entity_slug')
                .eq('user_id', req.touristId),
            mainDb.from('tourist_swipe_events')
                .select('category, direction')
                .eq('tourist_id', req.touristId),
            mainDb.from('tourist_profiles')
                .select('interests, seen_slugs:answers->seen_slugs')
                .eq('user_id', req.touristId)
                .maybeSingle(),
        ]);

        // Build category preference map (swipe:1 point, save:2 points)
        const categoryScores = {};
        for (const swipe of (swipes || [])) {
            if (swipe.direction === 'like' && swipe.category) {
                categoryScores[swipe.category] = (categoryScores[swipe.category] || 0) + 1;
            }
        }
        for (const save of (saves || [])) {
            if (save.category) {
                categoryScores[save.category] = (categoryScores[save.category] || 0) + 2;
            }
        }

        // Get seen slugs to exclude
        const seenSlugs = (profile?.seen_slugs || []).concat(
            (saves || []).map(s => s.entity_slug)
        );

        // Build query for recommended businesses
        // Prefer categories they've shown interest in, exclude seen
        let query = mainDb.from('entity')
            .select('slug, name, icon, subtitle, category, hero_image_url, rating, price_range')
            .eq('is_active', true)
            .limit(limit * 2); // Fetch 2x to filter

        if (exclude_saved && seenSlugs.length > 0) {
            query = query.not('slug', 'in', `(${seenSlugs.map(s => `"${s}"`).join(',')})`);
        }

        const { data: candidates } = await query;

        // Score and sort by preference match
        const scored = (candidates || []).map(biz => {
            const score = categoryScores[biz.category] || 0;
            return { ...biz, _score: score };
        });
        scored.sort((a, b) => b._score - a._score || (b.rating || 0) - (a.rating || 0));

        // Remove score field before returning
        const recommendations = scored.slice(0, limit).map(({ _score, ...rest }) => rest);

        // If no recommendations (new user), return featured businesses
        if (recommendations.length === 0) {
            const { data: featured } = await mainDb.from('entity')
                .select('slug, name, icon, subtitle, category, hero_image_url, rating, price_range')
                .eq('is_active', true)
                .eq('is_featured', true)
                .limit(limit);
            return res.json({ recommendations: featured || [], based_on: { saves: saves?.length || 0, swipes: swipes?.length || 0 } });
        }

        res.json({
            recommendations,
            based_on: { saves: saves?.length || 0, swipes: swipes?.length || 0 }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tourist/sms-optin — store phone + opt-in consent
router.post('/sms-optin', touristAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const { error } = await mainDb.from('tourist_profiles')
        .upsert({ user_id: req.touristId, phone, sms_opt_in: true, sms_opted_in_at: new Date().toISOString() },
                 { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// DELETE /api/tourist/sms-optin — opt out
router.delete('/sms-optin', touristAuth, async (req, res) => {
    await mainDb.from('tourist_profiles')
        .update({ sms_opt_in: false }).eq('user_id', req.touristId);
    res.json({ success: true });
});

router.delete('/saves/:slug', touristAuth, async (req, res) => {
    const { error } = await mainDb.from('tourist_saves')
        .delete().eq('user_id', req.touristId).eq('entity_slug', req.params.slug);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

router.get('/profile', touristAuth, async (req, res) => {
    const { data } = await mainDb.from('tourist_profiles').select('*').eq('user_id', req.touristId).maybeSingle();
    res.json({ profile: data || null });
});

router.put('/profile', touristAuth, async (req, res) => {
    const b = req.body || {};
    const row = {
        user_id: req.touristId,
        name: b.name || null,
        destination: b.destination || null,
        arrival: b.arrival || null,
        departure: b.departure || null,
        trip_days: b.trip_days || null,
        group_type: b.group_type || null,
        budget: b.budget || null,
        interests: b.interests || [],
        stay_status: b.stay_status || null,
        hotel_name: b.hotel_name || null,
        setup_complete: !!b.setup_complete,
    };
    const { data, error } = await mainDb.from('tourist_profiles')
        .upsert(row, { onConflict: 'user_id' })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ profile: data });
});

router.get('/itinerary', touristAuth, async (req, res) => {
    const { data } = await mainDb.from('tourist_itineraries')
        .select('*').eq('user_id', req.touristId)
        .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    res.json({ itinerary: data || null });
});

router.put('/itinerary', touristAuth, async (req, res) => {
    const { destination, days, model_used } = req.body || {};
    // Upsert by finding the most recent one; otherwise insert
    const { data: existing } = await mainDb.from('tourist_itineraries')
        .select('id').eq('user_id', req.touristId)
        .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (existing) {
        const { data, error } = await mainDb.from('tourist_itineraries')
            .update({ destination: destination || null, days: days || [], model_used: model_used || null })
            .eq('id', existing.id).eq('user_id', req.touristId)
            .select().single();
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ itinerary: data });
    }
    const { data, error } = await mainDb.from('tourist_itineraries')
        .insert({ user_id: req.touristId, destination: destination || null, days: days || [], model_used: model_used || null })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ itinerary: data });
});

// ═══════════════════════════════════════════════════════════════════════════
// Email itinerary via Brevo (info@cybercheckinc.com)
// ═══════════════════════════════════════════════════════════════════════════

const { sendEmail } = require('../utils/email');

router.post('/itinerary/email', touristAuth, async (req, res) => {
    const [{ data: itin }, { data: profile }] = await Promise.all([
        mainDb.from('tourist_itineraries').select('*').eq('user_id', req.touristId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
        mainDb.from('tourist_profiles').select('name,destination,arrival,departure').eq('user_id', req.touristId).maybeSingle(),
    ]);
    if (!itin || !itin.days?.length) return res.status(400).json({ error: 'No itinerary to email' });

    const destination = itin.destination || profile?.destination || 'Gulf Coast';
    const name = profile?.name || 'Traveler';
    const dateRange = profile?.arrival
        ? `${new Date(profile.arrival).toLocaleDateString('en-US',{month:'short',day:'numeric'})}${profile?.departure ? ' – ' + new Date(profile.departure).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}`
        : '';

    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const daysHtml = (itin.days || []).map(d => `
      <div style="margin:24px 0;padding:16px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;">
        <div style="font-size:14px;font-weight:700;color:#0ea5e9;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">${esc(d.date || ('Day ' + d.day))}</div>
        ${(d.slots || []).map(s => `
          <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #e5e7eb;">
            <div style="min-width:80px;font-size:13px;font-weight:700;color:#374151;">${esc(s.time || '')}</div>
            <div style="flex:1;">
              <div style="font-size:14px;font-weight:600;color:#111827;">${esc(s.business?.name || s.entity_slug || '')}</div>
              ${s.business?.subtitle ? `<div style="font-size:12px;color:#6b7280;">${esc(s.business.subtitle)}</div>` : ''}
              ${s.why || s.note ? `<div style="font-size:13px;color:#0ea5e9;margin-top:4px;">${esc(s.why || s.note)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;"><tr><td align="center">
    <table width="100%" style="max-width:640px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <tr><td style="background:linear-gradient(135deg,#0ea5e9,#7c6af7);padding:36px 32px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:26px;">🌊 Your ${esc(destination)} Trip</h1>
        ${dateRange ? `<p style="margin:8px 0 0;color:#e0f2fe;font-size:15px;">${esc(dateRange)}</p>` : ''}
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 20px;color:#374151;font-size:15px;">Hi ${esc(name)},</p>
        <p style="margin:0 0 20px;color:#374151;font-size:15px;">Here's your Gulf Coast Radar itinerary, built from the places you saved:</p>
        ${daysHtml}
        <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">Open the app anytime to edit, re-build, or add more spots. Your trip is saved across devices.</p>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">Sent automatically from Gulf Coast Radar.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

    const send = await sendEmail({
        to: req.touristEmail,
        subject: `🌊 Your ${destination} trip itinerary`,
        html,
    });
    if (!send.success) return res.status(500).json({ error: 'Failed to send email' });
    res.json({ success: true, sent_to: req.touristEmail });
});

// ═══════════════════════════════════════════════════════════════════════════
// AI — build itinerary from saved places + profile
// ═══════════════════════════════════════════════════════════════════════════

const { callAIRound } = require('./ai-provider');

router.post('/build-itinerary', touristAuth, async (req, res) => {
    const [{ data: profile }, { data: saves }] = await Promise.all([
        mainDb.from('tourist_profiles').select('*').eq('user_id', req.touristId).maybeSingle(),
        mainDb.from('tourist_saves').select('*').eq('user_id', req.touristId).order('saved_at', { ascending: false }),
    ]);
    if (!saves || saves.length < 2) return res.status(400).json({ error: 'Save at least 2 places first' });

    // Fetch richer detail (hours, tags) for each save from GCR entity endpoint
    const { createClient } = require('@supabase/supabase-js');
    const gcr = createClient(process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL, process.env.GCR_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY);
    const slugs = saves.map(s => s.entity_slug).filter(Boolean).slice(0, 20);
    const { data: entities } = slugs.length
        ? await gcr.from('entity').select('id,name,slug,subtitle,entity_type,entity_subtype,tags,hh_days,hh_start,hh_end,address_line_1,city,state,latitude,longitude,price_range,hero_image_url,booking_url,website_url,phone').in('slug', slugs)
        : { data: [] };

    const days = profile?.trip_days || 3;
    const destination = profile?.destination || 'Gulf Coast';
    const interests = Array.isArray(profile?.interests) ? profile.interests : [];
    const groupType = profile?.group_type || 'adults';
    const arrival = profile?.arrival || null;

    const placeList = (entities || []).map((e, i) => {
        const hh = e.hh_start && e.hh_end ? ` · happy hour ${e.hh_start}-${e.hh_end}` : '';
        const loc = [e.city, e.state].filter(Boolean).join(', ');
        const tagList = Array.isArray(e.tags) ? e.tags.slice(0, 4).map(t => typeof t === 'string' ? t : t.label || t.name).filter(Boolean).join(', ') : '';
        return `${i + 1}. ${e.name} (slug:${e.slug}) — ${e.entity_subtype || e.entity_type || 'place'}${e.subtitle ? ' · ' + e.subtitle : ''} · ${loc}${hh}${tagList ? ' · tags: ' + tagList : ''}`;
    }).join('\n');

    const systemPrompt = `You are a local trip planner for the Gulf Coast. Build a realistic, day-by-day itinerary from the user's saved places. Rules:
- Group activities by geographic proximity to minimize driving.
- Respect business category: breakfast spots morning, nightlife at night, activities/tours mid-day.
- Space out eating — not two restaurants in a row. Mix food, activity, beach/outdoor, nightlife.
- Exactly ${days} day(s). If fewer saves than slots, it's fine — leave slots empty.
- Each slot: {"time":"9:00 AM","entity_slug":"name-slug","why":"one short sentence"}.
- Return ONLY valid JSON matching this exact shape, no prose:
{"days":[{"date":"Day 1","slots":[{"time":"9:00 AM","entity_slug":"...","why":"..."}]}]}
- Use slugs from the provided list only. Don't invent businesses.`;

    const userPrompt = `Destination: ${destination}
Days: ${days}${arrival ? ' starting ' + arrival : ''}
Group: ${groupType}
Interests: ${interests.join(', ') || 'none specified'}

Saved places (${entities?.length || 0}):
${placeList || '(no enriched data)'}

Return the JSON itinerary now.`;

    try {
        const ai = await callAIRound({
            messages: [{ role: 'user', content: userPrompt }],
            systemPrompt,
            temperature: 0.4,
            maxTokens: 1800,
        });
        const text = ai?.text || ai?.content?.[0]?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return res.status(500).json({ error: 'AI returned no itinerary', raw: text.slice(0, 500) });
        let parsed;
        try { parsed = JSON.parse(match[0]); } catch(e) { return res.status(500).json({ error: 'AI returned invalid JSON', raw: match[0].slice(0, 500) }); }

        // Hydrate slots with business data for frontend
        const bySlug = {};
        (entities || []).forEach(e => { bySlug[e.slug] = e; });
        const slugToSave = {};
        (saves || []).forEach(s => { slugToSave[s.entity_slug] = s; });

        (parsed.days || []).forEach((d, idx) => {
            d.day = idx + 1;
            if (!d.date) d.date = 'Day ' + (idx + 1);
            (d.slots || []).forEach(slot => {
                const ent = bySlug[slot.entity_slug];
                const save = slugToSave[slot.entity_slug];
                const address = ent
                    ? [ent.address_line_1, ent.city, ent.state].filter(Boolean).join(', ')
                    : null;
                slot.business = ent ? {
                    id: ent.id, slug: ent.slug, name: ent.name,
                    subtitle: ent.subtitle,
                    hero_image_url: ent.hero_image_url || save?.hero_image_url || null,
                    rating: save?.rating || null,
                    price_range: ent.price_range || null,
                    booking_url: ent.booking_url || ent.website_url || null,
                    address,
                } : save ? {
                    id: save.entity_id, slug: save.entity_slug, name: save.business_name,
                    subtitle: save.subtitle, hero_image_url: save.hero_image_url,
                    rating: save.rating, price_range: save.price_range,
                    booking_url: null, address: null,
                } : { slug: slot.entity_slug, name: slot.entity_slug };
                slot.note = slot.why || slot.note || '';
            });
        });

        // Persist
        const payload = { destination, days: parsed.days || [], model_used: ai?.model || 'ai' };
        const { data: existing } = await mainDb.from('tourist_itineraries')
            .select('id').eq('user_id', req.touristId)
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (existing) {
            await mainDb.from('tourist_itineraries').update(payload).eq('id', existing.id).eq('user_id', req.touristId);
        } else {
            await mainDb.from('tourist_itineraries').insert({ user_id: req.touristId, ...payload });
        }

        res.json({ itinerary: { destination, days: parsed.days || [], model_used: payload.model_used } });
    } catch (err) {
        console.error('build-itinerary error:', err);
        res.status(500).json({ error: 'AI request failed: ' + err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// TOURIST AI CONCIERGE — chat with memory, fed live GCR data + tourist saves
// Dual-auth: real tourist token, OR admin token with ?as_tourist=USER_ID
// (admin testing surface lives in cybercheck-platform admin)
// ═══════════════════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');

async function touristOrAdminAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const token = header.split(' ')[1];

    // 1) Try admin JWT first (admin can impersonate any tourist via ?as_tourist=USER_ID)
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role === 'admin') {
            const asTourist = req.query.as_tourist || req.body?.as_tourist;
            if (!asTourist) return res.status(400).json({ error: 'Admin must pass as_tourist=USER_ID' });
            req.touristId = asTourist;
            req.touristEmail = `admin-test:${asTourist}`;
            req.isAdminImpersonating = true;
            return next();
        }
    } catch (e) { /* not an admin JWT — try tourist */ }

    // 2) Try tourist Supabase JWT
    try {
        const { data, error } = await mainDb.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });
        req.touristId = data.user.id;
        req.touristEmail = data.user.email;
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

router.post('/ai-chat', touristOrAdminAuth, async (req, res) => {
    const { message = '', history = [], image, url, conversation_id: clientConvId, lat: userLat, lng: userLng } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: 'Message required' });

    if (!process.env.ANTHROPIC_API_KEY) {
        return res.json({ reply: "AI concierge is being set up — check back soon!" });
    }

    const touristId = req.touristId;

    // Optional URL fetch
    let urlContent = '';
    if (url) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
            const html = await r.text();
            urlContent = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim().slice(0, 6000);
        } catch (e) { urlContent = `(Could not fetch ${url}: ${e.message})`; }
    }

    // Pull tourist context: profile, saves, memories
    const [profileRes, savesRes, memoriesRes] = await Promise.all([
        mainDb.from('tourist_profiles').select('name, destination, arrival, departure, trip_days, group_type, budget, interests, stay_status, hotel_name').eq('user_id', touristId).maybeSingle(),
        mainDb.from('tourist_saves').select('business_name, entity_slug, category, subtitle, rating, price_range').eq('user_id', touristId).order('saved_at', { ascending: false }).limit(50),
        mainDb.from('tourist_memories').select('category, key, value, tags').eq('user_id', touristId).order('updated_at', { ascending: false })
    ]);
    const profile   = profileRes.data || {};
    const saves     = savesRes.data || [];
    const memories  = memoriesRes.data || [];

    // Pull live GCR data — entities + menus + specials + pricing + activity details
    const gcrDb = require('../db');
    const hasUserLoc = userLat != null && userLng != null;
    const { data: gcrEntitiesRaw } = await gcrDb
        .from('entity')
        .select('name, slug, entity_type, entity_subtype, city, address_line_1, phone, website_url, rating, review_count, price_level, price_range_low, price_range_high, delivery, dine_in, takeout, curbside_pickup, reservable, outdoor_seating, live_music, serves_beer, serves_wine, serves_cocktails, serves_breakfast, serves_brunch, serves_lunch, serves_dinner, serves_vegetarian, serves_dessert, serves_coffee, good_for_groups, good_for_children, allows_dogs, editorial_summary, description, duration_text, price_from, price_unit, hh_days, hh_start, hh_end, hh_description, is_active, latitude, longitude')
        .eq('is_active', true)
        .order('rating', { ascending: false, nullsFirst: false })
        .limit(400);

    // If we know where the user is, compute distance and lead with proximity
    // instead of pure rating — otherwise a great, close-by spot can get cut
    // just for not being top-rated.
    let gcrEntities = gcrEntitiesRaw || [];
    if (hasUserLoc) {
        gcrEntities = gcrEntities.map(e => ({
            ...e,
            distance_mi: (e.latitude != null && e.longitude != null)
                ? distanceMiles(userLat, userLng, e.latitude, e.longitude)
                : null,
        })).sort((a, b) => (a.distance_mi ?? 9999) - (b.distance_mi ?? 9999));
    }
    gcrEntities = gcrEntities.slice(0, 200);

    const slugs = (gcrEntities || []).map(e => e.slug);

    // Fetch menus, specials, pricing, happy hour items in parallel
    const [menuSectionsRes, menuItemsRes, drinkSectionsRes, drinkItemsRes, specialsRes, pricingRes, hhSectionsRes, hhItemsRes, whatsIncludedRes] = await Promise.all([
        slugs.length ? gcrDb.from('menu_sections').select('id, entity_slug, name').in('entity_slug', slugs) : { data: [] },
        slugs.length ? gcrDb.from('menu_items').select('section_id, name, description, price, is_available').eq('is_available', true) : { data: [] },
        slugs.length ? gcrDb.from('drink_sections').select('id, entity_slug, name').in('entity_slug', slugs) : { data: [] },
        slugs.length ? gcrDb.from('drink_items').select('section_id, name, description, price').limit(2000) : { data: [] },
        slugs.length ? gcrDb.from('entity_specials').select('entity_slug, title, description, price, days_active, is_active').in('entity_slug', slugs).eq('is_active', true) : { data: [] },
        slugs.length ? gcrDb.from('pricing_items').select('entity_id, item_name, price, description, capacity_min, capacity_max, duration_minutes').limit(2000) : { data: [] },
        slugs.length ? gcrDb.from('happy_hour_sections').select('id, entity_slug, name').in('entity_slug', slugs) : { data: [] },
        slugs.length ? gcrDb.from('happy_hour_items').select('section_id, name, description, price').limit(1000) : { data: [] },
        slugs.length ? gcrDb.from('whats_included').select('entity_id, item').limit(2000) : { data: [] },
    ]);

    // Build lookup maps
    const menuSecMap = {};
    (menuSectionsRes.data || []).forEach(s => { menuSecMap[s.id] = { slug: s.entity_slug, name: s.name }; });
    const menuItemsBySlug = {};
    (menuItemsRes.data || []).forEach(item => {
        const sec = menuSecMap[item.section_id];
        if (!sec) return;
        if (!menuItemsBySlug[sec.slug]) menuItemsBySlug[sec.slug] = [];
        menuItemsBySlug[sec.slug].push({ section: sec.name, name: item.name, desc: item.description, price: item.price });
    });

    const drinkSecMap = {};
    (drinkSectionsRes.data || []).forEach(s => { drinkSecMap[s.id] = { slug: s.entity_slug, name: s.name }; });
    const drinkItemsBySlug = {};
    (drinkItemsRes.data || []).forEach(item => {
        const sec = drinkSecMap[item.section_id];
        if (!sec) return;
        if (!drinkItemsBySlug[sec.slug]) drinkItemsBySlug[sec.slug] = [];
        drinkItemsBySlug[sec.slug].push({ section: sec.name, name: item.name, desc: item.description, price: item.price });
    });

    const specialsBySlug = {};
    (specialsRes.data || []).forEach(s => {
        if (!specialsBySlug[s.entity_slug]) specialsBySlug[s.entity_slug] = [];
        specialsBySlug[s.entity_slug].push(s);
    });

    const entityIdMap = {};
    (gcrEntities || []).forEach(e => { if (e.id) entityIdMap[e.id] = e.slug; });
    const pricingBySlug = {};
    (pricingRes.data || []).forEach(p => {
        const slug = entityIdMap[p.entity_id];
        if (!slug) return;
        if (!pricingBySlug[slug]) pricingBySlug[slug] = [];
        pricingBySlug[slug].push(p);
    });
    const whatsIncludedBySlug = {};
    (whatsIncludedRes.data || []).forEach(w => {
        const slug = entityIdMap[w.entity_id];
        if (!slug) return;
        if (!whatsIncludedBySlug[slug]) whatsIncludedBySlug[slug] = [];
        whatsIncludedBySlug[slug].push(w.item);
    });

    const hhSecMap = {};
    (hhSectionsRes.data || []).forEach(s => { hhSecMap[s.id] = { slug: s.entity_slug, name: s.name }; });
    const hhItemsBySlug = {};
    (hhItemsRes.data || []).forEach(item => {
        const sec = hhSecMap[item.section_id];
        if (!sec) return;
        if (!hhItemsBySlug[sec.slug]) hhItemsBySlug[sec.slug] = [];
        hhItemsBySlug[sec.slug].push({ section: sec.name, name: item.name, desc: item.description, price: item.price });
    });

    const gcrContext = (gcrEntities || []).map(e => {
        const type = [e.entity_type, e.entity_subtype].filter(Boolean).join('/');
        const priceLevel = e.price_level ? '💰'.repeat(Math.min(e.price_level, 4)) : '';
        const priceRange = e.price_range_low && e.price_range_high ? ` ($${e.price_range_low}–$${e.price_range_high})` : '';
        const features = [
            e.outdoor_seating && 'outdoor seating',
            e.live_music && 'live music',
            e.delivery && 'delivery',
            e.dine_in && 'dine-in',
            e.takeout && 'takeout',
            e.reservable && 'reservations',
            e.good_for_groups && 'good for groups',
            e.good_for_children && 'kid-friendly',
            e.allows_dogs && 'dog-friendly',
            e.serves_breakfast && 'breakfast',
            e.serves_brunch && 'brunch',
            e.serves_lunch && 'lunch',
            e.serves_dinner && 'dinner',
            e.serves_beer && 'beer',
            e.serves_wine && 'wine',
            e.serves_cocktails && 'cocktails',
            e.serves_vegetarian && 'vegetarian options',
        ].filter(Boolean).join(', ');

        let lines = `• ${e.name} [${type}] ${e.city || ''} ${e.rating ? `⭐${e.rating} (${e.review_count || 0} reviews)` : ''} ${priceLevel}${priceRange}`;
        if (e.distance_mi != null) lines += ` · 📍${e.distance_mi.toFixed(1)}mi from user`;
        if (e.address_line_1) lines += `\n  📍 ${e.address_line_1}, ${e.city || ''}`;
        if (e.phone) lines += ` · 📞 ${e.phone}`;
        const blurb = e.description || e.editorial_summary;
        if (blurb) lines += `\n  ${blurb.slice(0, 120)}`;
        if (features) lines += `\n  Features: ${features}`;

        // Activity pricing
        if (e.price_from != null) lines += `\n  Price: ${e.price_from === 0 ? 'Free' : `From $${e.price_from}${e.price_unit ? `/${e.price_unit}` : ''}`}`;
        if (e.duration_text) lines += ` · Duration: ${e.duration_text}`;

        // Happy hour
        if (e.hh_days) lines += `\n  🍺 Happy Hour: ${e.hh_days} ${e.hh_start || ''}–${e.hh_end || ''} ${e.hh_description ? `— ${e.hh_description.slice(0, 100)}` : ''}`;

        // Specials
        const specials = specialsBySlug[e.slug] || [];
        if (specials.length) {
            lines += `\n  Specials: ${specials.map(s => `${s.title}${s.price ? ` ($${s.price})` : ''}${s.description ? ` — ${s.description.slice(0, 60)}` : ''}${s.days_active ? ` [${s.days_active}]` : ''}`).join(' | ')}`;
        }

        // Pricing items (activities/tours) with capacity and duration
        const pricing = pricingBySlug[e.slug] || [];
        if (pricing.length) {
            lines += `\n  Pricing: ${pricing.slice(0, 8).map(p => {
                let s = `${p.item_name} $${p.price}`;
                if (p.capacity_min && p.capacity_max) s += ` (${p.capacity_min}–${p.capacity_max} people)`;
                else if (p.capacity_max) s += ` (up to ${p.capacity_max} people)`;
                if (p.duration_minutes) s += ` · ${p.duration_minutes}min`;
                if (p.description) s += ` — ${p.description.slice(0, 50)}`;
                return s;
            }).join(' | ')}`;
        }

        // What's included
        const included = whatsIncludedBySlug[e.slug] || [];
        if (included.length) lines += `\n  Includes: ${included.join(', ')}`;

        // Menu items (top 8 per place to keep prompt size reasonable)
        const menuItems = menuItemsBySlug[e.slug] || [];
        if (menuItems.length) {
            lines += `\n  Menu: ${menuItems.slice(0, 8).map(i => `${i.name}${i.price ? ` $${i.price}` : ''}${i.desc ? ` (${i.desc.slice(0, 40)})` : ''}`).join(' | ')}`;
        }

        // Drink items
        const drinkItems = drinkItemsBySlug[e.slug] || [];
        if (drinkItems.length) {
            lines += `\n  Drinks: ${drinkItems.slice(0, 6).map(i => `${i.name}${i.price ? ` $${i.price}` : ''}`).join(' | ')}`;
        }

        // Happy hour items
        const hhItems = hhItemsBySlug[e.slug] || [];
        if (hhItems.length) {
            lines += `\n  HH deals: ${hhItems.slice(0, 6).map(i => `${i.name}${i.price ? ` $${i.price}` : ''}`).join(' | ')}`;
        }

        lines += `\n  (slug: ${e.slug})`;
        return lines;
    }).join('\n\n');

    // Group memories
    let memoryBlock = '';
    if (memories.length) {
        const byCat = {};
        memories.forEach(m => { (byCat[m.category] = byCat[m.category] || []).push(m); });
        const labels = { preference:'PREFERENCES', fact:'KNOWN FACTS', goal:'GOALS', decision:'PAST DECISIONS', recurring:'RECURRING TOPICS', note:'NOTES' };
        memoryBlock = '\n\nWHAT YOU REMEMBER ABOUT THIS TRAVELER (from past chats):\n';
        Object.keys(labels).forEach(cat => {
            if (!byCat[cat]) return;
            memoryBlock += `\n${labels[cat]}:\n`;
            byCat[cat].forEach(m => { memoryBlock += `  • [${m.key}] ${m.value}${m.tags?.length ? ` (${m.tags.join(', ')})` : ''}\n`; });
        });
    }

    // Build profile block
    let profileBlock = '';
    if (profile.name) profileBlock += `Name: ${profile.name}\n`;
    if (profile.destination) profileBlock += `Destination: ${profile.destination}\n`;
    if (profile.arrival && profile.departure) profileBlock += `Trip dates: ${profile.arrival} → ${profile.departure}${profile.trip_days ? ` (${profile.trip_days} days)` : ''}\n`;
    if (profile.group_type) profileBlock += `Group: ${profile.group_type}\n`;
    if (profile.budget) profileBlock += `Budget: ${profile.budget}\n`;
    if (profile.hotel_name) profileBlock += `Staying at: ${profile.hotel_name}\n`;
    if (profile.interests?.length) profileBlock += `Interests: ${profile.interests.join(', ')}\n`;

    let savesBlock = '';
    if (saves.length) {
        savesBlock = '\nPLACES THEY ALREADY SAVED:\n';
        saves.slice(0, 25).forEach(s => {
            savesBlock += `• ${s.business_name} [${s.category || s.subtitle || ''}]${s.rating ? ` ⭐${s.rating}` : ''}\n`;
        });
    }

    const systemPrompt = `You are the GulfCoast Concierge — a warm, enthusiastic local who's lived on the Alabama Gulf Coast forever and knows every spot. You're chatting with ${profile.name || 'a traveler'} as their personal trip planner.

YOU ARE TALKING TO:
${profileBlock || '(unknown traveler)'}
${savesBlock}${memoryBlock}

LIVE GULF COAST DATA (only recommend places from this list — never invent):
${gcrContext}
${urlContent ? `\nWEBPAGE CONTENT (URL they shared):\n${urlContent}\n` : ''}
${hasUserLoc ? `\nThe traveler's current location is known — each place above shows its distance from them. Prefer closer options when relevant, but don't force it if a farther spot is clearly the better fit.\n` : ''}
HOW TO CHAT:
- Warm, casual, fun — like texting a friend who's a local. Short sentences.
- Drop in local flavor: "trust me on this one", "locals don't even tell tourists about this spot"
- Ask follow-ups to keep it going: "How many in your group?", "Date night or family?", "Crab or oysters mood?"
- Recommend 1-2 specific spots — not a list of 5. Use the slug from the data so the app can link to it.
- Add a local tip: "Get there before 6 or you'll wait 45 min", "Sit on the patio if you can"
- Reference their saved places naturally if relevant ("since you already saved Harbor Docks…")

MEMORY (you remember across chats):
- When they share durable info (dietary restrictions, group composition, allergies, must-do/avoid lists, return-trip patterns), call save_memory
- Categories: preference / fact / goal / decision / recurring / note
- Keep memories concise and tagged. Don't save trivia.
- If memory is outdated, update_memory or delete_memory

HARD RULES:
- Only recommend places from the LIVE GULF COAST DATA above
- Keep replies under 100 words unless they ask for a full plan
- No phone numbers — they're chatting with you, not calling the place`;

    // ── Tools ──
    const tools = [
        {
            name: 'save_memory',
            description: 'Remember a durable fact, preference, or pattern about this traveler. Auto-upserts on (category, key).',
            input_schema: {
                type: 'object',
                properties: {
                    category:   { type: 'string', enum: ['preference','fact','goal','decision','recurring','note'] },
                    key:        { type: 'string', description: 'Short slug like "dietary" or "favorite_neighborhood"' },
                    value:      { type: 'string' },
                    tags:       { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'string', enum: ['high','medium','low'] }
                },
                required: ['category','key','value']
            }
        },
        {
            name: 'update_memory',
            description: 'Update an existing memory (when info has changed)',
            input_schema: {
                type: 'object',
                properties: {
                    category:  { type: 'string', enum: ['preference','fact','goal','decision','recurring','note'] },
                    key:       { type: 'string' },
                    new_value: { type: 'string' }
                },
                required: ['category','key','new_value']
            }
        },
        {
            name: 'delete_memory',
            description: 'Forget a memory',
            input_schema: {
                type: 'object',
                properties: {
                    category: { type: 'string', enum: ['preference','fact','goal','decision','recurring','note'] },
                    key:      { type: 'string' }
                },
                required: ['category','key']
            }
        }
    ];

    async function executeTool(name, input) {
        if (name === 'save_memory') {
            const row = { user_id: touristId, category: input.category, key: input.key, value: input.value, tags: input.tags || [], confidence: input.confidence || 'medium', source_message: (message || '').slice(0, 500), updated_at: new Date().toISOString() };
            const { error } = await mainDb.from('tourist_memories').upsert(row, { onConflict: 'user_id,category,key' });
            if (error) return { error: error.message };
            return { success: true, saved_key: input.key, category: input.category };
        }
        if (name === 'update_memory') {
            const { error } = await mainDb.from('tourist_memories').update({ value: input.new_value, updated_at: new Date().toISOString() }).eq('user_id', touristId).eq('category', input.category).eq('key', input.key);
            if (error) return { error: error.message };
            return { success: true, updated_key: input.key };
        }
        if (name === 'delete_memory') {
            const { error } = await mainDb.from('tourist_memories').delete().eq('user_id', touristId).eq('category', input.category).eq('key', input.key);
            if (error) return { error: error.message };
            return { success: true, deleted_key: input.key };
        }
        return { error: 'Unknown tool' };
    }

    try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const userContent = [];
        if (image && image.base64) {
            userContent.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType || 'image/jpeg', data: image.base64 } });
        }
        userContent.push({ type: 'text', text: message || 'What do you see in this image?' });

        const messages = [
            ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userContent.length > 1 ? userContent : (message || 'What do you see in this image?') }
        ];

        const toolResults = [];
        let finalReply = '';
        let loopMessages = [...messages];

        for (let i = 0; i < 4; i++) {
            const response = await client.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 2048,
                system: systemPrompt,
                tools,
                messages: loopMessages
            });

            if (response.stop_reason === 'end_turn') {
                finalReply = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
                break;
            }

            if (response.stop_reason === 'tool_use') {
                loopMessages.push({ role: 'assistant', content: response.content });
                const toolResultMsgs = [];
                for (const block of response.content) {
                    if (block.type !== 'tool_use') continue;
                    const result = await executeTool(block.name, block.input);
                    if (result.saved_key)   toolResults.push({ tool: block.name, saved_key: result.saved_key, category: result.category });
                    if (result.updated_key) toolResults.push({ tool: block.name, updated_key: result.updated_key });
                    if (result.deleted_key) toolResults.push({ tool: block.name, deleted_key: result.deleted_key });
                    toolResultMsgs.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
                }
                loopMessages.push({ role: 'user', content: toolResultMsgs });
                continue;
            }

            finalReply = response.content.filter(b => b.type === 'text').map(b => b.text).join('') || 'Try rephrasing!';
            break;
        }

        // Persist conversation + messages
        let conversationId = clientConvId || null;
        try {
            if (!conversationId) {
                const title = (message || 'Image conversation').slice(0, 60).replace(/\s+/g, ' ').trim();
                const { data: conv } = await mainDb.from('tourist_ai_conversations').insert({ user_id: touristId, title }).select('id').single();
                conversationId = conv?.id || null;
            } else {
                await mainDb.from('tourist_ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId).eq('user_id', touristId);
            }
            if (conversationId) {
                await mainDb.from('tourist_ai_messages').insert([
                    { conversation_id: conversationId, role: 'user',      content: message || '(image only)', has_image: !!image, url: url || null, tool_results: null },
                    { conversation_id: conversationId, role: 'assistant', content: finalReply || 'Done!',     has_image: false,    url: null,        tool_results: toolResults.length ? toolResults : null }
                ]);
            }
        } catch (persistErr) {
            console.warn('Tourist AI chat persist failed (non-fatal):', persistErr.message);
        }

        res.json({ reply: finalReply || 'Try rephrasing!', tool_results: toolResults, conversation_id: conversationId });
    } catch (err) {
        console.error('Tourist AI chat error:', err.message);
        res.json({ reply: 'Something went wrong — try again!' });
    }
});

// List recent conversations for sidebar
router.get('/ai-chat/conversations', touristOrAdminAuth, async (req, res) => {
    const { data, error } = await mainDb
        .from('tourist_ai_conversations')
        .select('id, title, created_at, updated_at')
        .eq('user_id', req.touristId)
        .order('updated_at', { ascending: false })
        .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ conversations: data || [] });
});

// Load one conversation's messages
router.get('/ai-chat/conversations/:id', touristOrAdminAuth, async (req, res) => {
    const { data: conv } = await mainDb
        .from('tourist_ai_conversations')
        .select('id, title, created_at')
        .eq('id', req.params.id).eq('user_id', req.touristId).single();
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const { data: msgs } = await mainDb
        .from('tourist_ai_messages')
        .select('id, role, content, has_image, url, tool_results, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at');
    res.json({ conversation: conv, messages: msgs || [] });
});

router.delete('/ai-chat/conversations/:id', touristOrAdminAuth, async (req, res) => {
    const { error } = await mainDb.from('tourist_ai_conversations').delete().eq('id', req.params.id).eq('user_id', req.touristId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// List all memories (for the owner / admin to review what AI has remembered)
router.get('/ai-chat/memories', touristOrAdminAuth, async (req, res) => {
    const { data, error } = await mainDb
        .from('tourist_memories')
        .select('id, category, key, value, tags, confidence, created_at, updated_at')
        .eq('user_id', req.touristId)
        .order('category')
        .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ memories: data || [] });
});

router.delete('/ai-chat/memories/:id', touristOrAdminAuth, async (req, res) => {
    const { error } = await mainDb.from('tourist_memories').delete().eq('id', req.params.id).eq('user_id', req.touristId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ── Community Photos & Videos ───────────────────────────────────────────────

// POST /api/tourist/upload-media — upload an image OR video, return its public URL.
// The tourist (identified by their phone-based account) then attaches this URL to
// a photo submission or a review. Files go to the shared customer-photos bucket
// under a per-tourist folder so everything traces back to their account.
router.post('/upload-media', touristAuth, touristUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const mime = req.file.mimetype || '';
    const isVideo = mime.startsWith('video/');
    const isImage = mime.startsWith('image/');
    if (!isVideo && !isImage) return res.status(400).json({ error: 'Only image or video files are allowed' });

    const ext = (mime.split('/')[1] || (isVideo ? 'mp4' : 'jpg')).replace('jpeg', 'jpg').replace('quicktime', 'mov');
    const fileName = `tourist/${req.touristId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
    try {
        const gcrDb = require('../db');
        let { error } = await gcrDb.storage.from('customer-photos').upload(fileName, req.file.buffer, { contentType: mime, upsert: false });
        if (error && /bucket|not found/i.test(error.message || '')) {
            await gcrDb.storage.createBucket('customer-photos', { public: true }).catch(() => {});
            ({ error } = await gcrDb.storage.from('customer-photos').upload(fileName, req.file.buffer, { contentType: mime, upsert: false }));
        }
        if (error) return res.status(500).json({ error: error.message });
        const { data } = gcrDb.storage.from('customer-photos').getPublicUrl(fileName);
        res.json({ url: data.publicUrl, media_type: isVideo ? 'video' : 'image' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tourist/photos — submit a photo or video (auth or anon via review link)
router.post('/photos', async (req, res) => {
    const { entity_slug, image_url, caption, uploader_name, category, media_type } = req.body;
    if (!entity_slug || !image_url) return res.status(400).json({ error: 'entity_slug and image_url required' });
    // Attempt to read user_id from token if present (not required)
    let userId = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        try {
            const token = header.slice(7);
            const { data: { user } } = await mainDb.auth.getUser(token);
            userId = user?.id || null;
        } catch (_) {}
    }
    const row = {
        user_id: userId,
        entity_slug,
        image_url,
        caption: caption || null,
        uploader_name: uploader_name || null,
        category: category || 'general',
        status: 'pending',
        media_type: media_type === 'video' ? 'video' : 'image',
    };
    let { data, error } = await mainDb.from('tourist_photos').insert(row).select().single();
    // If the media_type column doesn't exist yet, retry without it
    if (error && error.message?.includes('media_type')) {
        const { media_type: _dropped, ...rowWithout } = row;
        ({ data, error } = await mainDb.from('tourist_photos').insert(rowWithout).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    if (userId) awardPoints(userId, row.media_type === 'video' ? 'video' : 'photo', entity_slug).catch(() => {});
    res.json({ success: true, photo: data });
});

// GET /api/tourist/photos — get photos submitted by the logged-in user
router.get('/photos', touristAuth, async (req, res) => {
    const { data, error } = await mainDb.from('tourist_photos')
        .select('*')
        .eq('user_id', req.touristId)
        .order('submitted_at', { ascending: false })
        .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ photos: data || [] });
});

// ── Authentic Reviews — every review tied to the tourist's phone account ─────
// A review can only be written by a logged-in tourist, so it is provably from a
// real, identified person (their phone-based user_id) rather than an anonymous
// typed-in email. Supports photo/video reviews via media_url/media_type.

// POST /api/tourist/reviews — write a review as the logged-in tourist
router.post('/reviews', touristAuth, async (req, res) => {
    const { entity_slug, rating, title, body, media_url, media_type } = req.body || {};
    if (!entity_slug || !rating || !title || !body) {
        return res.status(400).json({ error: 'entity_slug, rating, title and body are required' });
    }
    const r = parseInt(rating);
    if (!(r >= 1 && r <= 5)) return res.status(400).json({ error: 'Rating must be 1–5' });

    const { data: profile } = await mainDb.from('tourist_profiles').select('name').eq('user_id', req.touristId).maybeSingle();
    const reviewerName = profile?.name || 'Traveler';

    const gcrDb = require('../db');
    const row = {
        entity_slug,
        reviewer_name: reviewerName,
        reviewer_email: req.touristEmail || null,
        user_id: req.touristId,             // ← ties the review to the phone account
        rating: r,
        title: String(title).trim(),
        body: String(body).trim(),
        media_url: media_url || null,
        media_type: media_type === 'video' ? 'video' : (media_url ? 'image' : null),
        approved: false,
        created_at: new Date().toISOString(),
    };
    let { data, error } = await gcrDb.from('entity_reviews').insert(row).select().single();
    // If newer columns (user_id / media_*) don't exist yet, retry with the base shape
    if (error && /column|user_id|media_url|media_type/i.test(error.message || '')) {
        const { user_id, media_url: _mu, media_type: _mt, ...base } = row;
        ({ data, error } = await gcrDb.from('entity_reviews').insert(base).select().single());
    }
    if (error) return res.status(500).json({ error: error.message });
    awardPoints(req.touristId, 'review', entity_slug).catch(() => {});
    res.status(201).json({ ok: true, review: data });
});

// GET /api/tourist/reviews — the tourist's own reviews, for their dashboard
router.get('/reviews', touristAuth, async (req, res) => {
    const gcrDb = require('../db');
    const { data, error } = await gcrDb.from('entity_reviews')
        .select('*')
        .eq('user_id', req.touristId)
        .order('created_at', { ascending: false })
        .limit(100);
    // If the user_id column isn't present yet, there's nothing to tie to — return empty
    if (error) return res.json({ reviews: [] });
    res.json({ reviews: data || [] });
});

// ── Points / Rewards ─────────────────────────────────────────────────────────
// One append-only ledger tied to the phone account. Balance = SUM(delta).
// Points never expire, so they roll over trip to trip automatically.

// Award points for an action, using the admin-configured earn amount.
async function awardPoints(userId, reason, entitySlug) {
    if (!userId || !reason) return;
    try {
        const { data: cfg } = await mainDb.from('points_config').select('earn').eq('id', 1).maybeSingle();
        const delta = cfg?.earn?.[reason];
        if (!delta) return;
        await mainDb.from('tourist_points').insert({ user_id: userId, delta, reason, entity_slug: entitySlug || null });
    } catch (e) { console.error('[points] award failed:', e?.message); }
}

// GET /api/tourist/points — balance, current tier, next tier, recent history
router.get('/points', touristAuth, async (req, res) => {
    const [{ data: rows }, { data: cfg }] = await Promise.all([
        mainDb.from('tourist_points').select('delta, reason, entity_slug, created_at').eq('user_id', req.touristId).order('created_at', { ascending: false }),
        mainDb.from('points_config').select('tiers').eq('id', 1).maybeSingle(),
    ]);
    const history = rows || [];
    const balance = history.reduce((s, r) => s + (r.delta || 0), 0);
    const tiers = (cfg?.tiers || []).slice().sort((a, b) => (a.min || 0) - (b.min || 0));
    let tier = tiers[0] || { name: 'Member', min: 0 };
    let next = null;
    for (const t of tiers) {
        if (balance >= (t.min || 0)) tier = t;
        else { next = t; break; }
    }
    res.json({ balance, tier, next, history: history.slice(0, 50) });
});

// GET/PUT /api/tourist/points-config — admin edits earn amounts + tiers/perks
router.get('/points-config', adminRequired, async (req, res) => {
    const { data } = await mainDb.from('points_config').select('*').eq('id', 1).maybeSingle();
    res.json({ config: data || null });
});
router.put('/points-config', adminRequired, async (req, res) => {
    const { earn, tiers } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (earn)  patch.earn  = earn;
    if (tiers) patch.tiers = tiers;
    const { data, error } = await mainDb.from('points_config').update(patch).eq('id', 1).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ config: data });
});

// POST /api/tourist/track-click — log an outbound click (Book Now, order, reserve…)
// tied to the tourist's account. Returns a click id (gcr_ref) to append to the
// outbound URL so a later conversion can be attributed back to them.
router.post('/track-click', async (req, res) => {
    const { entity_slug, click_type, target_url } = req.body || {};
    let userId = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        try {
            const { data: { user } } = await mainDb.auth.getUser(header.slice(7));
            userId = user?.id || null;
        } catch (_) {}
    }
    try {
        const { data, error } = await mainDb.from('tourist_click_events').insert({
            user_id: userId,
            entity_slug: entity_slug || null,
            click_type: click_type || 'book',
            target_url: target_url || null,
        }).select('id').single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ click_id: data.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tourist/location — browser sends GPS, we store it + check geofences
// Body: { lat, lng }
// ─────────────────────────────────────────────────────────────────────────────
// ─── GET/PUT /api/tourist/location-settings ──────────────────────────────────
router.get('/location-settings', touristAuth, async (req, res) => {
  const { data } = await mainDb.from('tourist_profiles')
    .select('location_sharing_enabled, geofence_radius_miles, sms_frequency, sms_categories')
    .eq('user_id', req.touristId).maybeSingle();
  res.json(data || { location_sharing_enabled: false, geofence_radius_miles: 1.0, sms_frequency: 'once_per_day', sms_categories: [] });
});

router.put('/location-settings', touristAuth, async (req, res) => {
  const { location_sharing_enabled, geofence_radius_miles, sms_frequency, sms_categories } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (location_sharing_enabled !== undefined) update.location_sharing_enabled = location_sharing_enabled;
  if (geofence_radius_miles !== undefined) update.geofence_radius_miles = geofence_radius_miles;
  if (sms_frequency !== undefined) update.sms_frequency = sms_frequency;
  if (sms_categories !== undefined) update.sms_categories = sms_categories;
  const { error } = await mainDb.from('tourist_profiles')
    .upsert({ user_id: req.touristId, ...update }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/location', touristAuth, async (req, res) => {
    const { lat, lng } = req.body || {};
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    // Store location on tourist_profiles
    await mainDb.from('tourist_profiles')
        .upsert({
            user_id:          req.touristId,
            last_lat:         lat,
            last_lng:         lng,
            last_location_at: new Date().toISOString(),
            updated_at:       new Date().toISOString(),
        }, { onConflict: 'user_id' }).catch(() => {});

    res.json({ ok: true });

    // Fire-and-forget geofence check
    checkGeofence(req.touristId, lat, lng).catch(() => {});
});

// Haversine distance in miles
function distanceMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Maps the category checkboxes tourists opt into (set at signup, see Profile.jsx)
// to the entity_type values actually stored on businesses — mirrors
// gcr-unified/src/data/categories.js so a "food" opt-in matches the same
// business types the app itself calls "Food & Drink".
const GEOFENCE_CATEGORY_TYPES = {
    food:       ['restaurant', 'bar', 'cafe'],
    activities: ['rental', 'tour', 'activity'],
    nightlife:  ['bar', 'nightclub', 'lounge'],
    shopping:   ['retail', 'shop'],
    stay:       ['hotel', 'resort', 'lodging'],
    events:     ['event', 'festival'],
};

async function checkGeofence(touristId, lat, lng) {
    // Get tourist phone + sms_opt_in + their geofence preferences
    const { data: profile } = await mainDb
        .from('tourist_profiles')
        .select('phone, sms_opt_in, geofence_radius_miles, sms_frequency, sms_categories')
        .eq('user_id', touristId)
        .maybeSingle();

    if (!profile?.phone || !profile.sms_opt_in) return;

    // Respect "once per day" — skip if we've already sent them ANY geofence
    // text in the last 24h, before even checking what's nearby.
    if (profile.sms_frequency === 'once_per_day') {
        const { data: todayLog } = await mainDb
            .from('tourist_sms_log')
            .select('id')
            .eq('tourist_id', touristId)
            .eq('trigger_type', 'geofence')
            .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .limit(1);
        if (todayLog?.length) return;
    }

    // Get their top preference tags
    const { data: scores } = await mainDb
        .from('user_preference_scores')
        .select('tag, score')
        .eq('user_id', touristId)
        .order('score', { ascending: false })
        .limit(10);
    const topTags = (scores || []).filter(s => s.score > 0).map(s => s.tag);

    // Find businesses within their chosen radius (default 0.5mi if never set)
    // that have active specials today
    const gcrDb = require('../db');
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    const { data: nearby } = await gcrDb
        .from('entity')
        .select('slug, name, latitude, longitude, entity_subtype, entity_type')
        .not('latitude', 'is', null)
        .eq('is_active', true)
        .limit(500);

    if (!nearby?.length) return;

    const RADIUS_MILES = profile.geofence_radius_miles || 0.5;
    let close = nearby.filter(b => {
        if (!b.latitude || !b.longitude) return false;
        return distanceMiles(lat, lng, b.latitude, b.longitude) <= RADIUS_MILES;
    });

    if (!close.length) return;

    // Respect their opted-in categories (food/nightlife/activities/stay/...) —
    // if they never set any, don't filter rather than matching nothing.
    if (profile.sms_categories?.length) {
        const allowedTypes = new Set(profile.sms_categories.flatMap(c => GEOFENCE_CATEGORY_TYPES[c] || []));
        close = close.filter(b => allowedTypes.has((b.entity_type || '').toLowerCase()));
    }

    if (!close.length) return;

    // Check which of those have an active special today
    const closeSlugs = close.map(b => b.slug);
    const { data: specials } = await gcrDb
        .from('specials')
        .select('entity_slug, special_name, discount_text')
        .in('entity_slug', closeSlugs)
        .eq('is_active', true)
        .limit(5);

    if (!specials?.length) return;

    // Only ping if they haven't been geofenced for this business in 6 hours
    // (secondary guard alongside the once-per-day gate above)
    const { data: recentLog } = await mainDb
        .from('tourist_sms_log')
        .select('id')
        .eq('tourist_id', touristId)
        .eq('trigger_type', 'geofence')
        .in('business_slug', closeSlugs)
        .gte('sent_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
        .limit(1);

    if (recentLog?.length) return;

    // Pick best matching special (prefer tag overlap)
    const special = specials[0];
    const biz = close.find(b => b.slug === special.entity_slug);
    if (!biz) return;

    const msg = `📍 You're near ${biz.name}!\n${special.special_name}${special.discount_text ? ' — ' + special.discount_text : ''}\n\nEnjoy! 🌊`;

    await sendTwilioText(profile.phone, msg).catch(() => {});

    // Log it
    await mainDb.from('tourist_sms_log').insert({
        tourist_id:   touristId,
        phone:        profile.phone,
        message:      msg,
        trigger_type: 'geofence',
        business_slug: special.entity_slug,
        status:       'sent',
        sent_at:      new Date().toISOString(),
    }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tourist/sms-campaign — admin triggers a targeted Twilio blast
// Body: { business_slug, message, tags[], min_score? }
// Sends ONLY to opted-in tourists whose preference scores match the business tags
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sms-campaign', adminRequired, async (req, res) => {
    const { business_slug, message, tags = [], min_score = 10 } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!tags.length) return res.status(400).json({ error: 'tags array required' });

    // Find tourists who match the tags with sufficient score and opted in
    const { data: matches } = await mainDb
        .from('user_preference_scores')
        .select('user_id, tag, score')
        .in('tag', tags.map(t => t.toLowerCase().trim()))
        .gte('score', min_score);

    if (!matches?.length) return res.json({ sent: 0, message: 'No matching users' });

    // Group by tourist — keep those who match at least one tag
    const touristIds = [...new Set(matches.map(m => m.user_id))];

    // Get opted-in phones — exclude anyone messaged by this business in last 24h
    const { data: recentSent } = await mainDb
        .from('tourist_sms_log')
        .select('tourist_id')
        .eq('business_slug', business_slug || '')
        .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const recentIds = new Set((recentSent || []).map(r => r.tourist_id));

    const eligibleIds = touristIds.filter(id => !recentIds.has(id));
    if (!eligibleIds.length) return res.json({ sent: 0, message: 'All matched users already messaged in last 24h' });

    const { data: profiles } = await mainDb
        .from('tourist_profiles')
        .select('user_id, phone')
        .in('user_id', eligibleIds)
        .eq('sms_opt_in', true)
        .not('phone', 'is', null);

    if (!profiles?.length) return res.json({ sent: 0 });

    // Twilio has no bulk/group-send endpoint — send individually, same pattern
    // as sms.js's /blast route, with a small delay to stay under rate limits.
    const sentTo = [];
    for (const p of profiles) {
        try {
            await sendTwilioText(p.phone, message);
            sentTo.push(p.phone);
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {
            console.error('sms-campaign: failed to send to', p.phone, e.message);
        }
    }

    // Log each successful send
    const logRows = profiles.filter(p => sentTo.includes(p.phone)).map(p => ({
        tourist_id:    p.user_id,
        phone:         p.phone,
        message,
        trigger_type:  'campaign',
        business_slug: business_slug || null,
        status:        'sent',
        sent_at:       new Date().toISOString(),
    }));
    await mainDb.from('tourist_sms_log').insert(logRows).catch(() => {});

    res.json({ sent: sentTo.length, total: profiles.length, numbers: sentTo });
});

module.exports = router;
module.exports.touristAuth = touristAuth;
module.exports._recomputeAllPreferences = recomputeAllPreferences;
