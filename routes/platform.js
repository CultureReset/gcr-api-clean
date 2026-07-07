// ============================================================
// MODULAR PLATFORM API
// ============================================================
// Backs the modular dashboard (cybercheck-login/modular-dashboard.html)
// and the public smart pages (cybercheck-login/page.html).
//
// Design rules (nothing hardwired):
// - The server has NO app catalog. Each install stores a snapshot of
//   the app's manifest, so the server knows everything it needs
//   (blocks, fields, automations, publicData) per business without
//   ever knowing what a "menu" or a "waiver" is.
// - Every app owns its own data stream: app_records(site_id, data_key).
//   New apps require zero schema changes.
// - Community-published apps live in app_registry and are installable
//   by every business.
//
// Tables (created via migration `modular_platform_tables`):
//   platform_state(site_id pk, business jsonb, installed jsonb, page_order jsonb)
//   app_registry(id pk, manifest jsonb, author_site_id, author_name, version, approved)
//   app_records(id uuid pk, site_id, data_key, record jsonb)
// ============================================================

const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');

const router = express.Router();

function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Automation engine (server-side) ────────────────────────────
// Runs whenever a record lands in a data stream, no matter the source
// (dashboard, public page, email parser, POS import).
async function runAutomations(siteId, dataKey, record, stateRow) {
    try {
        let state = stateRow;
        if (!state) {
            const { data } = await supabase.from('platform_state')
                .select('business, installed').eq('site_id', siteId).maybeSingle();
            state = data;
        }
        if (!state || !state.installed) return;

        const business = state.business || {};
        const installed = state.installed;
        const runs = [];

        Object.keys(installed).forEach(function (id) {
            const inst = installed[id];
            const man = inst && inst.manifest;
            if (!man || man.type !== 'automation' || !man.automation) return;
            if (inst.enabled === false) return;
            if (man.automation.trigger !== dataKey) return;

            const tpl = (inst.config && inst.config.template) || man.automation.template || '';
            const msg = tpl.replace(/\{(\w+)\}/g, function (_, k) {
                if (k === 'business') return business.name || 'our business';
                return record[k] != null ? String(record[k]) : '';
            });
            runs.push({ app: man.name, appId: id, action: man.automation.action, message: msg });
        });

        for (const run of runs) {
            // Deliver (fire-and-forget; failures logged, never thrown)
            if (run.action === 'sms') {
                try {
                    const { sendSms } = require('../utils/sms');
                    const to = record.phone || record.customer_phone || business.phone;
                    if (to) await sendSms(to, run.message, siteId, 'automation', null);
                } catch (e) { console.error('automation sms failed:', e.message); }
            } else if (run.action === 'email') {
                try {
                    const { sendEmail } = require('../utils/email');
                    const to = record.email || business.email;
                    if (to) await sendEmail({ to: to, subject: (business.name || 'Update'), html: '<p>' + run.message + '</p>' });
                } catch (e) { console.error('automation email failed:', e.message); }
            }
            // Always log the run into the site's automation_log stream
            await supabase.from('app_records').insert({
                site_id: siteId,
                data_key: 'automation_log',
                record: { when: new Date().toISOString(), app: run.app, appId: run.appId, action: run.action, message: run.message }
            });
        }
    } catch (e) {
        console.error('runAutomations error:', e.message);
    }
}

