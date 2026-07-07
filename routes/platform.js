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
        calendarSync(req.siteId, req.params.dataKey, data.id, record).catch(function () {});
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
        calendarSync(req.siteId, req.params.dataKey, req.params.id, req.body.record || {}).catch(function () {});
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/records/:dataKey/:id', authRequired, async (req, res) => {
    try {
        await supabase.from('app_records')
            .delete().eq('id', req.params.id).eq('site_id', req.siteId);
        calendarRemove(req.params.id).catch(function () {});
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Image upload: any business, any app — base64 in, public URL out.
//    Reuses the existing entity-media storage bucket. ──
router.post('/upload', authRequired, async (req, res) => {
    try {
        const b64 = String(req.body.image || '');
        const mime = String(req.body.mime || 'image/jpeg').slice(0, 40);
        if (!b64) return res.status(400).json({ error: 'image (base64) required' });
        if (b64.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Image too large — keep it under ~6MB' });
        if (!/^image\//.test(mime)) return res.status(400).json({ error: 'Only images can be uploaded' });
        const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg';
        const fileName = 'platform/' + req.siteId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        const buffer = Buffer.from(b64, 'base64');
        const { error } = await supabase.storage.from('entity-media')
            .upload(fileName, buffer, { contentType: mime, upsert: false });
        if (error) throw new Error(error.message);
        const { data } = supabase.storage.from('entity-media').getPublicUrl(fileName);
        res.json({ success: true, url: data.publicUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// UNIFIED CALENDAR — every date-claiming event, one table.
// Internal writes sync automatically; external platforms upsert
// through /calendar/import (email parser, FareHarbor, iCal, ...).
// Availability is computed from THIS table, so a date taken on any
// platform blocks the direct checkout too.
// ============================================================
function calDate(v) {
    const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
}

async function calendarSync(siteId, dataKey, refId, record) {
    try {
        const date = calDate(record.date || record.event_date || record.start_date);
        if (!date) return;
        const isBlock = dataKey === 'blocks';
        if (isBlock && record.kind && record.kind !== 'blocked') return; // only blocked entries claim dates
        const cancelled = ['cancelled', 'declined', 'no-show'].indexOf(record.status) !== -1;
        const entry = {
            site_id: siteId,
            date: date,
            end_date: calDate(record.end_date) || null,
            start_time: record.time || record.departure || record.start_time || null,
            kind: isBlock ? 'block' : 'booking',
            source: record.source === 'public_page' ? 'direct' : (record.calendar_source || 'manual'),
            status: cancelled ? 'cancelled' : 'active',
            title: record.service || record.trip || record.boat || record.session || record.item || record.title || record.note || dataKey.replace(/_/g, ' '),
            party: parseInt(record.party || record.guests || record.adults, 10) || null,
            ref_id: String(refId),
            record: record,
            updated_at: new Date().toISOString()
        };
        const { data: existing } = await supabase.from('unified_calendar')
            .select('id').eq('ref_id', String(refId)).maybeSingle();
        if (existing) await supabase.from('unified_calendar').update(entry).eq('id', existing.id);
        else await supabase.from('unified_calendar').insert(entry);
    } catch (e) { console.error('[calendar] sync failed:', e.message); }
}

async function calendarRemove(refId) {
    try { await supabase.from('unified_calendar').delete().eq('ref_id', String(refId)); }
    catch (e) { console.error('[calendar] remove failed:', e.message); }
}

// Backfill a site's existing dated records into the calendar (idempotent)
async function calendarBackfill(siteId) {
    const { data: recs } = await supabase.from('app_records')
        .select('id, data_key, record').eq('site_id', siteId)
        .neq('data_key', 'automation_log').limit(2000);
    let n = 0;
    for (const r of (recs || [])) {
        const rec = r.record || {};
        if (!calDate(rec.date || rec.event_date || rec.start_date)) continue;
        if (['reward_offers', 'redemptions', 'ugc_videos', 'reviews', 'menu_items', 'specials'].indexOf(r.data_key) !== -1) continue;
        await calendarSync(siteId, r.data_key, r.id, rec);
        n++;
    }
    return n;
}

// ── Availability: blocked dates + capacity, enforced server-side ──
async function getAvailability(siteId, installed, dataKey, month) {
    // ONE source of truth: the unified calendar. Blocks from the owner,
    // bookings from the direct checkout, and entries imported from any
    // external platform all claim dates here.
    const { data: entries } = await supabase.from('unified_calendar')
        .select('date, end_date, kind, status')
        .eq('site_id', siteId).eq('status', 'active').limit(3000);

    // capacity per date comes from the availability app's config
    let capacity = null;
    Object.keys(installed || {}).forEach(function (id) {
        const inst = installed[id];
        if (inst && inst.manifest && inst.manifest.dataKey === 'blocks' && inst.config && inst.config.capacity) {
            const c = parseInt(inst.config.capacity, 10);
            if (c > 0) capacity = c;
        }
    });

    const blocked = [];
    const counts = {};
    function eachDate(e, fn) {
        // multi-day entries claim every date in their range (max 60)
        const start = new Date(e.date + 'T00:00:00Z');
        const end = e.end_date ? new Date(e.end_date + 'T00:00:00Z') : start;
        for (let d = new Date(start), i = 0; d <= end && i < 60; d.setUTCDate(d.getUTCDate() + 1), i++) {
            fn(d.toISOString().slice(0, 10));
        }
    }
    (entries || []).forEach(function (e) {
        if (e.kind === 'block') eachDate(e, function (ds) { if (blocked.indexOf(ds) === -1) blocked.push(ds); });
        else eachDate(e, function (ds) { counts[ds] = (counts[ds] || 0) + 1; });
    });
    let full = capacity ? Object.keys(counts).filter(function (d) { return counts[d] >= capacity; }) : [];
    let b = blocked;
    if (month) {
        b = blocked.filter(function (d) { return d.slice(0, 7) === month; });
        full = full.filter(function (d) { return d.slice(0, 7) === month; });
    }
    return { blocked: b, full: full, capacity: capacity, counts: counts };
}

// Owner's unified calendar — every source, one view
router.get('/calendar', authRequired, async (req, res) => {
    try {
        // first call on a site with dated records but an empty calendar → backfill
        const { data: any } = await supabase.from('unified_calendar')
            .select('id').eq('site_id', req.siteId).limit(1);
        if (!any || !any.length) await calendarBackfill(req.siteId);

        let q = supabase.from('unified_calendar')
            .select('id, date, end_date, start_time, kind, source, status, title, party, ref_id, external_uid')
            .eq('site_id', req.siteId).order('date', { ascending: true }).limit(2000);
        if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
            const m = req.query.month;
            const last = new Date(Date.UTC(parseInt(m.slice(0, 4), 10), parseInt(m.slice(5, 7), 10), 0)).toISOString().slice(0, 10);
            q = q.gte('date', m + '-01').lte('date', last);
        }
        const { data: entries } = await q;
        res.json({ entries: entries || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// External sources push normalized entries here: the email parser,
// FareHarbor sync, iCal feeds, manual imports — anything. Upserts on
// (source, external_uid) so re-imports never duplicate.
router.post('/calendar/import', authRequired, async (req, res) => {
    try {
        const entries = Array.isArray(req.body.entries) ? req.body.entries : [req.body];
        let imported = 0, skipped = 0;
        for (const e of entries.slice(0, 500)) {
            const date = calDate(e.date);
            const source = String(e.source || '').slice(0, 60);
            const uid = String(e.external_uid || '').slice(0, 120);
            if (!date || !source || !uid) { skipped++; continue; }
            const row = {
                site_id: req.siteId,
                date: date,
                end_date: calDate(e.end_date) || null,
                start_time: e.start_time ? String(e.start_time).slice(0, 20) : null,
                end_time: e.end_time ? String(e.end_time).slice(0, 20) : null,
                kind: e.kind === 'block' ? 'block' : 'booking',
                source: source,
                status: e.status === 'cancelled' ? 'cancelled' : 'active',
                title: e.title ? String(e.title).slice(0, 200) : source,
                party: parseInt(e.party, 10) || null,
                external_uid: uid,
                record: e.record || {},
                updated_at: new Date().toISOString()
            };
            const { data: existing } = await supabase.from('unified_calendar')
                .select('id').eq('site_id', req.siteId).eq('source', source).eq('external_uid', uid).maybeSingle();
            if (existing) await supabase.from('unified_calendar').update(row).eq('id', existing.id);
            else await supabase.from('unified_calendar').insert(row);
            imported++;
        }
        res.json({ success: true, imported: imported, skipped: skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
        calendarSync(req.siteId, req.params.dataKey, req.params.id, record).catch(function () {});

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
                if (req.params.dataKey === 'ugc_videos') msg = null; // loyalty hook sends the video-specific text
                else if (status === 'confirmed') msg = '[' + bizName + '] You\'re confirmed' + (record.date ? ' for ' + record.date : '') + (record.time ? ' at ' + record.time : '') + '. See you then!';
                else if (status === 'declined' || status === 'cancelled') msg = '[' + bizName + '] Sorry — we couldn\'t take your request' + (record.date ? ' for ' + record.date : '') + '. Reply here and we\'ll find another time.';
                else if (status === 'completed') {
                    // Authentic review: the link carries the transaction record id,
                    // so the standalone reviews platform (CyberCheck Reviews) can
                    // verify this review came from a real, completed purchase.
                    const rbase = (process.env.REVIEW_BASE_URL || process.env.PUBLIC_PAGE_BASE_URL || 'https://gulfcoastradar.com').replace(/\/$/, '');
                    const link = rbase + '/r/' + (biz.slug || '') + '?t=' + req.params.id;
                    msg = '[' + bizName + '] Thanks for coming out' + (record.customer || record.name ? ', ' + (record.customer || record.name) : '') + '! How was it? Leave a quick review: ' + link + ' — it really helps us.';
                }
                if (msg) await sendSms(phone, msg, req.siteId, 'status_' + status, req.params.id);
            } catch (e) { console.error('status sms failed:', e.message); }
        }

        // ── co-op loyalty hooks (fire-and-forget) ──
        (async () => {
            try {
                const { data: st } = await supabase.from('platform_state')
                    .select('business').eq('site_id', req.siteId).maybeSingle();
                const slug = (st && st.business && st.business.slug) || null;
                const bizName = (st && st.business && st.business.name) || 'the business';
                const custPhone = record.phone || record.customer_phone;
                const { sendSms } = require('../utils/sms');

                if (req.params.dataKey === 'ugc_videos' && status === 'confirmed') {
                    // video approved → points to the uploader
                    const uploader = await touristByPhone(custPhone);
                    if (uploader) {
                        const pts = await platformAward(uploader.user_id, 'video', slug);
                        if (pts && custPhone) await sendSms(custPhone, '[' + bizName + '] Your video was approved — +' + pts + ' points! 🎥', req.siteId, 'points_video', req.params.id);
                    }
                } else if (status === 'completed') {
                    // customer earns for the completed booking
                    const customer = await touristByPhone(custPhone);
                    if (customer) {
                        const pts = await platformAward(customer.user_id, 'booking_completed', slug);
                        if (pts && custPhone) await sendSms(custPhone, '[' + bizName + '] +' + pts + ' points added to your Gulf Perks wallet! 🎁', req.siteId, 'points_booking', req.params.id);
                    }
                    // referrer earns when their booking converts (self-referral blocked)
                    if (record.ref) {
                        const { data: refT } = await supabase.from('tourist_profiles')
                            .select('user_id, phone').eq('ref_code', record.ref).maybeSingle();
                        const same = refT && String(refT.phone || '').replace(/\D/g, '').slice(-10) === String(custPhone || '').replace(/\D/g, '').slice(-10);
                        if (refT && !same) {
                            const pts = await platformAward(refT.user_id, 'referral', slug);
                            if (pts && refT.phone) await sendSms(refT.phone, 'Someone booked through your link at ' + bizName + ' — +' + pts + ' points! 🤝', req.siteId, 'points_referral', req.params.id);
                        }
                    }
                }
            } catch (e) { console.error('[loyalty] hook error:', e.message); }
        })();

        res.json({ success: true, status: status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CO-OP LOYALTY — one append-only ledger (tourist_points) on the
// phone identity. Points for VERIFIED actions only: completed
// bookings, converted referrals, approved videos. Redemptions are
// business-funded offers. Points are credits, never cash.
// ============================================================
const POINT_DEFAULTS = { booking_completed: 100, referral: 200, video: 100, review: 50 };

async function platformAward(userId, reason, slug) {
    if (!userId || !reason) return 0;
    try {
        const { data: cfg } = await supabase.from('points_config').select('earn').eq('id', 1).maybeSingle();
        const delta = parseInt((cfg && cfg.earn && cfg.earn[reason]) != null ? cfg.earn[reason] : POINT_DEFAULTS[reason], 10) || 0;
        if (!delta) return 0;
        await supabase.from('tourist_points').insert({ user_id: userId, delta: delta, reason: reason, entity_slug: slug || null });
        return delta;
    } catch (e) { console.error('[loyalty] award failed:', e.message); return 0; }
}

async function touristByPhone(phone) {
    const p = String(phone || '').replace(/\D/g, '').slice(-10);
    if (p.length < 10) return null;
    // fast paths: common stored formats
    for (const candidate of ['+1' + p, p, '1' + p]) {
        const { data } = await supabase.from('tourist_profiles')
            .select('user_id, phone, ref_code, share_enabled, name')
            .eq('phone', candidate).maybeSingle();
        if (data) return data;
    }
    return null;
}

// ============================================================
// TOURIST WALLET — the customer's own view of the platform.
// Matched by their verified phone number (the identity anchor):
// every booking they made through any business's checkout shows
// up in their GCR account, no matter which business it was with.
// ============================================================
async function touristAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    try {
        const { data, error } = await supabase.auth.getUser(header.split(' ')[1]);
        if (error || !data || !data.user) return res.status(401).json({ error: 'Invalid token' });
        req.touristId = data.user.id;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
function last10(p) {
    const d = String(p || '').replace(/\D/g, '');
    return d.slice(-10);
}

router.get('/my-bookings', touristAuth, async (req, res) => {
    try {
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('phone').eq('user_id', req.touristId).maybeSingle();
        const phone = last10(prof && prof.phone);
        if (!phone || phone.length < 10) return res.json({ bookings: [] });

        const { data: recs } = await supabase.from('app_records')
            .select('id, site_id, data_key, record, created_at')
            .neq('data_key', 'automation_log')
            .order('created_at', { ascending: false }).limit(2000);

        const mine = (recs || []).filter(function (r) {
            const rec = r.record || {};
            const rp = last10(rec.phone || rec.customer_phone);
            return rp.length === 10 && rp === phone;
        });
        if (!mine.length) return res.json({ bookings: [] });

        const siteIds = [];
        mine.forEach(function (r) { if (siteIds.indexOf(r.site_id) === -1) siteIds.push(r.site_id); });
        const { data: states } = await supabase.from('platform_state')
            .select('site_id, business').in('site_id', siteIds);
        const bizMap = {};
        (states || []).forEach(function (s) { bizMap[s.site_id] = s.business || {}; });

        const bookings = mine.map(function (r) {
            const rec = r.record || {};
            const biz = bizMap[r.site_id] || {};
            return {
                id: r.id,
                when: r.created_at,
                stream: r.data_key,
                business: biz.name || 'Business',
                slug: biz.slug || null,
                title: rec.service || rec.trip || rec.boat || rec.session || rec.item || rec.title || String(r.data_key).replace(/_/g, ' '),
                date: rec.date || null,
                time: rec.time || rec.departure || null,
                party: rec.party || rec.guests || null,
                status: rec.status || null,
                amount_paid: rec.amount_paid || null
            };
        });
        res.json({ bookings: bookings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Share & earnings: every tourist is a referrer ──
router.get('/my-share', touristAuth, async (req, res) => {
    try {
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('ref_code, share_enabled, name').eq('user_id', req.touristId).maybeSingle();
        if (!prof) return res.status(404).json({ error: 'No profile' });
        let code = prof.ref_code;
        if (!code) {
            const base = String(prof.name || 'GC').replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase() || 'GC';
            code = base + Math.random().toString(36).slice(2, 6).toUpperCase();
            const { error } = await supabase.from('tourist_profiles')
                .update({ ref_code: code }).eq('user_id', req.touristId);
            if (error) { // rare collision — add entropy and retry once
                code = base + Math.random().toString(36).slice(2, 8).toUpperCase();
                await supabase.from('tourist_profiles').update({ ref_code: code }).eq('user_id', req.touristId);
            }
        }
        const { data: hist } = await supabase.from('tourist_points')
            .select('delta, reason, entity_slug, created_at')
            .eq('user_id', req.touristId)
            .order('created_at', { ascending: false }).limit(100);
        res.json({ ref_code: code, share_enabled: !!prof.share_enabled, earnings: hist || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/my-share', touristAuth, async (req, res) => {
    try {
        await supabase.from('tourist_profiles')
            .update({ share_enabled: !!req.body.share_enabled }).eq('user_id', req.touristId);
        res.json({ success: true, share_enabled: !!req.body.share_enabled });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Guest videos: attach to a COMPLETED booking you own → moderation → points ──
router.post('/my/videos', touristAuth, async (req, res) => {
    try {
        const { booking_id, url } = req.body;
        if (!booking_id || !url || !/^https?:/i.test(url)) {
            return res.status(400).json({ error: 'booking_id and a valid video URL are required' });
        }
        const { data: b } = await supabase.from('app_records')
            .select('id, site_id, record').eq('id', booking_id).maybeSingle();
        if (!b) return res.status(404).json({ error: 'Booking not found' });
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('phone').eq('user_id', req.touristId).maybeSingle();
        const mine = prof && String(prof.phone || '').replace(/\D/g, '').slice(-10) ===
            String((b.record || {}).phone || (b.record || {}).customer_phone || '').replace(/\D/g, '').slice(-10);
        if (!mine) return res.status(403).json({ error: 'That booking is not yours' });
        if ((b.record || {}).status !== 'completed') {
            return res.status(400).json({ error: 'Videos can be added once the trip is completed' });
        }
        await supabase.from('app_records').insert({
            site_id: b.site_id, data_key: 'ugc_videos',
            record: { url: String(url).slice(0, 500), booking_id: booking_id, phone: prof.phone, status: 'pending', source: 'tourist' }
        });
        res.json({ success: true, status: 'pending', note: 'Points are awarded when the business approves it' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rewards: business-funded offers; redemption debits the ledger ──
router.get('/rewards/:slug', async (req, res) => {
    try {
        const { data: state } = await supabase.from('platform_state')
            .select('site_id, business').eq('business->>slug', req.params.slug).maybeSingle();
        if (!state) return res.status(404).json({ error: 'Not found' });
        const { data: offers } = await supabase.from('app_records')
            .select('id, record').eq('site_id', state.site_id).eq('data_key', 'reward_offers').limit(50);
        res.json({
            business: (state.business || {}).name || '',
            offers: (offers || []).map(function (o) {
                return { id: o.id, title: (o.record || {}).title || '', points: parseInt((o.record || {}).points, 10) || 0, detail: (o.record || {}).detail || '' };
            }).filter(function (o) { return o.title && o.points > 0; })
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/redeem', touristAuth, async (req, res) => {
    try {
        const { data: offer } = await supabase.from('app_records')
            .select('id, site_id, record').eq('id', req.body.offer_id).eq('data_key', 'reward_offers').maybeSingle();
        if (!offer) return res.status(404).json({ error: 'Offer not found' });
        const cost = parseInt((offer.record || {}).points, 10) || 0;
        if (!cost) return res.status(400).json({ error: 'Offer has no point cost' });
        const { data: rows } = await supabase.from('tourist_points').select('delta').eq('user_id', req.touristId);
        const balance = (rows || []).reduce(function (sum, r) { return sum + (r.delta || 0); }, 0);
        if (balance < cost) return res.status(400).json({ error: 'Not enough points — you have ' + balance + ', this needs ' + cost });
        const { data: st } = await supabase.from('platform_state')
            .select('business').eq('site_id', offer.site_id).maybeSingle();
        const code = 'GC-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        await supabase.from('tourist_points').insert({
            user_id: req.touristId, delta: -cost, reason: 'redeem',
            entity_slug: (st && st.business && st.business.slug) || null
        });
        await supabase.from('app_records').insert({
            site_id: offer.site_id, data_key: 'redemptions',
            record: { code: code, offer: (offer.record || {}).title, points: cost, status: 'issued' }
        });
        res.json({ success: true, code: code, offer: (offer.record || {}).title, points: cost });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Public user share page: only what they chose to share ──
router.get('/u/:code', async (req, res) => {
    try {
        const { data: prof } = await supabase.from('tourist_profiles')
            .select('name, ref_code, share_enabled, phone')
            .eq('ref_code', req.params.code).maybeSingle();
        if (!prof || !prof.share_enabled) return res.status(404).json({ error: 'Page not found' });
        const phone = String(prof.phone || '').replace(/\D/g, '').slice(-10);
        const { data: recs } = await supabase.from('app_records')
            .select('site_id, record')
            .neq('data_key', 'automation_log')
            .order('created_at', { ascending: false }).limit(2000);
        const siteIds = [];
        (recs || []).forEach(function (r) {
            const rec = r.record || {};
            const rp = String(rec.phone || rec.customer_phone || '').replace(/\D/g, '').slice(-10);
            if (rp === phone && rec.status === 'completed' && siteIds.indexOf(r.site_id) === -1) siteIds.push(r.site_id);
        });
        let businesses = [];
        if (siteIds.length) {
            const { data: states } = await supabase.from('platform_state')
                .select('business').in('site_id', siteIds);
            businesses = (states || []).map(function (st) {
                const b = st.business || {};
                return { name: b.name, slug: b.slug, emoji: b.emoji || '🏪', tagline: b.tagline || '' };
            }).filter(function (b) { return b.slug; });
        }
        res.json({ name: String(prof.name || 'A Gulf Coast local').split(' ')[0], ref_code: prof.ref_code, businesses: businesses });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// CYBERCHECK REVIEWS — the standalone verified review engine.
// A review token IS a completed transaction record id: proof the
// reviewer actually bought the thing. Reward honest feedback,
// never positive sentiment — points issue for submitting at all.
// Reviews land in the business's own 'reviews' stream, so they show
// in their dashboard and on their smart page automatically.
// ============================================================

// Validate a token → what the review form needs (no private data)
router.get('/review-token/:id', async (req, res) => {
    try {
        const { data: b } = await supabase.from('app_records')
            .select('id, site_id, data_key, record').eq('id', req.params.id).maybeSingle();
        if (!b || (b.record || {}).status !== 'completed') {
            return res.status(404).json({ valid: false, error: 'This review link is not valid.' });
        }
        // one review per transaction
        const { data: existing } = await supabase.from('app_records')
            .select('id').eq('site_id', b.site_id).eq('data_key', 'reviews')
            .eq('record->>booking_id', b.id).maybeSingle();
        if (existing) return res.status(409).json({ valid: false, error: 'A review was already left for this booking — thank you!' });

        const { data: st } = await supabase.from('platform_state')
            .select('business').eq('site_id', b.site_id).maybeSingle();
        const biz = (st && st.business) || {};
        const rec = b.record || {};
        res.json({
            valid: true,
            business: { name: biz.name || '', slug: biz.slug || '', emoji: biz.emoji || '🏪', accent: biz.accent || '#22c3a6' },
            title: rec.service || rec.trip || rec.boat || rec.session || rec.item || 'your visit',
            date: rec.date || null,
            reviewer: String(rec.customer || rec.name || '').split(' ')[0] || '',
            badge: 'Verified Booking'
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit a verified review
router.post('/reviews', async (req, res) => {
    try {
        const { token, stars, text, name } = req.body;
        const rating = parseInt(stars, 10);
        if (!token || !rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'A rating between 1 and 5 is required.' });
        }
        const { data: b } = await supabase.from('app_records')
            .select('id, site_id, record').eq('id', token).maybeSingle();
        if (!b || (b.record || {}).status !== 'completed') {
            return res.status(404).json({ error: 'This review link is not valid.' });
        }
        const { data: existing } = await supabase.from('app_records')
            .select('id').eq('site_id', b.site_id).eq('data_key', 'reviews')
            .eq('record->>booking_id', b.id).maybeSingle();
        if (existing) return res.status(409).json({ error: 'A review was already left for this booking.' });

        const rec = b.record || {};
        const reviewerName = String(name || rec.customer || rec.name || 'Verified guest').slice(0, 80);
        await supabase.from('app_records').insert({
            site_id: b.site_id, data_key: 'reviews',
            record: {
                name: reviewerName,
                stars: rating,
                text: String(text || '').slice(0, 2000),
                badge: 'Verified Booking',
                booking_id: b.id,
                source: 'cybercheck_reviews'
            }
        });

        // honest feedback earns points — any star count, same reward
        let pointsAwarded = 0;
        const { data: st } = await supabase.from('platform_state')
            .select('business').eq('site_id', b.site_id).maybeSingle();
        const slug = (st && st.business && st.business.slug) || null;
        const reviewer = await touristByPhone(rec.phone || rec.customer_phone);
        if (reviewer) pointsAwarded = await platformAward(reviewer.user_id, 'review', slug);

        res.json({ success: true, badge: 'Verified Booking', points: pointsAwarded });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public review wall for a business (embeddable anywhere)
router.get('/reviews/:slug', async (req, res) => {
    try {
        const { data: state } = await supabase.from('platform_state')
            .select('site_id, business').eq('business->>slug', req.params.slug).maybeSingle();
        if (!state) return res.status(404).json({ error: 'Not found' });
        const { data: rows } = await supabase.from('app_records')
            .select('record, created_at').eq('site_id', state.site_id).eq('data_key', 'reviews')
            .order('created_at', { ascending: false }).limit(200);
        const reviews = (rows || []).map(function (r) {
            const rec = r.record || {};
            return {
                name: rec.name || 'Guest',
                stars: parseInt(rec.stars, 10) || 0,
                text: rec.text || '',
                badge: rec.badge || (rec.booking_id ? 'Verified Booking' : 'Unverified Opinion'),
                when: r.created_at
            };
        }).filter(function (r) { return r.stars > 0; });
        const avg = reviews.length ? reviews.reduce(function (s, r) { return s + r.stars; }, 0) / reviews.length : 0;
        const biz = state.business || {};
        res.json({
            business: { name: biz.name || '', slug: biz.slug || '', emoji: biz.emoji || '🏪', tagline: biz.tagline || '', accent: biz.accent || '#22c3a6' },
            average: Math.round(avg * 10) / 10,
            count: reviews.length,
            verified_count: reviews.filter(function (r) { return r.badge === 'Verified Booking'; }).length,
            reviews: reviews
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        if (req.body.ref) {
            const code = String(req.body.ref).slice(0, 24);
            const { data: refT } = await supabase.from('tourist_profiles')
                .select('user_id').eq('ref_code', code).maybeSingle();
            if (refT) record.ref = code; // only real codes are stored
        }
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
        const { data: inserted, error } = await supabase.from('app_records')
            .insert({ site_id: state.site_id, data_key: dataKey, record: record })
            .select('id').single();
        if (error) throw error;

        runAutomations(state.site_id, dataKey, record, state).catch(function () {});
        calendarSync(state.site_id, dataKey, inserted.id, record).catch(function () {});

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
