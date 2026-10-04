// ============================================================
// GOOGLE BUSINESS PROFILE — tokens and the authorised fetch, one copy
// ============================================================
//
// Used by routes/google-business.js (connect, reviews, profile sync) and
// lib/googlePush.js (the push queue). Tokens are stored encrypted
// (AES-256-GCM, OAUTH_TOKEN_ENCRYPTION_KEY) in oauth_tokens, keyed by
// entity_slug and provider 'google_business'.
//
// The API roots are Google's own published ones; each can be overridden
// (GOOGLE_*_URL) for a proxy or a test double.

const crypto = require('crypto');
const supabase = require('../db');

const env = (name, fallback) => (process.env[name] || fallback).replace(/\/+$/, '');
const API = {
    auth: () => env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    userinfo: () => env('GOOGLE_USERINFO_URL', 'https://www.googleapis.com/oauth2/v3/userinfo'),
    token: () => env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    accounts: () => env('GOOGLE_GBP_ACCOUNTS_URL', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts'),
    info: () => env('GOOGLE_GBP_INFO_URL', 'https://mybusinessbusinessinformation.googleapis.com/v1'),
    v4: () => env('GOOGLE_GBP_V4_URL', 'https://mybusiness.googleapis.com/v4'),
    verifications: () => env('GOOGLE_GBP_VERIFICATIONS_URL', 'https://mybusinessverifications.googleapis.com/v1'),
};

const PROVIDER = 'google_business';

function key() {
    const hexKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.STRIPE_KEY_ENCRYPTION_KEY;
    if (!hexKey) throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY not set');
    return Buffer.from(hexKey, 'hex');
}

function encryptToken(plaintext) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(stored) {
    const [ivHex, tagHex, encHex] = String(stored).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

let fetchImpl = (...args) => fetch(...args);

/** The connection row (account, selected location), or null. */
async function connection(slug) {
    const { data } = await supabase.from('oauth_tokens')
        .select('account_id, account_email, expires_at, extra, updated_at')
        .eq('entity_slug', slug).eq('provider', PROVIDER).maybeSingle();
    return data || null;
}

/**
 * A valid access token, refreshed when it expires within five minutes. A
 * refresh Google refuses (revoked, password changed) marks the connection as
 * needing a reconnect, so the owner sees it rather than a silent queue.
 */
async function getValidAccessToken(slug) {
    const { data: row, error } = await supabase.from('oauth_tokens')
        .select('access_token, refresh_token, expires_at, extra')
        .eq('entity_slug', slug).eq('provider', PROVIDER).maybeSingle();
    if (error || !row) throw Object.assign(new Error('Google Business not connected'), { code: 'not_connected' });

    const accessToken = decryptToken(row.access_token);
    if (new Date(row.expires_at) > new Date(Date.now() + 5 * 60 * 1000)) return accessToken;

    const refreshToken = decryptToken(row.refresh_token);
    if (!refreshToken) throw Object.assign(new Error('Google Business needs to be reconnected'), { code: 'reconnect' });
    const resp = await fetchImpl(API.token(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }).toString(),
    });
    const tokens = await resp.json().catch(() => ({}));
    if (!resp.ok || !tokens.access_token) {
        await supabase.from('oauth_tokens').update({
            extra: { ...(row.extra || {}), reconnect_needed: true, refresh_error: tokens.error || `HTTP ${resp.status}` },
            updated_at: new Date().toISOString(),
        }).eq('entity_slug', slug).eq('provider', PROVIDER);
        throw Object.assign(new Error(`Failed to refresh Google token: ${tokens.error_description || tokens.error || resp.status}`), { code: 'reconnect' });
    }
    await supabase.from('oauth_tokens').update({
        access_token: encryptToken(tokens.access_token),
        expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
        extra: { ...(row.extra || {}), reconnect_needed: false, refresh_error: null },
        updated_at: new Date().toISOString(),
    }).eq('entity_slug', slug).eq('provider', PROVIDER);
    return tokens.access_token;
}

/** Call a Google API with the business's token. Throws with err.status and err.body. */
async function gbpFetch(slug, url, options = {}) {
    const token = await getValidAccessToken(slug);
    const res = await fetchImpl(url, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error?.message || 'Google API error'), { status: res.status, body });
    return body;
}

/**
 * The selected location, both ways Google names it: v4 wants
 * "accounts/1/locations/2", the v1 APIs want "locations/2".
 */
function locationNames(accountId) {
    const full = String(accountId || '');
    const m = full.match(/locations\/[^/]+/);
    if (!m) return null;
    return { v4: full.startsWith('accounts/') ? full : null, v1: m[0] };
}

module.exports = {
    API,
    PROVIDER,
    encryptToken,
    decryptToken,
    connection,
    getValidAccessToken,
    gbpFetch,
    locationNames,
    _setFetch: (impl) => { fetchImpl = impl; },
};
