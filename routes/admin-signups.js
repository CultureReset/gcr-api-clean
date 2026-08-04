// ============================================================
// BUSINESS SIGN-UP REVIEW
// ============================================================
//
// The approval gate for self-serve sign-ups. A business that created its own
// account is inactive and hidden until someone here says otherwise.
//
//   GET   /api/admin/signups            ?status=pending
//   GET   /api/admin/signups/:id        one, with its duplicate matches
//   PATCH /api/admin/signups/:id        { status, notes }
//
// Approving flips entity.is_active and show_in_listings. Rejecting leaves the
// entity inactive and the account intact — the owner keeps their dashboard,
// the public site just never shows the listing. Nothing is deleted, because a
// rejection is often "not yet" rather than "never".

const express = require('express');
const { adminRequired } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

const DECISIONS = new Set(['pending', 'approved', 'rejected']);

router.get('/', adminRequired, async (req, res) => {
    try {
        let query = db
            .from('business_signups')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(Number(req.query.limit) || 200);

        if (req.query.status) query = query.eq('status', req.query.status);

        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });

        const rows = data || [];
        res.json({
            signups: rows.map((row) => ({
                ...row,
                duplicate_count: Array.isArray(row.possible_duplicates) ? row.possible_duplicates.length : 0,
            })),
            total: rows.length,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id', adminRequired, async (req, res) => {
    try {
        const { data: signup, error } = await db
            .from('business_signups')
            .select('*')
            .eq('id', req.params.id)
            .maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!signup) return res.status(404).json({ error: 'No such sign-up' });

        // The listing as it stands now, so a reviewer sees what they filled in
        // rather than only what they typed at sign-up.
        let entity = null;
        if (signup.entity_slug) {
            const { data } = await db
                .from('entity')
                .select('slug, name, phone, email, website_url, city, entity_type, is_active, show_in_listings, created_at')
                .eq('slug', signup.entity_slug)
                .maybeSingle();
            entity = data || null;
        }

        res.json({ signup, entity });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.patch('/:id', adminRequired, async (req, res) => {
    const status = req.body?.status;
    if (status && !DECISIONS.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...DECISIONS].join(', ')}` });
    }

    try {
        const { data: signup } = await db
            .from('business_signups')
            .select('id, entity_slug, status')
            .eq('id', req.params.id)
            .maybeSingle();
        if (!signup) return res.status(404).json({ error: 'No such sign-up' });

        const patch = { reviewed_at: new Date().toISOString() };
        if (status) patch.status = status;
        if (req.body?.notes !== undefined) patch.notes = req.body.notes;
        if (req.admin) patch.reviewed_by = req.admin.email || req.admin.userId || null;

        const { data: updated, error } = await db
            .from('business_signups')
            .update(patch)
            .eq('id', signup.id)
            .select()
            .single();
        if (error) return res.status(400).json({ error: error.message });

        // Approval is the only thing that makes a self-created listing public.
        let entity = null;
        if (status === 'approved' && signup.entity_slug) {
            const { data } = await db
                .from('entity')
                .update({ is_active: true, show_in_listings: true })
                .eq('slug', signup.entity_slug)
                .select('slug, name, is_active, show_in_listings')
                .maybeSingle();
            entity = data || null;
        }

        // Reversing an approval hides it again, so a mistake is one click back
        // rather than a manual edit of the entity.
        if (status && status !== 'approved' && signup.status === 'approved' && signup.entity_slug) {
            const { data } = await db
                .from('entity')
                .update({ is_active: false, show_in_listings: false })
                .eq('slug', signup.entity_slug)
                .select('slug, name, is_active, show_in_listings')
                .maybeSingle();
            entity = data || null;
        }

        res.json({ success: true, signup: updated, entity });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
