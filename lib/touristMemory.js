// ============================================================
// TOURIST MEMORY — what the assistant knows about the person asking
// ============================================================
//
// Lifted out of the tool loop in routes/tourist.js so the MCP server can offer
// the same three tools over the same table. One copy: a memory saved by the
// voice agent is there in the web chat, and one saved in the web chat is there
// on the phone, because both write tourist_memories keyed by the same user.
//
// ── Why this is not optional ────────────────────────────────────────────
//
// An assistant that answers perfectly and remembers nothing is a search box
// with a voice. The second question in any real conversation depends on the
// first — "somewhere for dinner" means something different once you know they
// have two kids and do not eat seafood, and asking again every time is how a
// person works out they are talking to a machine.
//
// ── Who is "the person asking" ──────────────────────────────────────────
//
// Whoever the caller's token resolves to, exactly as touristAuth does. A signed
// -out visitor can carry a guest id instead, and tourist-auth.js already
// reassigns those rows to the real account when they sign up — so a
// conversation before signing up is not lost.
//
// Nothing here is reachable without an identity. An anonymous connection is not
// shown these tools at all, so there is no request that reads or writes another
// person's memories: the user id is never taken from the arguments.

const db = require('../db');

const CATEGORIES = ['preference', 'fact', 'goal', 'decision', 'recurring', 'note'];

const MEMORY_TOOLS = [
    {
        name: 'recall',
        title: 'What you already know about this person',
        description:
            'Everything remembered about the person you are talking to — their preferences, their party, decisions they have made, things they have told you before. Call this at the start of a conversation, before asking anything you may already have been told. Asking someone a question they have answered before is the fastest way to sound like a machine.',
        inputSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', enum: CATEGORIES, description: 'Optional: only this kind of memory.' },
                about: { type: 'string', description: 'Optional: match text in the key or the value, e.g. "food" or "kids".' },
            },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'remember',
        title: 'Remember something about this person',
        description:
            'Save a durable fact, preference or decision — "travelling with two kids", "does not eat seafood", "staying at Phoenix East until the 18th", "booked the sunset cruise Thursday". Save the things that will still matter tomorrow, not the turn-by-turn of the conversation. Re-saving the same key overwrites it, so use it to correct yourself when they change their mind.',
        inputSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', enum: CATEGORIES, description: 'preference, fact, goal, decision, recurring or note.' },
                key: { type: 'string', description: 'A short stable slug — "dietary", "party_size", "where_staying". Reusing a key replaces what was there.' },
                value: { type: 'string', description: 'What to remember, in plain words.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels.' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are. Default medium.' },
            },
            required: ['category', 'key', 'value'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'forget',
        title: 'Forget something',
        description:
            'Remove a memory, when the person asks you to or when it has stopped being true and has no replacement. If it has simply changed, call remember with the same key instead.',
        inputSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', enum: CATEGORIES },
                key: { type: 'string' },
            },
            required: ['category', 'key'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
];

const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

/** Everything remembered about one person. Also used to brief the agent on connect. */
async function loadMemories(userId, { category, about, limit = 100 } = {}) {
    if (!userId) return [];
    let q = db
        .from('tourist_memories')
        .select('category, key, value, tags, confidence, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(limit);
    if (category) q = q.eq('category', category);
    const { data, error } = await q;
    if (error) return [];

    const term = String(about || '').toLowerCase().trim();
    const rows = data || [];
    if (!term) return rows;
    return rows.filter((r) => `${r.key} ${r.value}`.toLowerCase().includes(term));
}

/**
 * The known-facts block that goes into the agent's instructions on connect.
 *
 * Handing these over up front rather than making the agent call recall first is
 * the difference between "welcome back" and an interrogation — a voice agent
 * that opens by asking how many people are in your party, again, has already
 * lost the conversation.
 */
async function briefing(userId) {
    const memories = await loadMemories(userId, { limit: 40 });
    if (!memories.length) return '';
    const lines = memories.map((m) => `  • ${m.key.replace(/_/g, ' ')}: ${m.value}${m.confidence === 'low' ? ' (unsure)' : ''}`);
    return [
        'What you already know about the person you are talking to:',
        ...lines,
        '',
        'Use it. Do not ask them again for anything above, and do not recite it back at them either —',
        'let it shape what you suggest. Call remember when they tell you something new that will still',
        'matter tomorrow, and remember again with the same key when they change their mind.',
    ].join('\n');
}

/** Run one memory tool as one person. Returns null if it is not a memory tool. */
async function runMemoryTool(name, input = {}, userId) {
    if (!MEMORY_TOOL_NAMES.has(name)) return null;
    // Belt and braces: these tools are not offered to an anonymous caller, so
    // this is unreachable — but the user id must never come from the arguments,
    // and this is the line that guarantees it.
    if (!userId) return { error: 'Not signed in, so there is nothing to remember against.' };

    if (name === 'recall') {
        const memories = await loadMemories(userId, { category: input.category, about: input.about });
        return {
            memories,
            count: memories.length,
            note: memories.length
                ? 'Things this person has told you before. Do not ask them again.'
                : 'Nothing remembered about them yet. Ask, then save what will still matter tomorrow.',
        };
    }

    if (name === 'remember') {
        const category = CATEGORIES.includes(input.category) ? input.category : 'note';
        const key = String(input.key || '').trim().slice(0, 80);
        const value = String(input.value ?? '').trim();
        if (!key || !value) return { error: 'A key and a value are both required.' };

        const { error } = await db.from('tourist_memories').upsert({
            user_id: userId,
            category,
            key,
            value,
            tags: Array.isArray(input.tags) ? input.tags : [],
            confidence: ['high', 'medium', 'low'].includes(input.confidence) ? input.confidence : 'medium',
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,category,key' });
        if (error) return { error: error.message };
        return { saved: key, category, value };
    }

    // forget
    const { error } = await db
        .from('tourist_memories')
        .delete()
        .eq('user_id', userId)
        .eq('category', input.category)
        .eq('key', input.key);
    if (error) return { error: error.message };
    return { forgotten: input.key, category: input.category };
}

module.exports = { MEMORY_TOOLS, MEMORY_TOOL_NAMES, CATEGORIES, loadMemories, briefing, runMemoryTool };
