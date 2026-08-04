// ============================================================
// CONCIERGE TOOLS — the public directory, as tools
// ============================================================
//
// Five read-only tools over every active business on the platform. No slug
// scoping and no session: this is the data already on the public site, so
// there is nothing here a visitor could not read by browsing.
//
// ── Where these came from ───────────────────────────────────────────────
//
// They were written inside routes/tourist.js, as the tool loop behind the
// tourist chat, and they work — search_businesses reaches the same deep
// multi-table index as the search bar, get_business_details renders the same
// page data as a profile. Lifting them out changes nothing about what they do.
//
// What it changes is who can call them. tourist.js drives them from one chat
// endpoint with one provider hard-coded inside it. Here they are a module, so
// routes/mcp-public.js can hand the same five to an outside agent — a voice
// agent taking phone calls, a web chat, anything that speaks MCP — and every
// one of them answers from the same rows.
//
// One copy. A better search here is a better search on the phone, in the chat
// widget and on the website at once.
//
// ── The rule these encode ───────────────────────────────────────────────
//
// Every tool returns real rows and says so. Where data is missing they return
// a note telling the model to say it does not know, because the failure that
// matters is not "I could not find it" — it is a confident wrong price read
// aloud to somebody standing at the door.

const db = require('../db');

/* ── the tools ────────────────────────────────────────────────────────── */

const CONCIERGE_TOOLS = [
    {
        name: 'search_businesses',
        title: 'Search every business',
        description:
            'Search ALL active Gulf Coast businesses by name OR by any of their content — menu items and dishes, drinks, happy-hour items, specials, events, activities/charters/tours, fish species, pricing tiers, what\'s-included, room types, services, products, amenities, FAQs, and tags. Use this for ANY "who has X / which places do Y / where can I get Z" question (e.g. "who has crab legs", "red snapper fishing charter", "family-friendly", "2-bedroom condo", "live music tonight"). Returns each match\'s parent hub (e.g. the marina it operates from).',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Free-text search — matches business name AND all of their content (dishes, drinks, activities, fish species, amenities, etc.). E.g. "crab legs", "red snapper", "Black Flag", "sunset cruise".',
                },
                entity_subtype: {
                    type: 'string',
                    description: 'Exact subtype to filter on, e.g. "dolphin_cruise", "kayak_rental", "fishing_charter", "marina"',
                },
                entity_type: { type: 'string', description: 'Exact type to filter on, e.g. "activity", "restaurant", "service"' },
                tag: {
                    type: 'string',
                    description:
                        'Substring match against tags, e.g. "dolphin" or "kayak" — broader than entity_subtype since tags catch secondary offerings',
                },
                limit: { type: 'integer', description: 'Max results, default 15, max 30' },
            },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'get_business_details',
        title: 'Read one business in full',
        description:
            'Read a specific business\'s FULL page — the same data shown on its real profile page: menu/drink/happy-hour items, offerings & pricing tiers, hours, reviews, FAQs, policies, team, amenities/tags, and its parent hub. Use this after search_businesses points you at a slug and the caller needs more depth than the one-line summary.',
        inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string', description: 'The business\'s slug, e.g. "black-flag" or "gulf-coast-luggo"' } },
            required: ['slug'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'check_availability',
        title: 'Live availability for today',
        description:
            'Check a specific business\'s real-time availability for today (spots/units remaining, capacity, whether it\'s a last-minute deal, and how recently that number was updated). Only businesses whose owner has enabled availability display will have data — if none exists, say you don\'t have live availability for that one rather than guessing.',
        inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string', description: 'The business\'s slug' } },
            required: ['slug'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'find_item_prices',
        title: 'Cheapest-first price search',
        description:
            'Price-sorted search across every structured item on the coast: menu items, drinks, happy-hour items, offers/trips/rentals (with their price tiers), and retail inventory. Use for ANY "cheapest / under $X / best price for Y" question — e.g. "cheapest crab legs", "margarita under $10", "cheapest dolphin cruise for kids". Returns real rows: item, price, and which business, sorted low to high.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The item to price-hunt, e.g. "crab legs", "margarita", "dolphin cruise"' },
                max_price: { type: 'number', description: 'Optional ceiling — only return items at or under this price' },
                limit: { type: 'integer', description: 'Max rows, default 20' },
            },
            required: ['query'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'compare_businesses',
        title: 'Compare two to five businesses',
        description:
            'Side-by-side structured comparison of 2–5 businesses: their industry facts table (boat length, max passengers, trip hours, altitude, units, price range — whatever their industry tracks), cheapest offer prices, fees, deposits, refund/cancellation and weather policies, rating. Use for "what\'s the difference between A and B", "which parasailing company is better", "compare these condos".',
        inputSchema: {
            type: 'object',
            properties: { slugs: { type: 'array', items: { type: 'string' }, description: '2–5 business slugs to compare' } },
            required: ['slugs'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
];

const CONCIERGE_TOOL_NAMES = new Set(CONCIERGE_TOOLS.map((t) => t.name));

/**
 * The same five in the shape the Messages-style tool loop in routes/tourist.js
 * wants: `input_schema` rather than `inputSchema`, and no annotations.
 */
const asInputSchemaTools = () =>
    CONCIERGE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));

