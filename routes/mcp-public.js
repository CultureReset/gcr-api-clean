// ============================================================
// MCP (PUBLIC) — one agent that knows every business
// ============================================================
//
// The whole directory as five tools, open to anyone. This is what a voice
// agent answers a phone call with, and what a web chat runs on: "where can I
// get crab legs", "cheapest dolphin cruise for two kids", "is Flora-Bama open
// tonight", "what's the difference between these two charters" — any business
// on the platform, one number, one chat box.
//
// ── Why it has no token ─────────────────────────────────────────────────
//
// Everything it returns is already on the public website. A token would not
// protect anything; it would only stop the thing from scaling, because every
// new surface would need one issued, stored and rotated.
//
// That is the difference between this and /api/mcp. That one is a business
// acting on its own data and is scoped to one slug by its token. This one is
// the public directory and is scoped to `is_active` businesses and the tables
// the website already renders. Nothing here can write.
//
// ── Where the tools come from ───────────────────────────────────────────
//
// lib/conciergeTools.js — the same five the tourist chat already runs on. Not
// reimplemented for MCP: lifted out, so the search an agent does on the phone
// is the search the website does in its search bar, and improving one improves
// both.

const db = require('../db');
const { createMcpRouter, content, toolError } = require('../lib/mcpServer');
const { CONCIERGE_TOOLS, runConciergeTool } = require('../lib/conciergeTools');
const { publicTables, allowPublicTable, scrubRow, getSchema, textColumns, publicReason, HIDE_PERSONAL } = require('../lib/businessTables');
const { MEMORY_TOOLS, MEMORY_TOOL_NAMES, briefing, runMemoryTool } = require('../lib/touristMemory');

const SERVER_INFO = { name: 'gulf-coast-radar', title: 'Gulf Coast Radar', version: '1.0.0' };

// Sent once when an agent connects. This is where the honesty rule lives,
// because it is the one thing the tools cannot enforce for themselves: a tool
// can return "no data", but only the prompt stops a model reading a plausible
// price out loud anyway.
const INSTRUCTIONS = [
    'You are the local expert for the Gulf Coast — Orange Beach, Gulf Shores and the surrounding',
    'coast. You know every business on the Gulf Coast Radar platform: restaurants, bars, charters,',
    'rentals, condos, activities and services.',
    '',
    'How to work:',
    '  • search_businesses first for anything of the form "who has X" or "where can I Y". It',
    '    searches business names AND their menus, drinks, trips, amenities, FAQs and tags, so',
    '    "red snapper" finds the charters that catch it and the kitchens that serve it.',
    '  • find_item_prices for anything about cost — "cheapest", "under $20", "what does X run".',
    '    It returns real rows sorted low to high.',
    '  • get_business_details once you have a slug and need depth: hours, full menu, policies,',
    '    fees, what is included.',
    '  • check_availability only tells you about today, and only for businesses that publish it.',
    '  • compare_businesses when someone is choosing between two or three.',
    '  • read_business is the catch-all: hand it a slug and you get every table that business has',
    '    rows in, and every row. Use it whenever a question is about one place. You never need to',
    '    know which table an answer lives in — only the slug.',
    '  • "at the Wharf", "at the marina", "at Orange Beach Marina" is the `at` filter on',
    '    search_businesses, whats_on and find_available. It scopes to the businesses inside that',
    '    complex. Never drop it: answering about the whole coast to a question about one place',
    '    sounds like an answer and is not one.',
    '  • industry_sections routes by kind rather than by name. Given a subtype — fishing_charter,',
    '    condo, seafood, dolphin_cruise — it says which sections that industry actually fills, so',
    '    you know where to look before you look: beds and views live in room_types for a condo,',
    '    what you catch lives in fish_species for a charter. Use it when the question is about a',
    '    kind of business rather than a named one.',
    '',
    'You are the last stop, not a switchboard. This platform holds the business\'s own data —',
    'their menu, their hours, their prices, their policies, entered by them. Never tell anyone to',
    'ring the business, check its website or look at the menu to be sure. There is nowhere better',
    'for them to go. Answer from the rows and answer flatly.',
    '',
    'The one rule: never state a price, a time or a count that was not in a row you read. If the',
    'business has not filled that in, say plainly that they have not published it — do not',
    'estimate, do not average, do not reason from what is typical for a place like this, and do',
    'not send the caller somewhere else to find out. "They have not listed their brunch prices" is',
    'a real answer. A confident wrong price sends somebody to the wrong door with the wrong money.',
    '',
    'Recommend two or three specific places, not ten. If the request is too broad to answer well,',
    'ask one narrowing question — party size, budget, or time — and then search.',
].join('\n');

