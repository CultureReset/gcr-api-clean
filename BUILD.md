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

## 3b. The Universal App Store document — this is not a separate platform

It is the same platform, described from the top down. What has been built so far
is the same platform from the bottom up. They meet, and the join is clean.

The strongest evidence is that the document independently re-derives structures
that are already in the kernel, without knowing they exist:

| That document says | Already in the kernel |
|---|---|
| §32 `data_sources`, `field_sources` | `source_field_observations` |
| §39 conflict UX — *"Google 9 PM vs Ghost 10 PM, which is authoritative?"* | `data_conflicts` + `data_conflict_options` |
| §33 `data_change_log` with `actor_type` owner/staff/integration/AI/system | `platform_events.actor_kind` |
| §42 install → dashboard visible → routes enabled → MCP tools available | Install controls visibility |
| §46 *"never add an industry field to the core business table"* | `table_registry` classification |
| §34 permission gateway — who / what business / what app / what action | Capability + policy layer |
| §35 third-party apps never get database credentials | `plugin_catalog.runtime = 'sandbox'` |
| §38 the app contract — tables, routes, components, events, permissions | `app_catalog` |

The Google-versus-Ghost closing-time example in §39 is, word for word, the case
already written into `sql/kernel/test/assertions.sql`. Two independent
derivations landing on the same structure is the strongest signal available that
the structure is right.

**So it is one platform.** Building it separately would mean two event buses,
two permission systems, two conflict resolvers and two copies of provenance —
and the rule in `CLAUDE.md` about a guard that exists twice drifting until one
has a hole applies at platform scale, not just to a function.

### What genuinely can ship separately, and later

Not the app store. **The third-party developer marketplace** — developer
accounts, payouts, moderation, security review, revenue splits, community apps
in a sandbox. That is roughly twenty tables and an entire trust problem, and
none of it is needed to run Ghost Apps you wrote yourself.

**The app manifest is the seam.** If the manifest contract is right now — data
models, components, actions, events, permissions, routes, version — then a
first-party app and a community app are the same object, and the marketplace
becomes additive later rather than a rewrite. Get the manifest wrong and the
marketplace is a second platform.

### One thing in that document corrects what was built

§32 puts source priority **on the business, per field**:

    Menu price:  1. Toast   2. Owner Dashboard   3. Website
    Hours:       1. Owner Dashboard   2. Google   3. Yelp

The kernel has `authority_rank` on each observation — a property of the
observation, set by whatever collected it. That is the wrong place. The
restaurant is the one who knows that Toast owns their prices and they own their
hours, and it differs per business and per field. `source_priority_rules` is
needed, and `authority_rank` becomes the fallback when no rule exists.

This is the answer to the open question flagged as *conflict authority ranking*.
It was never a platform-wide ranking. It is per business, per field, set by the
owner.

### What the document adds that the kernel has no answer for

- **`profile_sections`** — the business drags sections into order and picks how
  each renders. This is the MySpace half of the product and nothing in the
  kernel touches it.
- **App slots** — `hero`, `content`, `sidebar`, `feed`, `modal`, `full_page`,
  `floating_action`. An app declares which it supports.
- **Apps own tables.** `table_registry` classifies a table but does not record
  which app owns it, so uninstalling Menu cannot hide the menu tables.
- **Locations.** Every industry table in that document carries `location_id`.
  The kernel has businesses and parent/child businesses, and no locations.
- **One customer identity across every business** — phone-based, separate from
  the business-side `users`, with each business seeing only what it may.
- **Structured feed posts** that reference a real object rather than carrying
  text — an availability change renders as a live card. This hangs off
  `platform_events` naturally and is a genuinely good idea.
- **A bookable-object abstraction** across charter departures, cruise
  departures, restaurant reservations, rentals and appointments.

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

## 4b. What is left, and what open source actually removes

162 items left. Every one is one of three kinds of work, and they do not cost
the same thing:

| | |
|---|---|
| **assemble** | A mature open-source project or an existing service does the substance. You wire it up. Days, not weeks. |
| **author** | Nothing exists to download. The design, the decision or the data is yours. |
| **operate** | Never finishes. A running cost, not a build. |

    assemble   66
    author     90
    operate     6

Per layer, which is where it gets interesting:

