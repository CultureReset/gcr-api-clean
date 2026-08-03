// ============================================================
// ADMIN ANALYTICS — read-only views over behaviour actually recorded
// ============================================================
//
// Nothing here writes and nothing here invents a number. Every figure comes
// from a table the front end already fills.
//
// ── What is genuinely tracked today ─────────────────────────────────────
//
//   gcr_page_views        POST /api/gcr/track, from gcr-unified's App.jsx.
//                         A DAILY ROLLUP — (entity_id, view_date, view_count).
//                         No visitor, no referrer, no session, no path. The
//                         route also ignores any path that is not
//                         /business/:slug, so search, category and browse
//                         pages record nothing at all.
//
//   tourist_click_events  POST /api/tourist/track-click, from BusinessDetail.
//                         A real event log: user, slug, click_type
//                         (book | reserve | order | transportation),
//                         target_url and a `converted` flag.
//
//   tourist_swipe_events / tourist_seen / tourist_saves   Trip Swipe.
//
// ── The gap, stated plainly ─────────────────────────────────────────────
//
// routes/analytics.js already accepts UTM, referrer, device, session duration
// and conversions, and writes them to `page_views` and `conversions`. Both
// tables are EMPTY, because gcr-unified never calls those endpoints — it calls
// /api/gcr/track instead. So the capability exists and is simply unfed.
//
// Until that changes, sessions, referrers, devices, funnels and time-on-page
// cannot be reported, and no endpoint here pretends otherwise. Every response
// carries `coverage`, so a small number reads as "barely tracked yet" rather
// than "nobody came".

const express = require('express');
const db = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

/** Clamp ?days= to something a chart can hold. */
function windowDays(raw, fallback = 30) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 1), 365);
}

function since(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}