/* ── discovery, for any business ──────────────────────────────────────────
 *
 * The curated tools answer the questions the website asks. These two answer the
 * rest, and they are what makes one agent enough for the whole platform.
 *
 * A business is a slug. Every table in this database hangs off a slug, and any
 * business may fill any of them — hours, FAQs, photos and policies are the same
 * tables for a bakery and a dive charter. So given a slug, the database itself
 * says what that business has on file. Nothing is enumerated in code, so a
 * hundred thousand businesses and every table they use are reachable through
 * the same tools, and a table added to the database is answerable the same day
 * with no deploy.
 *
 * A business that has not filled a table has no section for it, which is why an
 * agent declines instead of inventing: there is nothing there to read.
 */

const DISCOVERY_TOOLS = [
    {
        name: 'read_business',
        title: 'Everything on file for one business',
        description:
            'Give it a slug and it returns that business in full: `profile` is exactly what its page on the site renders — menus with every dish and price, sections with their items and price tiers, hours, photos, policies, fees — and `sections` is every slug-keyed table underneath it, flat. Reach for this whenever a question is about a specific business; you never need to know which table an answer lives in, only the slug. Anything absent from the result, that business has not published.',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'The business\'s slug, from search_businesses.' },
                rows_per_section: { type: 'integer', description: 'Optional ceiling per section. Leave it out to get every row.' },
            },
            required: ['slug'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'list_sections',
        title: 'What a business has on file',
        description:
            'The sections one business has on file and how many rows are in each — an index rather than the data. read_business returns the data itself and is usually what you want; use this when you only need to know whether something exists, or which section to read on a very large business.',
        inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string', description: 'The business\'s slug, from search_businesses.' } },
            required: ['slug'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'read_section',
        title: 'Read one section of one business',
        description:
            'One section of one business, optionally filtered by a search across its text. Returns exactly what is stored — quote it, do not paraphrase figures. read_business already returns every section, so reach for this only when you want one of them narrowed by a search term.',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'The business\'s slug.' },
                section: { type: 'string', description: 'A section name from list_sections.' },
                search: { type: 'string', description: 'Match this text anywhere in the section.' },
                limit: { type: 'integer', description: 'Rows to return, 1-200. Default 50.' },
            },
            required: ['slug', 'section'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
];

const DISCOVERY_NAMES = new Set(DISCOVERY_TOOLS.map((t) => t.name));

const PUBLIC_ROW_LIMIT = 200;
const COUNT_CONCURRENCY = 24;

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) await worker(items[cursor++]);
    }));
}

/** Every section with rows for this slug, and how many. */
async function listSections(slug) {
    const tables = await publicTables();
    const found = [];
    await mapLimit(tables, COUNT_CONCURRENCY, async (table) => {
        const { count, error } = await db
            .from(table)
            .select('id', { count: 'exact', head: true })
            .eq('entity_slug', slug);
        // A section that cannot be counted must not take the list with it.
        if (!error && count) found.push({ section: table, rows: count });
    });
    found.sort((x, y) => y.rows - x.rows || x.section.localeCompare(y.section));
    return {
        slug,
        sections: found,
        note: found.length
            ? 'These are the sections this business has filled in. Anything not listed, they have not published — say so rather than guessing.'
            : 'This business has nothing on file beyond its listing.',
    };
}

/**
 * Every row a table holds for one slug.
 *
 * PostgREST silently caps a select with no range at 1,000 rows, which is how a
 * synced catalogue of 1,070 showed up as 1,000 and looked fine. A short page is
 * the only reliable end-of-data signal, so this walks ranges until it gets one.
 */
const PAGE = 1000;
async function allRowsFor(table, slug, cap = Infinity) {
    const out = [];
    for (let from = 0; out.length < cap; from += PAGE) {
        const size = Math.min(PAGE, cap - out.length);
        const { data, error } = await db
            .from(table)
            .select('*')
            .eq('entity_slug', slug)
            .range(from, from + size - 1);
        // A section that cannot be read must not take the whole business with it.
        if (error) break;
        out.push(...(data || []));
        if (!data || data.length < size) break; // short page = last page
    }
    return out;
}

/**
 * Everything on file for one slug, in one call.
 *
 * The slug is the entry point, not the table. An agent asked "do they allow
 * dogs" should not have to work out which section that lives in — it hands over
 * the slug and gets what the business has.
 *
 * Every table with an entity_slug column is swept in parallel, in full. The
 * tables are shared: hours, FAQs, photos and policies are the same tables for a
 * bakery and a dive charter, and either may fill any of the rest. Nothing here
 * decides which ones belong to which kind of business — a table with rows for
 * this slug is a section, and a table without is absent.
 *
 * That absence is what keeps an agent honest. An unfilled table does not come
 * back empty for the model to talk around; it does not come back at all.
 */
