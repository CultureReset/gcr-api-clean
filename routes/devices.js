// ============================================================
// Devices — real Android phones on a Linux box at the business
//
//   physical phone --USB--> Linux host --> Docker container (adb + scrcpy)
//                                                  |
//                                           streams the screen
//                                                  v
//                                              dashboard
//
// Owner-facing:
//   GET    /api/devices                    every phone this business has
//   GET    /api/devices/hosts              the Linux boxes
//   POST   /api/devices/hosts              enrol one, returns its token once
//   DELETE /api/devices/hosts/:id          remove a host and its phones
//   GET    /api/devices/:id                one phone, its apps, its session
//   POST   /api/devices/:id/session        open a view or control session
//   DELETE /api/devices/:id/session        end it
//   PATCH  /api/devices/:id                rename a phone
//
// Agent-facing (the host agent, not the dashboard):
//   POST   /api/devices/hosts/:id/heartbeat
//          { agent_version, os, docker_version, devices: [ ... ] }
//
// There is deliberately no "create device" route. A phone is not provisioned,
// it is plugged in — the agent reports what `adb devices` returned and the
// dashboard shows that. Anything else would let the dashboard claim a phone
// exists when nothing is on the end of the cable.
//
// SQL — see sql/devices.sql
// ============================================================

const crypto = require('crypto');
const express = require('express');
const supabase = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const SESSION_MINUTES = 30;
const HOST_GRACE_SECONDS = 90;

const ADB_STATES = ['attached', 'unauthorized', 'detached', 'error'];
const MODES = ['view', 'control'];

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

// A host is only really online if it checked in recently. The stored status
// goes stale when an agent dies without saying so, which is exactly when a
// green dot misleads someone into thinking the box is fine.
function hostLiveness(host) {
    const seen = host.last_seen_at ? Date.parse(host.last_seen_at) : 0;
    const fresh = seen > 0 && (Date.now() - seen) / 1000 < HOST_GRACE_SECONDS;
    return Object.assign({}, host, {
        online: host.status === 'online' && fresh,
        stale: host.status === 'online' && !fresh,
        token_hash: undefined
    });
}

// A phone is reachable only if it is attached AND its host is answering. A
// phone can be plugged in perfectly while the box it is plugged into is down.
function deviceLiveness(device, host) {
    const hostOk = host ? hostLiveness(host).online : false;
    return Object.assign({}, device, {
        host_online: hostOk,
        reachable: hostOk && device.status === 'attached' && Boolean(device.stream_url)
    });
}

// ------------------------------------------------------------------ hosts --

// GET /api/devices/hosts
router.get('/hosts', authRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('device_host')
        .select('id, name, status, os, docker_version, agent_version, error_message, last_seen_at, enrolled_at, created_at')
        .eq('site_id', req.siteId)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).map(hostLiveness));
});

// POST /api/devices/hosts  { name }
// Returns the enrolment token once. It goes in the agent's config on the box.
router.post('/hosts', authRequired, async (req, res) => {
    const name = req.body && req.body.name;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    const token = crypto.randomBytes(32).toString('hex');

    const { data, error } = await supabase
        .from('device_host')
        .insert({
            site_id: req.siteId,
            name: String(name).trim(),
            token_hash: hash(token),
            status: 'enrolling'
        })
        .select('id, name, status, created_at')
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'A host named "' + name + '" already exists' });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
        host: data,
        enrolment_token: token,
        note: 'Put this in the agent config on that machine. It is shown once.'
    });
});

// DELETE /api/devices/hosts/:id
router.delete('/hosts/:id', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('device_host').delete()
        .eq('id', req.params.id).eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// POST /api/devices/hosts/:id/heartbeat
//   { token, agent_version, os, docker_version,
//     devices: [{ serial, status, model, manufacturer, android_version,
//                 container_ref, stream_url, error_message }] }
//
// Called by the agent on the Linux box, every ~30 seconds. This is the only
// route that creates phone rows: whatever `adb devices` reported is what the
// dashboard sees.
router.post('/hosts/:id/heartbeat', async (req, res) => {
    const body = req.body || {};
    if (!body.token) return res.status(401).json({ error: 'token required' });

    const { data: host } = await supabase
        .from('device_host')
        .select('id, site_id, token_hash')
        .eq('id', req.params.id)
        .single();

    if (!host || host.token_hash !== hash(body.token)) {
        return res.status(401).json({ error: 'Unknown host or bad token' });
    }

    const now = new Date().toISOString();

    await supabase.from('device_host').update({
        status: 'online',
        last_seen_at: now,
        enrolled_at: undefined,
        os: body.os || undefined,
        docker_version: body.docker_version || undefined,
        agent_version: body.agent_version || undefined,
        error_message: null
    }).eq('id', host.id);

    const reported = Array.isArray(body.devices) ? body.devices : [];
    const seenSerials = [];

    for (const d of reported) {
        if (!d || !d.serial) continue;
        const status = ADB_STATES.includes(d.status) ? d.status : 'detached';
        if (status === 'error' && !d.error_message) continue;

        seenSerials.push(d.serial);

        await supabase.from('device').upsert({
            site_id: host.site_id,
            host_id: host.id,
            serial: d.serial,
            model: d.model || null,
            manufacturer: d.manufacturer || null,
            android_version: d.android_version || null,
            status: status,
            container_ref: d.container_ref || null,
            stream_url: d.stream_url || null,
            error_message: status === 'error' ? d.error_message : null,
            last_seen_at: status === 'attached' ? now : undefined
        }, { onConflict: 'host_id,serial', ignoreDuplicates: false });
    }

    // A phone the agent stopped reporting was unplugged. Mark it detached
    // rather than deleting it — the same phone plugged back in tomorrow should
    // return to its row, keeping its label and its app list.
    const { data: known } = await supabase
        .from('device').select('id, serial, status').eq('host_id', host.id);

    for (const k of (known || [])) {
        if (!seenSerials.includes(k.serial) && k.status !== 'detached') {
            await supabase.from('device').update({ status: 'detached' }).eq('id', k.id);
        }
    }

    res.json({ ok: true, accepted: seenSerials.length });
});

// ----------------------------------------------------------------- phones --

// GET /api/devices
router.get('/', authRequired, async (req, res) => {
    const { data: hosts } = await supabase
        .from('device_host').select('*').eq('site_id', req.siteId);

    const byId = {};
    (hosts || []).forEach(function (h) { byId[h.id] = h; });

    const { data, error } = await supabase
        .from('device')
        .select('id, host_id, serial, label, model, manufacturer, android_version, status, container_ref, stream_url, error_message, last_seen_at')
        .eq('site_id', req.siteId)
        .order('first_seen_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    res.json((data || []).map(function (d) {
        const host = byId[d.host_id];
        return Object.assign(deviceLiveness(d, host), {
            host_name: host ? host.name : null
        });
    }));
});

