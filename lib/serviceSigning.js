// ============================================================
// SERVICE SIGNING — Paperclip <-> gcr-api-clean (CONTRACT §3)
// ============================================================
//
// Both services hold NEXTGENT_SERVICE_SECRET. A signed request carries:
//
//   x-nextgent-timestamp   unix seconds
//   x-nextgent-nonce       random, at least 16 bytes as hex, never reused
//   x-nextgent-signature   hex HMAC-SHA256 of the signed string
//
// The signed string binds the request itself, not only its body, so a
// signature captured on one call cannot be presented on another:
//
//   `${timestamp}\n${nonce}\n${METHOD}\n${pathname}\n${query}\n${sha256hex(rawBody)}`
//
// METHOD upper-case; pathname without host; query the raw query string without
// its leading "?" ('' when there is none); the body hash of '' for no body.
//
// Rejected when older than 300 s (either direction, so a clock running ahead
// cannot mint requests for the future), when the nonce was already seen
// inside that window, or when the signature does not match. The comparison
// is constant-time. Seen nonces live in this process's memory; on more than
// one instance a shared store is needed for the replay check to hold across
// them.
//
// The raw body is what was signed, so the check reads req.rawBody, which
// server.js captures in express.json's verify hook.
//
// signature(timestamp, rawBody, key) — `${timestamp}.${rawBody}` — is a
// different thing: Paperclip's routine webhook format, used by the automation
// agent step (lib/automationEngine.js) and checked by Paperclip's routine
// service. It is kept here because it is one HMAC-SHA256 and nowhere else.

const crypto = require('crypto');

const TIMESTAMP_HEADER = 'x-nextgent-timestamp';
const NONCE_HEADER = 'x-nextgent-nonce';
const SIGNATURE_HEADER = 'x-nextgent-signature';
const MAX_SKEW_SECONDS = 300; // fixed by the contract
const NONCE_BYTES = 16;

const secret = () => process.env.NEXTGENT_SERVICE_SECRET || '';
const sha256hex = (s) => crypto.createHash('sha256').update(s || '').digest('hex');

/** Paperclip's routine webhook HMAC: `${timestamp}.${rawBody}` (see header). */
function signature(timestamp, rawBody, key = secret()) {
    return crypto.createHmac('sha256', key).update(`${timestamp}.${rawBody || ''}`).digest('hex');
}

/** The string a service request's signature is over. */
function signedString({ timestamp, nonce, method, pathname, query, rawBody }) {
    return [
        String(timestamp),
        String(nonce),
        String(method || 'GET').toUpperCase(),
        String(pathname || '/'),
        String(query || ''),
        sha256hex(typeof rawBody === 'string' ? rawBody : (rawBody ? rawBody.toString('utf8') : '')),
    ].join('\n');
}

/** Hex HMAC-SHA256 of signedString(parts). */
function requestSignature(parts, key = secret()) {
    return crypto.createHmac('sha256', key).update(signedString(parts)).digest('hex');
}

/** pathname and raw query (no "?") out of an absolute URL or a path. */
function splitUrl(url) {
    const u = new URL(String(url || '/'), 'http://localhost');
    return { pathname: u.pathname, query: u.search.replace(/^\?/, '') };
}

/**
 * Headers for an outgoing signed request.
 * @param {object} o  { method, url (absolute or a path, with its query), rawBody }
 */
function signHeaders({ method, url, rawBody } = {}, { now = Date.now(), key = secret(), nonce = crypto.randomBytes(NONCE_BYTES).toString('hex') } = {}) {
    const timestamp = String(Math.floor(now / 1000));
    const { pathname, query } = splitUrl(url);
    return {
        [TIMESTAMP_HEADER]: timestamp,
        [NONCE_HEADER]: nonce,
        [SIGNATURE_HEADER]: requestSignature({ timestamp, nonce, method, pathname, query, rawBody }, key),
    };
}

function rawBodyOf(req) {
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
    if (typeof req.rawBody === 'string') return req.rawBody;
    return '';
}

/* ── seen nonces (this process) ───────────────────────────────────────── */

const seenNonces = new Map(); // nonce -> unix second after which it can no longer be presented

function pruneNonces(nowSec) {
    for (const [nonce, until] of seenNonces) if (until < nowSec) seenNonces.delete(nonce);
}

/**
 * Check a request's signature. Returns null when it is good, or the reason it
 * is not. Reads req.method and req.originalUrl (the path as requested, with
 * its query), and req.rawBody.
 */
function verifyRequest(req, { now = Date.now(), key = secret() } = {}) {
    if (!key) return 'Service signing is not configured (NEXTGENT_SERVICE_SECRET).';
    const timestamp = String(req.headers[TIMESTAMP_HEADER] || '');
    const nonce = String(req.headers[NONCE_HEADER] || '').toLowerCase();
    const given = String(req.headers[SIGNATURE_HEADER] || '');
    if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{32,128}$/.test(nonce) || !/^[0-9a-f]{64}$/i.test(given)) {
        return 'Missing or malformed signature.';
    }

    const nowSec = Math.floor(now / 1000);
    const age = Math.abs(nowSec - Number(timestamp));
    if (age > MAX_SKEW_SECONDS) return 'Signature is too old.';

    pruneNonces(nowSec);
    if (seenNonces.has(nonce)) return 'Replayed request (nonce already seen).';

    const { pathname, query } = splitUrl(req.originalUrl || req.url || '/');
    const expected = Buffer.from(requestSignature({ timestamp, nonce, method: req.method, pathname, query, rawBody: rawBodyOf(req) }, key), 'hex');
    const actual = Buffer.from(given.toLowerCase(), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return 'Bad signature.';

    // Good: this nonce is spent for as long as its timestamp could be accepted.
    seenNonces.set(nonce, Number(timestamp) + MAX_SKEW_SECONDS);
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
    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signHeaders({ method: 'POST', url, rawBody: body }) },
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
    NONCE_HEADER,
    SIGNATURE_HEADER,
    MAX_SKEW_SECONDS,
    signature,
    signedString,
    requestSignature,
    signHeaders,
    verifyRequest,
    serviceSigned,
    signedPost,
    _resetNonces: () => seenNonces.clear(),
};