| Layer | assemble | author | operate |
|---|---:|---:|---:|
| 00 Contracts | — | **12** | — |
| 01 Identity & canonical truth | 2 | 15 | — |
| 02 Capabilities & policy | 4 | 8 | — |
| 03 Execution & proof | 16 | 11 | 1 |
| 04 The Five Maps | — | **10** | 2 |
| 05 Models & agents | 5 | 2 | — |
| 06 The six ecosystems | 3 | 13 | — |
| 07 Surfaces | 25 | 11 | — |
| 08 Cross-cutting | 5 | 3 | 2 |
| 09 Developer marketplace | 6 | 5 | 1 |

**Layer 07 is 25 assemble against 11 author.** That is the public page and the
owner dashboard — the A9ENT-shaped part. Profile renderer, listings, lead
capture, QR and NFC, theming, analytics, photo enhancement, booking: every one
of those is something you configure rather than write. And the six-to-ten-week
estimate in that teardown was for somebody starting at zero. This is not zero:
there is already a database with 4,067 businesses and 11,147 menu items, an API
that talks to it, a dashboard shell, a connections catalog of 1,070 tools, and
the kernel schema. That layer is not ten weeks.

**Layer 04 is zero assemble.** Not low — zero. There is no open-source map of
Toast's controls, none of Google Business Profile's admin, nothing that says the
hours field moved last Tuesday. Playwright gives you a browser; it does not give
you the map, and the map is the product.

**Layer 00 is zero assemble for a different reason:** a contract is a decision.
Nobody can publish your capability vocabulary or your canonical field paths, and
everything above inherits whatever you pick.

So what the open-source stack does is real and specific. It takes the plumbing
to near zero, which frees the calendar for the map. It does not shorten the map.

### What is genuinely assembled, and from what

| | |
|---|---|
| Browser execution | Playwright |
| Android execution | ReDroid in Docker, ADB, scrcpy, DroidRun |
| Authorization | OpenFGA |
| Policy | OPA |
| Secrets | OpenBao |
| Workflow | Temporal, or a Postgres queue to start |
| Mesh | Tailscale, NATS, WireGuard |
| Sandbox | Cloudflare Sandbox, Gondolin |
| Models | Ollama, llama.cpp, vLLM |
| Agents | Hermes, Pi Agent Core |
| Builders | Grok Build, Pi |
| Analytics | Umami |
| Photo enhancement | Real-ESRGAN, GFPGAN, CodeFormer |
| Video | FFmpeg for motion; a rented API only for true generative |
| Booking | Cal.com / Cal.diy |
| Profile rendering | LinkStack / LittleLink concepts |
| Signing | Sigstore, cosign |
| Observability | OpenTelemetry |
| Billing | Stripe |
| QR / vCard / NFC | Commodity libraries |

### What has to be authored, and cannot be shortened

1. **The Tool Digital Twin** — `tool_controls`, field maps, control fingerprints,
   the repair loop. Original data acquisition, per tool, forever.
2. **The contracts** — IDs, envelopes, errors, event types, capability keys,
   canonical field paths.
3. **Classifying the 319 business-scoped tables.**
4. **Populating `entity_owners`.**
5. **Verification strategy per capability** — how you read back a Google hours
   change is not how you read back a Toast price change.
6. **The app manifest contract** — the seam the whole marketplace hangs off.
7. **`source_priority_rules`, locations, customer identity, bookable objects.**

### What never finishes

Daily test fleet · map acquisition at scale · rate-limit, ToS and ban pacing ·
egress and device reputation · security review · marketplace moderation.

These are staffing and operating decisions, not sprints, and they start the day
the first customer's account is driven by the fleet rather than at the end.

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
- [ ] **Authority ranking** — answered: it is set per business, per field, by the owner. Not a platform-wide ranking. Implement as `source_priority_rules` below.
- [ ] Conflict-resolution screen in the dashboard
- [ ] Migration plan for the 582 tables across the `site_id` / `business_id` / `entity_slug` generations
- [?] **Locations.** Every industry table in the app-store document carries `location_id`. The kernel has businesses and parent/child businesses, and no locations. A separate `business_locations`, or a child entity per location?
- [ ] **`source_priority_rules`** — per business, per field, an ordered list of sources. Replaces `authority_rank` as the primary answer; the rank becomes the fallback when no rule exists.
- [ ] **One customer identity across every business** — phone-based, separate from the business-side `users`, with each business seeing only what it is permitted to
- [ ] Bookable-object abstraction — charter departure, cruise departure, reservation slot, rental, appointment
- [ ] `external_bookings` — external booking id ↔ internal object, per source

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
- [ ] **`table_registry.owner_app_key`** — an app owns its tables, so uninstalling Menu hides the menu tables
- [ ] **The app manifest contract** — data models, components, actions, events, permissions, routes, billing, version. This is the seam that lets the marketplace be additive later instead of being a second platform.
- [ ] App versions and release channels
- [ ] App data namespacing for third-party apps — `community.band-vote.*`, isolated
- [ ] Industry templates — a named bundle of installs, and nothing more
- [ ] Uninstall disables; it never deletes the business's data
- [?] Package/plan tiers — two documents disagree on the list

