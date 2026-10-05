#!/usr/bin/env node
// ============================================================
// Live calls and texts: Telnyx webhooks (signed), number routing,
// LiteLLM answering with the same MCP tools, conversations to Paperclip
// ============================================================
//
//     npm run test:live
//
// Real Ed25519 webhook signatures; recording stand-ins for Telnyx, LiteLLM
// and Paperclip; in-memory database. No credentials, no network.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const ed = crypto.generateKeyPairSync('ed25519');
const rawPub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: 'svc',
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    PAPERCLIP_API_URL: 'https://paperclip.test',
    TELNYX_API_KEY: 'KEY_test',
    TELNYX_PUBLIC_KEY: rawPub.toString('base64'),
    TELNYX_CONNECTION_ID: 'conn-1',
    PLATFORM_NUMBER: '+15550000001',
    CONCIERGE_NUMBER: '+15550000002',
    CONCIERGE_INSTRUCTIONS: 'You are the concierge.',
    CONCIERGE_GREETING: 'Hi, concierge here.',
    LITELLM_URL: 'https://litellm.test',
    LITELLM_MASTER_KEY: 'sk-master',
    LITELLM_CONCIERGE_KEY: 'sk-concierge',
    LITELLM_MODEL: 'configured-model',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    LIVE_SMS_SESSION_MINUTES: '30',
});
delete process.env.TELEPHONY_PROVIDER;

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    nextgent_installs: [{ install_id: 'in-phone', company_id: 'co-1', entity_slug: 'shop', item_key: 'phone-agent', kind: 'agent', status: 'active',
        permissions: ['business:read', 'messages:send'], instructions: 'You answer for The Shop.' }],
    business_phone_numbers: [{ entity_slug: 'shop', install_id: 'in-phone', phone_number: '+15550200000', status: 'active', registration_status: 'approved', provider: 'telnyx' }],
    live_conversations: [],
    nextgent_ai_keys: [],
    message_threads: [], business_messages: [], message_consent: [], sms_opt_outs: [], sms_log: [], booking_opt_ins: [],
    owner_notify_settings: [], owner_notifications: [], entity_owners: [],
    tourist_profiles: [],
} });
inject(path.join(ROOT, 'db.js'), db);
inject(path.join(ROOT, 'lib/staff-commands.js'), { handleStaffCommand: async (phone, body) => (/^SOLD OUT/i.test(body) ? 'Marked sold out.' : null) });
// The owner routes, signed in as The Shop (ownerAuth resolves the business
// from the session; here that resolution is stubbed to one business).
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, _res, next) => { Object.assign(req, { entitySlug: 'shop', authVia: 'paperclip', paperclip: { userId: 'pc-1', companyId: 'co-1' } }); next(); },
    resolveSessionSlug: async () => ({ reason: 'no sessions here' }),
});
const publicCalls = [];
inject(path.join(ROOT, 'routes/mcp-public.js'), {
    publicTools: [{ name: 'search_businesses', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
    runTool: async (name, args) => { publicCalls.push({ name, args }); return { content: [{ type: 'text', text: '[{"name":"The Shop","open":"until 9"}]' }] }; },
});

const telnyxCalls = [];
require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
    telnyxCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'm-1', result: 'ok' } }) };
});

const llmCalls = [];
const paperclip = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://db.example.test/rest/v1/')) {
        return { ok: true, status: 200, json: async () => ({ definitions: { menu_items: { properties: { id: {}, entity_slug: {}, name: {} } } } }) };
    }
    if (u.startsWith('https://litellm.test')) {
        const body = init.body ? JSON.parse(init.body) : null;
        llmCalls.push({ url: u, auth: init.headers.Authorization, body });
        const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
        if (u.endsWith('/key/generate')) return json({ key: 'sk-company-1' });
        const last = body.messages.at(-1);
        if (last.role !== 'tool' && body.tools?.length) {
            const name = body.tools[0].function.name;
            return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: '{"query":"tacos"}' } }] } }] });
        }
        return json({ choices: [{ message: { content: `Answer after ${last.role === 'tool' ? 'a tool' : 'nothing'}.` } }] });
    }
    if (u.startsWith('https://paperclip.test')) {
        paperclip.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
        return { ok: true, status: 201, text: async () => '{}' };
    }
    return realFetch(url, init);
};

