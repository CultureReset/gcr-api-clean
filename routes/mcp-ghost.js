// ============================================================
// GHOST MCP — the narrow agent door to one owner's physical Ghost
// ============================================================
//
// Paperclip connects to this as a generic remote HTTP MCP server. A credential
// is minted by an owner for exactly one enrolled node. The model cannot name
// an entity, node, owner, host, URL or arbitrary local path.
//
// Calls are relayed asynchronously: GCR queues a request, the Ghost pulls it
// over its existing outbound link, and the owner reads back the result. The
// local NEXT GENT core remains the policy, approval, execution and verification
// authority. A pending request is never represented as completed.

const crypto = require('crypto');
const supabase = require('../db');
const { createMcpRouter, content, toolError } = require('../lib/mcpServer');

const PREFIX = 'gcr_ghostmcp_';
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const SERVER_INFO = { name: 'next-gent-ghost', title: 'NEXT GENT Ghost', version: '1.0.0' };
const INSTRUCTIONS = [
    'You are connected to one owner-enrolled NEXT GENT Ghost. Its local NEXT GENT core',
    'resolves capabilities, enforces policy, requests owner approval by SMS when needed,',
    'executes on the owner\'s physical Android device, and verifies the result.',
    'A queued request is not completed. A pending SMS approval is not completed.',
    'Report success only when the action status or receipt says VERIFIED.',
    'Use nextgent_ghost_capabilities before asking the owner to perform an action.',
].join('\n');

async function authenticate(req) {
    const header = String(req.headers.authorization || '').trim();
    const raw = (/^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : header).trim();
    if (!raw.startsWith(PREFIX)) return { reason: 'A Ghost MCP bearer token is required.' };

    const { data: token, error } = await supabase
        .from('ghost_mcp_tokens')
        .select('id, node_id, entity_slug, label, created_by, revoked_at')
        .eq('token_hash', sha(raw))
        .maybeSingle();
    if (error) return { reason: 'Ghost MCP credential lookup failed.', status: 503 };
    if (!token || token.revoked_at) return { reason: 'That Ghost MCP token is invalid or revoked.' };

    const { data: node, error: nodeError } = await supabase
        .from('ghost_nodes')
        .select('id, entity_slug, revoked_at')
        .eq('id', token.node_id)
        .maybeSingle();
    if (nodeError) return { reason: 'Ghost status lookup failed.', status: 503 };
    if (!node || node.revoked_at || node.entity_slug !== token.entity_slug) {
        return { reason: 'The enrolled Ghost is unavailable or revoked.' };
    }
    supabase.from('ghost_mcp_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', token.id).then(() => {}, () => {});
    return { tokenId: token.id, nodeId: node.id, entitySlug: node.entity_slug, createdBy: token.created_by, label: token.label };
}

async function enqueue(caller, method, path, body = null) {
    const { data: liveNode, error: nodeError } = await supabase
        .from('ghost_nodes')
        .select('id, entity_slug, revoked_at')
        .eq('id', caller.nodeId)
        .maybeSingle();
    if (nodeError) throw new Error('Ghost status lookup failed.');
    if (!liveNode || liveNode.revoked_at || liveNode.entity_slug !== caller.entitySlug) {
        throw new Error('This Ghost has been revoked.');
    }
    const { data, error } = await supabase
        .from('ghost_node_requests')
        .insert({
            node_id: caller.nodeId,
            entity_slug: caller.entitySlug,
            method,
            path,
            body,
            created_by: caller.createdBy || null,
        })
        .select('id, status, created_at')
        .single();
    if (error) throw new Error('Unable to queue a Ghost request.');
    return data;
}

const TOOLS = [
    {
        name: 'nextgent_ghost_capabilities',
        title: 'List this Ghost’s available actions',
        description: 'Ask the physical Ghost for the capabilities currently installed on its local NEXT GENT core. The result may be delayed while the Ghost polls.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'nextgent_ghost_submit_intent',
        title: 'Request an action from this Ghost',
        description: 'Submit a short, explicit owner request to the local NEXT GENT intent catalog. Unknown or ambiguous requests do not execute. The local policy may require the owner to reply YES by SMS. This returns a relay request ID; it does not mean the action has completed.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1, maxLength: 2000, description: 'The exact requested action in plain language.' } },
            required: ['text'],
            additionalProperties: false,
        },
        annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: false },
    },
    {
        name: 'nextgent_ghost_request_status',
        title: 'Check a Ghost relay request',
        description: 'Check whether a queued request reached the Ghost and read its response. A response may include the local action ID and an approval-pending state.',
        inputSchema: {
            type: 'object',
            properties: { request_id: { type: 'string', minLength: 1, maxLength: 80 } },
            required: ['request_id'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'nextgent_ghost_action_status',
        title: 'Check local action status',
        description: 'Ask NEXT GENT for the durable status of an action ID returned by this Ghost. VERIFIED is the only success state.',
        inputSchema: {
            type: 'object',
            properties: { action_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' } },
            required: ['action_id'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'nextgent_ghost_action_receipt',
        title: 'Read the verification receipt',
        description: 'Read the independent verification receipt for a local action. A 409 or queued response means it is not ready; do not claim success.',
        inputSchema: {
            type: 'object',
            properties: { action_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' } },
            required: ['action_id'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
];

async function runTool(name, args = {}, caller) {
    if (name === 'nextgent_ghost_capabilities') {
        return content({ queued: true, ...(await enqueue(caller, 'GET', '/capabilities')) });
    }
    if (name === 'nextgent_ghost_submit_intent') {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text || text.length > 2000) return toolError('text must contain 1–2000 characters.');
        return content({
            queued: true,
            warning: 'This is a request, not a completed action. Check the relay response, then the action status and receipt.',
            ...(await enqueue(caller, 'POST', '/intent', { text, requested_by: 'paperclip' })),
        });
    }
    if (name === 'nextgent_ghost_request_status') {
        const id = String(args.request_id || '');
        const { data, error } = await supabase
            .from('ghost_node_requests')
            .select('id, method, path, status, response_status, response_body, created_at, dispatched_at, completed_at')
            .eq('id', id)
            .eq('node_id', caller.nodeId)
            .maybeSingle();
        if (error) throw new Error('Unable to read Ghost request status.');
        if (!data) return toolError('No request with that ID exists for this Ghost.');
        const actionStatus = data.response_body?.action?.status || null;
        const verified = actionStatus === 'VERIFIED' && Boolean(data.response_body?.receipt);
        return content({ request: data, verified, instruction: 'If the response body contains task_id, use nextgent_ghost_action_status. Report success only when the local action is VERIFIED and a verification receipt is available.' });
    }
    if (name === 'nextgent_ghost_action_status' || name === 'nextgent_ghost_action_receipt') {
        const id = String(args.action_id || '');
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return toolError('Invalid action ID.');
        const suffix = name === 'nextgent_ghost_action_receipt' ? '/receipt' : '';
        return content({ queued: true, ...(await enqueue(caller, 'GET', '/actions/' + encodeURIComponent(id) + suffix)) });
    }
    return toolError('Unknown Ghost MCP tool.');
}

const router = createMcpRouter({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    runTool,
    authenticate,
    authNote: 'Authorization: Bearer gcr_ghostmcp_… — credential scoped to one enrolled Ghost',
});

module.exports = router;
