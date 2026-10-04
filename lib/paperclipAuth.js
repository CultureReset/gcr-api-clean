// ============================================================
// PAPERCLIP AUTH — the business token a screen gets from Paperclip (CONTRACT §1)
// ============================================================
//
// Paperclip signs a short-lived JWT for one company and publishes its public
// keys as a JWKS. This file checks such a token and nothing else:
//
//   header   alg EdDSA (Ed25519) or RS256, and a kid
//   iss      PAPERCLIP_ISSUER
//   aud      "gcr-api-clean"
//   exp      in the future, and no more than 300 s after iat
//   sub      the Paperclip user id
//   company_id, role (owner | member | instance_admin)
//
// Keys come from PAPERCLIP_JWKS_URL and are cached. A kid that is not in the
// cache triggers one refetch (rate limited, so a stream of junk kids cannot
// turn this API into a JWKS hammer), which is how a key rotation is picked up
// without a restart.
//
// Which business the token acts for is NOT decided here. middleware/ownerAuth.js
// resolves company_id through company_links, exactly as the Supabase path
// resolves a user through entity_owners.

const crypto = require('crypto');
const { envInt } = require('./env');

const AUDIENCE = 'gcr-api-clean'; // fixed by the contract
const MAX_LIFETIME_SECONDS = 300; // fixed by the contract
const ROLES = new Set(['owner', 'member', 'instance_admin']);
const ALGORITHMS = new Set(['EdDSA', 'RS256']);

// Tunables, from env (lib/env.js, one reader). 0 is a meaningful value for
// each, so the minimum is 0. The fallbacks only keep a missing variable from
// breaking sign-in; they are documented in .env.example.
const cacheTtlMs = () => envInt('PAPERCLIP_JWKS_CACHE_SECONDS', 600, { min: 0 }) * 1000;
const refetchGapMs = () => envInt('PAPERCLIP_JWKS_MIN_REFETCH_SECONDS', 30, { min: 0 }) * 1000;
const clockSkew = () => envInt('PAPERCLIP_JWT_CLOCK_SKEW_SECONDS', 30, { min: 0 });

let jwks = { keys: new Map(), fetchedAt: 0, url: null };
let inflight = null;
let fetchImpl = (...args) => fetch(...args);

function b64urlJson(segment) {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Header and payload without checking anything. Null when it is not a JWT. */
function decodeUnverified(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        return { header: b64urlJson(parts[0]), payload: b64urlJson(parts[1]), parts };
    } catch {
        return null;
    }
}

/**
 * Is this bearer meant to be checked as a Paperclip token?
 *
 * Decided by the unverified iss only: a Supabase token carries Supabase's own
 * issuer, so the two paths never overlap. Whatever this says, nothing is
 * trusted until verifyToken() has checked the signature.
 */
function isPaperclipToken(token) {
    const issuer = process.env.PAPERCLIP_ISSUER;
    if (!issuer) return false;
    const decoded = decodeUnverified(token);
    return !!decoded && decoded.payload?.iss === issuer;
}

async function loadJwks() {
    const url = process.env.PAPERCLIP_JWKS_URL;
    if (!url) throw new Error('PAPERCLIP_JWKS_URL is not set.');
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const body = await res.json();
    const keys = new Map();
    for (const jwk of body?.keys || []) {
        if (!jwk?.kid) continue;
        try {
            keys.set(jwk.kid, { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), jwk });
        } catch {
            // One malformed key must not take the others down with it.
        }
    }
    jwks = { keys, fetchedAt: Date.now(), url };
    return jwks;
}

function refreshJwks() {
    if (!inflight) inflight = loadJwks().finally(() => { inflight = null; });
    return inflight;
}

async function keyFor(kid) {
    const stale = !jwks.fetchedAt || Date.now() - jwks.fetchedAt > cacheTtlMs()
        || jwks.url !== process.env.PAPERCLIP_JWKS_URL;
    if (stale) await refreshJwks();
    if (jwks.keys.has(kid)) return jwks.keys.get(kid);
    // Unknown kid: Paperclip may have rotated. Refetch once, not on every call.
    if (Date.now() - jwks.fetchedAt >= refetchGapMs()) {
        await refreshJwks();
        if (jwks.keys.has(kid)) return jwks.keys.get(kid);
    }
    return null;
}

function fail(message) {
    const err = new Error(message);
    err.status = 401;
    return err;
}

/**
 * Verify a Paperclip business token. Resolves to its claims or throws (err.status 401).
 */
async function verifyToken(token, { now = Date.now() } = {}) {
    const issuer = process.env.PAPERCLIP_ISSUER;
    if (!issuer || !process.env.PAPERCLIP_JWKS_URL) {
        const err = new Error('Paperclip sign-in is not configured on this API.');
        err.status = 503;
        throw err;
    }
    const decoded = decodeUnverified(token);
    if (!decoded) throw fail('That token is not valid.');
    const { header, payload, parts } = decoded;

    if (!ALGORITHMS.has(header.alg)) throw fail('That token is not valid.');
    if (!header.kid) throw fail('That token is not valid.');

    let found;
    try {
        found = await keyFor(header.kid);
    } catch (e) {
        const err = new Error(`Could not read Paperclip's keys: ${e.message}`);
        err.status = 503;
        throw err;
    }
    if (!found) throw fail('That token is not valid.');

    // The key's own type must match the alg the token claims, or an RSA key
    // could be offered as something else.
    const type = found.key.asymmetricKeyType;
    if ((header.alg === 'EdDSA' && type !== 'ed25519') || (header.alg === 'RS256' && type !== 'rsa')) {
        throw fail('That token is not valid.');
    }

    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    const ok = header.alg === 'EdDSA'
        ? crypto.verify(null, data, found.key, sig)
        : crypto.verify('sha256', data, found.key, sig);
    if (!ok) throw fail('That token is not valid.');

    const at = Math.floor(now / 1000);
    const skew = clockSkew();
    if (payload.iss !== issuer) throw fail('That token was not issued by Paperclip.');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(AUDIENCE)) throw fail('That token is not meant for this API.');
    if (typeof payload.exp !== 'number' || payload.exp + skew < at) throw fail('That token has expired.');
    if (typeof payload.iat !== 'number' || payload.iat - skew > at) throw fail('That token is not valid yet.');
    if (payload.exp - payload.iat > MAX_LIFETIME_SECONDS) throw fail('That token lives too long.');
    if (typeof payload.sub !== 'string' || !payload.sub) throw fail('That token names no user.');
    if (!ROLES.has(payload.role)) throw fail('That token carries an unknown role.');
    // An instance-admin token (CONTRACT §12) may name no company: it is for the
    // admin console, which names the business it acts on explicitly. Whether
    // the admin claim is honoured is decided by platform_admins, not here.
    const hasCompany = typeof payload.company_id === 'string' && !!payload.company_id;
    if (!hasCompany && (payload.role !== 'instance_admin' || payload.company_id !== undefined)) {
        throw fail('That token names no company.');
    }

    return payload;
}

/* ── test hooks ───────────────────────────────────────────────────────── */

function _setFetch(impl) { fetchImpl = impl; }
function _reset() { jwks = { keys: new Map(), fetchedAt: 0, url: null }; inflight = null; }

module.exports = {
    AUDIENCE,
    MAX_LIFETIME_SECONDS,
    ROLES,
    decodeUnverified,
    isPaperclipToken,
    verifyToken,
    _setFetch,
    _reset,
};