// ============================================================
// STATE — the business's dashboard (installed apps, page, business)
// ============================================================
router.get('/state', authRequired, async (req, res) => {
    try {
        const { data: state } = await supabase.from('platform_state')
            .select('*').eq('site_id', req.siteId).maybeSingle();

        // First login: seed from the businesses row created at signup
        if (!state) {
            const { data: biz } = await supabase.from('businesses')
                .select('name, type, subdomain, tagline, emoji')
                .eq('site_id', req.siteId).maybeSingle();
            const business = {
                name: (biz && biz.name) || '',
                type: (biz && biz.type) || '',
                tagline: (biz && biz.tagline) || '',
                emoji: (biz && biz.emoji) || '🏪',
                phone: '', accent: '#22c3a6',
                slug: (biz && biz.subdomain) || slugify(biz && biz.name)
            };
            return res.json({ business: business, installed: {}, page_order: [], fresh: true });
        }
        res.json({ business: state.business, installed: state.installed, page_order: state.page_order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/state', authRequired, async (req, res) => {
    try {
        const { business, installed, page_order } = req.body;
        const biz = business || {};
        if (!biz.slug) biz.slug = slugify(biz.name);

        // Keep slugs unique across the platform (excluding self)
        if (biz.slug) {
            const { data: clash } = await supabase.from('platform_state')
                .select('site_id').eq('business->>slug', biz.slug)
                .neq('site_id', req.siteId).maybeSingle();
            if (clash) biz.slug = biz.slug + '-' + req.siteId.slice(0, 4);
        }

        await supabase.from('platform_state').upsert({
            site_id: req.siteId,
            business: biz,
            installed: installed || {},
            page_order: page_order || [],
            updated_at: new Date().toISOString()
        }, { onConflict: 'site_id' });

        res.json({ success: true, slug: biz.slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// REGISTRY — community-published apps, shared by every business
// ============================================================
router.get('/registry', async (_req, res) => {
    try {
        const { data } = await supabase.from('app_registry')
            .select('manifest, author_name, version, updated_at')
            .eq('approved', true).order('updated_at', { ascending: false }).limit(500);
        res.json((data || []).map(function (r) {
            const m = r.manifest || {};
            m.author = m.author || r.author_name;
            m.version = r.version;
            return m;
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/registry', authRequired, async (req, res) => {
    try {
        const man = req.body.manifest;
        if (!man || !man.id || !man.name) return res.status(400).json({ error: 'manifest with id and name required' });

        const { data: existing } = await supabase.from('app_registry')
            .select('author_site_id, version').eq('id', man.id).maybeSingle();

        if (existing && existing.author_site_id && existing.author_site_id !== req.siteId) {
            return res.status(403).json({ error: 'That app id belongs to another publisher' });
        }
        const version = existing ? (existing.version || 1) + 1 : (man.version || 1);
        man.version = version;

        await supabase.from('app_registry').upsert({
            id: man.id,
            manifest: man,
            author_site_id: req.siteId,
            author_name: man.author || null,
            version: version,
            approved: true,
            updated_at: new Date().toISOString()
        }, { onConflict: 'id' });

        res.json({ success: true, version: version });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/registry/:id', authRequired, async (req, res) => {
    try {
        const { data: existing } = await supabase.from('app_registry')
            .select('author_site_id').eq('id', req.params.id).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.author_site_id !== req.siteId && req.role !== 'admin') {
            return res.status(403).json({ error: 'Not your app' });
        }
        await supabase.from('app_registry').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// RECORDS — every app's own data stream
// ============================================================
router.get('/records', authRequired, async (req, res) => {
    try {
        const { data } = await supabase.from('app_records')
            .select('id, data_key, record, created_at')
            .eq('site_id', req.siteId)
            .order('created_at', { ascending: false }).limit(2000);
        const grouped = {};
        (data || []).forEach(function (r) {
            if (!grouped[r.data_key]) grouped[r.data_key] = [];
            const rec = r.record || {};
            rec._id = r.id;
            grouped[r.data_key].push(rec);
        });
        res.json(grouped);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/records/:dataKey', authRequired, async (req, res) => {
    try {
        const record = req.body.record || {};
        const { data, error } = await supabase.from('app_records')
            .insert({ site_id: req.siteId, data_key: req.params.dataKey, record: record })
            .select('id').single();
        if (error) throw error;
        runAutomations(req.siteId, req.params.dataKey, record).catch(function () {});
        res.json({ success: true, id: data.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/records/:dataKey/:id', authRequired, async (req, res) => {
    try {
        await supabase.from('app_records')
            .update({ record: req.body.record || {}, updated_at: new Date().toISOString() })
            .eq('id', req.params.id).eq('site_id', req.siteId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/records/:dataKey/:id', authRequired, async (req, res) => {
    try {
        await supabase.from('app_records')
            .delete().eq('id', req.params.id).eq('site_id', req.siteId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Availability: blocked dates + capacity, enforced server-side ──
async function getAvailability(siteId, installed, dataKey, month) {
    // blocked dates come from the availability app's own data stream
    const { data: blockRecs } = await supabase.from('app_records')
        .select('record').eq('site_id', siteId).eq('data_key', 'blocks').limit(1000);
    const blocked = (blockRecs || [])
        .map(function (r) { return r.record || {}; })
        .filter(function (r) { return r.kind === 'blocked' && r.date; })
        .map(function (r) { return r.date; });

    // capacity per date comes from the availability app's config
    let capacity = null;
    Object.keys(installed || {}).forEach(function (id) {
        const inst = installed[id];
        if (inst && inst.manifest && inst.manifest.dataKey === 'blocks' && inst.config && inst.config.capacity) {
            const c = parseInt(inst.config.capacity, 10);
            if (c > 0) capacity = c;
        }
    });

    let full = [];
    if (capacity && dataKey) {
        const { data: recs } = await supabase.from('app_records')
            .select('record').eq('site_id', siteId).eq('data_key', dataKey).limit(2000);
        const counts = {};
        (recs || []).forEach(function (r) {
            const rec = r.record || {};
            if (!rec.date || rec.status === 'cancelled' || rec.status === 'declined') return;
            counts[rec.date] = (counts[rec.date] || 0) + 1;
        });
        full = Object.keys(counts).filter(function (d) { return counts[d] >= capacity; });
    }
    if (month) {
        blocked.filter(function (d) { return String(d).slice(0, 7) === month; });
        full = full.filter(function (d) { return String(d).slice(0, 7) === month; });
    }
    return { blocked: blocked, full: full, capacity: capacity };
}

router.get('/page/:slug/availability', async (req, res) => {
    try {
        const { data: state } = await supabase.from('platform_state')
            .select('site_id, installed').eq('business->>slug', req.params.slug).maybeSingle();
        if (!state) return res.status(404).json({ error: 'Page not found' });
        let dataKey = null;
        const inst = (state.installed || {})[req.query.app];
        if (inst && inst.manifest) dataKey = inst.manifest.dataKey;
        const avail = await getAvailability(state.site_id, state.installed, dataKey, req.query.month);
        res.json(avail);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Owner one-tap status change: confirm / decline / complete ──
// Texts the customer automatically; "completed" asks for a review
// (the authentic-review loop: tied to a real transaction).
router.post('/records/:dataKey/:id/status', authRequired, async (req, res) => {
    try {
        const status = String(req.body.status || '');
        if (!status) return res.status(400).json({ error: 'status required' });
        const { data: row } = await supabase.from('app_records')
            .select('record').eq('id', req.params.id).eq('site_id', req.siteId).maybeSingle();
        if (!row) return res.status(404).json({ error: 'Not found' });

        const record = row.record || {};
        record.status = status;
        await supabase.from('app_records')
            .update({ record: record, updated_at: new Date().toISOString() })
            .eq('id', req.params.id).eq('site_id', req.siteId);

        // notify the customer
        const phone = record.phone || record.customer_phone;
        if (phone) {
            try {
                const { data: st } = await supabase.from('platform_state')
                    .select('business').eq('site_id', req.siteId).maybeSingle();
                const biz = (st && st.business) || {};
                const bizName = biz.name || 'the business';
                const { sendSms } = require('../utils/sms');
                let msg = null;
                if (status === 'confirmed') msg = '[' + bizName + '] You\'re confirmed' + (record.date ? ' for ' + record.date : '') + (record.time ? ' at ' + record.time : '') + '. See you then!';
                else if (status === 'declined' || status === 'cancelled') msg = '[' + bizName + '] Sorry — we couldn\'t take your request' + (record.date ? ' for ' + record.date : '') + '. Reply here and we\'ll find another time.';
                else if (status === 'completed') {
                    // Authentic review: the link carries the transaction record id,
                    // so the standalone reviews platform (CyberCheck Reviews) can
                    // verify this review came from a real, completed purchase.
                    let link;
                    if (process.env.REVIEW_BASE_URL) {
                        link = process.env.REVIEW_BASE_URL.replace(/\/$/, '') + '/r/' + (biz.slug || '') + '?t=' + req.params.id;
                    } else {
                        const base = process.env.PUBLIC_PAGE_BASE_URL || 'https://gulfcoastradar.com';
                        link = base + '/p/' + (biz.slug || '');
                    }
                    msg = '[' + bizName + '] Thanks for coming out' + (record.customer || record.name ? ', ' + (record.customer || record.name) : '') + '! How was it? Leave a quick review: ' + link + ' — it really helps us.';
                }
                if (msg) await sendSms(phone, msg, req.siteId, 'status_' + status, req.params.id);
            } catch (e) { console.error('status sms failed:', e.message); }
        }
        res.json({ success: true, status: status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// PUBLIC PAGE — one URL per business, rendered from installed blocks
// ============================================================
router.get('/page/:slug', async (req, res) => {
    try {
        const { data: state } = await supabase.from('platform_state')
            .select('site_id, business, installed, page_order')
            .eq('business->>slug', req.params.slug).maybeSingle();
        if (!state) return res.status(404).json({ error: 'Page not found' });

        const installed = state.installed || {};
        const order = (state.page_order || []).filter(function (id) {
            const inst = installed[id];
            return inst && inst.enabled !== false && inst.showOnPublic && inst.manifest && inst.manifest.block;
        });

        // Which data streams are safe to show publicly: the app's own
        // manifest says so (publicData: true) — platform decides nothing.
        const publicKeys = [];
        order.forEach(function (id) {
            const man = installed[id].manifest;
            if (man.publicData && man.dataKey) publicKeys.push(man.dataKey);
        });

        let publicData = {};
        if (publicKeys.length) {
            const { data: recs } = await supabase.from('app_records')
                .select('data_key, record')
                .eq('site_id', state.site_id)
                .in('data_key', publicKeys)
                .order('created_at', { ascending: true }).limit(500);
            (recs || []).forEach(function (r) {
                if (!publicData[r.data_key]) publicData[r.data_key] = [];
                publicData[r.data_key].push(r.record);
            });
        }

        const blocks = order.map(function (id) {
            const inst = installed[id];
            const man = inst.manifest;
            const cfg = inst.config || {};
            return {
                id: id,
                icon: man.icon || '📦',
                title: cfg.label || man.block.title || man.name,
                sub: man.block.sub || '',
                url: cfg.url || null,
                dataKey: man.dataKey || null,
                publicData: !!man.publicData,
                checkout: !!man.checkout,
                fields: (man.fields || []).filter(function (f) { return f.key !== 'status'; })
            };
        });

        // payment config comes from the installed payments app, if any
        let payment = null;
        Object.keys(installed).forEach(function (id) {
            const inst = installed[id];
            const man = inst && inst.manifest;
            if (man && man.id === 'payments' && inst.enabled !== false) {
                const cfg = inst.config || {};
                if (cfg.mode && cfg.mode !== 'No payment (pay on site)') {
                    payment = { mode: cfg.mode, deposit: parseFloat(cfg.deposit) || 0 };
                }
            }
        });

        res.json({
            business: state.business,
            site_id: state.site_id,
            payment: payment,
            blocks: blocks,
            data: publicData
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public form submission — a booking, lead, song request, etc.
// Lands in the app's own data stream and fires automations.
router.post('/page/:slug/submit/:appId', async (req, res) => {
    try {
        const { data: state } = await supabase.from('platform_state')
            .select('site_id, business, installed')
            .eq('business->>slug', req.params.slug).maybeSingle();
        if (!state) return res.status(404).json({ error: 'Page not found' });

        const inst = (state.installed || {})[req.params.appId];
        if (!inst || inst.enabled === false || !inst.manifest || !inst.manifest.dataKey) {
            return res.status(400).json({ error: 'This form is not accepting submissions' });
        }

        const record = {};
        const allowed = (inst.manifest.fields || []).map(function (f) { return f.key; });
        allowed.forEach(function (k) {
            if (req.body[k] != null) record[k] = String(req.body[k]).slice(0, 2000);
        });
        record.source = 'public_page';
        record.status = record.status || 'pending';
        if (req.body.payment_intent_id) record.payment_id = String(req.body.payment_intent_id).slice(0, 100);
        if (req.body.amount_paid) record.amount_paid = String(req.body.amount_paid).slice(0, 20);

        // availability enforcement: no bookings on blocked or full dates
        if (record.date) {
            const avail = await getAvailability(state.site_id, state.installed, inst.manifest.dataKey, null);
            if (avail.blocked.indexOf(record.date) !== -1) {
                return res.status(409).json({ error: 'That date is unavailable — please pick another.' });
            }
            if (avail.full.indexOf(record.date) !== -1) {
                return res.status(409).json({ error: 'That date is fully booked — please pick another.' });
            }
        }

        const dataKey = inst.manifest.dataKey;
        const { error } = await supabase.from('app_records')
            .insert({ site_id: state.site_id, data_key: dataKey, record: record });
        if (error) throw error;

        runAutomations(state.site_id, dataKey, record, state).catch(function () {});

        // Notify the owner by SMS if the business has a phone on file
        try {
            const bizPhone = (state.business || {}).phone;
            if (bizPhone) {
                const { sendSms } = require('../utils/sms');
                const summary = allowed.slice(0, 4).map(function (k) { return record[k]; }).filter(Boolean).join(' · ');
                await sendSms(bizPhone, '[' + ((state.business || {}).name || 'Your page') + '] New ' + (inst.manifest.name || 'submission') + ': ' + summary, state.site_id, 'platform_lead', null);
            }
        } catch (e) { console.error('owner sms failed:', e.message); }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
