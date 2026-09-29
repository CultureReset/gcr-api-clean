// Who a push goes to. One copy, used by every router that pushes something
// to businesses (automations, the store): a second copy would drift until
// "owners" meant two different things.
//
// Admin-only callers: the audience names businesses explicitly, which an owner
// route must never accept (see CLAUDE.md, "The slug is never taken from the
// request").

const supabase = require('../db');

/** PostgREST caps at 1,000 rows silently; page explicitly. */
async function pageAll(build, pageSize = 1000) {
    const all = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await build().range(from, from + pageSize - 1);
        if (error) throw new Error(error.message);
        all.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return all;
}

/* ── audiences ───────────────────────────────────────────────────────────
 *
 * Who a push goes to. "owners" is the default and the honest meaning of
 * "my users": the businesses that have a login and therefore a dashboard to
 * see it on. "all" is every active listing, which is thousands — the preview
 * says so before anything is written.
 */
async function resolveAudience(audience) {
    const mode = audience?.mode || 'owners';

    if (mode === 'slugs') {
        const slugs = [...new Set((audience.slugs || []).map((s) => String(s).trim()).filter(Boolean))];
        if (!slugs.length) return [];
        const rows = await pageAll(() => supabase.from('entity').select('slug').in('slug', slugs));
        return rows.map((r) => r.slug);
    }

    if (mode === 'owners') {
        const rows = await pageAll(() => supabase.from('entity_owners').select('entity_slug').order('entity_slug'));
        return [...new Set(rows.map((r) => r.entity_slug).filter(Boolean))];
    }

    if (mode === 'industries') {
        const types = (audience.industries || []).map((s) => String(s).trim()).filter(Boolean);
        if (!types.length) return [];
        const rows = await pageAll(() =>
            supabase.from('entity').select('slug').eq('is_active', true).in('entity_type', types).order('slug'));
        return rows.map((r) => r.slug);
    }

    if (mode === 'all') {
        const rows = await pageAll(() => supabase.from('entity').select('slug').eq('is_active', true).order('slug'));
        return rows.map((r) => r.slug);
    }

    throw new Error(`Unknown audience mode: ${mode}`);
}

/** Distinct entity_type values with counts, for the audience picker. */
let industryCache = null;
async function industries() {
    if (industryCache && Date.now() - industryCache.at < 5 * 60 * 1000) return industryCache.list;
    const rows = await pageAll(() => supabase.from('entity').select('entity_type').eq('is_active', true).not('entity_type', 'is', null));
    const counts = new Map();
    for (const r of rows) {
        const v = (r.entity_type || '').trim();
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    const list = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    industryCache = { list, at: Date.now() };
    return list;
}


module.exports = { pageAll, resolveAudience, industries };