async function readBusiness(slug, a) {
    // A ceiling only if the caller asks for one. Left alone it returns the lot.
    const cap = Number(a.rows_per_section) > 0 ? Number(a.rows_per_section) : Infinity;

    // ── the profile, assembled ───────────────────────────────────────────
    //
    // Not every table hangs off entity_slug. The ones holding the actual
    // content mostly do not: menu_items, drink_items, happy_hour_items and
    // entity_section_items are keyed by their parent section's id, and
    // price_tiers by the item's. A sweep of slug tables alone returns
    // menu_sections — "Appetizers", "Entrées" — and not one dish or price.
    //
    // buildFullEntity() is what resolves those joins, and it is the same
    // function GCR Unified's profile page renders from. Calling it means the
    // agent sees exactly what the website shows, assembled the same way, with
    // one copy of the assembly rather than a second that drifts.
    const { buildFullEntity } = require('./gcr');
    const profile = await buildFullEntity(slug).catch(() => null);

    // ── and the flat sweep, for anything the profile does not reach ──────
    //
    // Kept alongside rather than instead: buildFullEntity names the tables it
    // knows, so a table added to the database tomorrow is not in it. The sweep
    // is what keeps "every table keyed by the slug" true. Some data appears in
    // both; that costs bytes, where dropping it would cost an answer.
    const tables = await publicTables();
    const sections = {};
    await mapLimit(tables, COUNT_CONCURRENCY, async (table) => {
        const rows = await allRowsFor(table, slug, cap);
        if (rows.length) sections[table] = rows.map(scrubRow);
    });

    const names = Object.keys(sections);
    if (!profile && !names.length) {
        return { slug, sections: {}, note: `${slug} has nothing on file beyond its listing. Say you do not have it.` };
    }

    return {
        slug,
        // What the profile page shows: menus with their items and prices,
        // sections with their items and price tiers, hours, photos, policies.
        profile: profile ? scrubRow(profile) : null,
        // Every table keyed by this slug, flat. Catches anything the profile
        // does not assemble.
        sections,
        section_count: names.length,
        note: 'profile is the business exactly as its page on the site renders it — menu items, prices and tiers are in there, nested under their sections. sections is every slug-keyed table underneath, flat. Anything in neither, this business has not published: say so rather than guessing.',
    };
}

/** The rows of one section for one slug. */
async function readSection(slug, a) {
    const table = await allowPublicTable(String(a.section || '').trim());
    if (!table) {
        return toolError(`There is no section called "${a.section}". Call list_sections for this business to see what it has.`);
    }

    const limit = Math.min(Math.max(Number(a.limit) || 50, 1), PUBLIC_ROW_LIMIT);
    const query = db.from(table).select('*', { count: 'exact' }).eq('entity_slug', slug).limit(limit);

    const term = typeof a.search === 'string' ? a.search.trim() : '';
    if (term) {
        // PostgREST's or() is a comma-separated list wrapped in its own
        // punctuation, so characters that would end a clause early are stripped.
        const safe = term.replace(/[,()*%\\]/g, ' ').trim();
        const cols = await textColumns(table);
        if (safe && cols.length) query.or(cols.map((c) => `${c}.ilike.%${safe}%`).join(','));
    }

    const { data, error, count } = await query;
    if (error) return toolError(`Could not read ${table}: ${error.message}`);
    if (!data?.length) {
        return content({ slug, section: table, rows: [], note: 'Nothing on file here for this business. Say you do not have it.' });
    }
    return content({ slug, section: table, rows: data.map(scrubRow), returned: data.length, total: count ?? null });
}

/* ── who is asking ────────────────────────────────────────────────────────
 *
 * Optional, and never a reason to refuse. Anyone can use this server; a signed
 * -in traveller additionally gets remembered.
 *
 * MCP clients hand over one credential field, so both forms arrive through it:
 * a Supabase access token resolves to the real account exactly as touristAuth
 * does, and a bare UUID is the guest id a signed-out visitor keeps in
 * localStorage — the same one tourist-auth.js reassigns to the real account
 * when they sign up, so a conversation held before signing up is not lost.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function identify(req) {
    const header = (req.headers.authorization || '').trim();
    const raw = (/^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : header).trim()
        || String(req.headers['x-guest-id'] || '').trim();
    if (!raw) return {};

    if (UUID_RE.test(raw)) return { touristId: raw, isGuest: true };

    try {
        const { data, error } = await db.auth.getUser(raw);
        if (!error && data?.user) return { touristId: data.user.id, email: data.user.email, isGuest: false };
    } catch { /* an unusable token is simply an anonymous caller */ }
    return {};
}

