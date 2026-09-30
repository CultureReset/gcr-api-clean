## Connect Paperclip to a NEXT GENT Ghost

Paperclip connects through its built-in **Apps → Connect an app → Connect your own MCP server** flow. No Paperclip code patch or duplicate app catalog is required.

1. Apply `sql/ghost_nodes.sql` and `sql/ghost_mcp_tokens.sql` to the GCR Supabase project (the first is safe to re-run), then enroll and start the owner's Ghost so it appears under **My Ghost**.
2. In the owner dashboard, mint a credential with `POST /api/nodes/:nodeId/mcp-token` using the signed-in owner session. Store the returned raw token in Paperclip's connection setup; it is shown once.
3. In Paperclip, connect the remote MCP server at `https://<your-gcr-api-host>/api/mcp/ghost` and set `Authorization: Bearer <token>`.
4. Enable only the NEXT GENT Ghost tools needed by the Paperclip agent.
5. Let the Ghost poll the existing outbound relay. An MCP tool call queues work; it does not connect inbound to the owner's box.
6. For a requested action, check the relay request response, then use the returned `task_id` with action status/receipt tools. The phone's local NEXT GENT policy and SMS YES approval remain authoritative. Report completion only on a VERIFIED receipt.
7. Revoke the Paperclip credential from the owner dashboard or revoke the Ghost node. Either action prevents future execution through that credential.

This server exposes only the Ghost's mapped capability list, a natural-language intent submission, request status, action status and verification receipt. It does not expose a generic URL/path proxy, arbitrary shell, credentials, or another owner's node. Paperclip's other Apps, Connections, provider credentials and integrations remain Paperclip-native.
