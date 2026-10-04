// ============================================================
// BUSINESS TOKENS — mint and look up business_mcp_tokens rows
// ============================================================
//
// One copy of how a business token is made and read, used by:
//
//   routes/mcp.js            the owner mints one in the dashboard; the MCP
//                            server signs callers in with it
//   routes/business-data.js  an installed app reaches the REST sections with it
//   routes/nextgent.js       Paperclip's link and install calls (CONTRACT §4),
//                            and the short-lived install session tokens
//   routes/app-data.js       an engine app's own records and settings
//
// Only sha256(token) is stored. The token exists outside the caller's config
// exactly once: in the response that created it.
//
// An install session token (gcr_mcp_ist.<payload>.<mac>) is the short-lived
// form of an install's token: nothing stored, HMAC-signed with a key derived
// from NEXTGENT_SECRETS_KEY / NEXTGENT_SERVICE_SECRET (lib/secretBox.js),
// expires in at most 300 s, and resolves through the install row every time,
// so it carries whatever the install's permissions are now and stops working
// the moment the install is removed. lookupToken reads both forms the same.

const crypto = require('crypto');
const supabase = require('../db');
const { derivedKey } = require('./secretBox');
const { scopeForPermissions } = require('./businessTables');
const { envInt } = require('./env');

const TOKEN_PREFIX = 'gcr_mcp_';
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const missingTable = (error) =>
    /business_mcp_tokens/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);
// sql/nextgent_link.sql not applied yet: the token columns it adds are absent.
const missingColumn = (error) => /(permissions|install_id|company_id)/.test(error?.message || '') && /column/i.test(error.message);

const isBusinessToken = (raw) => typeof raw === 'string' && raw.startsWith(TOKEN_PREFIX);

/* ── install session tokens ───────────────────────────────────────────── */

// The '.' keeps it apart from a stored token, whose base64url body never has one.
const SESSION_PREFIX = `${TOKEN_PREFIX}ist.`;
const SESSION_MAX_SECONDS = 300; // the contract's ceiling for short-lived tokens
const SESSION_KEY_PURPOSE = 'install-session-token';
const sessionMac = (payload) => crypto.createHmac('sha256', derivedKey(SESSION_KEY_PURPOSE)).update(payload).digest('base64url');

/** How long a session token lives: INSTALL_SESSION_TTL_SECONDS, never past 300 s. */
const sessionTtlSeconds = () => Math.min(envInt('INSTALL_SESSION_TTL_SECONDS', SESSION_MAX_SECONDS), SESSION_MAX_SECONDS);