async function runTool(name, args, caller = {}) {
    const a = args && typeof args === 'object' ? args : {};

    const remembered = await runMemoryTool(name, a, caller.touristId);
    if (remembered !== null) return content(remembered);

    if (name === 'read_business') {
        if (!a.slug) return toolError('A slug is required. Use search_businesses to find one.');
        return content(await readBusiness(String(a.slug).trim().toLowerCase(), a));
    }
    if (name === 'list_sections') {
        if (!a.slug) return toolError('A slug is required. Use search_businesses to find one.');
        return content(await listSections(String(a.slug).trim().toLowerCase()));
    }
    if (name === 'read_section') {
        if (!a.slug) return toolError('A slug is required. Use search_businesses to find one.');
        return readSection(String(a.slug).trim().toLowerCase(), a);
    }

    const payload = await runConciergeTool(name, a);
    if (payload === null) return null; // unknown tool — the transport turns this into an error
    return content(payload);
}

/**
 * The instruction block, plus what is already known about this person.
 *
 * The memories go in here rather than being left for the agent to fetch,
 * because a voice agent that opens by asking how many are in your party —
 * again — has lost the conversation before it starts.
 */
async function instructionsFor(caller) {
    if (!caller.touristId) return INSTRUCTIONS;
    const known = await briefing(caller.touristId);
    return known ? `${INSTRUCTIONS}\n\n${known}` : INSTRUCTIONS;
}

module.exports = createMcpRouter({
    serverInfo: SERVER_INFO,
    instructions: instructionsFor,
    // The memory tools only exist for someone there is a memory to keep
    // against. An anonymous caller is not shown them, so no request can reach
    // another person's memories — the user id is never an argument.
    tools: (caller) => (caller.touristId
        ? [...CONCIERGE_TOOLS, ...DISCOVERY_TOOLS, ...MEMORY_TOOLS]
        : [...CONCIERGE_TOOLS, ...DISCOVERY_TOOLS]),
    runTool,
    // Resolves an identity when one is offered and never refuses without one:
    // the directory is public, being remembered is what signing in buys.
    authenticate: identify,
    authNote: 'none — public. Send a tourist access token (or their guest UUID) to be remembered between conversations.',
});

/* ── the same thing, attached to one slug ─────────────────────────────────
 *
 *     /api/mcp/business/flora-bama
 *
 * A business's own agent, and it needs nothing provisioned. The slug is in the
 * URL, so standing one up for every business on the platform is a string
 * concatenation — not a token minted, stored and rotated a thousand times.
 *
 * It answers about that business without being told which one it is, and it
 * keeps the coast-wide tools, because the question after "are you open" is
 * usually "well who is". A local who only knows one address is not a local.
 *
 * Reads only, exactly like the open server above. A business's agent that can
 * CHANGE the menu is a different thing with a different threat model, and that
 * is what /api/mcp and its tokens are for — anyone who can type a URL can
 * reach this one.
 */

/** Resolve the slug in the URL to a real, listed business. */
async function pinToSlug(req) {
    const slug = String(req.params?.slug || '').trim().toLowerCase();
    if (!slug) return { reason: 'No business in the URL.', status: 404 };

    const { data, error } = await db
        .from('entity')
        .select('slug, name, city, phone, is_active')
        .eq('slug', slug)
        .maybeSingle();
    if (error) return { reason: error.message, status: 502 };
    // Not listed reads the same as not there. A delisted business should not be
    // answerable through a URL somebody kept.
    if (!data || data.is_active === false) return { reason: `No business called "${slug}".`, status: 404 };

    return { slug: data.slug, name: data.name, city: data.city, phone: data.phone };
}

/**
 * The same seven tools, with the two that take a slug no longer requiring one.
 * Built once at load — the shape does not vary per business, only the value
 * filled in for it does.
 */
const PINNED_TOOLS = CONCIERGE_TOOLS.map((tool) => {
    if (!['get_business_details', 'check_availability'].includes(tool.name)) return tool;
    // `slug` stops being required: the URL already said which business.
    const schema = { ...tool.inputSchema };
    delete schema.required;
    return {
        ...tool,
        inputSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                slug: {
                    type: 'string',
                    description: 'Leave this out to mean the business you are attached to. Only pass it to look up a different one.',
                },
            },
        },
    };
});

