/**
 * Editable trip-swipe setup/signup questions.
 *
 * Public:
 *   GET  /api/tourist/setup-questions              — active questions ordered for the setup flow
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

const publicRouter = express.Router();
const adminRouter = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Public — trip-swipe fetches the flow
// ─────────────────────────────────────────────────────────────────────────────
publicRouter.get('/setup-questions', async (req, res) => {
    const { data, error } = await mainDb.from('tourist_setup_questions')
        .select('*').eq('active', true).order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ questions: data || [] });
});

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

adminRouter.put('/reorder', adminRequired, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
    // Update each row's sort_order by its position in the array
    const ops = ids.map((id, idx) => mainDb.from('tourist_setup_questions').update({ sort_order: (idx + 1) * 10 }).eq('id', id));
    await Promise.all(ops);
    res.json({ success: true });
});

// Mount both routers with shared express.Router()
const combinedRouter = express.Router();

// Attach both routers
combinedRouter.use(publicRouter);
combinedRouter.use('/admin', adminRouter);

module.exports = combinedRouter;
