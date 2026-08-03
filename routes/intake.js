// ============================================================
// INTAKE — a business hands over its links, the platform gets told
// ============================================================
//
// A business (or whoever is onboarding them) submits a name, some contact
// details and a pile of URLs. That becomes a request, and every webhook
// endpoint listening for it is notified. The operator picks it up from the
// queue, runs the extraction against those links, and marks it done.
//
// ── Nothing here is hardcoded ───────────────────────────────────────────
//
// Where to notify is DATA, not an env var and not a constant. Endpoints live
// in `webhook_endpoints` — url, event, secret, is_active — so a destination
// can be added, paused or repointed from the dashboard with no deploy, and
// several can listen to the same event. `event = '*'` catches everything.
//
// The link kinds (website, google, airbnb…) are a display hint only. `kind` is
// free text, an unrecognised URL is stored with kind `other` rather than being
// rejected, and nothing downstream requires a kind at all.
//
// ── Delivery is logged, always ──────────────────────────────────────────
//
// Every attempt writes a row to `webhook_deliveries`, success or failure. A
// webhook that quietly stopped firing is the failure mode that actually
// happens, and it is invisible without a log.
//
// A failed delivery never fails the request. The submission is already saved
// by the time anything is sent, so a receiver being down loses a notification,
// not a customer's data.

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

/** Give up on a slow receiver rather than holding the submitter's request. */
const WEBHOOK_TIMEOUT_MS = 8000;

/** Best-effort guess at what a link is, purely to group them in the UI. */
function kindOf(url) {
    const u = String(url).toLowerCase();
    if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|business\.google/.test(u)) return 'google';
    if (/airbnb\./.test(u)) return 'airbnb';
    if (/vrbo\.|homeaway\./.test(u)) return 'vrbo';
    if (/facebook\.|fb\.com/.test(u)) return 'facebook';
    if (/instagram\./.test(u)) return 'instagram';
    if (/tiktok\./.test(u)) return 'tiktok';
    if (/yelp\./.test(u)) return 'yelp';
    if (/tripadvisor\./.test(u)) return 'tripadvisor';
    if (/fareharbor\.|peek\.com|checkfront|xola\./.test(u)) return 'booking';
    if (/opentable\.|resy\.|toasttab\.|doordash\.|ubereats\./.test(u)) return 'ordering';
    if (/\.pdf($|\?)/.test(u)) return 'document';
    return 'website';
}

/* ── webhook fan-out ─────────────────────────────────────────────────────── */

async function notify(event, payload, requestId) {
    const { data: endpoints } = await db
        .from('webhook_endpoints')
        .select('id, url, event, secret')
        .eq('is_active', true)
        .in('event', [event, '*']);

    if (!endpoints?.length) return { delivered: 0, endpoints: 0 };

    const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data: payload });
    let delivered = 0;

    await Promise.all(endpoints.map(async (ep) => {
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

        const headers = { 'Content-Type': 'application/json', 'X-GCR-Event': event };
        // Signed so a receiver can prove the call came from us rather than
        // trusting an open URL.
        if (ep.secret) {
            headers['X-GCR-Signature'] =
                'sha256=' + crypto.createHmac('sha256', ep.secret).update(body).digest('hex');
        }

        let status = 'failed';
        let responseCode = null;
        let error = null;
        try {
            const res = await fetch(ep.url, { method: 'POST', headers, body, signal: controller.signal });
            responseCode = res.status;
            if (res.ok) { status = 'delivered'; delivered += 1; }
            else error = `HTTP ${res.status}`;
        } catch (e) {
            error = e.name === 'AbortError' ? 'timed out' : e.message;
        } finally {
            clearTimeout(timer);
        }

        await db.from('webhook_deliveries').insert({
            endpoint_id: ep.id,
            event,
            target_url: ep.url,
            request_id: requestId || null,
            status,
            response_code: responseCode,
            error,
            duration_ms: Date.now() - started,
        }).then(() => {}, () => {});   // logging must never break the response
    }));

    return { delivered, endpoints: endpoints.length };
}

/* ── POST /api/intake ────────────────────────────────────────────────────── */
// Deliberately unauthenticated: this is the form a business fills in. It only
// ever creates a request — it cannot read anything, and it cannot touch an
// entity.

