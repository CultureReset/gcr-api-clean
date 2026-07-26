/**
 * Trip-swipe group planning endpoints.
 *   POST   /api/tourist/groups                       — create
 *   POST   /api/tourist/groups/join                 { invite_code }
 *   GET    /api/tourist/groups                       — list groups I'm in
 *   GET    /api/tourist/groups/:slug                  — group + members + overlaps + all saves
 *   POST   /api/tourist/groups/:slug/saves            — save a place (personal, shows up in this group's overlap)
 *   POST   /api/tourist/groups/:slug/leave
 *   POST   /api/tourist/groups/:slug/create-invite     — mint a shareable link
 *   GET    /api/tourist/groups/invite/:token           — public preview of a link
 *   POST   /api/tourist/groups/invite/:token/accept    — consume the link + join
 *
 * All routes use Supabase JWT from the trip-swipe frontend.
 *
 * Rewritten against the REAL live schema (previously every write here failed
 * silently against columns that don't exist — tourist_groups has no
 * invite_code/owner_user_id/sharing_mode/arrival/departure; tourist_saves has
 * no group_id; tourist_group_members has no display_name). Groups now use a
 * real `slug` column (added this pass) generated the same way this file
 * always intended to. "Overlap" is computed by joining group membership
 * against each member's personal saves, since saves were never group-scoped
 * in the schema -- likes are a property of the person, not the trip.
 */

const express = require('express');
const crypto = require('crypto');
const mainDb = require('../db');
const { touristAuth } = require('./tourist');

const router = express.Router();

function slugify(s) {
    return String(s || '').toLowerCase().trim()
        .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'trip';
}
async function uniqueSlug(base) {
    const b = slugify(base);
    for (let i = 0; i < 5; i++) {
        const s = i === 0 ? b : `${b}-${Math.random().toString(36).slice(2, 6)}`;
        const { data } = await mainDb.from('tourist_groups').select('id').eq('slug', s).maybeSingle();
        if (!data) return s;
    }
    return `${b}-${Date.now().toString(36)}`;
}
async function uniqueInviteCode() {
    // Short, readable code for manual entry (Groups.jsx "join via code");
    // create-invite mints a long token instead -- both live in the same
    // invite_code column, since a link and a typed-in code are the same
    // concept as far as the database is concerned.
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 10; i++) {
        const c = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        const { data } = await mainDb.from('tourist_group_invites').select('id').eq('invite_code', c).maybeSingle();
        if (!data) return c;
    }
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// Shared by both the "type in a code" flow and the "click a link" flow --
// both just look up the same invite_code column.
async function joinGroupByCode(code, touristId) {
    const { data: invite } = await mainDb.from('tourist_group_invites').select('*').eq('invite_code', code).maybeSingle();
    if (!invite) return { status: 404, error: 'Group not found — check the code' };
    if (invite.is_used) return { status: 410, error: 'This invite has already been used' };
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { status: 410, error: 'This invite has expired' };

    const { data: existing } = await mainDb.from('tourist_group_members')
        .select('id').eq('group_id', invite.group_id).eq('user_id', touristId).maybeSingle();
    if (!existing) {
        const { error: insErr } = await mainDb.from('tourist_group_members')
            .insert({ group_id: invite.group_id, user_id: touristId, role: 'member' });
        if (insErr) return { status: 500, error: insErr.message };
    }
    // Race-safe: only the first accept marks it used.
    await mainDb.from('tourist_group_invites').update({ is_used: true }).eq('id', invite.id).eq('is_used', false);

    const { data: group } = await mainDb.from('tourist_groups').select('*').eq('id', invite.group_id).maybeSingle();
    if (!group) return { status: 404, error: 'Group not found' };
    return { status: 200, group };
}