/* ── the pinned versions of the same two ──────────────────────────────────
 *
 * Identical tools, with the slug already answered by the URL. An agent attached
 * to one business should not have to name it to ask what it has on file.
 */

const PINNED_DISCOVERY_TOOLS = DISCOVERY_TOOLS.map((tool) => {
    const schema = { ...tool.inputSchema };
    delete schema.required;
    if (tool.name === 'read_section') schema.required = ['section'];
    return {
        ...tool,
        inputSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                slug: { type: 'string', description: 'Leave this out to mean the business you are attached to.' },
            },
        },
    };
});


async function runPinnedTool(name, args, caller) {
    const a = { ...(args && typeof args === 'object' ? args : {}) };
    // "How late are you open" arrives with no slug, because from the caller's
    // side there is only one business in the conversation.
    if (!a.slug) a.slug = caller.slug;
    return runTool(name, a);
}

const pinnedInstructions = (caller) => [
    `You answer for ${caller.name}${caller.city ? ` in ${caller.city}` : ''} — a business on the Gulf Coast`,
    'Radar platform. When someone says "you", "your" or "here", they mean this business.',
    '',
    `  • get_business_details and check_availability already know who you are — call them with no`,
    `    arguments for hours, the menu, prices, policies and today's availability.`,
    '  • If that does not answer it, call read_business with no arguments — it returns everything',
    '    on file here, whatever sections this business actually uses. You never need to know which',
    '    table something lives in. list_sections and read_section are there for the large ones.',
    '  • whats_on tells you what is happening across the whole coast tonight, including here.',
    '  • search_businesses, find_item_prices and compare_businesses reach every other business on',
    '    the platform. Use them when someone wants something this business does not do — naming a',
    '    real place that does is better service than turning them away.',
    '',
    '',
    'You are the last stop, not a switchboard. This is the business\'s own data, entered by them.',
    'Never tell a caller to ring the business, check the website or look at the menu to be sure —',
    'they are already talking to the place that holds it.',
    '',
    'The one rule: never state a price, a time or a count that was not in a row you read. If it is',
    'not on file, say plainly that it has not been listed — do not estimate and do not reason from',
    'what is typical for a place like this.',
].filter(Boolean).join('\n');

const pinned = createMcpRouter({
    serverInfo: { name: 'gulf-coast-radar-business', title: 'Gulf Coast Radar — one business', version: '1.0.0' },
    instructions: pinnedInstructions,
    tools: [...PINNED_TOOLS, ...PINNED_DISCOVERY_TOOLS],
    runTool: runPinnedTool,
    authenticate: pinToSlug,
});

/* ── what the line actually did, per business ─────────────────────────────
 *
 *     GET /api/mcp/business/flora-bama/sections
 *
 * The public/private split is a rule about table names, and a rule about names
 * can be wrong in both directions without anybody noticing: a table full of
 * customers quietly readable, or a business's own trip list quietly missing
 * from every answer it gives.
 *
 * So it reports itself. This lists what the agent can see and what was held
 * back, by name, with counts — no rows either way. Read it for a business and
 * the boundary is a thing you can check rather than trust.
 */
pinned.get('/sections', async (req, res) => {
    const caller = await pinToSlug(req);
    if (caller.reason) return res.status(caller.status || 404).json({ error: caller.reason });

    let schema;
    try {
        schema = await getSchema();
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }

    const visible = [];
    const withheld = [];

    await mapLimit(schema.tables, COUNT_CONCURRENCY, async (table) => {
        const { count, error } = await db
            .from(table)
            .select('id', { count: 'exact', head: true })
            .eq('entity_slug', caller.slug);
        if (error || !count) return;
        // whyPrivate names the column that decided it, so a wrong call is
        // something you can see the reason for rather than argue with.
        const why = await publicReason(table, schema.columns[table]);
        if (why) withheld.push({ section: table, rows: count, reason: why });
        else visible.push({ section: table, rows: count });
    });

    const bySize = (a, b) => b.rows - a.rows || a.section.localeCompare(b.section);
    res.json({
        slug: caller.slug,
        name: caller.name,
        readable_by_the_agent: visible.sort(bySize),
        // Named, never read. These hold this business's customers, bookings,
        // messages and credentials — keyed by its slug, but not its to publish
        // through a URL that takes no password.
        held_back: withheld.sort(bySize),
        note: 'Counts and reasons only, never rows. The reason names the column that decided it — if a section is on the wrong side, that column is the thing to argue with.',
    });
});

module.exports.pinned = pinned;
