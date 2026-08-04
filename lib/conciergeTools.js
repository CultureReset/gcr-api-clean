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
const { getSchema } = require('./businessTables');

/* ── the subtype is the router ────────────────────────────────────────────
 *
 * A slug says which business. Its entity_subtype says what kind, and that is
 * what decides where an answer lives: a condo answers about beds in room_types,
 * a charter answers about what you catch in fish_species, a restaurant answers
 * about crab legs in menu_items.
 *
 * industry_sections works that out by looking, not by a table somebody wrote
 * down — it takes the businesses of a subtype and counts which sections they
 * actually fill. A subtype that starts using a new section starts being routed
 * to it, with nothing to update.
 *
 * Cached because it is a whole-schema sweep and the answer moves slowly: what a
 * fishing charter records changes over months, not between two phone calls.
 */
const INDUSTRY_SECTION_TTL_MS = 15 * 60 * 1000;
const INDUSTRY_SAMPLE = 60;      // businesses sampled per subtype
const SECTION_CONCURRENCY = 24;
const industryCache = new Map(); // subtype -> { value, at }

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) await worker(items[cursor++]);
    }));
}

/* ── the tools ────────────────────────────────────────────────────────── */

const CONCIERGE_TOOLS = [
    {
        name: 'search_businesses',
        title: 'Search every business',
        description:
            'Search ALL active Gulf Coast businesses by name OR by any of their content — menu items and dishes, drinks, happy-hour items, specials, events, activities/charters/tours, fish species, pricing tiers, what\'s-included, room types, services, products, amenities, FAQs, and tags. Use this for ANY "who has X / which places do Y / where can I get Z" question ("who has all-you-can-eat snow crab legs", "gluten free menu", "vegan", "red snapper charter", "2-bedroom condo"). The filters stack, so a request with several conditions — live music tonight AND outdoor seating AND a happy hour — is one call, not three. Returns each match\'s parent hub (e.g. the marina it operates from).',
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
                must_have: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Features a business must have ALL of, matched against its tags and amenities — e.g. ["outdoor seating","dog friendly"]. This is how a multi-part request is answered in one call rather than by intersecting several.',
                },
                has_happy_hour: { type: 'boolean', description: 'Only businesses that run a happy hour.' },
                live_music: {
                    type: 'string',
                    description: '"tonight", "today", "tomorrow" or YYYY-MM-DD — only businesses with live music on then.',
                },
                open_now: { type: 'boolean', description: 'Only businesses open at this moment, by their published hours.' },
                at: {
                    type: 'string',
                    description:
                        'Scope to one hub — a marina, a condo tower, a complex like "The Wharf". Only businesses inside it (and the hub itself) are returned. Use it whenever someone says "at X".',
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
        name: 'find_available',
        title: 'Who has openings',
        description:
            'Which businesses have capacity left, across the whole coast or inside one complex — "who has availability for a dolphin cruise today", "any charters open Saturday", "who has availability at Phoenix East the 14th to the 18th". Pass `from` and `to` for a stay: a condo or hotel unit only counts if it is free EVERY night of the range, while a charter or tour only needs one open day in it. Returns who has room, which nights, how many spots and the unit specs where there are any. Only businesses that publish availability appear; say who does rather than implying the rest are full.',
        inputSchema: {
            type: 'object',
            properties: {
                what: {
                    type: 'string',
                    description: 'What they want — "dolphin cruise", "fishing charter", "parasailing", "kayak". Matched against the business name, its subtype and its description.',
                },
                date: { type: 'string', description: 'A single day: "today" (default), "tomorrow", or YYYY-MM-DD.' },
                from: { type: 'string', description: 'First night or day of a stay, YYYY-MM-DD. Use with `to` for "the 14th to the 18th".' },
                to: { type: 'string', description: 'Last night or day, YYYY-MM-DD.' },
                party_size: { type: 'integer', description: 'Only return slots with at least this many spots left.' },
                at: {
                    type: 'string',
                    description:
                        'Scope to one hub — a marina, a condo tower, a complex like "The Wharf". Only businesses inside it (and the hub itself) are returned. Use it whenever someone says "at X".',
                },
                limit: { type: 'integer', description: 'Max businesses, default 20.' },
            },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'whats_on',
        title: 'What is happening, coast-wide',
        description:
            'Everything happening across the whole coast at a given time — live music and events, food and drink specials, and who is in happy hour — with the business, the time and the phone number. Use this for anything time-shaped: "what\'s going on tonight", "who has happy hour right now", "live music this weekend", "any specials on Tuesday". This is the only tool that answers across every business at once by time; search_businesses answers by subject.',
        inputSchema: {
            type: 'object',
            properties: {
                when: {
                    type: 'string',
                    description:
                        '"now" (default — happening at this moment), "today", "tonight" (from 5pm), "tomorrow", "this_week" (next 7 days), or an exact date as YYYY-MM-DD.',
                },
                kind: {
                    type: 'string',
                    enum: ['all', 'events', 'specials', 'happy_hour'],
                    description: 'Narrow to one kind. Default "all".',
                },
                limit: { type: 'integer', description: 'Max rows per kind, default 20, max 50' },
                at: {
                    type: 'string',
                    description:
                        'Scope to one hub — a marina, a condo tower, a complex like "The Wharf". Only businesses inside it (and the hub itself) are returned. Use it whenever someone says "at X".',
                },
            },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'industry_sections',
        title: 'Where this kind of business keeps its answers',
        description:
            'Given an industry subtype — fishing_charter, condo, dolphin_cruise, seafood, spa — this returns the sections businesses of that kind actually fill in, most-used first. It is how you know where to look before you look: a condo answers about beds and views in room_types, a charter answers about what you catch in fish_species, a restaurant answers about crab legs in menu_items. Call it when a question is about a kind of business rather than a named one, then read_section on the sections it names.',
        inputSchema: {
            type: 'object',
            properties: {
                subtype: { type: 'string', description: 'An entity_subtype, e.g. "fishing_charter". From list_categories or a search result\'s type.' },
                slug: { type: 'string', description: 'Or a business slug, and its subtype is looked up for you.' },
            },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'list_categories',
        title: 'What kinds of businesses exist',
        description:
            'The platform\'s own category list with a count of businesses in each — restaurants, charters, rentals, condos, activities and their subtypes. Use it when a caller asks something open-ended ("what is there to do here?") or when you need the exact entity_subtype value to pass to search_businesses.',
        inputSchema: { type: 'object', properties: {} },
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

/* ── time, for the tools that answer "now" ────────────────────────────────
 *
 * The coast runs on Central. routes/gcr.js already owns that clock for its
 * /live-now rail, so this borrows it rather than starting a second one that
 * could disagree by an hour twice a year.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const addDays = (iso, n) => {
    const d = new Date(`${iso}T12:00:00Z`); // midday, so a DST shift cannot roll the date
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

/**
 * Does a recorded day field cover this day?
 *
 * Businesses enter these by hand, so the column holds anything from
 * `['mon','tue']` to "Mon-Fri" to "daily" to an empty string. An array is
 * unambiguous and is filtered strictly. A string is not: "Mon-Fri" does not
 * contain "wed", and dropping that row would hide a real Wednesday special.
 *
 * So a string that names days without matching is only excluded when it has no
 * range in it. Anything else is kept, and the raw text is returned alongside so
 * the model can read it out and let the caller judge.
 */
function dayMatches(field, dayName) {
    if (field == null) return true;
    const abbr = dayName.slice(0, 3);

    if (Array.isArray(field)) {
        if (!field.length) return true;
        return field.some((d) => String(d).toLowerCase().trim().startsWith(abbr));
    }

    const s = String(field).toLowerCase();
    if (!s.trim()) return true;
    if (/daily|every ?day|all week|7 days/.test(s)) return true;
    if (s.includes(abbr)) return true;

    const namesAnyDay = DAY_NAMES.some((d) => s.includes(d.slice(0, 3)));
    if (!namesAnyDay) return true; // not a day field we understand — keep it
    return /[-–—]|\bto\b|thru|through/.test(s); // a range we cannot expand — keep it
}

/**
 * The entity types whose availability means nights rather than slots.
 *
 * A condo free on the 14th and the 18th but booked on the 16th is not available
 * for that trip. A charter with one open day in the same range is. Same table,
 * opposite meaning, and getting it backwards ends with somebody at a locked
 * door — so the type decides which rule applies.
 */
const STAY_TYPES = new Set(['hotel', 'condo', 'vacation-rental', 'vacation_rental', 'resort']);

/** Is `time` (HH:MM) inside [start, end]? Handles a window that crosses midnight. */
function withinWindow(time, start, end) {
    if (!start || !end) return false;
    return end < start ? time >= start || time <= end : time >= start && time <= end;
}

/* ── hubs: "at the Wharf" ─────────────────────────────────────────────────
 *
 * A marina, a condo tower, a complex like The Wharf is an entity in its own
 * right, and the businesses inside it carry its slug in parent_entity_slug.
 * That relationship is what makes a whole class of question answerable:
 *
 *     who has happy hour at the Wharf
 *     does anybody at the Wharf do crab legs
 *     what is there to do at the Wharf tonight
 *
 * Without it, "at the Wharf" is just three words the search throws away, and
 * the agent answers about the whole coast while sounding like it answered the
 * question asked.
 *
 * Callers say "the Wharf", not "the-wharf", so the name is resolved before the
 * children are looked up — exact slug first, then name, then a loose match.
 */
async function hubChildren(where) {
    const raw = String(where || '').trim();
    if (!raw) return null;
    const asSlug = raw.toLowerCase().replace(/\s+/g, '-');
    const bare = raw.replace(/^the\s+/i, '').replace(/[,()%]/g, ' ').trim();

    const { data: exact } = await db
        .from('entity')
        .select('slug, name')
        .or(`slug.eq.${asSlug},slug.eq.${bare.toLowerCase().replace(/\s+/g, '-')}`)
        .limit(1);

    let hub = exact?.[0] || null;
    if (!hub && bare) {
        const { data: byName } = await db
            .from('entity')
            .select('slug, name')
            .ilike('name', `%${bare}%`)
            .limit(5);
        // The hub is whichever match actually has businesses under it.
        for (const candidate of byName || []) {
            const { count } = await db
                .from('entity')
                .select('id', { count: 'exact', head: true })
                .eq('parent_entity_slug', candidate.slug)
                .eq('is_active', true);
            if (count) { hub = candidate; break; }
        }
        if (!hub && byName?.length) hub = byName[0];
    }
    if (!hub) return { hub: null, slugs: new Set() };

    const { data: kids } = await db
        .from('entity')
        .select('slug')
        .eq('parent_entity_slug', hub.slug)
        .eq('is_active', true)
        .limit(500);

    // The hub itself counts as "at the Wharf" — the complex may hold the happy
    // hour, not one of its tenants.
    const slugs = new Set([hub.slug, ...(kids || []).map((r) => r.slug).filter(Boolean)]);
    return { hub, slugs };
}

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

    if (name === 'industry_sections') {
        let subtype = String(input.subtype || '').trim();
        if (!subtype && input.slug) {
            const { data } = await db.from('entity').select('entity_subtype').eq('slug', String(input.slug).trim()).maybeSingle();
            subtype = data?.entity_subtype || '';
        }
        if (!subtype) return { error: 'Give a subtype, or a slug to take one from.' };

        const cached = industryCache.get(subtype);
        if (cached && Date.now() - cached.at < INDUSTRY_SECTION_TTL_MS) return cached.value;

        const { data: peers, error: peerErr } = await db
            .from('entity')
            .select('slug')
            .eq('entity_subtype', subtype)
            .eq('is_active', true)
            .limit(INDUSTRY_SAMPLE);
        if (peerErr) return { error: peerErr.message };

        const slugs = (peers || []).map((r) => r.slug).filter(Boolean);
        if (!slugs.length) {
            return { subtype, businesses: 0, sections: [], note: `No active business has the subtype "${subtype}". Check list_categories for the ones that exist.` };
        }

        // Which tables do businesses of this kind actually put rows in? Counted
        // from the data, not declared anywhere — so a subtype that starts using
        // a new section starts being routed to it, with nothing to update.
        const { tables } = await getSchema();
        const used = [];
        await mapLimit(tables, SECTION_CONCURRENCY, async (table) => {
            const { data, error } = await db
                .from(table)
                .select('entity_slug')
                .in('entity_slug', slugs)
                .limit(5000);
            if (error || !data?.length) return;
            const withData = new Set(data.map((r) => r.entity_slug)).size;
            used.push({ section: table, businesses_with_data: withData, share: `${Math.round((withData / slugs.length) * 100)}%` });
        });
        used.sort((a, b) => b.businesses_with_data - a.businesses_with_data || a.section.localeCompare(b.section));

        const value = {
            subtype,
            businesses: slugs.length,
            sections: used,
            note: used.length
                ? 'Most-used first. These are where this kind of business puts its information — read_section on one of them, or read_business for all of it. A section missing here is one this industry does not use.'
                : `Businesses of type "${subtype}" have nothing on file beyond their listings.`,
        };
        industryCache.set(subtype, { value, at: Date.now() });
        return value;
    }

    if (name === 'list_categories') {
        const { data, error } = await db
            .from('subtype_taxonomy')
            .select('subtype_key, display_name, entity_type, listing_category, entity_count')
            .order('entity_count', { ascending: false });
        if (error) return { error: error.message };

        const sections = {};
        for (const row of data || []) {
            if (!row.listing_category) continue;
            (sections[row.listing_category] ||= []).push({
                entity_subtype: row.subtype_key,
                name: row.display_name || row.subtype_key,
                businesses: row.entity_count || 0,
            });
        }
        return {
            categories: Object.entries(sections).map(([category, subtypes]) => ({
                category,
                businesses: subtypes.reduce((n, s) => n + s.businesses, 0),
                subtypes: subtypes.slice(0, 25),
            })).sort((a, b) => b.businesses - a.businesses),
            note: 'Pass an entity_subtype value to search_businesses to list what is in one.',
        };
    }

    if (name === 'whats_on') {
        const { getCentralNow } = require('../routes/gcr');
        const { nowTime, today, todayName } = getCentralNow();

        const when = String(input.when || 'now').toLowerCase().trim();
        const kind = ['events', 'specials', 'happy_hour'].includes(input.kind) ? input.kind : 'all';
        const limit = Math.min(Math.max(parseInt(input.limit, 10) || 20, 1), 50);

        // Resolve `when` into a date window, a day name, and whether the
        // current clock time matters.
        let from = today;
        let to = today;
        let dayName = todayName;
        let timeFilter = null;
        let earliest = null;

        if (/^\d{4}-\d{2}-\d{2}$/.test(when)) {
            from = to = when;
            dayName = DAY_NAMES[new Date(`${when}T12:00:00Z`).getUTCDay()];
        } else if (when === 'tomorrow') {
            from = to = addDays(today, 1);
            dayName = DAY_NAMES[new Date(`${from}T12:00:00Z`).getUTCDay()];
        } else if (when === 'this_week' || when === 'week' || when === 'weekend') {
            to = addDays(today, 7);
            dayName = null; // a whole week matches every day
        } else if (when === 'tonight') {
            earliest = '17:00';
        } else if (when !== 'today') {
            timeFilter = nowTime; // "now", and anything unrecognised
        }

        let inHub = null;
        if (input.at) {
            const found = await hubChildren(input.at);
            if (!found?.hub) return { when, error: `There is no place called "${input.at}" on the platform.` };
            inHub = found.slugs;
        }
        const here = (slug) => !inHub || inHub.has(slug);

        const out = { when, as_of: `${today} ${nowTime} Central`, ...(inHub ? { at: input.at } : {}) };

        if (kind === 'all' || kind === 'events') {
            const { data, error } = await db
                .from('entity_events')
                .select('event_name, description, event_date, day_of_week, recurring, start_time, end_time, artist_name, cover_charge, event_type, entity_slug, entity:entity_slug(name, city, phone)')
                .eq('is_active', true)
                .order('event_date', { ascending: true, nullsFirst: false })
                .limit(400);
            if (error) return { error: error.message };

            const events = (data || []).filter((ev) => {
                if (!here(ev.entity_slug)) return false;
                // A dated event is in or out on its date alone. A recurring one
                // has no date, so it is judged on its day of the week.
                if (ev.event_date) {
                    if (ev.event_date < from || ev.event_date > to) return false;
                } else if (dayName && !dayMatches(ev.day_of_week, dayName)) {
                    return false;
                }
                if (earliest && ev.start_time && ev.start_time < earliest) return false;
                if (timeFilter && ev.start_time && ev.end_time && !withinWindow(timeFilter, ev.start_time, ev.end_time)) return false;
                return true;
            }).slice(0, limit).map((ev) => ({
                event: ev.event_name,
                artist: ev.artist_name || undefined,
                type: ev.event_type || undefined,
                date: ev.event_date || undefined,
                day_text: ev.event_date ? undefined : (ev.day_of_week || 'recurring, day not recorded'),
                time: [ev.start_time, ev.end_time].filter(Boolean).join('–') || undefined,
                cover: ev.cover_charge || undefined,
                business: ev.entity?.name || ev.entity_slug,
                slug: ev.entity_slug,
                city: ev.entity?.city || undefined,
                phone: ev.entity?.phone || undefined,
            }));
            out.events = events;
        }

        if (kind === 'all' || kind === 'specials') {
            const { data, error } = await db
                .from('entity_specials')
                .select('special_name, description, discount_text, discount_type, discount_value, days, day_of_week, start_time, end_time, start_date, end_date, entity_slug, entity:entity_slug(name, city, phone)')
                .eq('is_active', true)
                .limit(400);
            if (error) return { error: error.message };

            const specials = (data || []).filter((s) => {
                if (!here(s.entity_slug)) return false;
                if (s.start_date && s.start_date > to) return false;
                if (s.end_date && s.end_date < from) return false;
                if (dayName && !dayMatches(s.days ?? s.day_of_week, dayName)) return false;
                if (timeFilter && s.start_time && s.end_time && !withinWindow(timeFilter, s.start_time, s.end_time)) return false;
                if (earliest && s.start_time && s.end_time && s.end_time < earliest) return false;
                return true;
            }).slice(0, limit).map((s) => ({
                special: s.special_name,
                deal: s.discount_text || (s.discount_value != null
                    ? (s.discount_type === 'percent' ? `${s.discount_value}% off` : `$${s.discount_value} off`)
                    : undefined),
                description: s.description ? s.description.slice(0, 140) : undefined,
                // The raw day text goes out as written. "Mon-Fri" is kept rather
                // than expanded, so read it to the caller instead of asserting
                // that it is on today.
                day_text: s.days ?? s.day_of_week ?? undefined,
                time: [s.start_time, s.end_time].filter(Boolean).join('–') || undefined,
                business: s.entity?.name || s.entity_slug,
                slug: s.entity_slug,
                city: s.entity?.city || undefined,
                phone: s.entity?.phone || undefined,
            }));
            out.specials = specials;
        }

        if (kind === 'all' || kind === 'happy_hour') {
            const { data, error } = await db
                .from('entity')
                .select('slug, name, city, phone, hh_days, hh_start, hh_end, hh_description')
                .eq('is_active', true)
                .not('hh_days', 'is', null)
                .limit(400);
            if (error) return { error: error.message };

            const happyHour = (data || []).filter((e) => {
                if (!here(e.slug)) return false;
                if (dayName && !dayMatches(e.hh_days, dayName)) return false;
                if (timeFilter && !withinWindow(timeFilter, e.hh_start, e.hh_end)) return false;
                if (earliest && e.hh_end && e.hh_end < earliest) return false;
                return true;
            }).slice(0, limit).map((e) => ({
                business: e.name,
                slug: e.slug,
                day_text: e.hh_days,
                time: [e.hh_start, e.hh_end].filter(Boolean).join('–') || undefined,
                details: e.hh_description ? e.hh_description.slice(0, 140) : undefined,
                city: e.city || undefined,
                phone: e.phone || undefined,
            }));
            out.happy_hour = happyHour;
        }

        const total = (out.events?.length || 0) + (out.specials?.length || 0) + (out.happy_hour?.length || 0);
        out.total = total;
        out.note = total
            // Businesses type these by hand, so a day like "Mon-Fri" cannot be
            // expanded reliably. Reading it out is honest; asserting today is not.
            ? 'day_text is exactly as the business entered it — read it out rather than asserting the day. Use get_business_details for a full menu or policy.'
            : `Nothing recorded for ${when}${input.at ? ` at ${input.at}` : ''}. Say so — do not fall back on what is usually on, and do not widen to the rest of the coast unless asked.`;
        return out;
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

    if (name === 'find_available') {
        // Mirrors the three sources /api/gcr/availability-search merges, because
        // any one of them alone gives a wrong answer:
        //
        //   business_availability  capacity fed by the email parser and iCal
        //   availability           per-resource slots from the booking engine
        //   booking_calendar       entity-wide blocks that VETO a date
        //
        // A business can publish open slots and still be closed that day by a
        // block, so the blocks are subtracted rather than ignored.
        const { getCentralNow } = require('../routes/gcr');
        const { today } = getCentralNow();
        const when = String(input.date || 'today').toLowerCase().trim();
        const oneDay = /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : (when === 'tomorrow' ? addDays(today, 1) : today);
        const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
        const from = iso(input.from) || oneDay;
        const to = iso(input.to) || (iso(input.from) ? iso(input.from) : oneDay);
        const date = from; // what a single-day answer reports

        // Every night asked for. A stay has to cover all of them; a charter
        // only needs one — a condo free on the 14th and the 18th but booked on
        // the 16th is not available for that trip, and listing it as open is
        // the kind of wrong that ends at a locked door.
        const wanted = [];
        for (let d = from; d <= to && wanted.length < 120; d = addDays(d, 1)) wanted.push(d);

        const party = Number(input.party_size) > 0 ? Number(input.party_size) : 0;
        const limit = Math.min(Math.max(parseInt(input.limit, 10) || 20, 1), 40);

        const [capacity, slots, blocks] = await Promise.all([
            db.from('business_availability')
                .select('entity_slug, availability_date, time_slot, end_time, status, remaining_spots, total_capacity')
                .gte('availability_date', from).lte('availability_date', to).neq('status', 'full').limit(2000),
            db.from('availability')
                .select('entity_slug, date, start_time, end_time, status, spots_total, spots_remaining')
                .gte('date', from).lte('date', to).gt('spots_remaining', 0).limit(2000),
            db.from('booking_calendar')
                .select('entity_slug, date, end_date')
                .eq('kind', 'block').is('offering_id', null).neq('status', 'cancelled')
                .lte('date', to).limit(2000),
        ]);
        if (capacity.error) return { error: capacity.error.message };

        // A block covers a span, so it vetoes each night it touches.
        const blockedNights = new Map();
        for (const b of (blocks.data || [])) {
            const start = b.date;
            const end = b.end_date && b.end_date > b.date ? b.end_date : b.date;
            for (const night of wanted) {
                if (night >= start && night <= end) {
                    if (!blockedNights.has(b.entity_slug)) blockedNights.set(b.entity_slug, new Set());
                    blockedNights.get(b.entity_slug).add(night);
                }
            }
        }

        const open = new Map();
        const add = (slug, night, slot) => {
            if (blockedNights.get(slug)?.has(night)) return;
            if (party && slot.spots != null && slot.spots < party) return;
            if (!open.has(slug)) open.set(slug, []);
            open.get(slug).push({ date: night, ...slot });
        };
        for (const r of (capacity.data || [])) {
            add(r.entity_slug, r.availability_date, { time: r.time_slot || null, until: r.end_time || null, spots: r.remaining_spots ?? null, of: r.total_capacity ?? null });
        }
        for (const r of (slots.data || [])) {
            add(r.entity_slug, r.date, { time: r.start_time || null, until: r.end_time || null, spots: r.spots_remaining ?? null, of: r.spots_total ?? null });
        }

        if (!open.size) {
            return {
                date,
                available: [],
                note: `Nobody has published open capacity for ${date}. Only businesses that publish availability appear here — say that rather than saying the coast is booked out.`,
            };
        }

        let hubSlugs = null;
        if (input.at) {
            const found = await hubChildren(input.at);
            if (!found?.hub) return { date, available: [], note: `There is no place called "${input.at}" on the platform.` };
            hubSlugs = found.slugs;
        }
        const candidates = [...open.keys()].filter((s) => !hubSlugs || hubSlugs.has(s));
        if (!candidates.length) {
            return { date, available: [], note: `Nobody${input.at ? ` at ${input.at}` : ''} has published open capacity for ${date}. Only businesses that publish availability appear here.` };
        }

        let q = db.from('entity')
            .select('slug, name, entity_type, entity_subtype, parent_entity_slug, city, phone, rating, price_from, price_unit, description')
            .eq('is_active', true)
            .in('slug', candidates);
        const what = String(input.what || '').replace(/[,()%]/g, ' ').trim();
        if (what) q = q.or(`name.ilike.%${what}%,description.ilike.%${what}%,entity_subtype.ilike.%${what}%`);

        const { data, error } = await q.order('rating', { ascending: false, nullsFirst: false }).limit(limit);
        if (error) return { error: error.message };

        // Unit specs, for the condo and beach-house answers: beds, baths,
        // sleeps, nightly price. Keyed by the unit's own slug.
        const shown = (data || []).map((e) => e.slug);
        const { data: resources } = shown.length
            ? await db.from('bookable_resources')
                .select('entity_slug, name, bedrooms, bathrooms, capacity, nightly_price, min_nights')
                .in('entity_slug', shown).eq('is_active', true).limit(500)
            : { data: [] };
        const specs = new Map();
        for (const r of resources || []) if (!specs.has(r.entity_slug)) specs.set(r.entity_slug, r);

        const multiNight = wanted.length > 1;
        const available = [];
        const partly = [];

        for (const e of data || []) {
            const nights = [...new Set(open.get(e.slug).map((s) => s.date))].sort();
            // A stay must cover every night asked for; anything else needs one.
            const isStay = STAY_TYPES.has(String(e.entity_type || '').toLowerCase());
            const coversAll = wanted.every((n) => nights.includes(n));
            const spec = specs.get(e.slug);

            const row = {
                business: e.name,
                slug: e.slug,
                type: [e.entity_type, e.entity_subtype].filter(Boolean).join('/'),
                part_of: e.parent_entity_slug || undefined,
                city: e.city,
                rating: e.rating,
                from: e.price_from != null ? `$${e.price_from}${e.price_unit ? `/${e.price_unit}` : ''}` : undefined,
                phone: e.phone || undefined,
                nights_open: multiNight ? nights : undefined,
                open_slots: open.get(e.slug).slice(0, 8),
                unit: spec ? {
                    name: spec.name,
                    bedrooms: spec.bedrooms ?? undefined,
                    bathrooms: spec.bathrooms ?? undefined,
                    sleeps: spec.capacity ?? undefined,
                    nightly: spec.nightly_price != null ? `$${spec.nightly_price}` : undefined,
                    min_nights: spec.min_nights ?? undefined,
                } : undefined,
            };

            if (isStay && multiNight && !coversAll) partly.push({ ...row, missing_nights: wanted.filter((n) => !nights.includes(n)) });
            else available.push(row);
        }

        return {
            from,
            to,
            nights: wanted.length,
            available,
            count: available.length,
            // Named rather than dropped: "free the 14th and the 18th but not the
            // 16th" is a real answer to give, and dropping it silently would
            // read as "nothing is open".
            partly_available: partly.length ? partly : undefined,
            note: available.length
                ? (multiNight
                    ? 'Stays listed here are open every night asked for. Anything under partly_available is open some nights and not others — say which nights are missing rather than calling it unavailable. Quote spots and prices as published; do not round.'
                    : 'Spots left are as published by the business. Quote the number and the time; do not round it.')
                : `Businesses have capacity ${multiNight ? `between ${from} and ${to}` : `on ${date}`}, but none matching "${what}"${input.at ? ` at ${input.at}` : ''}. Widen the search rather than saying nobody is open.`,
        };
    }

    if (name === 'search_businesses') {
        const limit = Math.min(parseInt(input.limit, 10) || 15, 30);
        const slugSets = [];

        if (input.at) {
            const found = await hubChildren(input.at);
            if (!found?.hub) return { count: 0, results: [], note: `There is no place called "${input.at}" on the platform. Say so rather than answering about the whole coast.` };
            if (found.slugs.size <= 1) {
                return { count: 0, results: [], hub: found.hub.name, note: `${found.hub.name} has no businesses listed under it. Say so rather than widening the search.` };
            }
            slugSets.push(found.slugs);
        }
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

        /* ── the stacking filters ─────────────────────────────────────────
         *
         * "Live music tonight, outdoor seating and a happy hour" is one
         * question, and answering it as three searches leaves the intersecting
         * to the model — which on a phone call it will get wrong, confidently.
         * Each filter below narrows the same slug set, so the answer either has
         * all three or is not in the list.
         */

        // Every feature in must_have, matched across tags AND amenities, ANDed.
        for (const feature of (Array.isArray(input.must_have) ? input.must_have : []).slice(0, 6)) {
            const term = String(feature || '').replace(/[,()%]/g, ' ').trim();
            if (!term) continue;
            const [tags, amenities] = await Promise.all([
                db.from('entity_tags').select('entity_slug').ilike('tag_name', `%${term}%`).limit(2000),
                db.from('entity_amenities').select('entity_slug').ilike('amenity', `%${term}%`).limit(2000),
            ]);
            const has = new Set([...(tags.data || []), ...(amenities.data || [])].map((r) => r.entity_slug).filter(Boolean));
            if (!has.size) return { count: 0, results: [], note: `Nothing is tagged "${term}". Say so — do not drop the condition and answer as if it had not been asked.` };
            slugSets.push(has);
        }

        if (input.has_happy_hour) {
            // Two ways a happy hour is recorded: the summary field on entity, or
            // real sections and items. A business with one and not the other is
            // still a business with a happy hour.
            const [flagged, sectioned] = await Promise.all([
                db.from('entity').select('slug').not('hh_days', 'is', null).limit(2000),
                db.from('happy_hour_sections').select('entity_slug').limit(2000),
            ]);
            const hh = new Set([
                ...(flagged.data || []).map((r) => r.slug),
                ...(sectioned.data || []).map((r) => r.entity_slug),
            ].filter(Boolean));
            if (!hh.size) return { count: 0, results: [], note: 'No business has a happy hour on file.' };
            slugSets.push(hh);
        }

        if (input.live_music) {
            const { getCentralNow } = require('../routes/gcr');
            const { today, todayName } = getCentralNow();
            const when = String(input.live_music).toLowerCase().trim();
            const date = /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : (when === 'tomorrow' ? addDays(today, 1) : today);
            const dayName = date === today ? todayName : DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];

            const { data: evRows, error: evErr } = await db
                .from('entity_events')
                .select('entity_slug, event_date, day_of_week, event_name, event_type, artist_name')
                .eq('is_active', true)
                .limit(2000);
            if (evErr) return { error: evErr.message };

            const musical = (r) => /music|band|live|dj|karaoke|acoustic/i.test(
                `${r.event_type || ''} ${r.event_name || ''} ${r.artist_name || ''}`,
            ) || !!r.artist_name;

            const playing = new Set(
                (evRows || [])
                    .filter((r) => musical(r) && (r.event_date ? r.event_date === date : dayMatches(r.day_of_week, dayName)))
                    .map((r) => r.entity_slug)
                    .filter(Boolean),
            );
            if (!playing.size) return { count: 0, results: [], note: `Nobody has live music listed for ${date}. Say that rather than naming somewhere that usually has it.` };
            slugSets.push(playing);
        }

        if (input.open_now) {
            const { getCentralNow } = require('../routes/gcr');
            const { nowTime, todayName } = getCentralNow();
            const { data: hourRows, error: hourErr } = await db
                .from('entity_hours')
                .select('entity_slug, day_of_week, opens_at, closes_at, is_closed')
                .limit(4000);
            if (hourErr) return { error: hourErr.message };
            const openNow = new Set(
                (hourRows || [])
                    .filter((h) => !h.is_closed
                        && String(h.day_of_week || '').toLowerCase().startsWith(todayName.slice(0, 3))
                        && withinWindow(nowTime, h.opens_at, h.closes_at))
                    .map((h) => h.entity_slug)
                    .filter(Boolean),
            );
            if (!openNow.size) return { count: 0, results: [], note: 'Nothing is showing as open right now by its published hours. Businesses that have not published hours are not in this answer.' };
            slugSets.push(openNow);
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
