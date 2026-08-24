# Ghost — what it is, what you get, and the checklist

Written 2026-08-24. This is the master inventory. If something is not in here,
it is not being built, and that is the point of the file.

Status marks used throughout:

| | |
|---|---|
| `[x]` | done and working |
| `[~]` | written but not live — schema not applied, or code not wired up |
| `[ ]` | not started |
| `[?]` | blocked on a decision only you can make |

---

## 1. The one-sentence version

**A business owner is currently the integration layer between their own
software. Ghost replaces that with a control plane that updates once, lands
everywhere, and proves it landed.**

Everything below is in service of that sentence. The word that costs the most
is *proves*.

---

## 2. What you will have when this is done

Concretely, at the end of the full build:

**For a business owner.** One login. One place to change anything true about
their business — hours, menu, prices, photos, description, closures. They
change it once. It lands on Google Business, their website, the QR menu on the
table, their Instagram bio, their POS, their booking page, whatever else they
have connected. They get back a receipt for each destination showing what it
looked like before, what it looks like now, and a screenshot proving somebody
went and looked. When one destination fails, they are told which one and why,
not left to find out from a customer three weeks later.

**For their staff.** Scoped access to only the apps the business installed and
only the permissions they were granted. No staff member sees the till numbers
because they can edit the menu.

**For their customers.** Public pages that are always current, because they are
rendered from the same canonical record that everything else is rendered from —
not a copy that drifted.

**For you.** A platform where adding an industry is data entry, not a rewrite.
A restaurant, a marina, a real-estate brokerage and a bar all run on the same
kernel. What differs between them is which Data Modules have rows, which Ghost
Apps are installed, and which tools are mapped. Not the code.

**And the thing nobody else has.** A verified reverse-map of every business tool
that matters, down to the individual control, kept alive by a fleet that tests
it daily and repairs itself when a vendor moves a button. That map is the asset.
The software around it is replaceable; the map is not.

### What it is not

It is not an automation product. Zapier updates six places. So will Ghost. The
difference is entirely in what happens after the write, and if the verification
layer ever gets cut for speed, what is left is a worse Zapier.

---

## 3. Where A9ENT fits — the read on that teardown

A9ENT is one industry's worth of **the top two layers only**: a public
front-facing page and an owner dashboard, for real-estate agents. That is a
real product and it is roughly a two-month solo build, exactly as that document
says.

It is also, in Ghost terms, **an output**. Here is that teardown's own list of
"what actually needs building vs. assembling," mapped onto what is already
specced here:

| A9ENT's "must build" | Ghost primitive | Status |
|---|---|---|
| Multi-tenant profile renderer + theming | Public surface driven by `table_registry.visibility_class` (`PUBLIC` vs `BUSINESS_PRIVATE`) | `[~]` schema written |
| Brokerage → agents hierarchy, shared branding | `workspaces` → `workspace_entities` → `entity.parent_entity_slug` | `[~]` schema written |
| AI-media orchestration + job queue | `execution_jobs` / `execution_attempts` — the same tables, no second queue | `[~]` schema written |
| Lead capture from an open-house QR | `CUSTOMER_SUBMISSION` classification | `[~]` schema written |
| Credits / billing metering | Metering ledger | `[ ]` **not built — real gap** |
| "Done-for-you" onboarding tooling | Automations + agents doing the setup | `[ ]` not built |

Five of six are already covered by the kernel that went in today, because they
were never real-estate problems — they were multi-tenant SaaS problems, and you
specced them generically.

**The two things worth taking from that document:**

1. *"The moat is not the code."* Correct for A9ENT, and it is why they will be
   copied. It is not correct for Ghost, and the reason is the Tool Digital Twin.
   A competitor can clone your dashboard in a month. They cannot clone a map of
   3,000 Toast controls that has been maintained against reality for a year.

2. *"Keep the video provider behind an abstraction so you can swap models."*
   That is the same rule you already wrote as **never let a vendor name become
   your architecture** — and it is exactly what `capability_implementations`
   and `provider_kind` are for. That teardown arrived at your rule independently,
   from the other direction.

**The honest difference in timeline.** A9ENT ships in 6–10 weeks because A9ENT
writes to its own database. Nothing it does can be wrong, because it is the only
authority on its own data. Ghost writes into Google, Toast, Instagram, Yelp —
systems it does not control, which change without notice and can refuse or
silently drop a write. Every week of the difference between "6–10 weeks" and
what this takes is the verification-and-repair tax. That tax *is* the product.

A9ENT is also a good target: the real-estate vertical is a Ghost App plus a set
of Data Modules on top of a finished kernel. Once the kernel is real, that build
is short.