function tally(rows, key) {
    const out = new Map();
    for (const r of rows || []) {
        const k = r?.[key] ?? 'unknown';
        out.set(k, (out.get(k) || 0) + 1);
    }
    return [...out.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
}

const COVERAGE = {
    page_views:
        'Daily rollup of business-profile views only. Search, category and browse pages are not recorded, and there is no per-visitor detail.',
    clicks: 'Outbound clicks from a business profile: book, reserve, order, transportation.',
    swipes: 'Trip Swipe left/right events.',
    saves: 'Businesses a tourist kept.',
    not_tracked:
        'Sessions, referrers, devices, time on page and funnels are NOT recorded. routes/analytics.js can accept them but gcr-unified does not send them, so page_views and conversions are empty.',
};

/* ── GET /api/admin/analytics/entity/:slug ───────────────────────────────── */

router.get('/entity/:slug', adminRequired, async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const days = windowDays(req.query.days);
    const from = since(days);

    try {
        const { data: entity, error: entErr } = await db
            .from('entity').select('id, slug, name').eq('slug', slug).maybeSingle();
        if (entErr) return res.status(500).json({ error: entErr.message });
        if (!entity) return res.status(404).json({ error: `No business with slug "${slug}"` });

        const [views, clicks, swipes, saves, seen] = await Promise.all([
            db.from('gcr_page_views').select('view_date, view_count')
                .eq('entity_id', entity.id).gte('view_date', from).order('view_date'),
            db.from('tourist_click_events').select('click_type, target_url, created_at, converted, user_id')
                .eq('entity_slug', slug).gte('created_at', from).order('created_at', { ascending: false }),
            db.from('tourist_swipe_events').select('direction, category, created_at')
                .eq('entity_slug', slug).gte('created_at', from),
            db.from('tourist_saves').select('saved_at, is_super_like, user_id')
                .eq('entity_slug', slug).gte('saved_at', from),
            db.from('tourist_seen').select('created_at')
                .eq('entity_slug', slug).gte('created_at', from),
        ]);

        const viewRows = views.data || [];
        const clickRows = clicks.data || [];
        const swipeRows = swipes.data || [];
        const saveRows = saves.data || [];
        const shown = (seen.data || []).length;

        const totalViews = viewRows.reduce((n, r) => n + (r.view_count || 0), 0);
        const right = swipeRows.filter((s) => s.direction === 'right').length;

        res.json({
            slug,
            name: entity.name,
            window_days: days,
            since: from,
            totals: {
                page_views: totalViews,
                clicks: clickRows.length,
                clicks_converted: clickRows.filter((c) => c.converted).length,
                swipes: swipeRows.length,
                swipes_right: right,
                saves: saveRows.length,
                super_likes: saveRows.filter((s) => s.is_super_like).length,
                times_shown: shown,
            },
            // A rate is only returned when its denominator is real. A null here
            // means "not enough recorded to say", which is different from zero.
            rates: {
                click_through: totalViews ? +((clickRows.length / totalViews) * 100).toFixed(1) : null,
                swipe_right: swipeRows.length ? +((right / swipeRows.length) * 100).toFixed(1) : null,
                save_after_seen: shown ? +((saveRows.length / shown) * 100).toFixed(1) : null,
            },
            views_by_day: viewRows.map((r) => ({ date: r.view_date, views: r.view_count || 0 })),
            clicks_by_type: tally(clickRows, 'click_type'),
            recent_clicks: clickRows.slice(0, 50),
            coverage: COVERAGE,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── GET /api/admin/analytics/platform ───────────────────────────────────── */

router.get('/platform', adminRequired, async (req, res) => {
    const days = windowDays(req.query.days);
    const from = since(days);

    try {
        const [views, clicks, swipes, saves, entities] = await Promise.all([
            db.from('gcr_page_views').select('entity_id, view_date, view_count')
                .gte('view_date', from).limit(50000),
            db.from('tourist_click_events').select('entity_slug, click_type, created_at, converted, user_id')
                .gte('created_at', from).limit(50000),
            db.from('tourist_swipe_events').select('entity_slug, direction, category, created_at')
                .gte('created_at', from).limit(50000),
            db.from('tourist_saves').select('entity_slug, business_name, saved_at, is_super_like, user_id')
                .gte('saved_at', from).limit(50000),
            db.from('entity').select('id, slug, name').limit(10000),
        ]);

        const byId = new Map((entities.data || []).map((e) => [e.id, e]));
        const viewRows = views.data || [];
        const clickRows = clicks.data || [];
        const swipeRows = swipes.data || [];
        const saveRows = saves.data || [];

        const perDay = new Map();
        const perEntity = new Map();
        for (const r of viewRows) {
            perDay.set(r.view_date, (perDay.get(r.view_date) || 0) + (r.view_count || 0));
            const e = byId.get(r.entity_id);
            const key = e ? e.slug : String(r.entity_id);
            const cur = perEntity.get(key) || { slug: key, name: e?.name || key, views: 0 };
            cur.views += r.view_count || 0;
            perEntity.set(key, cur);
        }

        const clicksBySlug = new Map();
        for (const c of clickRows) clicksBySlug.set(c.entity_slug, (clicksBySlug.get(c.entity_slug) || 0) + 1);

        const identified = new Set(
            [...clickRows.map((c) => c.user_id), ...saveRows.map((s) => s.user_id)].filter(Boolean)
        ).size;

        res.json({
            window_days: days,
            since: from,
            totals: {
                page_views: viewRows.reduce((n, r) => n + (r.view_count || 0), 0),
                businesses_viewed: perEntity.size,
                clicks: clickRows.length,
                clicks_converted: clickRows.filter((c) => c.converted).length,
                swipes: swipeRows.length,
                swipes_right: swipeRows.filter((s) => s.direction === 'right').length,
                saves: saveRows.length,
                identified_visitors: identified,
            },
            views_by_day: [...perDay.entries()]
                .map(([date, views]) => ({ date, views }))
                .sort((a, b) => a.date.localeCompare(b.date)),
            top_businesses: [...perEntity.values()]
                .map((e) => ({ ...e, clicks: clicksBySlug.get(e.slug) || 0 }))
                .sort((a, b) => b.views - a.views)
                .slice(0, 50),
            clicks_by_type: tally(clickRows, 'click_type'),
            swipes_by_category: tally(swipeRows, 'category'),
            most_saved: tally(saveRows, 'business_name').slice(0, 25),
            coverage: COVERAGE,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ── GET /api/admin/analytics/health ─────────────────────────────────────── */
// Which trackers are actually feeding data. The honest answer to "why are my
// numbers so low" is usually here rather than in the numbers.

router.get('/health', adminRequired, async (_req, res) => {
    const probe = async (table, column) => {
        const { count, error } = await db.from(table).select(column, { count: 'exact', head: true });
        return { table, rows: error ? null : (count ?? 0), error: error?.message || null };
    };

    try {
        const sources = await Promise.all([
            probe('gcr_page_views', 'id'),
            probe('tourist_click_events', 'id'),
            probe('tourist_swipe_events', 'id'),
            probe('tourist_saves', 'id'),
            probe('tourist_seen', 'id'),
            probe('page_views', 'id'),
            probe('conversions', 'id'),
        ]);

        res.json({
            sources,
            note:
                '`page_views` and `conversions` are written by routes/analytics.js, which accepts UTM, referrer, device and duration. If they are empty, the front end is not calling those endpoints — gcr-unified currently posts to /api/gcr/track instead, which only rolls up business-profile view counts.',
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