// GET /api/devices/:id
router.get('/:id', authRequired, async (req, res) => {
    const { data: device, error } = await supabase
        .from('device').select('*')
        .eq('id', req.params.id).eq('site_id', req.siteId).single();

    if (error || !device) return res.status(404).json({ error: 'Device not found' });

    const { data: host } = await supabase
        .from('device_host').select('*').eq('id', device.host_id).single();

    const { data: apps } = await supabase
        .from('device_app')
        .select('package_name, label, signed_in, last_checked_at')
        .eq('device_id', device.id)
        .order('label', { ascending: true });

    const { data: live } = await supabase
        .from('device_session')
        .select('id, mode, expires_at, started_by, created_at')
        .eq('device_id', device.id).is('ended_at', null).maybeSingle();

    res.json(Object.assign(deviceLiveness(device, host), {
        host: host ? { id: host.id, name: host.name, online: hostLiveness(host).online } : null,
        apps: apps || [],
        session: live || null
    }));
});

// PATCH /api/devices/:id  { label }
// The serial is the identity; the label is what a person calls it.
router.patch('/:id', authRequired, async (req, res) => {
    const label = req.body && req.body.label;
    if (label === undefined) return res.status(400).json({ error: 'label required' });

    const { data, error } = await supabase
        .from('device').update({ label: label || null })
        .eq('id', req.params.id).eq('site_id', req.siteId)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Device not found' });
    res.json(data);
});

// POST /api/devices/:id/session  { mode }
router.post('/:id/session', authRequired, async (req, res) => {
    const mode = (req.body && req.body.mode) || 'view';
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode must be view or control' });

    const { data: device } = await supabase
        .from('device').select('*')
        .eq('id', req.params.id).eq('site_id', req.siteId).single();

    if (!device) return res.status(404).json({ error: 'Device not found' });

    const { data: host } = await supabase
        .from('device_host').select('*').eq('id', device.host_id).single();

    const state = deviceLiveness(device, host);

    // Each of these sends the owner somewhere different, so say which it is.
    if (!state.host_online) {
        return res.status(409).json({ error: 'The computer this phone is plugged into is not answering.' });
    }
    if (device.status === 'unauthorized') {
        return res.status(409).json({ error: 'Unlock the phone and tap "Allow USB debugging" — it is plugged in but has not been trusted.' });
    }
    if (device.status === 'detached') {
        return res.status(409).json({ error: 'That phone is not plugged in.' });
    }
    if (device.status === 'error') {
        return res.status(409).json({ error: device.error_message || 'That phone reported an error.' });
    }
    if (!device.stream_url) {
        return res.status(409).json({ error: 'The screen container for that phone is still starting.' });
    }

    const { data: existing } = await supabase
        .from('device_session').select('id, mode, expires_at')
        .eq('device_id', device.id).is('ended_at', null).maybeSingle();

    if (existing) {
        return res.status(409).json({
            error: 'A ' + existing.mode + ' session is already open on this phone',
            session: existing
        });
    }

    const token = crypto.randomBytes(32).toString('hex');

    const { data, error } = await supabase
        .from('device_session')
        .insert({
            device_id: device.id,
            site_id: req.siteId,
            mode: mode,
            token_hash: hash(token),
            started_by: req.userId || req.siteId,
            expires_at: new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString()
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
        .eq('device_id', device.id).is('ended_at', null);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// PUT /api/devices/:id/apps  { apps: [{ package_name, label, signed_in }] }
router.put('/:id/apps', authRequired, async (req, res) => {
    const apps = (req.body && req.body.apps) || [];
    if (!Array.isArray(apps)) return res.status(400).json({ error: 'apps must be an array' });

    const { data: device } = await supabase
        .from('device').select('id')
        .eq('id', req.params.id).eq('site_id', req.siteId).single();

    if (!device) return res.status(404).json({ error: 'Device not found' });

    const rows = apps.filter(function (a) { return a && a.package_name; }).map(function (a) {
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
        .from('device_app').upsert(rows, { onConflict: 'device_id,package_name' });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, count: rows.length });
});

module.exports = router;