---

## 4. The build order, and why it is this order

From `Flow_.html`, and it is right:

```
1. Contracts        IDs, envelopes, events, errors        ← nothing above this works without it
2. Foundation       identity, tenancy, canonical data, provenance
3. Control          capabilities, permissions, providers, workflows
4. Execution        models, memory, builders, nodes, executors, mesh
5. Surfaces         apps, dashboard, public pages, hardware
```

The reason to hold this order: every layer above **names** things in the layer
below. If capability keys are not settled before executors are written, each
executor invents its own names and the map cannot be shared. Surfaces built
before the kernel get their own database access, and then the rule that only
this API talks to the database is already broken.

**Where we are: Layer 2 has schema on disk, unapplied. Layer 1 is not written
down yet, which is the part that is out of order and needs fixing first.**

---

## 5. The checklist

### Layer 0 — Contracts

- [ ] ID vocabulary frozen: `organization_id`/`workspace_id`, `business_id`/`entity_slug`, `user_id`, `agent_id`, `node_id`, `device_id`, `job_id`, `receipt_id`, `event_id`
- [?] `organization_id` vs `workspace_id` — kernel currently ships `workspaces` only, no separate org table. Confirm or correct.
- [ ] Request envelope (who, as which business, asking for what, with which idempotency key)
- [ ] Response envelope
- [ ] Event envelope — partly implied by `platform_events`; not written as a contract
- [ ] Error taxonomy — stable codes, not message strings
- [ ] Canonical field-path vocabulary (`hours.monday.close`, `profile.phone`) — the thing the Field Map translates through
- [~] Capability key vocabulary — dotted, format enforced in `capability_catalog`; 9 seeded
- [ ] Event type catalog — dotted format enforced; no catalog table yet
- [~] Table classification vocabulary — 5 values, enforced
- [~] Visibility vocabulary — 8 values, enforced
- [ ] Versioning rule for all of the above

### Layer 1 — Identity, tenancy, canonical truth, provenance

- [~] `workspaces`, `workspace_members`, `workspace_entities`, `roles`, `role_permissions`
- [~] Constraints on `entity_owners` (unique per person-per-business, one primary)
- [ ] **Populate `entity_owners`** — 0 rows live. Nothing in the owner dashboard works until this is real. **This is the production blocker.**
- [ ] Workspace/business selector in the UI, replacing `ownerAuth`'s `.limit(1)`
- [~] Parent/child businesses — FK and self-parent check, added `NOT VALID`
- [ ] Validate those two constraints after checking the existing 4,000 rows
- [~] `table_registry` + `column_registry` + `table_registry_gaps`
- [ ] **Classify the 319 business-scoped tables.** Until this is done the registry-driven dashboard shows nothing. This is real, unglamorous work and it is on the critical path.
- [~] `source_field_observations`, `data_conflicts`, `data_conflict_options`
- [ ] Conflict-detection job — nothing writes conflicts yet
- [?] **Authority ranking** — who wins between owner-declared, Google, Yelp, POS, website? `authority_rank` exists; the actual ranking does not. No document specifies it.
- [ ] Conflict-resolution screen in the dashboard
- [ ] Migration plan for the 582 tables across the `site_id` / `business_id` / `entity_slug` generations

### Layer 2 — Capabilities, permissions, policy, secrets, workflows

- [~] `capability_catalog`, `capability_implementations`, `execution_routes`
- [ ] Capability catalog filled out beyond the 9 seeded
- [ ] `permission_catalog` filled out and wired to roles
- [ ] AuthorizationProvider interface + OpenFGA behind it
- [ ] OpenFGA model (who may act as which business, on which capability)
- [ ] PolicyProvider interface + OPA behind it
- [ ] Policy rules producing AUTO / ASK / NEVER
- [ ] The ASK path end to end — a request that stops and waits for a human
- [ ] SecretStore interface + OpenBao behind it
- [ ] Migrate any credentials currently in the database or env into it
- [ ] WorkflowEngine interface; Postgres job queue for MVP, Temporal behind the same interface later
- [?] **"capability" naming collision** — `routes/capabilities.js` means business inventory. Live with it, or rename one side.

### Layer 3 — Execution and proof

- [~] `execution_jobs`, `execution_attempts`, `verification_checks`, `action_receipts`, `receipt_evidence`
- [~] Trigger refusing a VERIFIED receipt with no verification behind it
- [~] `platform_events`, `event_consumers`
- [ ] Job runner — claims a job, picks a route by priority, records the attempt
- [ ] Verifier — separate process from the executor, on purpose
- [ ] Receipt issuer + signer (`content_hash`, `signature`, `signer_key_id` — Sigstore/cosign, not a blockchain)
- [ ] Evidence capture to object storage, with retention
- [ ] Event bus wiring — `business.hours.changed` fans out to subscribers
- [ ] Idempotency enforced at the API edge, not just by the unique index
- [ ] Retry and backoff policy per provider kind

