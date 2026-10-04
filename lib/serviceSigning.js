// ============================================================
// SERVICE SIGNING — Paperclip <-> gcr-api-clean (CONTRACT §3)
// ============================================================
//
// Both services hold NEXTGENT_SERVICE_SECRET. A signed request carries:
//
//   x-nextgent-timestamp   unix seconds
//   x-nextgent-signature   hex HMAC-SHA256 of `${timestamp}.${rawBody}`
//
// Rejected when older than 300 s (either direction, so a clock running ahead
// cannot mint requests for the future) or when the signature does not match.
// The comparison is constant-time.
//
// The raw body is what was signed, so the check reads req.rawBody, which
// server.js captures in express.json's verify hook. A GET or DELETE has an
// empty body and signs `${timestamp}.`.

const crypto = require('crypto');

const TIMESTAMP_HEADER = 'x-nextgent-timestamp';
const SIGNATURE_HEADER = 'x-nextgent-signature';
const MAX_SKEW_SECONDS = 300; // fixed by the contract

const secret = () => process.env.NEXTGENT_SERVICE_SECRET || '';

function signature(timestamp, rawBody, key = secret()) {
    return crypto.createHmac('sha256', key).update(`${timestamp}.${rawBody || ''}`).digest('hex');
}

/** Headers for an outgoing signed request. */
function signHeaders(rawBody, { now = Date.now(), key = secret() } = {}) {
    const timestamp = String(Math.floor(now / 1000));
    return {
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature(timestamp, rawBody, key),
    };
}

function rawBodyOf(req) {
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
    if (typeof req.rawBody === 'string') return req.rawBody;
    return '';
}

/**
 * Check a request's signature. Returns null when it is good, or the reason it
 * is not.
 */
function verifyRequest(req, { now = Date.now(), key = secret() } = {}) {
    if (!key) return 'Service signing is not configured (NEXTGENT_SERVICE_SECRET).';
    const timestamp = String(req.headers[TIMESTAMP_HEADER] || '');
    const given = String(req.headers[SIGNATURE_HEADER] || '');
    if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(given)) return 'Missing or malformed signature.';

    const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
    if (age > MAX_SKEW_SECONDS) return 'Signature is too old.';

    const expected = Buffer.from(signature(timestamp, rawBodyOf(req), key), 'hex');
    const actual = Buffer.from(given.toLowerCase(), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return 'Bad signature.';
    return null;
}

/** Express middleware: only correctly signed requests get through. */
function serviceSigned(req, res, next) {
    const reason = verifyRequest(req);
    if (reason) {
        const status = /not configured/.test(reason) ? 503 : 401;
        return res.status(status).json({ error: reason });
    }
    req.nextgentService = true;
    return next();
}

/**
 * POST a signed JSON body to Paperclip (CONTRACT §5: receipts, conversations).
 * The base URL is PAPERCLIP_API_URL; path is e.g. '/api/nextgent/receipts'.
 */
async function signedPost(path, payload, { baseUrl = process.env.PAPERCLIP_API_URL, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error('PAPERCLIP_API_URL is not set.');
    if (!secret()) throw new Error('NEXTGENT_SERVICE_SECRET is not set.');
    const body = JSON.stringify(payload ?? {});
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signHeaders(body) },
        body,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`Paperclip ${path} answered ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

module.exports = {
    TIMESTAMP_HEADER,
    SIGNATURE_HEADER,
    MAX_SKEW_SECONDS,
    signature,
    signHeaders,
    verifyRequest,
    serviceSigned,
    signedPost,
};