const { check, done } = checker();
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/telephony/telnyx', require(path.join(ROOT, 'routes/telephony-live.js')));
app.use('/api/owner', require(path.join(ROOT, 'routes/owner.js')));
const server = app.listen(0, run);
const settle = () => new Promise((r) => setTimeout(r, 80));
async function hook(kind, data, { sign = true } = {}) {
    const raw = JSON.stringify({ data });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json' };
    if (sign) {
        headers['telnyx-timestamp'] = ts;
        headers['telnyx-signature-ed25519'] = crypto.sign(null, Buffer.from(`${ts}|${raw}`), ed.privateKey).toString('base64');
    }
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/telephony/telnyx/${kind}`, { method: 'POST', headers, body: raw });
    await settle();
    return res.status;
}
const text = (from, to, t) => ({ event_type: 'message.received', payload: { id: crypto.randomUUID(), from: { phone_number: from }, to: [{ phone_number: to }], text: t } });
const sentTexts = () => telnyxCalls.filter((c) => c.url.endsWith('/messages')).map((c) => c.body);

async function run() {
    try {
        console.log('\n── signatures ──');
        check('an unsigned messaging webhook is refused', (await hook('messaging', text('+12515550111', '+15550000002', 'hi'), { sign: false })) === 401);
        check('an unsigned voice webhook is refused', (await hook('voice', { event_type: 'call.initiated', payload: {} }, { sign: false })) === 401);
        check('nothing was handled', !llmCalls.length && !telnyxCalls.length);

        console.log('\n── a text to the concierge ──');
        check('a signed text is accepted', (await hook('messaging', text('+12515550111', '+15550000002', 'Any tacos open now?'))) === 200);
        const firstLlm = llmCalls.find((c) => c.url.endsWith('/chat/completions'));
        check('answered through LiteLLM with the concierge key and configured model', firstLlm?.auth === 'Bearer sk-concierge' && firstLlm.body.model === 'configured-model');
        check('with the NEXT GENT instructions and the public MCP tools', firstLlm.body.messages[0].content === 'You are the concierge.' && firstLlm.body.tools[0].function.name === 'search_businesses');
        check('the tool ran through the public MCP handler', publicCalls[0]?.name === 'search_businesses' && publicCalls[0].args.query === 'tacos');
        check('the reply went back from the concierge number', sentTexts().at(-1)?.from === '+15550000002' && sentTexts().at(-1).to === '+12515550111' && /a tool/.test(sentTexts().at(-1).text));
        await hook('messaging', text('+12515550111', '+15550000002', 'Thanks'));
        check('a follow-up continues the same conversation', T.live_conversations.filter((c) => c.channel === 'sms').length === 1 && T.live_conversations[0].transcript.length === 4);

        console.log('\n── a text to a business\'s Phone Agent number ──');
        llmCalls.length = 0;
        await hook('messaging', text('+12515550122', '+15550200000', 'Are you open?'));
        const bizLlm = llmCalls.find((c) => c.url.endsWith('/chat/completions'));
        check('the company\'s own LiteLLM key, made once with the master key', llmCalls.some((c) => c.url.endsWith('/key/generate') && c.body.metadata.company_id === 'co-1') && bizLlm.auth === 'Bearer sk-company-1' && T.nextgent_ai_keys.length === 1);
        check('the agent\'s stored instructions and its install\'s tools', bizLlm.body.messages[0].content === 'You answer for The Shop.' && bizLlm.body.tools.some((t) => t.function.name === 'send_message') && !bizLlm.body.tools.some((t) => t.function.name === 'create_row'));
        const inbound = T.business_messages.find((m) => m.direction === 'in');
        check('the text is in the business\'s inbox', inbound?.entity_slug === 'shop' && inbound.body === 'Are you open?');
        const out = T.business_messages.find((m) => m.direction === 'out');
        check('the reply goes through messages.send from the registered number', out?.status === 'sent' && sentTexts().at(-1).from === '+15550200000');
        await hook('messaging', text('+12515550122', '+15550200000', 'STOP'));
        // STOP is per business (DECISIONS.md #6): it revokes this business's
        // consent, which blocks every text it sends to that phone, and no one else's.
        check('STOP to a business number revokes that business\'s consent', T.message_consent.some((c) => c.entity_slug === 'shop' && c.phone === '+12515550122' && c.status === 'revoked'));
        check('and does not go on the platform-wide list', !T.sms_opt_outs.some((o) => o.phone === '+12515550122'), JSON.stringify(T.sms_opt_outs));
        const messages = require(path.join(ROOT, 'lib/messages.js'));
        check('so the business cannot text them, a confirmation included', (await messages.textCustomer({ slug: 'shop', to: '+12515550122', body: 'Confirmed', purpose: 'transactional' })).reason === 'consent_revoked');
        check('while another business still can', (await messages.textCustomer({ slug: 'other', to: '+12515550122', body: 'Confirmed', purpose: 'transactional' })).success);
        llmCalls.length = 0;
        await hook('messaging', text('+12515550122', '+15550200000', 'hello again'));
        check('after STOP the agent\'s reply is blocked', T.business_messages.filter((m) => m.direction === 'out').at(-1).status === 'blocked');

        console.log('\n── the platform number ──');
        await hook('messaging', text('+12515550133', '+15550000001', 'SOLD OUT fish'));
        check('staff commands still work on the platform number', sentTexts().at(-1)?.text === 'Marked sold out.' && sentTexts().at(-1).from === '+15550000001');
        await hook('messaging', text('+12515550133', '+15550000001', 'STOP'));
        check('STOP to the platform number, which texts for everyone, goes on the platform-wide list', T.sms_opt_outs.some((o) => o.phone === '+12515550133'));

        console.log('\n── a call to the concierge ──');
        telnyxCalls.length = 0;
        const action = (name) => telnyxCalls.find((c) => c.url.endsWith(`/actions/${name}`));
        await hook('voice', { event_type: 'call.initiated', payload: { call_control_id: 'cc-1', direction: 'incoming', from: '+12515550144', to: '+15550000002' } });
        check('the call is answered', !!action('answer'));
        await hook('voice', { event_type: 'call.answered', payload: { call_control_id: 'cc-1' } });
        check('the greeting is spoken', action('speak')?.body.payload === 'Hi, concierge here.');
        await hook('voice', { event_type: 'call.transcription', payload: { call_control_id: 'cc-1', transcription_data: { transcript: 'too early', is_final: true } } });
        check('speech while the agent speaks is ignored', telnyxCalls.filter((c) => c.url.endsWith('/actions/speak')).length === 1);
        await hook('voice', { event_type: 'call.speak.ended', payload: { call_control_id: 'cc-1' } });
        check('then it listens (speech gather)', action('transcription_start')?.body.transcription_tracks === 'inbound');
        await hook('voice', { event_type: 'call.transcription', payload: { call_control_id: 'cc-1', transcription_data: { transcript: 'Where can I get tacos', is_final: false } } });
        check('a partial sentence waits', telnyxCalls.filter((c) => c.url.endsWith('/actions/speak')).length === 1);
        await hook('voice', { event_type: 'call.transcription', payload: { call_control_id: 'cc-1', transcription_data: { transcript: 'Where can I get tacos?', is_final: true } } });
        const speaks = telnyxCalls.filter((c) => c.url.endsWith('/actions/speak'));
        check('a finished sentence is answered with the tools and spoken', speaks.length === 2 && /a tool/.test(speaks[1].body.payload));
        await hook('voice', { event_type: 'call.speak.ended', payload: { call_control_id: 'cc-1' } });
        check('and it listens again without restarting transcription', telnyxCalls.filter((c) => c.url.endsWith('/actions/transcription_start')).length === 1);
        await hook('voice', { event_type: 'call.hangup', payload: { call_control_id: 'cc-1', hangup_cause: 'normal_clearing' } });
        const conv = paperclip.find((p) => p.body.channel === 'voice');
        const voiceRow = T.live_conversations.find((c) => c.channel === 'voice');
        // DECISIONS #34: Paperclip gets a reference to the conversation, never
        // the conversation. The transcript stays in live_conversations.
        check('at hang-up a reference to the conversation is posted to Paperclip', conv?.url === 'https://paperclip.test/api/nextgent/conversations'
            && conv.body.companyId === 'nextgent' && conv.body.conversationId === voiceRow.id && conv.body.mode === 'concierge'
            && conv.body.startedAt === voiceRow.started_at && conv.body.endedAt === voiceRow.ended_at && conv.body.turns === 3 && conv.body.outcome === 'normal_clearing', JSON.stringify(conv?.body));
        check('the reference and nothing else: no transcript, no numbers',
            JSON.stringify(Object.keys(conv.body).sort()) === JSON.stringify(['channel', 'companyId', 'conversationId', 'endedAt', 'mode', 'outcome', 'startedAt', 'turns']), JSON.stringify(conv.body));
        check('the transcript stays here', voiceRow.transcript.map((t) => t.role).join(',') === 'agent,caller,agent' && voiceRow.from_number === '+12515550144');
        check('signed per CONTRACT §3', /^[0-9a-f]{64}$/.test(conv.headers['x-nextgent-signature']));

        console.log('\n── texts are recorded when they go quiet ──');
        const live = require(path.join(ROOT, 'lib/liveAgent.js'));
        const closed = await live.closeIdleConversations({ now: new Date(Date.now() + 31 * 60e3) });
        const smsConv = paperclip.filter((p) => p.body.channel === 'sms');
        check('idle text conversations are closed and recorded', closed.closed === 2 && smsConv.some((p) => p.body.companyId === 'nextgent') && smsConv.some((p) => p.body.companyId === 'co-1'));
        const bizRow = T.live_conversations.find((c) => c.entity_slug === 'shop');
        const bizRef = smsConv.find((p) => p.body.companyId === 'co-1')?.body;
        const thread = T.message_threads.find((t) => t.entity_slug === 'shop' && t.channel === 'sms' && t.customer_address === '+12515550122');
        check('a business text conversation\'s reference names its inbox thread', bizRef?.mode === 'business' && bizRef.conversationId === bizRow.id && !!thread && bizRef.threadId === thread.id, JSON.stringify(bizRef));
        check('a concierge one has no thread, and no reference carries a number', !('threadId' in smsConv.find((p) => p.body.companyId === 'nextgent').body)
            && !JSON.stringify(paperclip.map((p) => p.body)).includes('+1251'));

        console.log('\n── owners read their own conversations (DECISIONS #36) ──');
        const owner = async (p) => { const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/owner${p}`); return { status: r.status, body: await r.json() }; };
        const list = await owner('/conversations');
        const item = list.body?.conversations?.[0];
        check('the list is this business\'s conversations only', list.status === 200 && list.body.conversations.length === 1 && item.id === bizRow.id && T.live_conversations.length === 3, JSON.stringify(list.body));
        check('each with channel, mode, times, outcome and a turn count, no bodies',
            item.channel === 'sms' && item.mode === 'business' && item.started_at === bizRow.started_at && item.ended_at === bizRow.ended_at && item.outcome === 'idle'
            && item.turns === bizRow.transcript.length && bizRow.transcript.length > 0 && !('transcript' in item) && !('tool_calls' in item) && !JSON.stringify(item).includes('+1251'), JSON.stringify(item));
        const paged = await owner('/conversations?limit=1&offset=1');
        check('paged: limit and offset, with the total', paged.body.conversations.length === 0 && paged.body.total === 1 && list.body.total === 1, JSON.stringify(paged.body));
        const one = await owner(`/conversations/${bizRow.id}`);
        check('one conversation comes with its transcript and tool calls', one.status === 200 && one.body.conversation.id === bizRow.id
            && JSON.stringify(one.body.conversation.transcript) === JSON.stringify(bizRow.transcript) && Array.isArray(one.body.conversation.tool_calls), JSON.stringify(one.body));
        check('another business\'s (or the concierge\'s) conversation is 404', (await owner(`/conversations/${voiceRow.id}`)).status === 404 && (await owner('/conversations/no-such')).status === 404);

        console.log('\n── numbers nobody answers here ──');
        telnyxCalls.length = 0;
        await hook('voice', { event_type: 'call.initiated', payload: { call_control_id: 'cc-2', direction: 'incoming', from: '+12515550155', to: '+15559999999' } });
        check('a call to an unknown number is rejected, not answered', !!action('reject') && !action('answer'));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('live');
}
