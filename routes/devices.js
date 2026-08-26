// ============================================================
// Devices — a business's own cloud Android, phone, browser or container
//
// GET    /api/devices                    list this business's devices
// POST   /api/devices                    provision one
// GET    /api/devices/:id                one device, with its apps
// DELETE /api/devices/:id                deprovision
// POST   /api/devices/:id/session        open a view or control session
// DELETE /api/devices/:id/session        end the live session
// POST   /api/devices/:id/heartbeat      the device agent checks in
// PUT    /api/devices/:id/apps           the agent reports what is installed
//
// SQL — see sql/devices.sql
//
// Every route is scoped to req.siteId. A device belongs to one business and
// is never visible to another, so every query filters on site_id even when
// the id alone would be unique.
//
// The session token is returned exactly once, on creation. Only its hash is
// stored, so a leaked database row cannot be replayed against a device.
// ============================================================

const crypto = require('crypto');
const express = require('express');
const supabase = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const SESSION_MINUTES = 30;
const HEARTBEAT_GRACE_SECONDS = 90;

const KINDS = ['android-cloud', 'android-physical', 'browser', 'container'];
const MODES = ['view', 'control'];

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// A device is only really online if it checked in recently. The stored status
// can go stale when an agent dies without saying so, which is exactly when a
// green dot is most misleading.
function withLiveness(device) {
    const seen = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
    const fresh = seen > 0 && (Date.now() - seen) / 1000 < HEARTBEAT_GRACE_SECONDS;
    return Object.assign({}, device, {
        online: device.status === 'online' && fresh,
        stale: device.status === 'online' && !fresh
    });
}

// GET /api/devices
router.get('/', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('device')
        .select('id, name, kind, status, container_ref, stream_url, region, error_message, last_seen_at, created_at')
        .eq('site_id', req.siteId)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(withLiveness));
});

// POST /api/devices  { name, kind, region }
router.post('/', authRequired, async (req, res) => {
    const { name, kind, region } = req.body || {};

    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!KINDS.includes(kind)) {
        return res.status(400).json({ error: 'kind must be one of ' + KINDS.join(', ') });
    }

    const { data, error } = await supabase
        .from('device')
        .insert({
            site_id: req.siteId,
            name: String(name).trim(),
            kind: kind,
            region: region || null,
            status: 'provisioning'
        })
        .select()
        .single();

    if (error) {
        // 23505 is a unique violation — this business already named a device this.
        if (error.code === '23505') {
            return res.status(409).json({ error: 'A device named "' + name + '" already exists' });
        }
        return res.status(500).json({ error: error.message });
    }

    // The orchestrator picks this up, creates the container, and calls
    // PATCH back with container_ref and stream_url. Until then it stays
    // 'provisioning' — the dashboard shows it as coming up, not as broken.
    res.status(201).json(withLiveness(data));
});

// GET /api/devices/:id
router.get('/:id', authRequired, async (req, res) => {
    const { data: device, error } = await supabase
        .from('device')
        .select('*')
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .single();

    if (error || !device) return res.status(404).json({ error: 'Device not found' });

    const { data: apps } = await supabase
        .from('device_app')
        .select('package_name, label, signed_in, last_checked_at')
        .eq('device_id', device.id)
        .order('label', { ascending: true });

    const { data: live } = await supabase
        .from('device_session')
        .select('id, mode, expires_at, started_by, created_at')
        .eq('device_id', device.id)
        .is('ended_at', null)
        .maybeSingle();

    res.json(Object.assign(withLiveness(device), {
        apps: apps || [],
        session: live || null
    }));
});

