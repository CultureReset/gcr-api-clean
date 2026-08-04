/**
 * Editable trip-swipe setup/signup questions.
 *
 * The public read — GET /api/tourist/setup-questions — lives in routes/tourist.js.
 * This file is admin-only.
 *
 * Admin (requires admin JWT from cybercheck-login):
 *   GET  /api/admin/setup-questions                — ALL questions (incl. inactive) for editing
 *   POST /api/admin/setup-questions                — create
 *   PUT  /api/admin/setup-questions/:id            — update
 *   DELETE /api/admin/setup-questions/:id          — delete
 *   PUT  /api/admin/setup-questions/reorder        — { ids:[...] } updates sort_order
 */

const express = require('express');
const mainDb = require('../db');
const { adminRequired } = require('../middleware/auth');

const adminRouter = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Admin — editor CRUD
// ─────────────────────────────────────────────────────────────────────────────
adminRouter.get('/', adminRequired, async (req, res) => {
    const { data, error } = await mainDb.from('tourist_setup_questions')
        .select('*').order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ questions: data || [] });
});

adminRouter.post('/', adminRequired, async (req, res) => {
    const b = req.body || {};
    if (!b.key || !b.label || !b.input_type) return res.status(400).json({ error: 'key, label, input_type required' });
    const { data, error } = await mainDb.from('tourist_setup_questions').insert({
        key: String(b.key).trim(),
        label: b.label,
        subtitle: b.subtitle || null,
        input_type: b.input_type,
        options: Array.isArray(b.options) ? b.options : [],
        placeholder: b.placeholder || null,
        required: !!b.required,
        sort_order: b.sort_order ?? 100,
        active: b.active !== false,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ question: data });
});

/* Before '/:id' on purpose. Express takes the first route that matches, and
 * '/:id' matches the literal string 'reorder' too — with this handler declared
 * afterwards, every PUT to /reorder was answered by the update handler trying
 * to patch a row whose id is "reorder". The dashboard noticed and works around
 * it by issuing one PUT per question (see SwipeQuestions.jsx); that keeps
 * working, and the bulk endpoint is now reachable as well. */
adminRouter.put('/reorder', adminRequired, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    // Update each row's sort_order by its position in the array
    const ops = ids.map((id, idx) => mainDb.from('tourist_setup_questions').update({ sort_order: (idx + 1) * 10 }).eq('id', id));
    await Promise.all(ops);
    res.json({ success: true });
});

adminRouter.put('/:id', adminRequired, async (req, res) => {
    const b = req.body || {};
    const patch = {};
    ['label','subtitle','input_type','placeholder'].forEach(k => { if (k in b) patch[k] = b[k] || null; });
    if ('options' in b) patch.options = Array.isArray(b.options) ? b.options : [];
    if ('required' in b) patch.required = !!b.required;
    if ('active' in b) patch.active = !!b.active;
    if ('sort_order' in b) patch.sort_order = b.sort_order;
    if ('key' in b) patch.key = String(b.key).trim();

    const { data, error } = await mainDb.from('tourist_setup_questions')
        .update(patch).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ question: data });
});

adminRouter.delete('/:id', adminRequired, async (req, res) => {
    const { error } = await mainDb.from('tourist_setup_questions').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

/* server.js mounts this file at /api/admin/setup-questions, so the base path
 * already names both the audience and the resource. Attaching adminRouter at
 * '/admin' pushed every handler one segment deeper — the real paths were
 * /api/admin/setup-questions/admin and .../admin/:id, and the four documented
 * ones above all 404'd. That is the whole Swipe Questions screen in the admin
 * dashboard: list, create, update and delete.
 *
 * publicRouter is not mounted. Its one route would land on
 * /api/admin/setup-questions/setup-questions — an unauthenticated endpoint
 * sitting inside the admin namespace, reachable by anyone who guessed it. The
 * public flow it was meant to serve is already served by routes/tourist.js,
 * which owns GET /api/tourist/setup-questions and answers 200 today. Nothing
 * in any of the five repos calls the duplicate.
 */
const combinedRouter = express.Router();

combinedRouter.use(adminRouter);

module.exports = combinedRouter;
