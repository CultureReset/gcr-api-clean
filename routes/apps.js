const express = require('express');
const supabase = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// GET /api/apps — full app catalog (for app store in dashboard)
router.get('/', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('apps')
        .select('app_id, name, description, category, business_types, monthly_price, icon')
        .eq('active', true)
        .order('category', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Mark which ones this business has installed
    const { data: installed } = await supabase
        .from('site_apps')
        .select('app_id, enabled')
        .eq('site_id', req.siteId);

    const installedMap = {};
    (installed || []).forEach(function(a) { installedMap[a.app_id] = a.enabled; });

    const apps = (data || []).map(function(app) {
        return Object.assign({}, app, {
            installed: installedMap[app.app_id] === true
        });
    });

    res.json(apps);
});

// POST /api/apps/install — install an app for this business
router.post('/install', authRequired, async (req, res) => {
    const { app_id, provider } = req.body;
    if (!app_id) return res.status(400).json({ error: 'app_id required' });

    const { data, error } = await supabase
        .from('site_apps')
        .upsert({
            site_id: req.siteId,
            app_id: app_id,
            provider: provider || 'builtin',
            enabled: true
        }, { onConflict: 'site_id,app_id' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, app: data });
});

// DELETE /api/apps/uninstall/:appId — uninstall an app
router.delete('/uninstall/:appId', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('site_apps')
        .update({ enabled: false })
        .eq('site_id', req.siteId)
        .eq('app_id', req.params.appId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

module.exports = router;
