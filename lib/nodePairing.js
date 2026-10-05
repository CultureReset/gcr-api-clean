// ============================================================
// NODE PAIRING — approving a computer's code, in one place (DECISIONS #69)
// ============================================================
//
// Two callers approve a pairing (routes/nodes.js step 2 of the device flow):
//
//   the owner's session       POST /api/nodes/pair          (transitional)
//   Paperclip, signed         POST /api/nextgent/nodes/pair (the business is
//                             the company's, through company_links)
//
// Both end here, so the ownership decision — which business the new
// ghost_nodes row belongs to — is made the same way for both. The caller
// says which business; nothing here reads a request.
//
// What waits for the computer in node_pairings.token_sealed is one sealed
// JSON payload: { token, deviceToken? }. The node token is the relay's; the
// device token, when Paperclip minted one (DECISIONS #71), is Paperclip's, and
// the computer collects both in the same POST /pair/poll answer. Older rows
// sealed the bare node token; openSealed reads those too.
//
// The agent's credential for the computer (ghost_mcp_tokens, routes/mcp-ghost.js)
// is minted here too (mintMcpToken): with the pairing, for the company's
// assistant (DECISIONS #74), or by the owner's transitional route.
//
// Revoking is here as well (revokeNodes): a node's agent credentials
// (ghost_mcp_tokens) go with it, whether one computer is revoked or every
// computer of a business that unlinks (DECISIONS #78).

const crypto = require('crypto');
const supabase = require('../db');
const secretBox = require('./secretBox');
const { envStr } = require('./env');

const TOKEN_PREFIX = 'gcr_node_';
const MCP_TOKEN_PREFIX = 'gcr_ghostmcp_';
const PAIR_PURPOSE = 'node-pair-token';

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const nowIso = () => new Date().toISOString();
const normalizeUserCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const fail = (status, message, dbError) => Object.assign(new Error(message), { status, ...(dbError ? { dbError } : {}) });

/** The sealed payload the computer collects: { token, deviceToken|null }. */
function sealPayload({ token, deviceToken }) {
    return secretBox.seal(JSON.stringify({ token, ...(deviceToken ? { deviceToken } : {}) }), PAIR_PURPOSE);
}

/** Read what sealPayload (or the older bare-token form) stored. */
function openSealed(sealed) {
    const plain = secretBox.open(sealed, PAIR_PURPOSE);
    if (plain === null) return { token: null, deviceToken: null };
    if (plain.startsWith('{')) {
        try {
            const parsed = JSON.parse(plain);
            return { token: parsed.token || null, deviceToken: parsed.deviceToken || null };
        } catch { /* not JSON: a bare token */ }
    }
    return { token: plain, deviceToken: null };
}

/**
 * Approve the code a computer shows and enrol it as a node of `entitySlug`.
 *
 *   entitySlug   the business the node belongs to (the caller resolved it)
 *   code         the short code the computer shows
 *   name         a name when the computer gave none
 *   approvedBy   who approved (e.g. 'paperclip:<userId>' or a Supabase id)
 *   createdBy    ghost_nodes.created_by (a Supabase user id, or null)
 *   deviceToken  Paperclip's device token for the box, handed over with the
 *                node token (optional)
 *
 * Resolves { node: { id, name, token_hint, version, health, created_at,
 * last_seen_at }, pairingId }. Throws with err.status (400 bad code, 404 not
 * valid or expired, 409 just used) or err.dbError for a database error.
 */
async function approvePairing({ entitySlug, code, name, approvedBy = null, createdBy = null, deviceToken = null }) {
    if (!entitySlug) throw fail(400, 'entitySlug is required.');
    const userCode = normalizeUserCode(code);
    if (userCode.length < 6) throw fail(400, 'Enter the code the computer shows.');

    const { data: row, error } = await supabase.from('node_pairings').select('*')
        .eq('user_code_hash', hashToken(userCode)).eq('status', 'pending').maybeSingle();
    if (error) throw fail(500, error.message, error);
    if (!row || new Date(row.expires_at) < new Date()) throw fail(404, 'That code is not valid or has expired. Ask the computer for a new one.');

    const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
    const { data: node, error: nodeError } = await supabase.from('ghost_nodes').insert({
        entity_slug: entitySlug,
        name: row.name || String(name || '').trim().slice(0, 80) || envStr('NODE_DEFAULT_NAME', 'Computer'),
        token_hash: hashToken(token),
        token_hint: token.slice(-6),
        created_by: createdBy || null,
    }).select('id, name, token_hint, version, health, created_at, last_seen_at').single();
    if (nodeError) throw fail(500, nodeError.message, nodeError);

    const { data: approved } = await supabase.from('node_pairings').update({
        status: 'approved', node_id: node.id, entity_slug: entitySlug,
        token_sealed: sealPayload({ token, deviceToken }), approved_at: nowIso(),
        approved_by: approvedBy || null,
    }).eq('id', row.id).eq('status', 'pending').select('id');
    if (!approved?.length) {
        await supabase.from('ghost_nodes').update({ revoked_at: nowIso() }).eq('id', node.id);
        throw fail(409, 'That code was just used.');
    }
    return {
        node: {
            id: node.id,
            name: node.name,
            token_hint: node.token_hint,
            version: node.version ?? null,
            health: node.health ?? null,
            created_at: node.created_at,
            last_seen_at: node.last_seen_at ?? null,
        },
        pairingId: row.id,
    };
}

/**
 * Mint a Ghost MCP credential for one node (the agent's way to the computer,
 * routes/mcp-ghost.js). Resolves { credential, token }; the raw token is
 * returned once and only its hash is stored.
 */
async function mintMcpToken({ nodeId, entitySlug, label, createdBy = null }) {
    const token = MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
    const { data, error } = await supabase
        .from('ghost_mcp_tokens')
        .insert({
            node_id: nodeId,
            entity_slug: entitySlug,
            label: String(label || 'Paperclip').trim().slice(0, 80) || 'Paperclip',
            token_hash: hashToken(token),
            token_hint: token.slice(-6),
            created_by: createdBy || null,
        })
        .select('id, node_id, label, token_hint, created_at')
        .single();
    if (error) throw fail(500, error.message, error);
    return { credential: data, token };
}

/**
 * Revoke the live nodes of `entitySlug` — one (`nodeId`) or all — and every
 * MCP credential of those nodes. `createdBy` narrows to the nodes one Supabase
 * login enrolled (the owner route's "one login, one box"). Resolves the number
 * of nodes revoked.
 */
async function revokeNodes({ entitySlug, nodeId = null, createdBy = null }) {
    if (!entitySlug) throw fail(400, 'entitySlug is required.');
    const at = nowIso();
    let q = supabase.from('ghost_nodes').update({ revoked_at: at }).eq('entity_slug', entitySlug).is('revoked_at', null);
    if (nodeId) q = q.eq('id', nodeId);
    if (createdBy) q = q.eq('created_by', createdBy);
    const { data, error } = await q.select('id');
    if (error) throw fail(500, error.message, error);
    const ids = (data || []).map((n) => n.id);
    if (ids.length) {
        const { error: tokenError } = await supabase.from('ghost_mcp_tokens').update({ revoked_at: at })
            .in('node_id', ids).is('revoked_at', null);
        if (tokenError) throw fail(500, tokenError.message, tokenError);
    }
    return ids.length;
}

module.exports = {
    TOKEN_PREFIX, MCP_TOKEN_PREFIX, PAIR_PURPOSE,
    hashToken, normalizeUserCode,
    sealPayload, openSealed,
    approvePairing, mintMcpToken, revokeNodes,
};