/* ── running them ─────────────────────────────────────────────────────── */

/**
 * Run one concierge tool and return its raw payload.
 *
 * Returns `{ error }` rather than throwing for expected failures — a missing
 * slug, an empty search — because the caller should show the model what went
 * wrong and let it try something else, not end the turn.
 */
async function runConciergeTool(name, input = {}) {
    if (name === 'find_item_prices') {
        // Structured price hunt: item name → price → business, low to high.
        // ilike is sanitized (strip supabase .or() metacharacters).
        const q = String(input.query || '').replace(/[,()%]/g, ' ').trim();
        if (!q) return { error: 'query required' };
        const pat = `%${q}%`;
        const limit = Math.min(parseInt(input.limit, 10) || 20, 40);
        const maxPrice = input.max_price != null ? Number(input.max_price) : null;

        const [menu, drinks, hh, offers, inv] = await Promise.all([
            db.from('menu_items').select('item_name,price,description,menu_sections!inner(entity_slug)').ilike('item_name', pat).not('price', 'is', null).limit(80),
            db.from('drink_items').select('item_name,price,drink_sections!inner(entity_slug)').ilike('item_name', pat).not('price', 'is', null).limit(40),
            db.from('happy_hour_items').select('item_name,price,original_price,happy_hour_sections!inner(entity_slug)').ilike('item_name', pat).not('price', 'is', null).limit(40),
            db.from('entity_offer').select('name,entity_slug,entity_offer_price(amount,label,price_unit,age_min,age_max)').ilike('name', pat).limit(60),
            db.from('inventory_items').select('name,price,entity_slug').ilike('name', pat).not('price', 'is', null).eq('active', true).limit(40),
        ]);

        const rows = [];
        for (const m of (menu.data || [])) rows.push({ item: m.item_name, price: Number(m.price), entity_slug: m.menu_sections.entity_slug, source: 'menu' });
        for (const d of (drinks.data || [])) rows.push({ item: d.item_name, price: Number(d.price), entity_slug: d.drink_sections.entity_slug, source: 'drinks' });
        for (const h of (hh.data || [])) rows.push({ item: h.item_name, price: Number(h.price), entity_slug: h.happy_hour_sections.entity_slug, source: 'happy_hour', regular_price: h.original_price != null ? Number(h.original_price) : undefined });
        for (const o of (offers.data || [])) {
            for (const p of (o.entity_offer_price || [])) {
                if (p.amount == null) continue;
                const ageNote = p.age_max != null && p.age_max <= 17 ? 'kids' : (p.age_min != null && p.age_min >= 55 ? 'senior' : null);
                rows.push({ item: o.name + (p.label ? ` (${p.label})` : ''), price: Number(p.amount), entity_slug: o.entity_slug, source: 'offer', unit: p.price_unit || undefined, audience: ageNote || undefined });
            }
        }
        for (const i of (inv.data || [])) rows.push({ item: i.name, price: Number(i.price), entity_slug: i.entity_slug, source: 'product' });

        let filtered = rows.filter((r) => Number.isFinite(r.price) && r.price > 0);
        if (maxPrice != null) filtered = filtered.filter((r) => r.price <= maxPrice);
        filtered.sort((a, b) => a.price - b.price);
        filtered = filtered.slice(0, limit);

        const slugs = [...new Set(filtered.map((r) => r.entity_slug))];
        const { data: ents } = slugs.length
            ? await db.from('entity').select('slug,name,city,rating,review_count,is_active').in('slug', slugs)
            : { data: [] };
        const eMap = Object.fromEntries((ents || []).filter((e) => e.is_active !== false).map((e) => [e.slug, e]));
        const results = filtered.filter((r) => eMap[r.entity_slug]).map((r) => ({
            ...r,
            business: eMap[r.entity_slug].name,
            city: eMap[r.entity_slug].city,
            rating: eMap[r.entity_slug].rating,
        }));

        if (!results.length) return { results: [], note: `No structured items matched "${q}" — try a broader term or search_businesses.` };
        return { results, note: 'Sorted cheapest first. Prices are from the structured database, not estimates.' };
    }

    if (name === 'compare_businesses') {
        const slugs = [...new Set((input.slugs || []).filter(Boolean))].slice(0, 5);
        if (slugs.length < 2) return { error: 'Provide 2-5 slugs to compare.' };
        const { getIndustryFacts } = require('./industry-contract');
        const out = [];
        for (const slug of slugs) {
            const { data: e } = await db.from('entity')
                .select('slug,name,industry_code,entity_subtype,city,rating,review_count,price_range,phone,booking_url')
                .eq('slug', slug).maybeSingle();
            if (!e) { out.push({ slug, error: 'not found' }); continue; }
            const [facts, feesR, depR, refR, wxR, offR] = await Promise.all([
                getIndustryFacts(db, e),
                db.from('entity_offer_fee').select('fee_name,fee_type,amount,amount_type,mandatory,description').eq('entity_slug', slug).limit(10),
                db.from('entity_offer_deposit').select('deposit_name,amount,amount_type,refundable').eq('entity_slug', slug).limit(5),
                db.from('entity_refund_policy').select('policy_name,policy_type,full_refund_window_hours,non_refundable,terms').eq('entity_slug', slug).limit(5),
                db.from('weather_rules').select('condition,action,refund_percent,description').eq('entity_slug', slug).limit(5),
                db.from('entity_offer').select('name,entity_offer_price(amount,label,price_unit)').eq('entity_slug', slug).limit(8),
            ]);
            const cleanFacts = {};
            for (const [k, v] of Object.entries(facts || {})) {
                if (v == null || ['entity_slug', 'updated_at'].includes(k)) continue;
                cleanFacts[k] = v;
            }
            const offersFrom = (offR.data || []).map((o) => {
                const prices = (o.entity_offer_price || []).filter((p) => p.amount != null).map((p) => Number(p.amount));
                return prices.length ? `${o.name}: from $${Math.min(...prices)}` : null;
            }).filter(Boolean).slice(0, 6);
            out.push({
                slug, name: e.name, type: e.entity_subtype || e.industry_code, city: e.city,
                rating: e.rating != null ? `${e.rating} (${e.review_count || 0} reviews)` : null,
                price_range: e.price_range,
                industry_facts: Object.keys(cleanFacts).length ? cleanFacts : 'no structured facts yet — say so rather than guessing',
                offers_from: offersFrom,
                fees: (feesR.data || []).map((f) => `${f.fee_name}${f.amount != null ? ` $${f.amount}` : ''}${f.description ? ` — ${f.description.slice(0, 80)}` : ''}`),
                deposits: (depR.data || []).map((d) => `${d.deposit_name}${d.amount != null ? ` $${d.amount}` : ''}${d.refundable ? ' (refundable)' : ''}`),
                refund_policies: (refR.data || []).map((p) => (p.non_refundable ? `${p.policy_name}: non-refundable` : `${p.policy_name}${p.full_refund_window_hours ? `: full refund up to ${p.full_refund_window_hours}h before` : ''}${p.terms ? ` ${p.terms.slice(0, 100)}` : ''}`)),
                weather_policy: (wxR.data || []).map((w) => `${w.condition || ''} → ${w.action || ''}${w.description ? ` (${w.description.slice(0, 80)})` : ''}`),
            });
        }
        return { comparison: out, note: 'Compare only on fields present for both. Missing facts mean the data is not collected yet — say that, never fill the gap with a guess.' };
    }

    if (name === 'check_availability') {
        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await db.from('business_availability')
            .select('total_capacity, remaining_spots, status, source_platform, last_minute_deal, last_minute_price, original_price, last_updated')
            .eq('entity_slug', input.slug).eq('availability_date', today).eq('visible_on_profile', true).maybeSingle();
        if (error) return { error: error.message };
        if (!data) {
            return {
                available: false,
                note: 'No live availability data for this business today — do not guess a number, just say availability isn\'t tracked for them.',
            };
        }
        return { available: true, ...data };
    }

    if (name === 'get_business_details') {
        try {
            const { buildFullEntity } = require('../routes/gcr');
            const e = await buildFullEntity(input.slug);
            if (!e) return { error: `No business found for slug "${input.slug}"` };

            const lines = [];
            lines.push(`${e.name} [${[e.entity_type, e.entity_subtype].filter(Boolean).join('/')}] — ${e.city || ''}, ${e.state || ''}`);
            if (e.parent) lines.push(`Part of: ${e.parent.name}`);
            if (e.is_hub) lines.push(`This is a hub with ${e.child_count} businesses under it — use search_businesses with entity_subtype or tag filters, or the "parent_hub" field from a search_businesses result, to find them.`);
            if (e.description || e.editorial_summary) lines.push(`About: ${(e.description || e.editorial_summary).slice(0, 400)}`);
            if (e.phone) lines.push(`Phone: ${e.phone}`);
            if (e.price_from != null) lines.push(`Price: ${e.price_from === 0 ? 'Free' : `From $${e.price_from}${e.price_unit ? `/${e.price_unit}` : ''}`}`);
            if (e.rating) lines.push(`Rating: ⭐${e.rating} (${e.review_count || 0} reviews)`);

            const tagNames = [...new Set((e.tags || []).map((t) => t.tag_name).filter(Boolean))];
            if (tagNames.length) lines.push(`Tags: ${tagNames.slice(0, 20).join(', ')}`);

            if ((e.hours || []).length) {
                lines.push(`Hours: ${e.hours.map((h) => `${h.day_of_week}: ${h.is_closed ? 'closed' : `${h.opens_at}-${h.closes_at}`}`).join(' | ')}`);
            }

            const fmtItems = (items, n = 15) => (items || []).slice(0, n).map((i) => `${i.item_name}${i.price ? ` $${i.price}` : ''}${i.description ? ` — ${i.description.slice(0, 60)}` : ''}`).join(' | ');
            (e.menu_sections || []).forEach((s) => { if (s.items?.length) lines.push(`Menu — ${s.section_name}: ${fmtItems(s.items)}`); });
            (e.drink_sections || []).forEach((s) => { if (s.items?.length) lines.push(`Drinks — ${s.section_name}: ${fmtItems(s.items)}`); });
            (e.happy_hour_sections || []).forEach((s) => { if (s.items?.length) lines.push(`Happy Hour — ${s.section_name} (${(s.days_of_week || []).join(',')} ${s.start_time || ''}-${s.end_time || ''}): ${fmtItems(s.items)}`); });
            if ((e.specials || []).length) lines.push(`Specials: ${e.specials.slice(0, 10).map((s) => `${s.special_name}${s.discount_value ? ` (${s.discount_type === 'percent' ? `${s.discount_value}% off` : `$${s.discount_value} off`})` : ''}`).join(' | ')}`);

            (e.sections || []).forEach((s) => {
                if (s.items?.length) lines.push(`${s.section_name}: ${s.items.slice(0, 10).map((i) => `${i.item_name}${i.price_from != null ? ` from $${i.price_from}` : ''}${i.description ? ` — ${i.description.slice(0, 60)}` : ''}`).join(' | ')}`);
            });

            if (e.industry_facts) {
                const f = Object.entries(e.industry_facts)
                    .filter(([k, v]) => v != null && !['entity_slug', 'updated_at'].includes(k))
                    .map(([k, v]) => `${k}=${v}`);
                if (f.length) lines.push(`Industry facts (structured, ${e.industry_code}): ${f.join(', ')}`);
            }
            if ((e.fees || []).length) lines.push(`Fees: ${e.fees.slice(0, 8).map((f) => `${f.fee_name}${f.amount != null ? ` $${f.amount}` : ''}${f.description ? ` — ${f.description.slice(0, 60)}` : ''}`).join(' | ')}`);
            if ((e.deposits || []).length) lines.push(`Deposits: ${e.deposits.slice(0, 5).map((d) => `${d.deposit_name}${d.amount != null ? ` $${d.amount}` : ''}${d.refundable ? ' (refundable)' : ''}`).join(' | ')}`);
            if ((e.refund_policies || []).length) lines.push(`Refund/cancellation: ${e.refund_policies.slice(0, 5).map((p) => (p.non_refundable ? `${p.policy_name}: non-refundable` : `${p.policy_name}${p.full_refund_window_hours ? `: full refund up to ${p.full_refund_window_hours}h before` : ''}${p.terms ? ` ${(p.terms || '').slice(0, 80)}` : ''}`)).join(' | ')}`);
            if ((e.weather_rules || []).length) lines.push(`Weather policy: ${e.weather_rules.slice(0, 4).map((w) => `${w.condition || ''} → ${w.action || ''}`).join(' | ')}`);
            if ((e.pricing || []).length) lines.push(`Pricing: ${e.pricing.slice(0, 10).map((p) => `${p.item_name || p.name} $${p.price}`).join(' | ')}`);
            if ((e.whats_included || []).length) lines.push(`Includes: ${e.whats_included.map((w) => w.item_name || w.included_item).filter(Boolean).join(', ')}`);
            if ((e.faqs || []).length) lines.push(`FAQ: ${e.faqs.slice(0, 8).map((f) => `Q:${f.question} A:${(f.answer || '').slice(0, 100)}`).join(' | ')}`);
            if ((e.policies || []).length) lines.push(`Policies: ${e.policies.slice(0, 6).map((p) => `${p.title || p.policy_type}: ${(p.body || p.content || '').slice(0, 100)}`).join(' | ')}`);
            if ((e.team || []).length) lines.push(`Team: ${e.team.slice(0, 8).map((t) => `${t.name}${t.title ? ` (${t.title})` : ''}`).join(', ')}`);
            if ((e.reviews || []).length) lines.push(`Recent reviews: ${e.reviews.slice(0, 5).map((r) => `"${(r.body || '').slice(0, 80)}" — ${r.reviewer_name || 'guest'} (${r.rating}★)`).join(' | ')}`);
            if ((e.bookable_resources || []).length) lines.push(`Units/resources: ${e.bookable_resources.slice(0, 10).map((r) => `${r.name}${r.nightly_price ? ` $${r.nightly_price}/night` : ''}${r.bedrooms ? ` ${r.bedrooms}bd` : ''}`).join(' | ')}`);

            return { slug: e.slug, details: lines.join('\n') };
        } catch (err) {
            return { error: err.message };
        }
    }

    if (name === 'search_businesses') {
        const limit = Math.min(parseInt(input.limit, 10) || 15, 30);
        const slugSets = [];
        // Free-text query → the SAME deep multi-table search the GCR Unified
        // search bar uses (name + menu items + drinks + activities + fish
        // species + pricing + amenities + FAQs + …), so an agent is exactly as
        // capable as the bar.
        if (input.query) {
            const { searchEntitySlugs } = require('../routes/gcr');
            const { slugs } = await searchEntitySlugs(input.query);
            if (!slugs.length) return { count: 0, results: [] };
            slugSets.push(new Set(slugs));
        }
        if (input.tag) {
            const { data: tagRows, error: tagErr } = await db.from('entity_tags').select('entity_slug').ilike('tag_name', `%${input.tag}%`).limit(1000);
            if (tagErr) return { error: tagErr.message };
            const tagSlugs = new Set((tagRows || []).map((r) => r.entity_slug).filter(Boolean));
            if (!tagSlugs.size) return { count: 0, results: [] };
            slugSets.push(tagSlugs);
        }
        // Intersect the provided slug filters (query AND tag both narrow the set).
        let filterSlugs = null;
        if (slugSets.length) {
            filterSlugs = [...slugSets.reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))))];
            if (!filterSlugs.length) return { count: 0, results: [] };
        }

        let q = db.from('entity')
            .select('name, slug, entity_type, entity_subtype, parent_entity_slug, city, rating, review_count, description, price_from, price_unit')
            .eq('is_active', true);
        if (input.entity_subtype) q = q.eq('entity_subtype', input.entity_subtype);
        if (input.entity_type) q = q.eq('entity_type', input.entity_type);
        if (filterSlugs) q = q.in('slug', filterSlugs);
        q = q.order('rating', { ascending: false, nullsFirst: false }).limit(limit);

        const { data, error } = await q;
        if (error) return { error: error.message };

        const parentSlugs = [...new Set((data || []).map((e) => e.parent_entity_slug).filter(Boolean))];
        const parentNames = {};
        if (parentSlugs.length) {
            const { data: parents } = await db.from('entity').select('slug, name').in('slug', parentSlugs);
            (parents || []).forEach((p) => { parentNames[p.slug] = p.name; });
        }

        const results = (data || []).map((e) => ({
            name: e.name,
            slug: e.slug,
            type: [e.entity_type, e.entity_subtype].filter(Boolean).join('/'),
            city: e.city,
            rating: e.rating,
            review_count: e.review_count,
            parent_hub: e.parent_entity_slug ? (parentNames[e.parent_entity_slug] || e.parent_entity_slug) : null,
            price: e.price_from != null ? (e.price_from === 0 ? 'Free' : `From $${e.price_from}${e.price_unit ? `/${e.price_unit}` : ''}`) : null,
            description: e.description ? e.description.slice(0, 150) : null,
        }));
        return { count: results.length, results };
    }

    return null; // not a concierge tool
}

module.exports = { CONCIERGE_TOOLS, CONCIERGE_TOOL_NAMES, asInputSchemaTools, runConciergeTool };
