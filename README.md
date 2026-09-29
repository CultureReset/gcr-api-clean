# gcr-api-clean

**The one backend.** Every screen, every app and every AI agent talks to this
API, and **only this API talks to the database** (Supabase project `cyber check`,
see `CLAUDE.md`). No dashboard and no MCP server holds a database key. Production:
`gcr-api-clean.vercel.app` (Express on Vercel).

It started as the Gulf Coast Radar directory backend and now also carries the
Ghost product: the relay to each box, the fleet view, the App Store, billing and
the automation builder. Those Ghost parts sit in the same service and the same
database as the directory.

![Where this repo sits in the whole system](docs/images/where-it-fits.png)

## Who it serves

| Caller | Mount | Auth |
| --- | --- | --- |
| Admin console (`Admin-dashboard-main`) | `/api/admin/*` | admin token (`adminRequired`) |
| Business dashboard (`Dashboards-users-`) and Modular app | `/api/business/*`, `/api/store`, `/api/nodes`, `/api/billing` | business session (`ownerRequired`) |
| A Ghost box | `/api/nodes/heartbeat`, `/pull`, `/requests/:rid/response` | a node token (only its hash is stored) |
| AI agents | `/api/mcp`, `/api/mcp/public`, `/api/mcp/business/:slug` | business MCP token |
| Public sites (`gcr-unified`) | `/api/gcr`, `/api/public`, `/api/tourist*` … | none / tourist session |

There are about 80 mounted routers; `server.js` is the list.

## Two rules that hold everywhere

**The slug is never taken from the request.** `middleware/ownerAuth.js` resolves
which business a caller is from the session token via `entity_owners`, and
handlers filter on `req.entitySlug`, never on the URL, query or body. The one
exception is an admin, who must name a slug explicitly and is checked against
`platform_admins` first. Same for MCP: which business a token acts as comes from
`business_mcp_tokens`, and no tool takes a slug argument.

**One copy of the guards.** `lib/businessTables.js` holds schema discovery, the
table allow-list and the column filter. `routes/business-data.js` and
`routes/mcp.js` both use it. Tables that carry `entity_slug` but must never be
written by a business (`billing_subscription`, `store_installs`, `store_grants`,
`entity_automations`…) are held back there.

## The Ghost parts

| Piece | Where | Tables (SQL) |
| --- | --- | --- |
| **Relay** to each box: an owner enrols a box, sends it a request, reads the answer. The box calls out, nothing calls in. One login = one box. | `routes/nodes.js` | `ghost_nodes`, `ghost_node_requests` (`sql/ghost_nodes.sql`) |
| **Fleet view** (read-only): every box, its release, online or not | `routes/admin-ghost.js` | same |
| **App Store**: items, versions, plans, grants, deployments, installs; entitlement is free OR plan OR grant; a version that widens access is offered, never forced | `routes/store.js`, `lib/entitlements.js`, `lib/storeManifest.js`, `lib/audience.js` | `store_*` (`sql/store.sql`) |
| **Billing**: plans and limits are rows, grace period before restriction | `routes/billing.js`, `lib/billing.js` | `billing_*` (`sql/billing.sql`) |
| **Automation builder** | `routes/automations.js`, `lib/automationEngine.js` | `sql/automations.sql` |

The store and billing tables are applied to the live database, and were checked
there on 2026-09-29: row-level security on, nothing granted to `anon` or
`authenticated`. The relay and automation tables were applied earlier; their SQL
files enable row-level security and revoke public access, but that was not
re-checked on the live database.

## Run it

```bash
npm install
npm run dev        # node --watch server.js
npm start
```

Configuration is environment variables (names only here): `GCR_SUPABASE_URL`,
`GCR_SUPABASE_SERVICE_KEY`, `JWT_SECRET`, `CRON_SECRET`, `CORS_ORIGINS`,
`ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`, `BREVO_API_KEY`, plus the rest in
`.env.example`.

## Checks

```bash
npm run verify     # sql safety, capability columns, and every suite below
npm run test:mcp   # MCP protocol and scoping
npm run test:nodes # relay
npm run test:ghost-admin
npm run test:automations
npm run test:billing
npm run test:store # 50 checks against an in-memory database
npm run test:concierge
```

None of them needs credentials or a network.

## Automation builder

Build a trigger + a chain of steps once in the admin console, publish it as a
version, and push that version to every business dashboard (or some). A
business runs the version it was given, never the draft — so editing changes
nothing anywhere until the next publish and push.

| Piece | Where |
|---|---|
| Engine: step catalogue, templating, runner, schedule check, events | `lib/automationEngine.js` |
| Routes: admin builder, owner installs, cron tick, inbound hooks | `routes/automations.js` |
| Tables (applied to the live project) | `sql/automations.sql` |
| Tests, no credentials needed | `npm run test:automations` |

Mounts: `/api/admin/automations` (adminRequired), `/api/business/automations`
(ownerRequired — the slug comes from the session), `/api/automations/cron/tick`
(hourly, from `vercel.json`, guarded by `CRON_SECRET`) and
`/api/automations/hook/:token` (one random token per install).

Step types are the modular part: `data.query`, `data.insert`, `data.update`,
`condition`, `transform`, `script`, `ai.prompt`, `http.request`, `sms.send`,
`email.send`, `notify`, `log`. Adding one is one entry in the engine; both
dashboards read the catalogue from `GET /api/admin/automations/meta`.

The data steps use the same three guards as the dashboard and the MCP server
(`lib/businessTables.js`). `entity_automations` and `automation_runs` carry
`entity_slug` but are held back from schema discovery there, so a business can
never reach them through the generic writer.

To fire an automation from another route: `require('../lib/automationEngine').emitEvent(name, slug, payload)`.
`routes/intake.js` does this for `intake.created`.