### Layer 7 — Surfaces

> **Correction, 2026-08-24.** This layer was first written from the spec
> documents rather than from the code, and it badly understated what exists.
> There are 281 UI files across the three front-ends — a working owner
> dashboard with phone auth, a business picker, twelve section renderers,
> inline editing and an app-store view; a public app with thirty-odd pages
> including a real business profile; and an admin dashboard of 135 files. The
> items below are what is genuinely missing, not the whole layer.

**Owner dashboard** (`Dashboards-users-`)

- [ ] `GET /api/business/workspace` — the manifest endpoint
- [ ] Rewrite `lib/businessTables.js` to read `table_registry` instead of "has an `entity_slug` column"
- [ ] Gut the table sweep in `src/pages/Dashboard.jsx`; render from the manifest
- [x] Workspace / business switcher — `pages/BusinessPicker.jsx`
- [x] Connected Accounts screen — `pages/AppStore.jsx` over `/api/connections`
- [ ] Install screens for all six ecosystems
- [ ] Receipts / activity screen — where a business sees what Ghost did for them
- [ ] Conflict-resolution screen
- [ ] Approvals inbox — where ASK lands

**Public front-facing layer** — the A9ENT-shaped part

- [x] Public profile renderer — `gcr-unified/pages/BusinessDetail.jsx`, though not yet driven by `visibility_class`
- [ ] Listings / menu / hours rendered from canonical truth
- [x] Lead and submission capture — claim, book service, book rental, confirmation. Not yet classified.
- [ ] QR and NFC sharing rails
- [ ] Theming per business
- [ ] Link-in-bio surface
- [ ] SEO and social cards
- [ ] **`profile_sections`** — the business drags sections into order. This is the MySpace half of the product.
- [ ] **App slots** — `hero`, `content`, `sidebar`, `feed`, `modal`, `full_page`, `floating_action`; an app declares which it supports
- [ ] Display variants per section — list, cards, accordion, modal, carousel, tab, button
- [ ] Website widgets — `<ghost-app business="cobalt" app="menu">` on the owner's own site
- [ ] White-label rendering — a chamber site showing permitted Ghost data, not a copy of it
- [x] Consumer home and Explore — Home, Browse, CategoryPage, Deals, Events, Swipe, Itinerary
- [ ] Structured feed posts referencing a real object, so the card stays current when the object changes
- [ ] Social graph — entities, relationships, follows, saved items
- [ ] Design system with controlled customization — theme, accent, font pair, radius, order, visibility. No arbitrary CSS.

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

### Layer 9 — The developer marketplace *(ships last, behind the manifest)*

The one part that genuinely can be built separately and later — not because it
is unimportant, but because none of it is needed to run apps you wrote yourself,
and all of it hangs off the app manifest contract.

- [ ] `developer_accounts`, `developer_organizations`, `developer_members`, `developer_payout_accounts`
- [ ] Marketplace listings, prices, purchases, subscriptions, reviews, refunds
- [ ] `marketplace_transactions`, `developer_earnings`, `developer_payouts`, `platform_fees`
- [ ] Revenue split, and the pricing models a developer may choose
- [ ] App moderation, version review, security scans
- [ ] Sandboxed app runtime — third-party code reaches data only through the SDK and the permission gateway
- [ ] Permission consent screen at install — what the app gets, and what it explicitly does not
- [ ] Developer test business, pre-populated
- [ ] Developer SDK
- [ ] **Ghost App Builder** — no-code and AI, emitting the same manifest as the SDK
- [ ] Builder primitives — data types, UI components, actions, triggers
- [ ] Automation builder — when / if / then, in the owner's language

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
2. ~~**Conflict authority ranking.**~~ **Answered** by §32 of the app-store
   document: it is not a platform-wide ranking, it is set per business, per
   field, by the owner. Needs `source_priority_rules`.
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
