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

const { createMcpRouter, content } = require('../lib/mcpServer');
const { CONCIERGE_TOOLS, runConciergeTool } = require('../lib/conciergeTools');

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
