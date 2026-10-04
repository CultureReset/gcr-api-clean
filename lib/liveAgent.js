// ============================================================
// LIVE AGENT — who answers a call or a text, and the conversation itself
// ============================================================
//
// Plan §3 (concierge) and §12: a call or text arrives at one of our numbers.
//
//   CONCIERGE_NUMBER        the concierge: NEXT GENT's own instructions
//                           (CONCIERGE_INSTRUCTIONS, or platform_config row
//                           concierge_instructions), the public MCP tools
//                           (routes/mcp-public.js), the NEXT GENT LiteLLM key.
//   a Phone Agent number    that business: its install's permissions (the
//                           same caller its install token is), the business
//                           MCP tools (routes/mcp.js — the same handlers, not
//                           a copy), the agent's instructions as stored at
//                           install, the company's LiteLLM key.
//   anything else           not a conversation here (texts to the platform
//                           number go to routes/sms.js's handler).
//
// Each conversation is a live_conversations row (so a call survives a restart
// mid-sentence) and, when it ends, is recorded to Paperclip:
// POST /api/nextgent/conversations (signed, CONTRACT §5).

const supabase = require('../db');
const telephony = require('./telephony');
const litellm = require('./litellm');
const { signedPost } = require('./serviceSigning');
const { scopeForPermissions } = require('./businessTables');
const { envStr, envInt } = require('./env');

const nowIso = () => new Date().toISOString();

async function conciergeInstructions() {
    const fromEnv = envStr('CONCIERGE_INSTRUCTIONS');
    if (fromEnv) return fromEnv;
    const { data } = await supabase.from('platform_config').select('value').eq('key', 'concierge_instructions').maybeSingle();
    return data?.value || null;
}

/**
 * Who answers at this number. Resolves a context:
 *   { mode: 'concierge' | 'business', companyId, slug?, instructions, greeting,
 *     tools, runTool(name, args) }
 * or null when the number is not one a live agent answers.
 */
async function contextFor(toNumber) {
    const to = telephony.normalizePhone(toNumber);
    if (!to) return null;
    const concierge = telephony.normalizePhone(process.env.CONCIERGE_NUMBER);
    if (concierge && to === concierge) {
        const pub = require('../routes/mcp-public');
        return {
            mode: 'concierge',
            companyId: 'nextgent',
            slug: null,
            number: to,
            instructions: await conciergeInstructions(),
            greeting: envStr('CONCIERGE_GREETING'),
            model: envStr('LITELLM_CONCIERGE_MODEL'),
            tools: pub.publicTools,
            runTool: (name, args) => pub.runTool(name, args, {}),
        };
    }

    const { numberRow } = require('./phoneAgent');
    const row = await numberRow(to);
    if (!row?.install_id) return null;
    const { data: install } = await supabase.from('nextgent_installs').select('*').eq('install_id', row.install_id).maybeSingle();
    if (!install || install.status !== 'active' || install.entity_slug !== row.entity_slug) return null;

    const mcp = require('../routes/mcp');
    const permissions = Array.isArray(install.permissions) ? install.permissions : [];
    // Exactly the caller this install's token is: its business, its permissions.
    const caller = {
        slug: install.entity_slug,
        scope: scopeForPermissions(permissions),
        permissions,
        installId: install.install_id,
        via: 'phone',
        label: `phone:${install.item_key}`,
    };
    const { data: entity } = await supabase.from('entity').select('name').eq('slug', install.entity_slug).maybeSingle();
    return {
        mode: 'business',
        companyId: install.company_id,
        slug: install.entity_slug,
        number: to,
        businessName: entity?.name || null,
        instructions: install.instructions || envStr('PHONE_AGENT_DEFAULT_INSTRUCTIONS'),
        greeting: envStr('PHONE_AGENT_GREETING'),
        model: envStr('LITELLM_MODEL'),
        tools: mcp.toolsFor(caller),
        runTool: (name, args) => mcp.runTool(name, args, caller),
    };
}

/* ── conversation rows ────────────────────────────────────────────────── */

async function openConversation({ ctx, channel, from, to, providerRef = null }) {
    const { data, error } = await supabase.from('live_conversations').insert({
        channel, mode: ctx.mode, entity_slug: ctx.slug, company_id: ctx.companyId,
        from_number: from, to_number: to, provider_ref: providerRef,
        transcript: [], status: 'open', state: 'new', started_at: nowIso(), last_activity_at: nowIso(),
    }).select('*').single();
    if (error) throw Object.assign(new Error(`Live conversations are not set up on this database yet: ${error.message}`), { status: 503 });
    return data;
}

