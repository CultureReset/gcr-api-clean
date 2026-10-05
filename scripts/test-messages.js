#!/usr/bin/env node
// ============================================================
// messages.send — MCP tool, owner Messages screen, the texting rules
// ============================================================
//
//     npm run test:messages
//
// In-memory database, a recording carrier and email. No credentials, no network.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    TELNYX_API_KEY: 'KEY_test',
    PLATFORM_NUMBER: '+15550000001',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const TOK_SEND = 'gcr_mcp_send-token';
const TOK_READ = 'gcr_mcp_read-token';
const TOK_LEGACY = 'gcr_mcp_legacy-token';

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', email: 'owner@shop.test', phone: '+15550100000' }, { slug: 'other', name: 'Other' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    entity_owners: [],
    business_mcp_tokens: [
        { id: 't1', entity_slug: 'shop', scope: 'write', token_hash: sha(TOK_SEND), permissions: ['messages:send', 'menu:read'], install_id: 'in-agent' },
        { id: 't2', entity_slug: 'shop', scope: 'read', token_hash: sha(TOK_READ), permissions: ['menu:read'] },
        { id: 't3', entity_slug: 'shop', scope: 'write', token_hash: sha(TOK_LEGACY), permissions: null },
    ],
    business_phone_numbers: [{ entity_slug: 'shop', phone_number: '+15550200000', status: 'active', registration_status: 'pending', provider: 'telnyx' }],
    message_threads: [
        // A visitor's submission through an installed app (DECISIONS #48), as routes/app-data.js records it.
        { id: 'th-app', entity_slug: 'shop', channel: 'app', customer_address: 'vis@example.test', mode: 'agent', last_message_at: '2026-01-01T00:00:00Z' },
    ],
    business_messages: [
        { id: 'm-app', entity_slug: 'shop', thread_id: 'th-app', channel: 'app', direction: 'in', customer_address: 'vis@example.test', body: 'Do you cater?\nname: Pat', status: 'received', author: 'customer', install_id: 'in-song', created_at: '2026-01-01T00:00:00Z' },
    ],
    entity_modules: [{ id: 1, entity_slug: 'shop', module_key: 'enquiry-form', managed_by: 'paperclip', install_id: 'in-song', enabled: true, settings: { manifest: { name: 'Enquiry Form' } } }],
    // A booking opt-in's yes, as the opt-in route records it (and as
    // sql/nextgent_consent_fold.sql copied the older ones): message_consent is
    // the only place consent is read from.
    message_consent: [{ entity_slug: 'shop', channel: 'sms', phone: '+12515550177', status: 'granted', source: 'booking_opt_in' }],
    booking_opt_ins: [{ entity_slug: 'shop', phone: '251-555-0177', sms_consent: true }],
    sms_opt_outs: [{ phone: '+12515550166' }],
    sms_log: [],
    owner_notify_settings: [],
    owner_notifications: [],
} }, );
inject(path.join(ROOT, 'db.js'), db);
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true, id: 'em-1' }; } });
let session = { entitySlug: 'shop', authVia: 'paperclip', paperclip: { userId: 'pc-1' } };
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, res, next) => (session ? (Object.assign(req, session), next()) : res.status(401).json({ error: 'no' })),
    resolveSessionSlug: async () => ({ reason: 'no sessions here' }),
});

const carrier = [];
require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
    carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'msg-1' } }) };
});