// POST /api/devices/:id/session  { mode }
// Returns the token once. It is never readable again.
router.post('/:id/session', authRequired, async (req, res) => {
    const mode = (req.body && req.body.mode) || 'view';
    if (!MODES.includes(mode)) {
        return res.status(400).json({ error: 'mode must be view or control' });
    }

    const { data: device } = await supabase
        .from('device')
        .select('id, status, stream_url, last_seen_at')
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .single();

    if (!device) return res.status(404).json({ error: 'Device not found' });

    const state = withLiveness(device);
    if (!state.online) {
        return res.status(409).json({
            error: state.stale
                ? 'That device stopped checking in. Restart it before opening a session.'
                : 'That device is not online yet.'
        });
    }

    // A second viewer joins the session already open rather than fighting it
    // for the same screen.
    const { data: existing } = await supabase
        .from('device_session')
        .select('id, mode, expires_at')
        .eq('device_id', device.id)
        .is('ended_at', null)
        .maybeSingle();

    if (existing) {
        return res.status(409).json({
            error: 'A ' + existing.mode + ' session is already open on this device',
            session: existing
        });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('device_session')
        .insert({
            device_id: device.id,
            site_id: req.siteId,
            mode: mode,
            token_hash: hashToken(token),
            started_by: req.userId || req.siteId,
            expires_at: expiresAt
        })
        .select('id, mode, expires_at, created_at')
        .single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({
        session: data,
        stream_url: device.stream_url,
        token: token,
        note: 'This token is shown once and is not recoverable.'
    });
});

// DELETE /api/devices/:id/session
router.delete('/:id/session', authRequired, async (req, res) => {
    const { data: device } = await supabase
        .from('device').select('id')
        .eq('id', req.params.id).eq('site_id', req.siteId).single();

    if (!device) return res.status(404).json({ error: 'Device not found' });

    const { error } = await supabase
        .from('device_session')
        .update({ ended_at: new Date().toISOString() })
        .eq('device_id', device.id)
        .is('ended_at', null);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// POST /api/devices/:id/heartbeat  { status, container_ref, stream_url, error_message }
// Called by the device agent, not the dashboard.
router.post('/:id/heartbeat', authRequired, async (req, res) => {
    const body = req.body || {};
    const status = body.status || 'online';

    if (!['online', 'offline', 'error'].includes(status)) {
        return res.status(400).json({ error: 'status must be online, offline or error' });
    }
    if (status === 'error' && !body.error_message) {
        return res.status(400).json({ error: 'error_message required when reporting error' });
    }

    const patch = {
        status: status,
        last_seen_at: new Date().toISOString(),
        error_message: status === 'error' ? body.error_message : null
    };
    if (body.container_ref) patch.container_ref = body.container_ref;
    if (body.stream_url) patch.stream_url = body.stream_url;

    const { data, error } = await supabase
        .from('device')
        .update(patch)
        .eq('id', req.params.id)
        .eq('site_id', req.siteId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Device not found' });

    res.json(withLiveness(data));
});

// PUT /api/devices/:id/apps  { apps: [{ package_name, label, signed_in }] }
router.put('/:id/apps', authRequired, async (req, res) => {
    const apps = (req.body && req.body.apps) || [];
    if (!Array.isArray(apps)) return res.status(400).json({ error: 'apps must be an array' });

    const { data: device } = await supabase
        .from('device').select('id')
        .eq('id', req.params.id).eq('site_id', req.siteId).single();

    if (!device) return res.status(404).json({ error: 'Device not found' });

    const rows = apps
        .filter(function (a) { return a && a.package_name; })
        .map(function (a) {
            return {
                device_id: device.id,
                package_name: a.package_name,
                label: a.label || null,
                signed_in: a.signed_in === true,
                last_checked_at: new Date().toISOString()
            };
        });

    if (rows.length === 0) return res.json({ success: true, count: 0 });

    const { error } = await supabase
        .from('device_app')
        .upsert(rows, { onConflict: 'device_id,package_name' });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, count: rows.length });
});

// DELETE /api/devices/:id
router.delete('/:id', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('device')
        .delete()
        .eq('id', req.params.id)
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

module.exports = router;
