// ============================================================
// LIVE CALLS AND TEXTS — Telnyx inbound webhooks (CONTRACT §7)
// ============================================================
//
//   POST /api/telephony/telnyx/messaging   inbound texts
//   POST /api/telephony/telnyx/voice       Call Control events for inbound calls
//
// Every request must carry Telnyx's Ed25519 signature (TELNYX_PUBLIC_KEY);
// anything else is refused before it is read. Each webhook is acknowledged
// first and then handled, because Telnyx retries a slow answer.
//
// Who answers is decided by the number called (lib/liveAgent.js): the
// concierge number, a business's Phone Agent number, or — for texts — the
// platform number's own handler (routes/sms.js: staff commands, sign-up).
//
// Voice runs as a loop on Call Control: answer → speak the greeting → listen
// (transcription_start, speech in) → on a final transcript, answer through
// LiteLLM with the agent's tools → speak → listen again, until hang-up. The
// state lives in live_conversations, keyed by the call.
//
// THIS MUST RUN ON THE ALWAYS-ON SERVER, NOT ON VERCEL: a call is a minutes-
// long exchange of webhooks and model calls, and the work after the
// acknowledgement would be frozen by a serverless function (README.md).

const express = require('express');
const supabase = require('../db');
const telephony = require('../lib/telephony');
const live = require('../lib/liveAgent');
const messages = require('../lib/messages');
const { envStr } = require('../lib/env');

const router = express.Router();

function verified(req, res) {
    const check = telephony.verifyWebhook(req, { provider: 'telnyx' });
    if (!check.ok) {
        res.status(401).json({ error: check.reason });
        return false;
    }
    return true;
}

const KEYWORDS = {
    stop: /^(stop|stopall|unsubscribe|cancel|end|quit)$/i,
    start: /^(start|unstop|yes)$/i,
    help: /^(help|info)$/i,
};

/* ── texts ────────────────────────────────────────────────────────────── */

async function onText({ from, to, text, messageId }) {
    const customer = telephony.normalizePhone(from);
    const ours = telephony.normalizePhone(to);
    if (!customer || !ours) return { handled: 'ignored' };
    const body = String(text || '').trim();

    // Opt-out and opt-in words apply to every number, before anything answers.
    // STOP is per business: to a business's number it revokes that business's
    // consent (lib/messages.js reads the revoked row for every purpose, so its
    // confirmations stop too) and touches no other business. To the platform
    // number, which texts for everyone, it goes on the platform-wide list.
    const { numberRow } = require('../lib/phoneAgent');
    const number = await numberRow(ours);
    if (KEYWORDS.stop.test(body)) {
        if (number) await messages.recordConsent(number.entity_slug, customer, { granted: false, source: 'sms_keyword', text: body }).catch(() => {});
        else await supabase.from('sms_opt_outs').insert({ phone: customer }).then(() => {}, () => {});
        return { handled: 'stop' };
    }
    if (number && KEYWORDS.start.test(body)) {
        await messages.recordConsent(number.entity_slug, customer, { granted: true, source: 'sms_keyword', text: body }).catch(() => {});
    }
    if (KEYWORDS.help.test(body)) {
        const help = envStr('SMS_HELP_REPLY');
        if (help) await telephony.sendSms({ to: customer, from: ours, text: help }).catch(() => {});
        return { handled: 'help' };
    }

    const ctx = await live.contextFor(ours);
    if (!ctx) {
        // The platform number: staff commands, QR attribution, tourist sign-up.
        const { handlePlatformInbound } = require('./sms');
        const { reply } = await handlePlatformInbound({ from: customer, body });
        if (reply) await telephony.sendSms({ to: customer, from: ours, text: reply });
        return { handled: 'platform' };
    }

    if (ctx.mode === 'business') {
        const rec = await messages.recordInbound({ slug: ctx.slug, channel: 'sms', from: customer, to: ours, body });
        // The owner took this conversation over: they answer, not the agent.
        if (rec?.thread?.mode === 'owner') return { handled: 'owner' };
    }

    let row = await live.openTextConversation(customer, ours);
    if (!row) row = await live.openConversation({ ctx, channel: 'sms', from: customer, to: ours, providerRef: messageId ? `sms:${messageId}` : null });
    const { reply } = await live.converse(ctx, row, body);
    if (!reply) return { handled: 'no_reply' };

    if (ctx.mode === 'business') {
        // Through messages.send: from the registered number only, opt-outs kept.
        const msg = await messages.sendMessage({ slug: ctx.slug, channel: 'sms', to: customer, body: reply, author: 'agent', inReplyTo: true });
        return { handled: 'business', status: msg.status, reason: msg.status_reason || null };
    }
    await telephony.sendSms({ to: customer, from: ours, text: reply });
    return { handled: 'concierge' };
}

