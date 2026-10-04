// ============================================================
// TWILIO — the legacy telephony provider (off unless TELEPHONY_PROVIDER=twilio)
// ============================================================
//
// What utils/sms.js used to do inline, moved behind the same interface as
// Telnyx so nothing else in the API knows which provider is live. Plain REST
// over fetch (form-encoded, basic auth) rather than the SDK, so it can be
// tested without network.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (default
// sender), TWILIO_API_URL / TWILIO_LOOKUP_URL (only to override the hosts),
// TWILIO_WEBHOOK_BASE_URL (the public origin Twilio signs webhook URLs with).

const crypto = require('crypto');

const NAME = 'twilio';
// The provider's own published API roots; overridable for a proxy or sandbox.
const apiBase = () => (process.env.TWILIO_API_URL || 'https://api.twilio.com/2010-04-01').replace(/\/+$/, '');
const lookupBase = () => (process.env.TWILIO_LOOKUP_URL || 'https://lookups.twilio.com/v2').replace(/\/+$/, '');

let fetchImpl = (...args) => fetch(...args);

const configured = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

async function api(method, url, form) {
    if (!configured()) {
        throw Object.assign(new Error('Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).'), { code: 'not_configured' });
    }
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const init = { method, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } };
    if (form) {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) {
            if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
            else if (v !== undefined && v !== null) body.set(k, String(v));
        }
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = body.toString();
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`Twilio ${method}: ${data?.message || `HTTP ${res.status}`}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

const account = () => `${apiBase()}/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID || '')}`;

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function sendSms({ to, from, text, mediaUrls }) {
    const sender = from || process.env.TWILIO_PHONE_NUMBER;
    if (!sender) throw Object.assign(new Error('No sender: set TWILIO_PHONE_NUMBER.'), { code: 'not_configured' });
    const data = await api('POST', `${account()}/Messages.json`, { To: to, From: sender, Body: text, MediaUrl: mediaUrls });
    return { provider: NAME, id: data?.sid || null, status: data?.status || 'queued' };
}

/**
 * Dial out. `say` speaks a message and hangs up (TwiML inline); otherwise
 * webhookUrl is fetched for instructions, as Twilio does.
 */
async function placeCall({ to, from, say, webhookUrl }) {
    const sender = from || process.env.TWILIO_PHONE_NUMBER;
    if (!sender) throw Object.assign(new Error('No caller id: set TWILIO_PHONE_NUMBER.'), { code: 'not_configured' });
    const form = { To: to, From: sender };
    if (say) form.Twiml = `<Response><Say>${escapeXml(say)}</Say><Pause length="1"/><Say>${escapeXml(say)}</Say></Response>`;
    else if (webhookUrl) form.Url = webhookUrl;
    else throw new Error('placeCall needs say or webhookUrl.');
    const data = await api('POST', `${account()}/Calls.json`, form);
    return { provider: NAME, id: data?.sid || null };
}

async function hangup({ callId }) {
    await api('POST', `${account()}/Calls/${encodeURIComponent(callId)}.json`, { Status: 'completed' });
    return { provider: NAME, result: 'ok' };
}

async function searchNumbers({ areaCode, countryCode, limit = 5 } = {}) {
    const params = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: String(limit) });
    if (areaCode) params.set('AreaCode', String(areaCode));
    const country = countryCode || process.env.TELEPHONY_NUMBER_COUNTRY || 'US';
    const data = await api('GET', `${account()}/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?${params}`);
    return (data?.available_phone_numbers || []).map((n) => ({
        phoneNumber: n.phone_number,
        region: [n.locality, n.region].filter(Boolean).join(', ') || null,
        monthlyCost: null,
        currency: null,
        features: Object.entries(n.capabilities || {}).filter(([, v]) => v).map(([k]) => k.toLowerCase()),
    }));
}

async function buyNumber({ phoneNumber, areaCode, countryCode } = {}) {
    let number = phoneNumber;
    if (!number) {
        const found = await searchNumbers({ areaCode, countryCode, limit: 1 });
        if (!found.length) throw Object.assign(new Error('No number available for that search.'), { status: 404 });
        number = found[0].phoneNumber;
    }
    const data = await api('POST', `${account()}/IncomingPhoneNumbers.json`, { PhoneNumber: number });
    return { provider: NAME, phoneNumber: number, orderId: data?.sid || null, status: 'active' };
}

async function releaseNumber({ phoneNumber, id }) {
    let sid = id;
    if (!sid) {
        const data = await api('GET', `${account()}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: phoneNumber })}`);
        sid = data?.incoming_phone_numbers?.[0]?.sid;
        if (!sid) throw Object.assign(new Error(`Not a number on this account: ${phoneNumber}`), { status: 404 });
    }
    await api('DELETE', `${account()}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`);
    return { provider: NAME, released: true, id: sid };
}

async function lookupNumber(phone) {
    const data = await api('GET', `${lookupBase()}/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`);
    const type = String(data?.line_type_intelligence?.type || '').toLowerCase();
    return { provider: NAME, lineType: type || 'unknown', canText: type === 'mobile' };
}

/**
 * X-Twilio-Signature: base64 HMAC-SHA1 of the full URL followed by each POST
 * parameter's name and value, sorted by name.
 */
function verifyWebhook(req) {
    const token = process.env.TWILIO_AUTH_TOKEN;
    const base = process.env.TWILIO_WEBHOOK_BASE_URL;
    if (!token || !base) return { ok: false, reason: 'TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_BASE_URL are required to check Twilio webhooks.' };
    const given = String(req.headers['x-twilio-signature'] || '');
    if (!given) return { ok: false, reason: 'Missing signature header.' };
    const url = `${base.replace(/\/+$/, '')}${req.originalUrl || req.url || ''}`;
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
    const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'Bad signature.' };
}

module.exports = {
    name: NAME,
    configured,
    KEY_ENV: 'TWILIO_AUTH_TOKEN',
    sendSms,
    placeCall,
    hangup,
    searchNumbers,
    buyNumber,
    releaseNumber,
    lookupNumber,
    verifyWebhook,
    _setFetch: (impl) => { fetchImpl = impl; },
};
