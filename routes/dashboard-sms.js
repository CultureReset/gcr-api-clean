// ============================================================
// DASHBOARD SMS — text a question, get an answer from real data
// ============================================================
//
// SEPARATE FROM routes/sms.js. That file is the customer-facing pipeline —
// tourist signup, staff commands, blasts, QR attribution — and nothing here
// touches it, imports from it, or changes how it behaves. This file talks to
// Brevo directly rather than going through utils/sms.js so the two systems
// cannot affect each other. There is no Twilio anywhere in this file.
//
// ── What it does ────────────────────────────────────────────────────────
//
// You text a question. A model reads it, decides which of the platform's own
// read endpoints answer it, those run for real, and the model writes one short
// reply from what came back.
//
// ── The rule that makes it trustworthy ──────────────────────────────────
//
// THE MODEL NEVER PRODUCES A NUMBER. It chooses which query to run and phrases
// the result. Every figure in a reply came out of the database on that
// request. A model asked "how many views did Caribe Marina get" will happily
// invent a plausible number if allowed to; here it has nothing to invent from
// until a tool has run, and if no tool applies it is required to say so.
//
// ── Who may ask ─────────────────────────────────────────────────────────
//
// A phone number in `dashboard_sms_allowlist`, and nobody else. This endpoint
// answers questions about the whole platform, so an open one would be a data
// leak whose only password is knowing the number. Rejections are logged rather
// than silently dropped.
//
// Provider: Brevo. Its inbound webhook posts JSON, so this reads JSON and
// replies by making its own outbound call — not by returning a body, which is
// the Twilio idiom and is why the existing /api/sms/inbound cannot serve this.

const express = require('express');
const db = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

/** One SMS segment is 160 chars; keep replies to about two. */
const MAX_REPLY = 300;

/* ── Brevo, spoken to directly ───────────────────────────────────────────── */

