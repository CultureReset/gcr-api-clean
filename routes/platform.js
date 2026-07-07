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
                fields: (man.fields || []).filter(function (f) { return f.key !== 'status'; })
            };
        });

        res.json({
            business: state.business,
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