async function findByRef(providerRef) {
    const { data } = await supabase.from('live_conversations').select('*').eq('provider_ref', providerRef).maybeSingle();
    return data || null;
}

/** The open text conversation between two numbers, if it is recent enough. */
async function openTextConversation(from, to, now = new Date()) {
    const { data } = await supabase.from('live_conversations').select('*')
        .eq('channel', 'sms').eq('from_number', from).eq('to_number', to).eq('status', 'open')
        .order('last_activity_at', { ascending: false }).limit(1);
    const row = data?.[0];
    if (!row) return null;
    const idle = envInt('LIVE_SMS_SESSION_MINUTES', 30) * 60 * 1000;
    if (now - new Date(row.last_activity_at) > idle) {
        await closeConversation(row, { outcome: 'idle' });
        return null;
    }
    return row;
}

async function saveConversation(row, patch) {
    const { data } = await supabase.from('live_conversations').update({ ...patch, last_activity_at: nowIso() }).eq('id', row.id).select('*');
    return data?.[0] || { ...row, ...patch };
}

/**
 * The caller (or texter) said something: answer it. Appends both sides to
 * the transcript and resolves { reply, conversation }.
 */
async function converse(ctx, row, text) {
    const transcript = Array.isArray(row.transcript) ? row.transcript.slice() : [];
    transcript.push({ role: 'caller', text: String(text || '').slice(0, 4000), at: nowIso() });
    let reply = '';
    let toolCalls = [];
    try {
        ({ text: reply, toolCalls } = await litellm.respond({
            companyId: ctx.companyId,
            model: ctx.model,
            instructions: ctx.instructions,
            history: transcript,
            tools: ctx.tools,
            runTool: ctx.runTool,
        }));
    } catch (e) {
        console.error('[live]', ctx.mode, e.message);
        reply = '';
    }
    if (!reply) reply = envStr('LIVE_FALLBACK_REPLY', '');
    if (reply) transcript.push({ role: 'agent', text: reply, at: nowIso() });
    const tools = [...(Array.isArray(row.tool_calls) ? row.tool_calls : []), ...toolCalls];
    const saved = await saveConversation(row, { transcript, tool_calls: tools });
    return { reply, conversation: saved };
}

/** End a conversation and record it to Paperclip. Never throws. */
async function closeConversation(row, { outcome = null, summary = null } = {}) {
    if (!row || row.status === 'closed') return row;
    const closed = await saveConversation(row, { status: 'closed', ended_at: nowIso(), outcome });
    const transcript = Array.isArray(row.transcript) ? row.transcript : [];
    if (!transcript.length) return closed;
    try {
        await signedPost('/api/nextgent/conversations', {
            companyId: row.mode === 'concierge' ? 'nextgent' : row.company_id,
            channel: row.channel,
            from: row.from_number,
            to: row.to_number,
            transcript,
            ...(summary ? { summary } : {}),
            ...(outcome ? { outcome } : {}),
        });
        await supabase.from('live_conversations').update({ recorded_at: nowIso(), record_error: null }).eq('id', row.id);
    } catch (e) {
        await supabase.from('live_conversations').update({ record_error: String(e.message).slice(0, 300) }).eq('id', row.id);
    }
    return closed;
}

/** Close text conversations nobody has added to for a while (the scheduler runs this). */
async function closeIdleConversations({ now = new Date(), limit = 200 } = {}) {
    const cutoff = new Date(now.getTime() - envInt('LIVE_SMS_SESSION_MINUTES', 30) * 60 * 1000).toISOString();
    const { data } = await supabase.from('live_conversations').select('*')
        .eq('channel', 'sms').eq('status', 'open').lt('last_activity_at', cutoff).limit(limit);
    for (const row of data || []) await closeConversation(row, { outcome: 'idle' });
    return { closed: (data || []).length };
}

/** Retry recording conversations Paperclip did not take. */
async function retryUnrecorded({ limit = 50 } = {}) {
    const { data } = await supabase.from('live_conversations').select('*')
        .eq('status', 'closed').is('recorded_at', null).not('record_error', 'is', null).limit(limit);
    let n = 0;
    for (const row of data || []) {
        await closeConversation({ ...row, status: 'open' }, { outcome: row.outcome });
        n += 1;
    }
    return { retried: n };
}

module.exports = {
    contextFor,
    openConversation,
    findByRef,
    openTextConversation,
    saveConversation,
    converse,
    closeConversation,
    closeIdleConversations,
    retryUnrecorded,
};