const { check, done } = checker();
const app = express();
app.use(express.json());
// The one Messages API (the /api/business/messages copy was folded into it).
app.use('/api/owner', require(path.join(ROOT, 'routes/owner.js')));
app.use('/api/mcp', require(path.join(ROOT, 'routes/mcp.js')));
const server = app.listen(0, run);
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
async function call(method, p, body, token) {
    const res = await fetch(url(p), { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const rpc = (token, method, params) => call('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method, params }, token);

async function run() {
    try {
        console.log('\n── who sees messages.send ──');
        const names = async (tok) => ((await rpc(tok, 'tools/list')).body.result?.tools || []).map((t) => t.name);
        check('a token with messages:send sees send_message', (await names(TOK_SEND)).includes('send_message'));
        check('a token without it does not', !(await names(TOK_READ)).includes('send_message'));
        check('a legacy write token does not either', !(await names(TOK_LEGACY)).includes('send_message'));
        const refused = await rpc(TOK_READ, 'tools/call', { name: 'send_message', arguments: { channel: 'email', to: 'a@b.test', body: 'hi' } });
        check('calling it without the permission is refused', refused.body.error?.code === -32601 || refused.body.result?.isError);

        console.log('\n── email ──');
        const em = await rpc(TOK_SEND, 'tools/call', { name: 'send_message', arguments: { channel: 'email', to: 'Guest@Example.test', subject: 'Thanks', body: 'See you soon <3' } });
        const sc = em.body.result?.structuredContent;
        check('an email goes out', sc?.status === 'sent', JSON.stringify(em.body));
        check('through utils/email with the business as Reply-To, body escaped', emails[0]?.to === 'guest@example.test' && emails[0].replyTo === 'owner@shop.test' && emails[0].html.includes('&lt;3'));
        const rec = T.business_messages.find((m) => m.id === sc.message_id);
        check('recorded for the token\'s business, by an agent, with its install', rec.entity_slug === 'shop' && rec.author === 'agent' && rec.install_id === 'in-agent');

        console.log('\n── texts: registered number and consent ──');
        const t1 = await rpc(TOK_SEND, 'tools/call', { name: 'send_message', arguments: { channel: 'sms', to: '251-555-0177', body: 'Your table is ready' } });
        check('no text while the number\'s registration is pending', t1.body.result.structuredContent.status === 'blocked' && /registration_pending/.test(t1.body.result.structuredContent.reason));
        check('and nothing reached the carrier', !carrier.length);
        T.business_phone_numbers[0].registration_status = 'approved';
        const t2 = await rpc(TOK_SEND, 'tools/call', { name: 'send_message', arguments: { channel: 'sms', to: '251-555-0177', body: 'Your table is ready' } });
        check('approved number + opt-in consent: sent', t2.body.result.structuredContent.status === 'sent', JSON.stringify(t2.body.result));
        check('from the business\'s registered number', carrier.at(-1)?.body.from === '+15550200000' && carrier.at(-1).body.to === '+12515550177');
        const t3 = await rpc(TOK_SEND, 'tools/call', { name: 'send_message', arguments: { channel: 'sms', to: '251-555-0188', body: 'Hello' } });
        check('no consent on file: blocked', t3.body.result.structuredContent.status === 'blocked' && t3.body.result.structuredContent.reason === 'no_consent');
        const t4 = await rpc(TOK_SEND, 'tools/call', { name: 'send_message', arguments: { channel: 'sms', to: '251-555-0166', body: 'Hello' } });
        check('opted out: blocked', t4.body.result.structuredContent.reason === 'opted_out');

        console.log('\n── owner Messages screen ──');
        const consent = await call('POST', '/api/owner/messages/consent', { phone: '251-555-0188', text: 'Said yes at the counter' });
        check('the owner records consent', consent.status === 201 && T.message_consent[0].entity_slug === 'shop');
        const t5 = await call('POST', '/api/owner/messages', { channel: 'sms', to: '251-555-0188', body: 'Thanks for coming!' });
        check('then the owner can text them', t5.body.message?.status === 'sent', JSON.stringify(t5.body));
        const held = await call('POST', '/api/owner/messages', { channel: 'email', to: 'x@y.test', subject: 'Draft', body: 'v1', hold: true });
        check('a held message waits for approval', held.body.message.status === 'pending_approval');
        const edited = await call('PATCH', `/api/owner/messages/${held.body.message.id}`, { body: 'v2' });
        check('it can be edited before it goes', edited.body.message.body === 'v2' && edited.body.message.edited_at);
        const go = await call('POST', `/api/owner/messages/${held.body.message.id}/send`);
        check('and sent', go.body.message.status === 'sent' && emails.at(-1).html.includes('v2'));
        const again = await call('PATCH', `/api/owner/messages/${held.body.message.id}`, { body: 'v3' });
        check('a sent message cannot be edited', again.status === 409);

        const inbox = await call('GET', '/api/owner/messages');
        const thread = inbox.body.threads.find((t) => t.customer_address === '+12515550188');
        check('the inbox lists threads with their last message', thread?.last_message?.body === 'Thanks for coming!');

        console.log('\n── a submission through an app shows where it came from (DECISIONS #48) ──');
        const appThread = inbox.body.threads.find((t) => t.id === 'th-app');
        check('the inbox carries source: { installId, appKey } on an app thread', appThread?.channel === 'app' && appThread.source?.installId === 'in-song' && appThread.source.appKey === 'enquiry-form', JSON.stringify(appThread));
        check('and no source on a text thread', thread.source === undefined || thread.source === null, JSON.stringify(thread.source));
        const list = await call('GET', '/api/owner/messages/threads');
        const listed = list.body.threads.find((t) => t.id === 'th-app');
        check('the threads list says the same', listed?.source?.installId === 'in-song' && listed.source.appKey === 'enquiry-form' && listed.contact === 'vis@example.test', JSON.stringify(listed));
        check('no label text is added server-side (the owner confirms the wording)', !Object.values(listed || {}).some((v) => typeof v === 'string' && /via /i.test(v)), JSON.stringify(listed));
        const one = await call('GET', '/api/owner/messages/threads/th-app');
        check('and so does the thread itself', one.body.thread?.source?.appKey === 'enquiry-form' && one.body.messages[0].text === 'Do you cater?\nname: Pat', JSON.stringify(one.body.thread));
        await call('POST', `/api/owner/messages/threads/${thread.id}/takeover`, { on: true });
        const t6 = await rpc(TOK_SEND, 'tools/call', { name: 'send_message', arguments: { channel: 'sms', to: '251-555-0188', body: 'Agent here' } });
        check('after the owner takes over, an agent is blocked', t6.body.result.structuredContent.reason === 'owner_has_taken_over');
        const t7 = await call('POST', '/api/owner/messages', { channel: 'sms', to: '251-555-0188', body: 'Owner here' });
        check('the owner still can', t7.body.message.status === 'sent');
        const conv = await call('GET', `/api/owner/messages/threads/${thread.id}`);
        check('the thread reads in order, the refused one included', conv.body.messages.map((m) => m.text).join('|') === 'Hello|Thanks for coming!|Agent here|Owner here', conv.body.messages.map((m) => m.text).join('|'));

        session = { entitySlug: 'other', authVia: 'paperclip' };
        const foreign = await call('GET', `/api/owner/messages/threads/${thread.id}`);
        check('another business cannot read the thread', foreign.status === 404);
        const foreignSend = await call('POST', `/api/owner/messages/${held.body.message.id}/send`);
        check('or send its messages', foreignSend.status === 404);
        session = { entitySlug: 'shop', authVia: 'paperclip' };

        const approval = T.owner_notifications;
        check('the held message told the owner it needs approval', approval.some((n) => n.kind === 'approval'));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('messages');
}
