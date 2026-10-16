# NEXT GENT — Orchestration Architecture Research & Recommendation
_Prepared 2026-10-16 (America/Chicago). Read-only research; nothing was changed, deployed or pushed._

## 1. TL;DR
The draft plan points the right way: one brain, one data door, one executor. It needs five fixes:
1. **gcr-api-clean must own the fan-out, not Paperclip.** "Write once, publish everywhere" is a deterministic sync job (Yext model), not an agent task. Use a transactional outbox in Postgres plus per-channel publisher workers. Paperclip and agents get the fuzzy work: copy, photos, content, triage.
2. **No global service key for Jarvis or agents.** Mint per-tenant, per-agent scoped tokens. The Supabase service-role key stays inside gcr-api-clean only.
3. **Don't auto-expose every module action as an MCP tool.** Keep a curated allowlist with a risk tier per tool, and use the `include_tools` filtering in OpenJarvis.
4. **Database webhooks / pg_net are not an event bus.** They make one attempt, never retry and aren't signed. Use an outbox table plus pgmq (Supabase Queues) or a polling worker, with idempotency keys end to end.
5. **Confirmation lives in the data door, not in the LLM.** External writes create a pending "publish plan" (a diff) that a human approves in the dashboard or by replying to Jarvis. Paperclip approvals can be reused for agent-initiated work.