async function sendSms(to, text) {
    const key = process.env.BREVO_API_KEY;
    if (!key) return { ok: false, error: 'BREVO_API_KEY not set' };
    try {
        const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
            method: 'POST',
            headers: { 'api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sender: process.env.DASHBOARD_SMS_SENDER || process.env.BREVO_SMS_SENDER || 'CyberCheck',
                recipient: String(to).replace(/[^\d]/g, ''),
                content: text.slice(0, MAX_REPLY),
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: data.message || `HTTP ${res.status}` };
        return { ok: true, id: data.messageId };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

const normalise = (p) => {
    const digits = String(p || '').replace(/[^\d]/g, '');
    if (!digits) return null;
    return '+' + (digits.length === 10 ? '1' + digits : digits);
};

/* ── the tools ───────────────────────────────────────────────────────────────
   Each is a real read against the database. The model may only get numbers
   through these — it has no other source. Adding a capability here is the ONLY
   way to widen what a text can ask about, which keeps the blast radius visible.
*/

const since = (days) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
};

const TOOLS = {
    find_business: {
        description: 'Find businesses by name or slug. Use this first when a question names a business.',
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'part of a name or slug' } },
            required: ['query'],
        },
        run: async ({ query }) => {
            const { data } = await db.from('entity')
                .select('slug, name, entity_type, city')
                .or(`name.ilike.%${query}%,slug.ilike.%${query}%`)
                .limit(8);
            return data || [];
        },
    },

    platform_totals: {
        description: 'Platform-wide counts: businesses, and how many have menus, photos or hours on file.',
        input_schema: { type: 'object', properties: {} },
        run: async () => {
            const count = async (t) => (await db.from(t).select('id', { count: 'exact', head: true })).count ?? 0;
            return {
                businesses: await count('entity'),
                menu_items: await count('menu_items'),
                photos: await count('entity_photos'),
                events: await count('entity_events'),
                bookable_resources: await count('bookable_resources'),
            };
        },
    },

    traffic: {
        description: 'Visitor behaviour over a window: profile views, clicks, swipes, saves. Platform-wide, or one business if slug is given.',
        input_schema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'optional business slug' },
                days: { type: 'integer', description: 'how many days back, default 7' },
            },
        },
        run: async ({ slug, days = 7 }) => {
            const from = since(days);
            if (slug) {
                const { data: ent } = await db.from('entity').select('id, name').eq('slug', slug).maybeSingle();
                if (!ent) return { error: `no business with slug ${slug}` };
                const [v, c, s] = await Promise.all([
                    db.from('gcr_page_views').select('view_count').eq('entity_id', ent.id).gte('view_date', from),
                    db.from('tourist_click_events').select('id', { count: 'exact', head: true }).eq('entity_slug', slug).gte('created_at', from),
                    db.from('tourist_saves').select('id', { count: 'exact', head: true }).eq('entity_slug', slug).gte('saved_at', from),
                ]);
                return {
                    business: ent.name, days,
                    views: (v.data || []).reduce((n, r) => n + (r.view_count || 0), 0),
                    clicks: c.count ?? 0,
                    saves: s.count ?? 0,
                };
            }
            const [v, c, s, sw] = await Promise.all([
                db.from('gcr_page_views').select('view_count').gte('view_date', from).limit(50000),
                db.from('tourist_click_events').select('id', { count: 'exact', head: true }).gte('created_at', from),
                db.from('tourist_saves').select('id', { count: 'exact', head: true }).gte('saved_at', from),
                db.from('tourist_swipe_events').select('id', { count: 'exact', head: true }).gte('created_at', from),
            ]);
            return {
                days,
                views: (v.data || []).reduce((n, r) => n + (r.view_count || 0), 0),
                clicks: c.count ?? 0,
                saves: s.count ?? 0,
                swipes: sw.count ?? 0,
            };
        },
    },

    top_businesses: {
        description: 'The most-viewed businesses over a window.',
        input_schema: {
            type: 'object',
            properties: { days: { type: 'integer' }, limit: { type: 'integer' } },
        },
        run: async ({ days = 7, limit = 5 }) => {
            const { data: views } = await db.from('gcr_page_views')
                .select('entity_id, view_count').gte('view_date', since(days)).limit(50000);
            const totals = new Map();
            for (const r of views || []) totals.set(r.entity_id, (totals.get(r.entity_id) || 0) + (r.view_count || 0));
            const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
            if (!top.length) return [];
            const { data: ents } = await db.from('entity').select('id, name').in('id', top.map(([id]) => id));
            const byId = new Map((ents || []).map((e) => [e.id, e.name]));
            return top.map(([id, v]) => ({ name: byId.get(id) || id, views: v }));
        },
    },

    business_profile: {
        description: 'What one business has on file: which tables hold its data and how many rows in each.',
        input_schema: {
            type: 'object',
            properties: { slug: { type: 'string' } },
            required: ['slug'],
        },
        run: async ({ slug }) => {
            const probe = async (t) => {
                const { count } = await db.from(t).select('id', { count: 'exact', head: true }).eq('entity_slug', slug);
                return count ?? 0;
            };
            const tables = ['menu_items', 'entity_photos', 'entity_events', 'entity_hours',
                'bookable_resources', 'offerings', 'vessels', 'charter_trips', 'entity_reviews'];
            const out = {};
            for (const t of tables) {
                const n = await probe(t);
                if (n) out[t] = n;
            }
            return out;
        },
    },

    intake_queue: {
        description: 'Businesses that have submitted their links and are waiting to be processed.',
        input_schema: { type: 'object', properties: {} },
        run: async () => {
            const { data } = await db.from('intake_requests')
                .select('business_name, entity_slug, status, created_at')
                .neq('status', 'done').order('created_at', { ascending: false }).limit(10);
            return data || [];
        },
    },

    capacity_gaps: {
        description: 'Businesses with no daily capacity set — they can never report an opening.',
        input_schema: { type: 'object', properties: {} },
        run: async () => {
            const [total, missing] = await Promise.all([
                db.from('entity').select('id', { count: 'exact', head: true }),
                db.from('entity').select('id', { count: 'exact', head: true }).is('daily_capacity', null),
            ]);
            return { businesses: total.count ?? 0, without_capacity: missing.count ?? 0 };
        },
    },
};

/* ── the loop ────────────────────────────────────────────────────────────── */

async function answer(question) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return { text: 'The assistant is not configured (no ANTHROPIC_API_KEY).', tools: [] };
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const tools = Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        input_schema: t.input_schema,
    }));

    const messages = [{ role: 'user', content: question }];
    const used = [];

    // A handful of turns is plenty for "find the business, then get its
    // traffic". The cap exists so a confused model cannot loop forever on
    // someone's phone bill.
    for (let turn = 0; turn < 5; turn++) {
        const res = await client.messages.create({
            model: process.env.DASHBOARD_SMS_MODEL || 'claude-opus-4-7',
            max_tokens: 1024,
            system:
                'You answer questions about the Gulf Coast Radar platform by calling the provided tools. ' +
                'You must never state a number that did not come from a tool result on this request — if no tool ' +
                'can answer, say plainly what is not available rather than estimating. ' +
                'Reply in at most two sentences, plain text, no markdown, suitable for an SMS.',
            tools,
            messages,
        });

        const calls = res.content.filter((c) => c.type === 'tool_use');
        if (!calls.length) {
            const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
            return { text: text || 'No answer.', tools: used };
        }

        messages.push({ role: 'assistant', content: res.content });
        const results = [];
        for (const call of calls) {
            used.push(call.name);
            let out;
            try {
                out = TOOLS[call.name]
                    ? await TOOLS[call.name].run(call.input || {})
                    : { error: `no such tool ${call.name}` };
            } catch (e) {
                out = { error: e.message };
            }
            results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out).slice(0, 6000) });
        }
        messages.push({ role: 'user', content: results });
    }

    return { text: 'That took too many steps to answer. Try asking something narrower.', tools: used };
}