/** A short-lived token for one install. Returns { token, expiresAt }. */
function mintInstallSession({ installId, companyId = null, now = Date.now() }) {
    const exp = Math.floor(now / 1000) + sessionTtlSeconds();
    const payload = Buffer.from(JSON.stringify({
        v: 1, i: String(installId), c: companyId ? String(companyId) : null, exp, n: crypto.randomBytes(9).toString('base64url'),
    })).toString('base64url');
    return { token: `${SESSION_PREFIX}${payload}.${sessionMac(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

async function lookupInstallSession(raw, { now = Date.now() } = {}) {
    const [payload, mac, extra] = raw.slice(SESSION_PREFIX.length).split('.');
    if (!payload || !mac || extra !== undefined) return { reason: 'That token is not valid.' };
    let expected;
    try {
        expected = Buffer.from(sessionMac(payload));
    } catch (err) {
        return { reason: err.message };
    }
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { reason: 'That token is not valid.' };
    let claims;
    try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return { reason: 'That token is not valid.' };
    }
    if (!claims || claims.v !== 1 || typeof claims.i !== 'string' || !Number.isFinite(claims.exp)) return { reason: 'That token is not valid.' };
    if (claims.exp * 1000 <= now) return { reason: 'That token has expired.' };

    const { data, error } = await supabase
        .from('nextgent_installs')
        .select('install_id, company_id, entity_slug, item_key, permissions, status')
        .eq('install_id', claims.i)
        .maybeSingle();
    if (error) return { reason: error.message };
    if (!data || data.status !== 'active') return { reason: 'That install has been removed.' };
    if (claims.c && data.company_id !== claims.c) return { reason: 'That token is not valid.' };
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    return {
        id: null,
        slug: data.entity_slug,
        scope: scopeForPermissions(permissions),
        permissions,
        installId: data.install_id,
        companyId: data.company_id,
        label: `install:${data.item_key}`,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
}

/**
 * Create a token. Returns { row, token }; the token is not recoverable later.
 */
async function mintToken({ slug, label, scope = 'read', permissions = null, installId = null, companyId = null, createdBy = null }) {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const row = {
        entity_slug: slug,
        label: String(label || 'AI assistant').slice(0, 80),
        scope: scope === 'write' ? 'write' : 'read',
        token_hash: hashToken(token),
        token_hint: token.slice(-6),
        created_by: createdBy,
    };
    // Only send the new columns when they carry something, so a database
    // without sql/nextgent_link.sql keeps minting legacy tokens.
    if (permissions !== null) row.permissions = permissions;
    if (installId !== null) row.install_id = String(installId);
    if (companyId !== null) row.company_id = String(companyId);

    const { data, error } = await supabase
        .from('business_mcp_tokens')
        .insert(row)
        .select('id, label, scope, token_hint, created_at')
        .single();
    if (error) {
        const err = new Error(missingTable(error) || missingColumn(error)
            ? 'Business tokens are not set up on this database yet (see sql/ORDER.md).'
            : error.message);
        err.status = missingTable(error) || missingColumn(error) ? 503 : 500;
        throw err;
    }
    return { row: { ...data, permissions }, token };
}

/**
 * Look a token up. Resolves to { slug, scope, permissions, installId, companyId,
 * label, id } or { reason }.
 */
async function lookupToken(raw) {
    if (!isBusinessToken(raw)) return { reason: 'That token is not valid.' };
    if (raw.startsWith(SESSION_PREFIX)) return lookupInstallSession(raw);
    let { data, error } = await supabase
        .from('business_mcp_tokens')
        .select('id, entity_slug, label, scope, revoked_at, permissions, install_id, company_id')
        .eq('token_hash', hashToken(raw))
        .maybeSingle();

    if (error && missingColumn(error)) {
        ({ data, error } = await supabase
            .from('business_mcp_tokens')
            .select('id, entity_slug, label, scope, revoked_at')
            .eq('token_hash', hashToken(raw))
            .maybeSingle());
    }
    if (error) {
        if (missingTable(error)) {
            return { reason: 'MCP tokens are not set up on this database yet (business_mcp_tokens is missing).' };
        }
        return { reason: error.message };
    }
    if (!data) return { reason: 'That token is not valid.' };
    if (data.revoked_at) return { reason: 'That token has been revoked.' };

    // Best effort: a failed timestamp update must not fail the call.
    supabase
        .from('business_mcp_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', data.id)
        .then(() => {}, () => {});

    return {
        id: data.id,
        slug: data.entity_slug,
        scope: data.scope || 'read',
        permissions: Array.isArray(data.permissions) ? data.permissions : null,
        installId: data.install_id || null,
        companyId: data.company_id || null,
        label: data.label,
    };
}

/** Revoke every live token matching a filter ({ install_id } or { company_id }). */
async function revokeWhere(filter) {
    let query = supabase
        .from('business_mcp_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .is('revoked_at', null);
    for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
    const { data, error } = await query.select('id');
    if (error) {
        if (missingTable(error) || missingColumn(error)) return 0;
        throw new Error(error.message);
    }
    return (data || []).length;
}

module.exports = {
    TOKEN_PREFIX, SESSION_PREFIX, SESSION_MAX_SECONDS, hashToken, isBusinessToken, mintToken, lookupToken, revokeWhere, missingTable,
    mintInstallSession, sessionTtlSeconds,
};