## 2. Verified facts about the components
| Component | What's verified | Source |
|---|---|---|
| OpenJarvis | Has a `[tools.mcp]` config with servers over Streamable HTTP (`url`) or stdio (`command/args`). Runs `tools/list` at startup and wraps tools as native tools. Supports `include_tools` / `exclude_tools`. A server that fails is skipped and logged ("best-effort"). MCP protocol 2025-11-25. `litellm` is the inference engine, not the MCP client. | open-jarvis.github.io/OpenJarvis/user-guide/mcp-external-servers/ ; …/getting-started/configuration/ ; …/api-reference/openjarvis/mcp/loader/ |
| Paperclip | Node server + React UI. Company-scoped REST API (`POST /api/companies/{id}/agents`, `POST /api/agents/{id}/heartbeat/invoke`). Agent tokens can only act inside their own company. Heartbeats run on a DB-backed wakeup queue with budget checks and secret injection. Heartbeats default to disabled on new agents. Has approvals and "Allowed / Ask first / Off" gateway actions. | github.com/paperclipai/paperclip ; docs.paperclip.ing/reference/api/agents/ |
| Paperclip MCP | `@paperclipai/mcp-server` is a **stdio** wrapper over REST and has no network port. It uses env `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID` and has tools such as `paperclipCreateIssue`, `paperclipGetIssue`, `paperclipRequestConfirmation`, `paperclipCreateApproval`, plus a `paperclipApiRequest` escape hatch. | github.com/paperclipai/paperclip/tree/master/packages/mcp-server ; paperclip-operator docs |
| Hermes ↔ Paperclip | Built-in `hermes_local` adapter (launches the local Hermes CLI, Python 3.10+, `~/.hermes/config.yaml`). `hermes_gateway` connects to a remote Hermes API server. | docs.paperclip.ing/reference/adapters/hermes/ ; …/hermes-gateway/ |
| OpenClaw ↔ Paperclip | Built-in `openclaw_gateway` adapter (WebSocket gateway, invite flow). | docs.paperclip.ing/reference/adapters/overview/ |
| MCP auth | OAuth 2.1 + PKCE. Clients MUST send an RFC 8707 `resource`. Servers MUST validate the audience. **Token passthrough is forbidden**: upstream calls need their own tokens. | modelcontextprotocol.io/specification/2025-11-25/basic/authorization |
| Supabase as MCP AS | Supabase has an OAuth 2.1 server for MCP, but an open issue (Oct 2026) says it ignores `resource` and issues `aud: "authenticated"`. That means it can't do MCP audience binding today. | github.com/supabase/auth/issues/2610 ; supabase.com/docs/guides/auth/oauth-server/mcp-authentication |
| Supabase webhooks | Database Webhooks = trigger + pg_net. One attempt, after commit, no retries, unsigned. pgmq gives durable at-least-once delivery with a visibility timeout. | hookdeck.com guide ; urhoba.net Supabase guide (secondary sources) |
| Google Business Profile | API access needs an application (0 QPM = not approved, 300 QPM = approved; review takes up to ~14 days). Food menus: `PATCH accounts.locations.updateFoodMenus`, only if `canHaveFoodMenus`. With no `updateMask` it's a full replace, and repeated fields can't be patched one item at a time. Edits are limited to **10/min per profile** (can't be raised). Access is granted per Cloud project. Fake/test listings aren't allowed. | developers.google.com/my-business/content/{prereqs,limits,faq,update-food-menus} ; reference/rest/v4/accounts.locations/updateFoodMenus |
| Square | `POST /v2/catalog/batch-upsert`: idempotency_key, atomic batches ≤1,000 objects, ≤10,000 total, concurrent writes per seller serialized (429 possible). Object `version` gives optimistic concurrency. | developer.squareup.com/reference/square/catalog-api/batch-upsert-catalog-objects ; …/common-square-api-patterns |
| Yext pattern | The Knowledge Graph is the single source of truth. Entities sync automatically to publishers, one listing per entity per publisher. A Listings API covers status and opt-in/out. | help.yext.com Listings Overview ; yext.com/knowledge-center/data-syndication |
| Composio | One connected account per `user_id`, holding OAuth/API-key credentials with lifecycle management. | docs.composio.dev/reference/api-reference/connected-accounts |

## 3. Target architecture
```
Matt ──chat──> Jarvis (OpenJarvis, grok-4 via litellm)  [brain: intent, plan, ask-to-confirm]
   │  MCP (Streamable HTTP, HTTPS, per-tenant token)            MCP (stdio, local)
   ▼                                                            ▼
gcr-api-clean /mcp  [ONLY data door + publish engine]     Paperclip MCP → Paperclip :3100 (localhost only)
   │ writes canonical data + outbox row in ONE txn              │ company per business; issues, approvals,
   ▼                                                            │ budgets; heartbeats Hermes/OpenClaw
Supabase Postgres (RLS by business_id)                          ▼
   │ outbox → pgmq                                         Agents call gcr-api-clean MCP/REST with
   ▼                                                        their own scoped, short-lived token
Publisher workers (GBP, Square, website rebuild/ISR, QR menu, listings) – idempotent, rate-limited,
   per-channel status written back → dashboards + Jarvis can report "published to 4/5, GBP pending"
```
Key rules:
- **Canonical model first.** Store menus, hours, etc. once, in a channel-neutral schema. Each publisher is a pure mapper (canonical → GBP FoodMenus, → Square Catalog objects) plus a sync-state table (`external_id`, `last_pushed_hash`, `remote_version`, `status`, `error`).
- **Website and QR menu read live from gcr-api-clean**, with cache invalidation by tag. They don't need "publishing", only invalidation. The real fan-out is only GBP, Square and listings.
- **Paperclip only for non-deterministic work:** writing descriptions, generating photos, reconciling a Square catalog that diverged, answering reviews. A Paperclip task may *propose* a change. The change still goes through the same gcr-api-clean write path, including confirm.

## 4. Changes to the draft plan
| Draft item | Verdict | Change |
|---|---|---|
| Jarvis only brain | Keep | Jarvis has no direct DB/secret access. It only talks MCP to gcr-api-clean and Paperclip. Keep long-running work out of the chat loop (Jarvis creates a Paperclip issue or publish job and polls status). |
| gcr-api-clean only data door (service key) | **Change** | Data door yes, service key no. Issue per-tenant, per-principal API tokens (`jarvis@biz123`, `hermes@biz123`) with scopes (`menu:read`, `menu:write`, `publish:request`) and short TTLs. Check `business_id` from the token, never from the tool arguments. Service-role key only inside gcr-api-clean, ideally with RLS still on via `SET app.business_id`. |
| Paperclip only executor | **Narrow** | It's the executor for *agent* work. Deterministic fan-out runs in gcr-api-clean workers. Agent orchestration isn't a reliable sync engine, and LLM calls cost tokens. |
| MCP on gcr-api-clean, module actions auto-exposed | **Change** | Use a manifest-driven but **curated** registry. Each module declares tools with a JSON schema and a risk tier (read / internal-write / external-publish). Default deny for new tools. Few, coarse tools (`menu.get`, `menu.propose_change`, `publish.plan`, `publish.confirm`, `publish.status`) beat dozens of CRUD tools for LLM accuracy and safety. |
| MCP on Paperclip (task.create/status) | Keep, adjusted | Use the official `@paperclipai/mcp-server` as stdio on the droplet. Restrict it with `include_tools` (create/get issue, comments, approvals). **Exclude `paperclipApiRequest`.** Use one API key per company, or set PAPERCLIP_COMPANY_ID per tenant session. |
| Event bus gcr-api-clean → Paperclip | **Change** | Outbox in Postgres (same transaction as the write) → pgmq → workers. Only events that need agent judgment get forwarded to Paperclip (HTTPS, HMAC-signed, Standard-Webhooks style, `webhook-id` = idempotency key). Don't rely on Database Webhooks/pg_net or Realtime for anything that must be delivered. |
| Tenant scoping via business id | Keep + harden | business_id comes from the token. Use RLS on every table, one Paperclip company per business, and per-company secrets (Paperclip enforces same-company secret refs). Run a cross-tenant test suite. The shared droplet means agent sandboxes/workspaces need per-company dirs and no shared HOME secrets (e.g. `~/.hermes/config.yaml` holds keys). |
| Confirm step for external writes | Keep + make it structural | The server enforces it. `publish.plan` returns a diff + plan_id, and `publish.confirm(plan_id)` requires a human-origin confirmation (dashboard click, or a Jarvis reply tied to Matt's session). Agents can never confirm. Plans expire. |
| HTTPS domain in front of droplet | Keep, extend | Caddy/nginx with TLS on e.g. `agents.<domain>`. Bind Paperclip :3100 and Jarvis to localhost and expose only through the proxy with auth. Firewall everything else. Replace the plain-http Vercel proxy calls immediately (credentials are currently crossing the internet in cleartext). |

## 5. Idempotency, retries, ordering
- Every write gets an `idempotency_key` (client-supplied, or a hash of plan_id+channel). Store it on the server with its result.
- Outbox row: `id, business_id, aggregate, version, payload, created_at`. Worker uses at-least-once delivery, so handlers must be idempotent. Compare `content_hash` with `last_pushed_hash` and skip if equal.
- Coalesce: if 5 menu edits land in a minute, publish the *latest* snapshot per channel (debounce ~30–60 s). This matters for GBP's 10 edits/min/profile limit.
- Retries: exponential backoff + jitter, honor 429/Retry-After, dead-letter after N tries, surface the failure in the dashboard and to Jarvis.
- GBP: always GET → modify → PATCH full FoodMenus (repeated fields can't be masked individually), and check `canHaveFoodMenus`. Square: send the stored `version` and handle version-mismatch by re-reading. Batches ≤1,000 objects.

## 6. Security risks
- **Prompt injection** through untrusted content (reviews, emails, customer song requests, scraped sites) reaching an agent with publish tools. Mitigations: tool-risk tiers, agents that read untrusted input get no external-write tools, server-side confirm, and treat tool output as data.
- **Confused deputy / token passthrough**: never forward Matt's or a tenant's token downstream (forbidden by the MCP spec). gcr-api-clean holds the GBP/Square/Composio OAuth credentials and calls the providers itself.
- **Supabase OAuth for MCP**: don't use it as the MCP authorization server for third-party clients until the `resource`/`aud` issue is fixed. For Jarvis (a first-party server-to-server caller), use your own signed JWTs with `aud=https://api.<domain>/mcp`, `sub`, `business_id` and scopes, or static per-tenant tokens rotated regularly.
- **Shared droplet blast radius**: one compromised agent process can read other tenants' files. Run agents as separate Unix users or containers per company if possible, and keep the litellm/xAI key and per-tenant OAuth tokens out of agent environments.
- **Cost runaway**: Paperclip budgets per company. Heartbeats stay off unless needed (that's the default). Rate-limit Jarvis tool calls.
- **Audit**: log every tool call (principal, business_id, tool, args hash, result) in gcr-api-clean.

## 7. Cost & simplicity
- Simplest path that works: **no new infrastructure.** Supabase (outbox + pgmq + pg_cron) plus one worker (a Vercel Cron-triggered function, or a small Node process on the droplet) handles fan-out. No Kafka/Redis.
- Composio: good for *linking* accounts quickly (connected accounts per user_id). Decide whether GBP/Square calls go through Composio or direct. For core, high-volume channels, direct API + your own token store gives control over idempotency, versioning and rate limits. Use Composio for the long tail. (Unverified: whether Composio's GBP/Square toolkits expose updateFoodMenus / batch-upsert with idempotency. Check before relying on it.)
- n8n: a reasonable alternative for long-tail glue, but it adds a second workflow engine next to Paperclip. Not recommended at first.
- GBP API approval takes up to ~14 days. **Apply now.** It's on the critical path.

## 8. Build order
1. **Harden transport (no feature change):** domain + TLS proxy on droplet, bind :3100 and Jarvis to localhost, switch the dashboard serverless proxies to HTTPS + auth, rotate any keys sent over plain http.
2. **Apply for GBP API access**; create a Square developer app (sandbox).
3. **Canonical schema + RLS** in Supabase for menus and hours (business_id on every row). Add a `channel_sync_state` table.
4. **Scoped token service** in gcr-api-clean (principal, business_id, scopes, TTL) and an audit log.
5. **Outbox + pgmq + one worker**, with the first publisher being the *website/QR cache invalidation* (internal, safe).
6. **gcr-api-clean MCP endpoint** (Streamable HTTP) with 5–8 curated tools including `publish.plan/confirm/status`. Wire into OpenJarvis `[tools.mcp]` with `include_tools`.
7. **Confirm UX**: dashboard "pending publish" card + Jarvis confirmation reply.
8. **Square publisher** (sandbox → prod), then **GBP publisher** once approved, with coalescing/rate limiting.
9. **Paperclip MCP (stdio) into Jarvis**, restricted tools. One company per business, Hermes via `hermes_local`, OpenClaw via `openclaw_gateway`. Agents get their own scoped gcr-api-clean tokens.
10. Listings beyond GBP (evaluate a Yext-style aggregator vs direct APIs), then more modules (bookings, merch, song requests) using the same tool-manifest + outbox pattern.

## 9. Unverified / open questions
- Exact OpenJarvis auth header support for HTTP MCP servers (docs mention a token field in examples, but I didn't confirm it per-server). Check the repo before relying on it.
- Paperclip multi-company isolation of *agent runtime filesystems* on one host. The API is company-scoped (verified), but workspace/process isolation on a shared droplet isn't verified.
- How Duda and Squarespace implement internal fan-out wasn't researched in depth. The Yext model is the verified reference.
- Composio toolkit coverage for GBP food menus and Square catalog.
- The Supabase webhook claims come from secondary sources (Hookdeck, a blog). They're consistent with pg_net's documented behavior but should be confirmed in the Supabase docs.

## 10. Sources
- https://open-jarvis.github.io/OpenJarvis/user-guide/mcp-external-servers/
- https://open-jarvis.github.io/OpenJarvis/getting-started/configuration/
- https://open-jarvis.github.io/OpenJarvis/api-reference/openjarvis/mcp/loader/
- https://open-jarvis.github.io/OpenJarvis/api-reference/openjarvis/engine/litellm/
- https://github.com/paperclipai/paperclip
- https://paperclip.ing/
- https://docs.paperclip.ing/reference/api/agents/
- https://github.com/paperclipai/paperclip/tree/master/packages/mcp-server
- https://github.com/paperclipinc/paperclip-operator/blob/main/docs/deploy/runtime-configured-features.md
- https://docs.paperclip.ing/reference/adapters/hermes/
- https://docs.paperclip.ing/reference/adapters/hermes-gateway/
- https://docs.paperclip.ing/reference/adapters/overview/
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://github.com/supabase/auth/issues/2610
- https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- https://hookdeck.com/webhooks/platforms/guide-to-supabase-webhooks-features-and-best-practices
- https://www.urhoba.net/en/post/supabase-guide-webhooks-background-work-and-idempotency
- https://developers.google.com/my-business/content/prereqs
- https://developers.google.com/my-business/content/limits
- https://developers.google.com/my-business/content/faq
- https://developers.google.com/my-business/content/update-food-menus
- https://developers.google.com/my-business/reference/rest/v4/accounts.locations/updateFoodMenus
- https://developer.squareup.com/reference/square/catalog-api/batch-upsert-catalog-objects
- https://developer.squareup.com/docs/sdks/python/common-square-api-patterns
- https://help.yext.com/hc/en-us/articles/51581418976411-Listings-Overview
- https://www.yext.com/knowledge-center/data-syndication
- https://docs.composio.dev/reference/api-reference/connected-accounts
