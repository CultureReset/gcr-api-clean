// ============================================================
// TELNYX — the default telephony provider (REST API v2)
// ============================================================
//
// Messages, Call Control, number search / order / release, number lookup, and
// webhook signature checking (Ed25519 over `${timestamp}|${rawBody}` with
// TELNYX_PUBLIC_KEY). Plain fetch, no SDK, so tests can stub it.
//
// Env: TELNYX_API_KEY, TELNYX_PUBLIC_KEY, TELNYX_MESSAGING_PROFILE_ID,
// TELNYX_CONNECTION_ID (voice), PLATFORM_NUMBER (default sender),
// TELNYX_API_URL (only to override the API host), TELNYX_TTS_VOICE /
// TELNYX_TTS_LANGUAGE (what a spoken message sounds like).

const crypto = require('crypto');

const NAME = 'telnyx';
// The provider's own published API root; overridable for a proxy or sandbox.
const apiBase = () => (process.env.TELNYX_API_URL || 'https://api.telnyx.com/v2').replace(/\/+$/, '');
const WEBHOOK_TOLERANCE_SECONDS = Number(process.env.TELNYX_WEBHOOK_TOLERANCE_SECONDS || 300);

let fetchImpl = (...args) => fetch(...args);

function configured() {
    return !!process.env.TELNYX_API_KEY;
}