**Executors**

- [ ] Executor interface — every kind implements the same shape
- [ ] API executor (vendor REST APIs)
- [ ] BrowserExecutor — Playwright
- [ ] AndroidRuntime — **ReDroid in Docker, one container per device**, ADB control, scrcpy for watching
- [ ] MobileExecutor — DroidRun on top of that
- [ ] MCP executor — for tools that expose MCP
- [ ] Manual executor — a human does it and records what they did (needed for the tail, and honest)
- [ ] SandboxProvider — Cloudflare Sandbox / Gondolin
- [ ] MeshProvider — reaching nodes and devices wherever they are

**Device fleet** — expanded per your note about Docker

- [ ] Base ReDroid image, versioned and pinned
- [ ] One container per device, with a stable `device_id` recorded on every attempt
- [ ] Device registry: which container, which accounts it is signed into, which business it acts for
- [ ] **Per-account device affinity** — the same account always returns to the same device fingerprint. Rotating containers under one Instagram account is the fastest way to get it flagged.
- [ ] Egress strategy per account (residential vs datacenter IP)
- [ ] Session and cookie persistence across container restarts
- [ ] Health checks, and a device taken out of rotation when it fails them
- [ ] Provisioning and teardown, so a business's devices are created with the business
- [ ] Screen recording captured as receipt evidence

### Layer 4 — The Five Maps and the Tool Digital Twin

- [ ] Canonical Map — the shape of business truth
- [ ] Field Map — canonical field ↔ each tool's field
- [~] Capability Map — capability ↔ implementation ↔ route
- [ ] Tenant Map — which business has which accounts on which tools
- [ ] AppMap — every control of every tool, at the individual-control level
- [ ] `tool_catalog` beyond `platform_connections` (which is Composio-shaped and web-only)
- [ ] `tool_controls` — the actual twin. Not built. This is the largest single piece of work in the entire project.
- [ ] Control fingerprinting, so a moved button is recognised as the same control
- [ ] AppMap repair loop — detect drift, re-map, re-verify
- [ ] Daily test fleet exercising every mapped control
- [?] **Map acquisition at scale** — who maps 3,000 Toast controls, who reviews what an AI discovered, and what the daily cost of keeping it true is. **No document you have written addresses this. It is the biggest unanswered question in the project.**
- [ ] Global map / per-customer values split (the map is shared, the values are not)

### Layer 5 — Models, memory, agents, builders

- [ ] ModelRuntime interface — Ollama / llama.cpp / vLLM behind it
- [ ] AgentRuntime interface — Hermes, Pi Agent Core
- [ ] BuilderProvider interface — Grok Build, Pi
- [ ] Agent memory
- [ ] Agent identity — `agent_id`, and agents going through the same policy path as people
- [?] **Harness roster** — OpenClaw / Hermes / ZeroClaw in one document, OpenClaw / Odysseus in another. Pick.
- [ ] Model pinning by commit SHA, per your xAI note

### Layer 6 — The six ecosystems

- [~] Data Modules — `module_catalog` exists; `entity_module_preferences` written
- [ ] Module presence derived from row existence, not from a flag
- [~] Ghost Apps — `app_catalog`, `entity_app_installs`
- [x] Connections — `platform_connections` (1,070 tools) + `entity_connections`
- [~] Device Apps — `device_app_catalog`, `entity_device_app_installs`
- [~] Plugins — `plugin_catalog`, `entity_plugin_installs`
- [~] Automations — `automation_catalog`, `entity_automation_installs`
- [ ] **Install controls visibility, enforced end to end.** No install row → no nav, no permission, no route that answers. Song Request is the test.
- [ ] Install / uninstall flows
- [ ] Plugin sandboxing actually enforced (`runtime = 'sandbox'` is currently just a column)
- [?] Package/plan tiers — two documents disagree on the list

### Layer 7 — Surfaces

**Owner dashboard** (`Dashboards-users-`)

- [ ] `GET /api/business/workspace` — the manifest endpoint
- [ ] Rewrite `lib/businessTables.js` to read `table_registry` instead of "has an `entity_slug` column"
- [ ] Gut the table sweep in `src/pages/Dashboard.jsx`; render from the manifest
- [ ] Workspace / business switcher
- [ ] Connected Accounts screen ("credit accounts")
- [ ] Install screens for all six ecosystems
- [ ] Receipts / activity screen — where a business sees what Ghost did for them
- [ ] Conflict-resolution screen
- [ ] Approvals inbox — where ASK lands