function withDates(group) {
    if (!group) return group;
    return { ...group, arrival: group.trip_start_date, departure: group.trip_end_date };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE a group
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', touristAuth, async (req, res) => {
    const { name, destination, arrival, departure, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });

    const slug = await uniqueSlug(name);
    const { data: group, error } = await mainDb.from('tourist_groups').insert({
        slug,
        name: name.trim(),
        description: description || null,
        destination: destination || null,
        trip_start_date: arrival || null,
        trip_end_date: departure || null,
        creator_id: req.touristId,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    const { error: memErr } = await mainDb.from('tourist_group_members')
        .insert({ group_id: group.id, user_id: req.touristId, role: 'owner' });
    if (memErr) return res.status(500).json({ error: memErr.message });

    res.json({ group: withDates(group) });
});

// ─────────────────────────────────────────────────────────────────────────────
// JOIN a group via invite code (manual entry)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/join', touristAuth, async (req, res) => {
    const code = String(req.body?.invite_code || '').trim();
    if (!code) return res.status(400).json({ error: 'Invite code is required' });
    const result = await joinGroupByCode(code.toUpperCase(), req.touristId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ group: withDates(result.group) });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIST groups I'm a member of
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', touristAuth, async (req, res) => {
    const { data: memberships } = await mainDb.from('tourist_group_members')
        .select('group_id').eq('user_id', req.touristId);
    const ids = (memberships || []).map(m => m.group_id);
    if (!ids.length) return res.json({ groups: [] });

    const { data: groups } = await mainDb.from('tourist_groups')
        .select('*').in('id', ids).order('created_at', { ascending: false });
    res.json({ groups: (groups || []).map(withDates) });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET one group (members + saves + overlap summary)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:slug', touristAuth, async (req, res) => {
    const { data: group } = await mainDb.from('tourist_groups').select('*').eq('slug', req.params.slug).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { data: mySelf } = await mainDb.from('tourist_group_members')
        .select('id').eq('group_id', group.id).eq('user_id', req.touristId).maybeSingle();
    if (!mySelf) return res.status(403).json({ error: 'Not a member of this group' });

    const { data: members } = await mainDb.from('tourist_group_members').select('*').eq('group_id', group.id);
    const memberIds = (members || []).map(m => m.user_id);

    // Saves aren't group-scoped in the schema -- they belong to the person.
    // "Overlap" is every member's personal saves, joined at read time.
    const { data: saves } = memberIds.length
        ? await mainDb.from('tourist_saves').select('*').in('user_id', memberIds).order('saved_at', { ascending: false })
        : { data: [] };

    // Reuse the already-configured GCR client (mainDb) instead of building a
    // new one from SUPABASE_URL/SUPABASE_SERVICE_KEY -- those aren't the env
    // vars actually set for this project, so this was failing to connect.
    const { data: authList } = await mainDb.auth.admin.listUsers({ perPage: 1000 });
    const emailById = {};
    (authList?.users || []).forEach(u => { emailById[u.id] = u.email; });
    const membersOut = (members || []).map(m => ({
        ...m,
        email: emailById[m.user_id] || null,
        display_name: (emailById[m.user_id] || '').split('@')[0] || 'member',
    }));

    // Overlap: group saves by entity_slug, count unique users who saved it.
    const bySlug = {};
    (saves || []).forEach(s => {
        const key = s.entity_slug;
        if (!key) return;
        if (!bySlug[key]) bySlug[key] = {
            entity_slug: key, business_name: s.business_name, hero_image_url: s.hero_image_url,
            subtitle: s.subtitle, category: s.category, rating: s.rating, price_range: s.price_range,
            savers: [], count: 0,
        };
        const displayName = membersOut.find(m => m.user_id === s.user_id)?.display_name || 'someone';
        if (!bySlug[key].savers.find(x => x.user_id === s.user_id)) {
            bySlug[key].savers.push({ user_id: s.user_id, display_name: displayName });
            bySlug[key].count++;
        }
    });
    const overlaps = Object.values(bySlug).sort((a, b) => b.count - a.count);

    res.json({
        group: withDates(group),
        members: membersOut,
        saves: saves || [],
        overlaps,
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SAVE a place (personal save; shows up in every group this person is in)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:slug/saves', touristAuth, async (req, res) => {
    const { data: group } = await mainDb.from('tourist_groups').select('id').eq('slug', req.params.slug).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { data: mySelf } = await mainDb.from('tourist_group_members')
        .select('id').eq('group_id', group.id).eq('user_id', req.touristId).maybeSingle();
    if (!mySelf) return res.status(403).json({ error: 'Not a member' });

    const b = req.body || {};
    if (!b.entity_slug) return res.status(400).json({ error: 'entity_slug required' });

    const row = {
        user_id: req.touristId,
        entity_slug: b.entity_slug,
        entity_id: b.entity_id && /^[0-9a-f-]{36}$/i.test(String(b.entity_id)) ? b.entity_id : null,
        business_name: b.business_name || null,
        hero_image_url: b.hero_image_url || null,
        subtitle: b.subtitle || null,
        category: b.category || null,
        rating: b.rating ?? null,
        price_range: b.price_range || null,
    };
    const { data, error } = await mainDb.from('tourist_saves')
        .upsert(row, { onConflict: 'user_id,entity_slug' })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ save: data });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:slug/leave', touristAuth, async (req, res) => {
    const { data: group } = await mainDb.from('tourist_groups').select('id,creator_id').eq('slug', req.params.slug).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.creator_id === req.touristId) return res.status(400).json({ error: 'Owner cannot leave — delete the group instead' });

    const { error } = await mainDb.from('tourist_group_members')
        .delete().eq('group_id', group.id).eq('user_id', req.touristId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// SHAREABLE INVITE LINKS
//   POST  /api/tourist/groups/:slug/create-invite  → { token, url, expires_at }
//   GET   /api/tourist/groups/invite/:token        → preview (group info + status)
//   POST  /api/tourist/groups/invite/:token/accept → consume + join
// ═══════════════════════════════════════════════════════════════════════════

router.post('/:slug/create-invite', touristAuth, async (req, res) => {
    const { data: group } = await mainDb.from('tourist_groups').select('*').eq('slug', req.params.slug).maybeSingle();
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const { data: mySelf } = await mainDb.from('tourist_group_members')
        .select('id').eq('group_id', group.id).eq('user_id', req.touristId).maybeSingle();
    if (!mySelf) return res.status(403).json({ error: 'Not a member of this group' });

    const token = crypto.randomBytes(20).toString('hex');
    const expires_at = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

    const { error } = await mainDb.from('tourist_group_invites').insert({
        group_id: group.id,
        invite_code: token,
        invite_email: req.body?.email || null, // optional -- null for a generic shareable link
        invited_by_user_id: req.touristId,
        expires_at,
    });
    if (error) return res.status(500).json({ error: error.message });

    // GCR unified has swipe/join/everything built in natively -- "Trip Swipe"
    // as a separate deployment is legacy, invite links belong on the real app.
    const base = process.env.GCR_UNIFIED_URL || 'https://gulfcoastradar.com';
    res.json({ token, url: `${base}/join?t=${token}`, expires_at });
});

router.get('/invite/:token', async (req, res) => {
    const { data: invite } = await mainDb.from('tourist_group_invites')
        .select('*').eq('invite_code', req.params.token).maybeSingle();
    if (!invite) return res.status(404).json({ error: 'Invite not found' });

    const { data: group } = await mainDb.from('tourist_groups')
        .select('slug,name,destination,trip_start_date,trip_end_date').eq('id', invite.group_id).maybeSingle();

    const expired = !!(invite.expires_at && new Date(invite.expires_at) < new Date());

    res.json({
        group: group ? withDates(group) : null,
        status: invite.is_used ? 'used' : expired ? 'expired' : 'valid',
        expires_at: invite.expires_at,
    });
});

router.post('/invite/:token/accept', touristAuth, async (req, res) => {
    const result = await joinGroupByCode(req.params.token, req.touristId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ success: true, group: withDates(result.group) });
});

module.exports = router;