/* ── POST /api/dashboard-sms/inbound ─────────────────────────────────────── */
// Brevo's inbound webhook. Unauthenticated by necessity — Brevo cannot carry a
// bearer token — so the allowlist IS the authentication.

router.post('/inbound', express.json(), async (req, res) => {
    const started = Date.now();
    const b = req.body || {};
    // Brevo has used a few field names across versions; accept the ones it
    // sends rather than insisting on one and silently dropping the rest.
    const from = normalise(b.from || b.sender || b.msisdn || b.From);
    const text = String(b.text || b.content || b.message || b.Body || '').trim();

    // Always 200. A webhook that returns an error gets retried, and retrying a
    // question means answering it twice.
    const ack = (payload = { ok: true }) => res.status(200).json(payload);

    if (!from || !text) return ack({ ok: true, ignored: 'no sender or text' });

    try {
        const { data: allowed } = await db.from('dashboard_sms_allowlist')
            .select('id, phone').eq('phone', from).eq('is_active', true).maybeSingle();

        if (!allowed) {
            await db.from('dashboard_sms_log').insert({
                from_phone: from, allowed: false, question: text,
                answer: null, duration_ms: Date.now() - started,
            });
            return ack({ ok: true, ignored: 'not allowlisted' });
        }

        const { text: reply, tools } = await answer(text);
        const sent = await sendSms(from, reply);

        await Promise.all([
            db.from('dashboard_sms_log').insert({
                from_phone: from, allowed: true, question: text, answer: reply,
                tools_used: tools.join(',') || null,
                error: sent.ok ? null : sent.error,
                duration_ms: Date.now() - started,
            }),
            db.from('dashboard_sms_allowlist').update({ last_used_at: new Date().toISOString() }).eq('id', allowed.id),
        ]);

        return ack({ ok: true, replied: sent.ok });
    } catch (e) {
        await db.from('dashboard_sms_log').insert({
            from_phone: from, allowed: true, question: text, error: e.message,
            duration_ms: Date.now() - started,
        }).then(() => {}, () => {});
        return ack({ ok: true, error: e.message });
    }
});

/* ── admin: try it without a phone ───────────────────────────────────────── */

router.post('/ask', adminRequired, async (req, res) => {
    const q = String(req.body?.question || '').trim();
    if (!q) return res.status(400).json({ error: 'question required' });
    const started = Date.now();
    try {
        const { text, tools } = await answer(q);
        res.json({ question: q, answer: text, tools_used: tools, duration_ms: Date.now() - started });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── admin: who may text, and what has been asked ────────────────────────── */

router.get('/allowlist', adminRequired, async (_req, res) => {
    const { data, error } = await db.from('dashboard_sms_allowlist')
        .select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ numbers: data || [] });
});

router.post('/allowlist', adminRequired, async (req, res) => {
    const phone = normalise(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'A phone number is required' });
    const { data, error } = await db.from('dashboard_sms_allowlist')
        .insert({ phone, label: req.body?.label || null }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ number: data });
});

router.patch('/allowlist/:id', adminRequired, async (req, res) => {
    const patch = {};
    if (req.body?.label !== undefined) patch.label = req.body.label;
    if (req.body?.is_active !== undefined) patch.is_active = req.body.is_active;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    const { data, error } = await db.from('dashboard_sms_allowlist').update(patch).eq('id', req.params.id).select();
    if (error) return res.status(400).json({ error: error.message });
    if (!data?.length) return res.status(404).json({ error: 'No such number' });
    res.json({ number: data[0] });
});

router.delete('/allowlist/:id', adminRequired, async (req, res) => {
    const { error } = await db.from('dashboard_sms_allowlist').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ deleted: true });
});

router.get('/log', adminRequired, async (req, res) => {
    const { data, error } = await db.from('dashboard_sms_log')
        .select('*').order('created_at', { ascending: false }).limit(Number(req.query.limit) || 100);
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];
    res.json({
        log: rows,
        rejected: rows.filter((r) => r.allowed === false).length,
        tools: Object.keys(TOOLS),
        configured: {
            brevo: Boolean(process.env.BREVO_API_KEY),
            model: Boolean(process.env.ANTHROPIC_API_KEY),
        },
    });
});

module.exports = router;