**Public front-facing layer** — the A9ENT-shaped part

- [ ] Public profile renderer, driven by `visibility_class`
- [ ] Listings / menu / hours rendered from canonical truth
- [ ] Lead and submission capture → `CUSTOMER_SUBMISSION`
- [ ] QR and NFC sharing rails
- [ ] Theming per business
- [ ] Link-in-bio surface
- [ ] SEO and social cards

**Admin dashboard** (`admin-dashboard-main`)

- [ ] Table classification queue — working `table_registry_gaps` down
- [ ] Capability and implementation management
- [ ] Route health, and repair queue
- [ ] Fleet and device console
- [ ] Tool map review queue

**GCR** (`gcr-unified`) — consumer demand side

- [ ] Confirm its relationship to the kernel; it reads canonical truth, it does not own it

**MCP** (`routes/mcp.js`)

- [x] Wrapper over the same handlers, no database key of its own
- [ ] `business_mcp_tokens` table — referenced in `CLAUDE.md`, does not exist live
- [ ] MCP tools exposing capabilities, still with no slug argument

**Device apps**

- [ ] QR menu on the table
- [ ] Kiosk
- [ ] Song Request

### Layer 8 — Cross-cutting (Section 28 and children)

- [ ] **Metering and billing** — credits ledger, Stripe, plan enforcement. Nothing exists.
- [ ] Usage metering per capability execution
- [ ] Observability — structured logs, traces across job → attempt → verification, metrics
- [ ] Alerting on route health decay
- [ ] **Rate limits, ToS and account bans.** Driving Yelp / Facebook / Instagram at scale will get customer accounts flagged. Nothing in any document addresses pacing, per-account budgets, backoff on soft-blocks, or what you do for a customer whose account you got suspended. **This is a business risk, not just an engineering one.**
- [ ] Data retention and deletion (evidence contains customers' screens)
- [ ] Backup and restore
- [ ] Security review of the plugin sandbox and the device fleet
- [?] Open-core split — extract a framework repo, or open `gcr-api-clean`?
- [ ] Patent Ideas 1–48 — never reviewed against what is being built

---

## 6. What is decided

- `entity_id` (uuid) is the relational key; `slug` (text) is the public identifier
- Capability keys are dotted, with a display label written for a business owner
- Only `gcr-api-clean` talks to the database. No dashboard, no MCP server, holds a key.
- The slug comes from the session, never from the request. Admins are the one exception and are checked against `platform_admins` first.
- One copy of every shared guard
- Modules are discovered from row existence, not enabled from a preset list
- Install controls visibility
- Verification is separate from execution, and a receipt requires it
- Every OSS choice sits behind an interface. No vendor name in a column name.
- Receipts are signed, not chained. Sigstore/cosign, not a blockchain.
- `apps` / `site_apps` are obsolete and left alone rather than repaired

## 7. Open conflicts — your call, nobody else's

1. **SAM's expansion** — three different names across the posters
2. **Package tier lists** — two posters disagree
3. **Harness roster** — OpenClaw/Hermes/ZeroClaw vs OpenClaw/Odysseus
4. **Open-core split** — extract a framework repo, or open this one
5. **"capability" naming collision** — inventory vs. action
6. **Organization vs. workspace** — one container or two

## 8. The gaps that appear in no document you have written

These are not oversights in the specs. They are things the specs do not know
about yet, and each one can stop the project:

1. **Tool map acquisition at scale.** Who maps 3,000 Toast controls. Who reviews
   AI-discovered controls before they are trusted. What the daily test fleet
   costs to run. This is the single largest unanswered question.
2. **Conflict authority ranking.** The schema has a column for it. Nothing says
   what the ranking is.
3. **Rate limits, ToS, and account bans.** The failure mode is a customer's
   Instagram account suspended because of something Ghost did on their behalf.
4. **The 582-table migration** across three generations of tenant key.
5. **Metering, security and observability** — Section 28 and its children exist
   as a heading, not as a spec.
6. **Patent Ideas 1–48** — never cross-checked against the build.

---

## 9. Immediate next three

In order, and nothing else matters until these are done:

1. **Populate `entity_owners`.** Zero rows. Nothing works.
2. **`GET /api/business/workspace`** + rewrite `lib/businessTables.js` to read
   `table_registry`. This is what turns the kernel from schema into behaviour.
3. **One capability end to end** — `business.hours.update` through one provider:
   canonical change → event → capability → route → job → attempt → read-back →
   verification → signed receipt. Once that path is real once, every other
   capability is filling in a table.
