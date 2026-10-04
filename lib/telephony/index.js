// ============================================================
// TELEPHONY — one module for texts, calls and numbers (CONTRACT §7)
// ============================================================
//
// Every text and call this API makes goes through here; nothing else talks to
// a carrier. TELEPHONY_PROVIDER picks the provider:
//
//   telnyx   the default (lib/telephony/telnyx.js)
//   twilio   the legacy path, kept working, off unless chosen
//
// The interface is the same whichever is live:
//
//   sendSms({ to, from?, text, mediaUrls? })          -> { provider, id, status }
//   placeCall({ to, from?, say?, webhookUrl?, clientState? }) -> { provider, id }
//   speak({ callId, text, clientState? })              Telnyx Call Control only
//   hangup({ callId })
//   callAction(callId, action, body)                   Telnyx Call Control only
//   searchNumbers({ areaCode?, countryCode?, limit? }) -> [{ phoneNumber, … }]
//   buyNumber({ phoneNumber? | areaCode? })            -> { provider, phoneNumber, orderId }
//   releaseNumber({ phoneNumber | id })                -> { provider, released }
//   lookupNumber(phone)                                -> { provider, lineType, canText }
//   verifyWebhook(req, { provider? })                  -> { ok, reason? }
//
// `from` defaults to the provider's platform sender (PLATFORM_NUMBER for
// Telnyx, TWILIO_PHONE_NUMBER for Twilio). Numbers are E.164; normalizePhone
// below turns what a person typed into one.
//
// `say` on placeCall speaks a short message to whoever answers and hangs up
// (claim codes). On Telnyx that runs through the Call Control webhook at
// /api/telephony/telnyx/say (routes/telephony-say.js); the live voice and
// messaging handlers are separate and built on callAction/speak.

const telnyx = require('./telnyx');
const twilio = require('./twilio');
const { normalizePhone, phoneHint } = require('./phone');

const PROVIDERS = { telnyx, twilio };

function providerName() {
    const name = String(process.env.TELEPHONY_PROVIDER || 'telnyx').toLowerCase();
    return PROVIDERS[name] ? name : 'telnyx';
}

function provider(name = providerName()) {
    return PROVIDERS[name] || telnyx;
}

const unsupported = (what) => {
    const err = new Error(`${what} is not available on the ${providerName()} provider.`);
    err.code = 'unsupported';
    return err;
};

function requireNumber(value, label) {
    const e164 = normalizePhone(value);
    if (!e164) throw Object.assign(new Error(`${label} is not a phone number: ${value}`), { code: 'invalid_phone', status: 400 });
    return e164;
}

/** Where Telnyx posts Call Control events for a `say` call. */
function sayWebhookUrl() {
    if (process.env.TELNYX_SAY_WEBHOOK_URL) return process.env.TELNYX_SAY_WEBHOOK_URL;
    const base = process.env.API_BASE_URL;
    return base ? `${base.replace(/\/+$/, '')}/api/telephony/telnyx/say` : null;
}

async function sendSms({ to, from, text, mediaUrls } = {}) {
    if (!text) throw Object.assign(new Error('Nothing to send.'), { status: 400 });
    return provider().sendSms({
        to: requireNumber(to, 'to'),
        from: from ? requireNumber(from, 'from') : undefined,
        text: String(text),
        mediaUrls,
    });
}

async function placeCall({ to, from, say, webhookUrl, clientState, connectionId, timeoutSecs } = {}) {
    const p = provider();
    const args = {
        to: requireNumber(to, 'to'),
        from: from ? requireNumber(from, 'from') : undefined,
    };
    if (p.name === 'twilio') return p.placeCall({ ...args, say, webhookUrl });

    if (say) {
        const hook = webhookUrl || sayWebhookUrl();
        if (!hook) throw Object.assign(new Error('Set API_BASE_URL or TELNYX_SAY_WEBHOOK_URL so a spoken call can be driven.'), { code: 'not_configured' });
        return p.placeCall({ ...args, webhookUrl: hook, clientState: { ...(clientState || {}), say: String(say) }, connectionId, timeoutSecs });
    }
    return p.placeCall({ ...args, webhookUrl, clientState, connectionId, timeoutSecs });
}

function speak(args) {
    const p = provider();
    if (!p.speak) throw unsupported('speak');
    return p.speak(args);
}

function hangup(args) {
    return provider().hangup(args);
}

function callAction(callId, action, body) {
    const p = provider();
    if (!p.callAction) throw unsupported('callAction');
    return p.callAction(callId, action, body);
}

const searchNumbers = (args) => provider().searchNumbers(args || {});

function buyNumber(args = {}) {
    const p = provider();
    return p.buyNumber({ ...args, phoneNumber: args.phoneNumber ? requireNumber(args.phoneNumber, 'phoneNumber') : undefined });
}

function releaseNumber(args = {}) {
    const p = provider();
    return p.releaseNumber({ ...args, phoneNumber: args.phoneNumber ? requireNumber(args.phoneNumber, 'phoneNumber') : undefined });
}

const lookupNumber = (phone) => provider().lookupNumber(requireNumber(phone, 'phone'));

/** Check an inbound webhook's signature with the provider that sent it. */
function verifyWebhook(req, { provider: name } = {}) {
    return provider(name || providerName()).verifyWebhook(req);
}

const isConfigured = () => provider().configured();

module.exports = {
    providerName,
    provider,
    isConfigured,
    sendSms,
    placeCall,
    speak,
    hangup,
    callAction,
    searchNumbers,
    buyNumber,
    releaseNumber,
    lookupNumber,
    verifyWebhook,
    decodeClientState: telnyx.decodeClientState,
    normalizePhone,
    phoneHint,
};
