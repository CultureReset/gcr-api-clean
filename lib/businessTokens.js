// ============================================================
// BUSINESS TOKENS — mint and look up business_mcp_tokens rows
// ============================================================
//
// One copy of how a business token is made and read, used by:
//
//   routes/mcp.js            the owner mints one in the dashboard; the MCP
//                            server signs callers in with it
//   routes/business-data.js  an installed app reaches the REST sections with it
//   routes/nextgent.js       Paperclip's link and install calls (CONTRACT §4)
//
// Only sha256(token) is stored. The token exists outside the caller's config
// exactly once: in the response that created it.

const crypto = require('crypto');
const supabase = require('../db');

const TOKEN_PREFIX = 'gcr_mcp_';
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const missingTable = (error) =>
    /business_mcp_tokens/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);
// sql/nextgent_link.sql not applied yet: the token columns it adds are absent.
const missingColumn = (error) => /(permissions|install_id|company_id)/.test(error?.message || '') && /column/i.test(error.message);

const isBusinessToken = (raw) => typeof raw === 'string' && raw.startsWith(TOKEN_PREFIX);

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

module.exports = { TOKEN_PREFIX, hashToken, isBusinessToken, mintToken, lookupToken, revokeWhere, missingTable };
