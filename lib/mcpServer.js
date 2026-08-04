// ============================================================
// MCP — the transport, shared by every MCP surface this API exposes
// ============================================================
//
// JSON-RPC 2.0 over a single POST, answered with a plain JSON body. Everything
// that varies between MCP servers — who may call, what tools exist, what they
// do — is passed in. Nothing about the protocol is.
//
// There are two servers on this API and they have nothing in common except
// this file:
//
//   /api/mcp          one business's own data, behind a token. Writes.
//   /api/mcp/public   the public directory, open. Reads only.
//
// ── Why no SSE ──────────────────────────────────────────────────────────
//
// The spec offers a server-initiated stream over GET. This runs on Vercel
// serverless, where a long-lived connection is killed mid-flight — the same
// thing that killed the Composio sync. Every method implemented here answers
// immediately, so the stream would buy nothing and cost reliability. GET
// returns 405, which is the signal a client needs to fall back to plain POST
// rather than hang waiting for a stream that will never open.

const express = require('express');

// Newest first. A client asking for one of these gets it back; anything else
// is answered with the newest and the client decides whether it can proceed.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

const RPC = {
    PARSE: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL: -32603,
};

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
});

/** What a tool hands back. Text for every client, structured for the ones that read it. */
const content = (payload) => ({
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(typeof payload === 'string' ? {} : { structuredContent: payload }),
});

/** A tool that failed. isError, not a JSON-RPC error — the model should see it and recover. */
const toolError = (message) => ({
    content: [{ type: 'text', text: message }],
    isError: true,
});

/**
 * Build an Express router that speaks MCP.
 *
 * @param serverInfo   { name, title, version } — reported by initialize
 * @param instructions how a model should use this server, sent once on connect.
 *                     A function when the text depends on the caller — the
 *                     slug-pinned server names the business it is answering for.
 * @param tools        an array, or (caller) => array when the caller's rights
 *                     change what they may see
 * @param runTool      (name, args, caller) => tool result. Return the payload
 *                     and it is wrapped; throw and the message becomes an
 *                     isError result the model can read and correct itself from.
 * @param authenticate (req) => caller, or { reason } to refuse with 401.
 *                     Omit entirely for a public server.
 */
function createMcpRouter({ serverInfo, instructions, tools, runTool, authenticate }) {
    // mergeParams so a router mounted at /api/mcp/business/:slug can read that
    // slug. That is how a business's own public agent is scoped: by the URL it
    // was pointed at, with nothing to provision.
    const router = express.Router({ mergeParams: true });
    const toolsFor = (caller) => (typeof tools === 'function' ? tools(caller) : tools);

    async function handleMessage(msg, caller) {
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
            return err(msg?.id, RPC.INVALID_REQUEST, 'Not a JSON-RPC request.');
        }

        const { id, method, params } = msg;
        // No id means a notification: act on it, answer nothing.
        const isNotification = id === undefined || id === null;

        switch (method) {
            case 'initialize': {
                const asked = params?.protocolVersion;
                return ok(id, {
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo,
                    instructions: typeof instructions === 'function' ? instructions(caller) : instructions,
                });
            }

            case 'notifications/initialized':
            case 'notifications/cancelled':
                return null;

            case 'ping':
                return isNotification ? null : ok(id, {});

            case 'tools/list':
                return ok(id, { tools: toolsFor(caller) });

            case 'tools/call': {
                const name = params?.name;
                if (typeof name !== 'string') return err(id, RPC.INVALID_PARAMS, 'A tool name is required.');
                if (!toolsFor(caller).some((t) => t.name === name)) {
                    return err(id, RPC.METHOD_NOT_FOUND, `No tool called "${name}".`);
                }
                try {
                    const result = await runTool(name, params.arguments, caller);
                    if (!result) return err(id, RPC.METHOD_NOT_FOUND, `No tool called "${name}".`);
                    return ok(id, result);
                } catch (e) {
                    // A thrown tool is still a tool result: the model reads it
                    // and can correct itself, where a JSON-RPC error just ends
                    // the turn — on a voice call, mid-sentence.
                    return ok(id, toolError(e.message || 'That did not work.'));
                }
            }

            // Advertised as unsupported in capabilities, but clients still ask.
            case 'resources/list':
                return ok(id, { resources: [] });
            case 'prompts/list':
                return ok(id, { prompts: [] });

            default:
                return isNotification ? null : err(id, RPC.METHOD_NOT_FOUND, `Unknown method "${method}".`);
        }
    }

    router.post('/', async (req, res) => {
        let caller = {};
        if (authenticate) {
            caller = await authenticate(req);
            if (caller.reason) {
                // 404 when the thing named in the URL does not exist, 401 when
                // a credential is missing or wrong. A client told "unauthorised"
                // for a misspelled slug goes looking for a token it never needed.
                const status = caller.status || 401;
                const response = res.status(status);
                if (status === 401) response.set('WWW-Authenticate', 'Bearer realm="gcr-api-clean"');
                return response.json(err(req.body?.id, RPC.INVALID_REQUEST, caller.reason));
            }
        }

        const body = req.body;
        const batched = Array.isArray(body);
        const messages = batched ? body : [body];
        if (batched && !messages.length) {
            return res.status(400).json(err(null, RPC.INVALID_REQUEST, 'Empty batch.'));
        }

        const replies = [];
        for (const msg of messages) {
            try {
                const reply = await handleMessage(msg, caller);
                if (reply) replies.push(reply);
            } catch (e) {
                replies.push(err(msg?.id, RPC.INTERNAL, e.message || 'Server error.'));
            }
        }

        // Everything was a notification. 202 with no body is the correct answer.
        if (!replies.length) return res.status(202).end();
        return res.json(batched ? replies : replies[0]);
    });

    router.get('/', (_req, res) => {
        res.status(405).set('Allow', 'POST').json({
            error: 'This MCP server is POST-only (streamable HTTP without the SSE channel).',
            info: 'GET ./info',
        });
    });

    // Session teardown. Nothing is held between requests, so there is nothing
    // to tear down — but answering 204 is friendlier than 404.
    router.delete('/', (_req, res) => res.status(204).end());

    /** Unauthenticated: enough to check the server is up, nothing more. */
    router.get('/info', (_req, res) => {
        res.json({
            server: serverInfo,
            transport: 'streamable-http (POST, JSON responses)',
            protocol_versions: PROTOCOL_VERSIONS,
            authentication: authenticate ? 'Authorization: Bearer <token>' : 'none — public',
            tools: toolsFor({}).map((t) => t.name),
        });
    });

    return router;
}

module.exports = { createMcpRouter, content, toolError, PROTOCOL_VERSIONS, RPC };