router.post('/messaging', async (req, res) => {
    if (!verified(req, res)) return;
    res.status(200).json({ received: true });
    const data = req.body?.data || {};
    if (data.event_type !== 'message.received') return;
    const p = data.payload || {};
    try {
        await onText({
            from: p.from?.phone_number,
            to: (Array.isArray(p.to) ? p.to[0]?.phone_number : p.to) || null,
            text: p.text,
            messageId: p.id,
        });
    } catch (err) {
        console.error('[telnyx/messaging]', err.message);
    }
});

/* ── voice ────────────────────────────────────────────────────────────── */

function transcriptionBody() {
    const body = { transcription_tracks: 'inbound' };
    const engine = envStr('TELNYX_TRANSCRIPTION_ENGINE');
    const lang = envStr('TELNYX_TRANSCRIPTION_LANGUAGE') || envStr('TELNYX_TTS_LANGUAGE');
    if (engine) body.transcription_engine = engine;
    if (lang) body.language = lang;
    return body;
}

async function say(callId, text, state) {
    await live.saveConversation(state.row, { state: 'speaking' });
    await telephony.speak({ callId, text, clientState: { conv: state.row.id } });
}

async function onCallEvent(event, payload) {
    const callId = payload.call_control_id;
    if (!callId) return { handled: 'ignored' };

    if (event === 'call.initiated') {
        if (payload.direction && payload.direction !== 'incoming') return { handled: 'outgoing' };
        const ctx = await live.contextFor(payload.to);
        if (!ctx) {
            // Not a number a live agent answers here.
            await telephony.callAction(callId, 'reject', { cause: 'CALL_REJECTED' }).catch(() => {});
            return { handled: 'rejected' };
        }
        const row = await live.openConversation({ ctx, channel: 'voice', from: telephony.normalizePhone(payload.from), to: ctx.number, providerRef: `call:${callId}` });
        await telephony.callAction(callId, 'answer', { client_state: Buffer.from(JSON.stringify({ conv: row.id })).toString('base64') });
        return { handled: 'answered' };
    }

    const row = await live.findByRef(`call:${callId}`);
    if (!row) return { handled: 'unknown_call' };

    if (event === 'call.hangup') {
        await live.closeConversation(row, { outcome: payload.hangup_cause || 'hangup' });
        return { handled: 'closed' };
    }
    if (row.status === 'closed') return { handled: 'closed' };

    const ctx = await live.contextFor(row.to_number);
    if (!ctx) {
        await telephony.hangup({ callId }).catch(() => {});
        return { handled: 'gone' };
    }

    if (event === 'call.answered') {
        const greeting = ctx.greeting || (ctx.businessName ? ctx.businessName : null);
        if (greeting) {
            const transcript = [...(row.transcript || []), { role: 'agent', text: greeting, at: new Date().toISOString() }];
            const saved = await live.saveConversation(row, { transcript });
            await say(callId, greeting, { row: saved });
        } else {
            await telephony.callAction(callId, 'transcription_start', transcriptionBody());
            await live.saveConversation(row, { state: 'listening', transcribing: true });
        }
        return { handled: 'greeted' };
    }

    if (event === 'call.speak.ended') {
        if (!row.transcribing) {
            await telephony.callAction(callId, 'transcription_start', transcriptionBody());
            await live.saveConversation(row, { state: 'listening', transcribing: true });
        } else {
            await live.saveConversation(row, { state: 'listening' });
        }
        return { handled: 'listening' };
    }

    if (event === 'call.transcription') {
        const t = payload.transcription_data || {};
        const text = String(t.transcript || '').trim();
        // Only a finished sentence, and only while it is the caller's turn.
        if (!text || t.is_final === false || row.state !== 'listening') return { handled: 'partial' };
        const thinking = await live.saveConversation(row, { state: 'thinking' });
        const { reply, conversation } = await live.converse(ctx, thinking, text);
        if (reply) await say(callId, reply, { row: conversation });
        else await live.saveConversation(conversation, { state: 'listening' });
        return { handled: 'answered_turn' };
    }

    return { handled: 'ignored' };
}

router.post('/voice', async (req, res) => {
    if (!verified(req, res)) return;
    res.status(200).json({ received: true });
    const data = req.body?.data || {};
    try {
        await onCallEvent(data.event_type, data.payload || {});
    } catch (err) {
        console.error('[telnyx/voice]', data.event_type, err.message);
    }
});

module.exports = router;
module.exports.onText = onText;
module.exports.onCallEvent = onCallEvent;