router.post('/', async (req, res) => {
    const b = req.body || {};
    const urls = Array.isArray(b.urls) ? b.urls : String(b.urls || '').split(/[\n,]/);
    const clean = urls.map((u) => String(u).trim()).filter(Boolean).slice(0, 25);

    if (!clean.length && !String(b.notes || '').trim()) {
        return res.status(400).json({ error: 'Send at least one link, or some notes' });
    }

    try {
        const { data: request, error } = await db.from('intake_requests').insert({
            entity_slug: b.entity_slug || null,
            business_name: b.business_name || null,
            contact_name: b.contact_name || null,
            contact_email: b.contact_email || null,
            contact_phone: b.contact_phone || null,
            notes: b.notes || null,
            source: b.source || 'form',
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        if (clean.length) {
            await db.from('intake_request_links').insert(
                clean.map((url, i) => ({
                    request_id: request.id,
                    url,
                    kind: kindOf(url),
                    sort_order: i,
                }))
            );
        }

        // Saved first, notified second. A receiver being down loses a
        // notification, never the submission.
        const fanout = await notify('intake.created', { ...request, links: clean }, request.id);

        res.status(201).json({ id: request.id, links: clean.length, notified: fanout });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── GET /api/admin/intake ───────────────────────────────────────────────── */

router.get('/', adminRequired, async (req, res) => {
    const status = req.query.status;
    try {
        let q = db.from('intake_requests').select('*').order('created_at', { ascending: false }).limit(500);
        if (status && status !== 'all') q = q.eq('status', status);
        const { data: requests, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const ids = (requests || []).map((r) => r.id);
        const { data: links } = ids.length
            ? await db.from('intake_request_links').select('*').in('request_id', ids).order('sort_order')
            : { data: [] };

        const byRequest = new Map();
        for (const l of links || []) {
            if (!byRequest.has(l.request_id)) byRequest.set(l.request_id, []);
            byRequest.get(l.request_id).push(l);
        }

        res.json({
            requests: (requests || []).map((r) => ({ ...r, links: byRequest.get(r.id) || [] })),
            counts: (requests || []).reduce((acc, r) => {
                acc[r.status] = (acc[r.status] || 0) + 1;
                return acc;
            }, {}),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── PATCH /api/admin/intake/:id ─────────────────────────────────────────── */

router.patch('/:id', adminRequired, async (req, res) => {
    const patch = {};
    for (const k of ['status', 'assigned_to', 'notes', 'entity_slug', 'business_name']) {
        if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    patch.updated_at = new Date().toISOString();
    if (patch.status === 'done' || patch.status === 'rejected') patch.handled_at = new Date().toISOString();

    try {
        const { data, error } = await db.from('intake_requests').update(patch).eq('id', req.params.id).select();
        if (error) return res.status(400).json({ error: error.message });
        if (!data?.length) return res.status(404).json({ error: 'No such request' });

        if (patch.status) await notify(`intake.${patch.status}`, data[0], data[0].id);
        res.json({ request: data[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── webhook endpoints, as data ──────────────────────────────────────────── */

router.get('/webhooks/endpoints', adminRequired, async (_req, res) => {
    const { data, error } = await db.from('webhook_endpoints')
        .select('id, label, url, event, is_active, created_at')   // never returns the secret
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ endpoints: data || [] });
});

router.post('/webhooks/endpoints', adminRequired, async (req, res) => {
    const { url, event, label, secret } = req.body || {};
    if (!url || !event) return res.status(400).json({ error: 'url and event are required' });
    const { data, error } = await db.from('webhook_endpoints')
        .insert({ url, event, label: label || null, secret: secret || null })
        .select('id, label, url, event, is_active, created_at').single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ endpoint: data });
});

router.patch('/webhooks/endpoints/:id', adminRequired, async (req, res) => {
    const patch = {};
    for (const k of ['label', 'url', 'event', 'secret', 'is_active']) {
        if (req.body?.[k] !== undefined) patch[k] = req.body[k];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    const { data, error } = await db.from('webhook_endpoints').update(patch).eq('id', req.params.id)
        .select('id, label, url, event, is_active, created_at');
    if (error) return res.status(400).json({ error: error.message });
    if (!data?.length) return res.status(404).json({ error: 'No such endpoint' });
    res.json({ endpoint: data[0] });
});

router.delete('/webhooks/endpoints/:id', adminRequired, async (req, res) => {
    const { error } = await db.from('webhook_endpoints').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ deleted: true });
});

/* ── GET /api/admin/intake/webhooks/deliveries ───────────────────────────── */
// Whether the notifications are actually arriving.

router.get('/webhooks/deliveries', adminRequired, async (req, res) => {
    const { data, error } = await db.from('webhook_deliveries')
        .select('*').order('created_at', { ascending: false }).limit(Number(req.query.limit) || 100);
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];
    res.json({
        deliveries: rows,
        failed_recently: rows.filter((d) => d.status !== 'delivered').length,
    });
});

/* ── POST /api/admin/intake/webhooks/endpoints/:id/test ──────────────────── */
// Prove a destination works before waiting on a real submission.

router.post('/webhooks/endpoints/:id/test', adminRequired, async (req, res) => {
    const { data: ep } = await db.from('webhook_endpoints').select('*').eq('id', req.params.id).maybeSingle();
    if (!ep) return res.status(404).json({ error: 'No such endpoint' });
    const result = await notify(ep.event === '*' ? 'test.ping' : ep.event, { test: true }, null);
    res.json(result);
});

module.exports = router;
