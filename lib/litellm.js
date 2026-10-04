// ============================================================
// LITELLM — the model gateway for live calls and texts (CONTRACT §8)
// ============================================================
//
// gcr-api-clean answers live calls and texts through LiteLLM (LITELLM_URL),
// never a provider key of its own:
//
//   the concierge   LITELLM_CONCIERGE_KEY (NEXT GENT's own key)
//   a business      a key for that company: generated once with the master
//                   key (/key/generate, metadata.company_id) and kept sealed in
//                   nextgent_ai_keys, so its spend is the company's.
//
// The model is configuration (LITELLM_MODEL, LITELLM_CONCIERGE_MODEL); no
// model is named in code. Requests are OpenAI-compatible chat completions with
// tools, which is what LiteLLM serves.
//
// Without LITELLM_URL (development only) the old single-key path
// (utils/ai-provider.js callAI) answers instead, without tools, and a warning
// is logged.

const supabase = require('../db');
const secretBox = require('./secretBox');
const { envStr, envInt } = require('./env');

const KEY_PURPOSE = 'litellm-company-key';
let fetchImpl = (...args) => fetch(...args);
let warned = false;

const baseUrl = () => (envStr('LITELLM_URL') || '').replace(/\/+$/, '');
const configured = () => !!baseUrl();

async function api(path, { method = 'POST', key, body } = {}) {
    const res = await fetchImpl(`${baseUrl()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw Object.assign(new Error(`LiteLLM ${path} answered ${res.status}: ${data?.error?.message || data?.detail || ''}`.trim()), { status: res.status, data });
    return data;
}

/** The key a conversation runs on: the concierge's, or the company's own. */
async function keyFor(companyId) {
    if (!companyId || companyId === 'nextgent') {
        const k = envStr('LITELLM_CONCIERGE_KEY');
        if (!k) throw Object.assign(new Error('LITELLM_CONCIERGE_KEY is not set.'), { status: 503 });
        return k;
    }
    const { data } = await supabase.from('nextgent_ai_keys').select('key_sealed').eq('company_id', String(companyId)).maybeSingle();
    if (data?.key_sealed) return secretBox.open(data.key_sealed, KEY_PURPOSE);

    const master = envStr('LITELLM_MASTER_KEY');
    if (!master) throw Object.assign(new Error('No LiteLLM key for this company and no LITELLM_MASTER_KEY to make one.'), { status: 503 });
    const made = await api('/key/generate', {
        key: master,
        body: { metadata: { company_id: String(companyId), purpose: 'live' }, key_alias: `company-${companyId}-live` },
    });
    const key = made?.key;
    if (!key) throw Object.assign(new Error('LiteLLM did not return a key.'), { status: 502 });
    await supabase.from('nextgent_ai_keys').upsert({ company_id: String(companyId), key_sealed: secretBox.seal(key, KEY_PURPOSE), created_at: new Date().toISOString() }, { onConflict: 'company_id' });
    return key;
}

/** MCP tool definitions as OpenAI-style function tools. */
function asFunctionTools(mcpTools) {
    return (mcpTools || []).map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || t.title || t.name, parameters: t.inputSchema || { type: 'object', properties: {} } },
    }));
}

/**
 * One turn of a conversation, tools included. `runTool(name, args)` executes
 * a tool and resolves the MCP result ({ content: [{ text }] , isError? }).
 * Resolves { text, toolCalls }.
 */
async function respond({ companyId, model, instructions, history, tools = [], runTool }) {
    const messages = [
        ...(instructions ? [{ role: 'system', content: instructions }] : []),
        ...history.map((h) => ({ role: h.role === 'caller' || h.role === 'user' ? 'user' : 'assistant', content: h.text })),
    ];

    if (!configured()) {
        if (!warned) { console.warn('[litellm] LITELLM_URL is not set: answering through the single-key fallback, without tools (development only).'); warned = true; }
        const { callAI } = require('../utils/ai-provider');
        const prompt = messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`).join('\n');
        const text = await callAI('live', prompt, { systemPrompt: instructions || undefined, maxTokens: envInt('LIVE_MAX_TOKENS', 300) });
        return { text: String(text || '').trim(), toolCalls: [] };
    }

    const useModel = model || envStr('LITELLM_MODEL');
    if (!useModel) throw Object.assign(new Error('LITELLM_MODEL is not set.'), { status: 503 });
    const key = await keyFor(companyId);
    const fnTools = asFunctionTools(tools);
    const toolCalls = [];
    const rounds = envInt('LIVE_MAX_TOOL_ROUNDS', 4);

    for (let i = 0; i <= rounds; i += 1) {
        const data = await api('/chat/completions', {
            key,
            body: {
                model: useModel,
                messages,
                ...(fnTools.length && i < rounds ? { tools: fnTools, tool_choice: 'auto' } : {}),
                max_tokens: envInt('LIVE_MAX_TOKENS', 300),
                metadata: { company_id: String(companyId || 'nextgent') },
            },
        });
        const msg = data?.choices?.[0]?.message || {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) return { text: String(msg.content || '').trim(), toolCalls };

        messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
        for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
            let result;
            try {
                result = await runTool(call.function?.name, args);
            } catch (e) {
                result = { content: [{ type: 'text', text: e.message }], isError: true };
            }
            const text = (result?.content || []).map((c) => c.text).filter(Boolean).join('\n') || (result ? JSON.stringify(result) : 'No such tool.');
            toolCalls.push({ name: call.function?.name, args, error: !!result?.isError });
            messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, envInt('LIVE_TOOL_RESULT_CHARS', 6000)) });
        }
    }
    return { text: '', toolCalls };
}

module.exports = {
    configured,
    keyFor,
    respond,
    asFunctionTools,
    api,
    _setFetch: (impl) => { fetchImpl = impl; },
};