async function api(method, path, body) {
    if (!configured()) {
        const err = new Error('Telnyx is not configured (TELNYX_API_KEY).');
        err.code = 'not_configured';
        throw err;
    }
    const res = await fetchImpl(`${apiBase()}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
        const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `HTTP ${res.status}`;
        const err = new Error(`Telnyx ${method} ${path}: ${detail}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

/* ── messaging ────────────────────────────────────────────────────────── */

async function sendSms({ to, from, text, mediaUrls }) {
    const body = { to, text };
    const sender = from || process.env.PLATFORM_NUMBER;
    if (sender) body.from = sender;
    if (process.env.TELNYX_MESSAGING_PROFILE_ID) body.messaging_profile_id = process.env.TELNYX_MESSAGING_PROFILE_ID;
    if (Array.isArray(mediaUrls) && mediaUrls.length) body.media_urls = mediaUrls;
    if (!body.from && !body.messaging_profile_id) {
        throw Object.assign(new Error('No sender: set PLATFORM_NUMBER or TELNYX_MESSAGING_PROFILE_ID.'), { code: 'not_configured' });
    }
    const data = await api('POST', '/messages', body);
    return { provider: NAME, id: data?.data?.id || null, status: data?.data?.to?.[0]?.status || 'queued' };
}

/* ── voice (Call Control) ─────────────────────────────────────────────── */

/**
 * Dial out. Call Control is event driven: the call's progress arrives at
 * webhookUrl, and that handler decides what to say. clientState (any JSON) is
 * echoed back on every event for that call.
 */
async function placeCall({ to, from, webhookUrl, clientState, connectionId, timeoutSecs }) {
    const body = {
        to,
        from: from || process.env.PLATFORM_NUMBER,
        connection_id: connectionId || process.env.TELNYX_CONNECTION_ID,
    };
    if (!body.connection_id) throw Object.assign(new Error('TELNYX_CONNECTION_ID is not set.'), { code: 'not_configured' });
    if (!body.from) throw Object.assign(new Error('No caller id: set PLATFORM_NUMBER.'), { code: 'not_configured' });
    if (webhookUrl) body.webhook_url = webhookUrl;
    if (clientState !== undefined) body.client_state = b64(clientState);
    if (timeoutSecs) body.timeout_secs = timeoutSecs;
    const data = await api('POST', '/calls', body);
    return { provider: NAME, id: data?.data?.call_control_id || null, legId: data?.data?.call_leg_id || null };
}

/** Any Call Control action: answer, speak, gather_using_speak, hangup, transfer… */
async function callAction(callId, action, body = {}) {
    const data = await api('POST', `/calls/${encodeURIComponent(callId)}/actions/${action}`, body);
    return { provider: NAME, result: data?.data?.result || 'ok' };
}

function speak({ callId, text, clientState }) {
    const body = {
        payload: text,
        voice: process.env.TELNYX_TTS_VOICE || 'female',
        language: process.env.TELNYX_TTS_LANGUAGE || 'en-US',
    };
    if (clientState !== undefined) body.client_state = b64(clientState);
    return callAction(callId, 'speak', body);
}

const hangup = ({ callId }) => callAction(callId, 'hangup', {});

/* ── numbers ──────────────────────────────────────────────────────────── */

async function searchNumbers({ areaCode, countryCode, locality, limit = 5, features = ['sms', 'voice'] } = {}) {
    const params = new URLSearchParams();
    params.set('filter[country_code]', countryCode || process.env.TELEPHONY_NUMBER_COUNTRY || 'US');
    if (areaCode) params.set('filter[national_destination_code]', String(areaCode));
    if (locality) params.set('filter[locality]', locality);
    for (const f of features) params.append('filter[features][]', f);
    params.set('filter[limit]', String(limit));
    const data = await api('GET', `/available_phone_numbers?${params}`);
    return (data?.data || []).map((n) => ({
        phoneNumber: n.phone_number,
        region: n.region_information?.map((r) => r.region_name).filter(Boolean).join(', ') || null,
        monthlyCost: n.cost_information?.monthly_cost ?? null,
        currency: n.cost_information?.currency ?? null,
        features: (n.features || []).map((f) => f.name),
    }));
}

/**
 * Buy a number: the one asked for, or the first available matching the search.
 * It is attached to the voice connection and messaging profile from env.
 */
async function buyNumber({ phoneNumber, areaCode, countryCode } = {}) {
    let number = phoneNumber;
    if (!number) {
        const found = await searchNumbers({ areaCode, countryCode, limit: 1 });
        if (!found.length) throw Object.assign(new Error('No number available for that search.'), { status: 404 });
        number = found[0].phoneNumber;
    }
    const body = { phone_numbers: [{ phone_number: number }] };
    if (process.env.TELNYX_CONNECTION_ID) body.connection_id = process.env.TELNYX_CONNECTION_ID;
    if (process.env.TELNYX_MESSAGING_PROFILE_ID) body.messaging_profile_id = process.env.TELNYX_MESSAGING_PROFILE_ID;
    const data = await api('POST', '/number_orders', body);
    return { provider: NAME, phoneNumber: number, orderId: data?.data?.id || null, status: data?.data?.status || null };
}

async function releaseNumber({ phoneNumber, id }) {
    let numberId = id;
    if (!numberId) {
        const params = new URLSearchParams({ 'filter[phone_number]': phoneNumber });
        const data = await api('GET', `/phone_numbers?${params}`);
        numberId = data?.data?.[0]?.id;
        if (!numberId) throw Object.assign(new Error(`Not a number on this account: ${phoneNumber}`), { status: 404 });
    }
    await api('DELETE', `/phone_numbers/${encodeURIComponent(numberId)}`);
    return { provider: NAME, released: true, id: numberId };
}

/** What kind of line this is, so a code goes by text only when it can. */
async function lookupNumber(phone) {
    const data = await api('GET', `/number_lookup/${encodeURIComponent(phone)}?type=carrier`);
    const type = String(data?.data?.carrier?.type || '').toLowerCase();
    // "mobile" takes texts; "fixed line" does not; voip may or may not, and a
    // text that never arrives is worse than a call, so only mobile counts.
    return { provider: NAME, lineType: type || 'unknown', canText: type === 'mobile' };
}

/* ── webhooks ─────────────────────────────────────────────────────────── */

// SPKI DER header for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKey() {
    const raw = process.env.TELNYX_PUBLIC_KEY;
    if (!raw) return null;
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== 32) return null;
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

function rawBodyOf(req) {
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
    if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
    return null;
}

/** { ok: true } or { ok: false, reason }. */
function verifyWebhook(req, { now = Date.now() } = {}) {
    const key = publicKey();
    if (!key) return { ok: false, reason: 'TELNYX_PUBLIC_KEY is not set or not a 32-byte base64 key.' };
    const signature = req.headers['telnyx-signature-ed25519'];
    const timestamp = req.headers['telnyx-timestamp'];
    if (!signature || !timestamp || !/^\d+$/.test(String(timestamp))) return { ok: false, reason: 'Missing signature headers.' };
    if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'Signature is too old.' };
    const body = rawBodyOf(req);
    if (!body) return { ok: false, reason: 'No raw body to check.' };
    const message = Buffer.concat([Buffer.from(`${timestamp}|`), body]);
    let ok = false;
    try {
        ok = crypto.verify(null, message, key, Buffer.from(String(signature), 'base64'));
    } catch {
        ok = false;
    }
    return ok ? { ok: true } : { ok: false, reason: 'Bad signature.' };
}

/** client_state as Telnyx echoes it (base64 JSON), decoded. */
function decodeClientState(value) {
    if (!value) return null;
    try { return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')); } catch { return null; }
}

module.exports = {
    name: NAME,
    configured,
    KEY_ENV: 'TELNYX_API_KEY',
    sendSms,
    placeCall,
    callAction,
    speak,
    hangup,
    searchNumbers,
    buyNumber,
    releaseNumber,
    lookupNumber,
    verifyWebhook,
    decodeClientState,
    _setFetch: (impl) => { fetchImpl = impl; },
};
