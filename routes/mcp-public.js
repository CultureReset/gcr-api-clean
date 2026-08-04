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
const { publicTables, allowPublicTable, scrubRow, getSchema, textColumns } = require('../lib/businessTables');

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
    '',
    'The one rule: never state a price, a time, a phone number or a count you did not read from a',
    'tool. If a tool says there is no data, say you do not have it and offer to give them the',
    'business\'s number — do not estimate, do not average, do not reason from what is typical.',
    'A confident wrong price sends somebody to the wrong door with the wrong money.',
    '',
    'Recommend two or three specific places, not ten. If the request is too broad to answer well,',
    'ask one narrowing question — party size, budget, or time — and then search.',
].join('\n');

async function runTool(name, args) {
    const payload = await runConciergeTool(name, args && typeof args === 'object' ? args : {});
    if (payload === null) return null; // unknown tool — the transport turns this into an error
    return content(payload);
}

module.exports = createMcpRouter({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    tools: CONCIERGE_TOOLS,
    runTool,
    // No authenticate: public by design. See the note at the top.
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

/* ── discovery: any table this business actually uses ─────────────────────
 *
 * The curated tools above answer the questions the website asks — menu, hours,
 * prices, what's on. They cannot answer the rest, because there is no fixed set
 * of tables to curate: every table in this database is keyed by entity_slug and
 * a business may use any of them. A dive shop fills tables a bakery never
 * touches, and both are real.
 *
 * So these two ask the schema instead of a list. list_sections returns the
 * tables that actually hold rows for this business, read_section returns them.
 * Nothing is enumerated in code, so a table added to the database is answerable
 * the same day with no deploy — and a business that has not filled a table
 * simply has no section for it, which is why the agent declines instead of
 * inventing: there is nothing there to read.
 *
 * The line these do not cross is in lib/businessTables.js. Tables holding other
 * people — bookings, customers, waivers, message logs, credentials — are out,
 * because this URL takes no credential and that data is not the business's to
 * publish. Sensitive columns are stripped again on the way out.
 */

const DISCOVERY_TOOLS = [
    {
        name: 'list_sections',
        title: 'What else is on file for this business',
        description:
            'Every section of published information this business actually has, with a row count for each — beyond the menu and hours the other tools cover. Businesses differ: a charter has trips and fish species, a spa has treatments, a rental has units. Call this when a question is not answered by get_business_details, then read_section to answer it.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'read_section',
        title: 'Read one section',
        description:
            'The rows of one section for this business, optionally filtered by a search across its text. Returns exactly what is stored — quote it, do not paraphrase figures. If a section is not in list_sections this business has not filled it in, and the honest answer is that you do not have it.',
        inputSchema: {
            type: 'object',
            properties: {
                section: { type: 'string', description: 'A section name from list_sections.' },
                search: { type: 'string', description: 'Match this text anywhere in the section.' },
                limit: { type: 'integer', description: 'Rows to return, 1-200. Default 50.' },
            },
            required: ['section'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
];

const PUBLIC_ROW_LIMIT = 200;
const COUNT_CONCURRENCY = 24;

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) await worker(items[cursor++]);
    }));
}

async function runDiscoveryTool(name, a, caller) {
    if (name === 'list_sections') {
        const tables = await publicTables();
        const found = [];
        await mapLimit(tables, COUNT_CONCURRENCY, async (table) => {
            const { count, error } = await db
                .from(table)
                .select('id', { count: 'exact', head: true })
                .eq('entity_slug', caller.slug);
            // A section that cannot be counted must not take the list with it.
            if (!error && count) found.push({ section: table, rows: count });
        });
        found.sort((x, y) => y.rows - x.rows || x.section.localeCompare(y.section));
        return content({
            business: caller.name,
            sections: found,
            note: found.length
                ? 'These are the sections this business has filled in. Anything not listed here, they have not published — say so rather than guessing.'
                : 'This business has not published any extra sections yet.',
        });
    }

    // read_section
    const table = await allowPublicTable(String(a.section || '').trim());
    if (!table) {
        return toolError(`There is no published section called "${a.section}". Call list_sections to see what this business has.`);
    }

    const limit = Math.min(Math.max(Number(a.limit) || 50, 1), PUBLIC_ROW_LIMIT);
    const query = db.from(table).select('*', { count: 'exact' }).eq('entity_slug', caller.slug).limit(limit);

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
        return content({ section: table, rows: [], note: 'Nothing on file here for this business. Say you do not have it.' });
    }

    return content({ section: table, rows: data.map(scrubRow), returned: data.length, total: count ?? null });
}

const DISCOVERY_NAMES = new Set(DISCOVERY_TOOLS.map((t) => t.name));

async function runPinnedTool(name, args, caller) {
    const a = { ...(args && typeof args === 'object' ? args : {}) };
    if (DISCOVERY_NAMES.has(name)) return runDiscoveryTool(name, a, caller);

    // "How late are you open" arrives with no slug, because from the caller's
    // side there is only one business in the conversation.
    if (['get_business_details', 'check_availability'].includes(name) && !a.slug) a.slug = caller.slug;
    const payload = await runConciergeTool(name, a);
    if (payload === null) return null;
    return content(payload);
}

const pinnedInstructions = (caller) => [
    `You answer for ${caller.name}${caller.city ? ` in ${caller.city}` : ''} — a business on the Gulf Coast`,
    'Radar platform. When someone says "you", "your" or "here", they mean this business.',
    '',
    `  • get_business_details and check_availability already know who you are — call them with no`,
    `    arguments for hours, the menu, prices, policies and today's availability.`,
    '  • If that does not answer it, call list_sections. Businesses keep different things on file —',
    '    trips, treatments, units, fish species, whatever this one actually does — and read_section',
    '    reads any of them. This is how you answer a question the standard tools do not cover.',
    '  • whats_on tells you what is happening across the whole coast tonight, including here.',
    '  • search_businesses, find_item_prices and compare_businesses reach every other business.',
    '    Use them when someone wants something this business does not do — sending them somewhere',
    '    real is better service than turning them away.',
    '',
    'The one rule: never state a price, a time, a phone number or a count you did not read from a',
    'tool. If a tool has no data, say you do not have it and offer to pass the caller on — do not',
    'estimate and do not reason from what is typical for a place like this.',
    `${caller.phone ? `This business's own number is ${caller.phone}.` : ''}`,
].filter(Boolean).join('\n');

const pinned = createMcpRouter({
    serverInfo: { name: 'gulf-coast-radar-business', title: 'Gulf Coast Radar — one business', version: '1.0.0' },
    instructions: pinnedInstructions,
    tools: [...PINNED_TOOLS, ...DISCOVERY_TOOLS],
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

    const open = new Set(await publicTables());
    const visible = [];
    const withheld = [];

    await mapLimit(schema.tables, COUNT_CONCURRENCY, async (table) => {
        const { count, error } = await db
            .from(table)
            .select('id', { count: 'exact', head: true })
            .eq('entity_slug', caller.slug);
        if (error || !count) return;
        (open.has(table) ? visible : withheld).push({ section: table, rows: count });
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
        note: 'Counts only, no rows. If something in held_back should be public, or something readable should not be, say which and the rule moves.',
    });
});

module.exports.pinned = pinned;
