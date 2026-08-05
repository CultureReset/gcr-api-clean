# gcr-api-clean — The Complete Wiring Blueprint

The canonical in-repo version of the API spine teardown: every file, every
route, every table, every external connection, and what is live versus dead.

**Provenance.** §0–11 and Appendices A–S are the blueprint computed against
`main` at HEAD `b75300c` (2026-08-04) — 100% of the application code read line
by line, in the passes recorded in each appendix's status line. This file
carries that work with **four corrections and one new section** folded in from
the verification pass at the same commit; every change is marked ⟲ and the
reasoning is in `docs/BLUEPRINT_VERIFICATION.md`.

**Scope measured on disk:** 198 files · 59,034 lines of JS · **76 route files**
(75 in `routes/` + `routes/gcr/deep-crawl.js`) · 13 libs · 2 middleware · 11
utils · 2 extractors · 3,029 lines of SQL · 6 guard scripts · 4 Vercel crons.

> ⟲ The original scope line read "174 files, ~59,367 lines, 75 route files."
> Cosmetic; the per-file counts it reasons from are correct.

This repo is the single spine: all three front ends (`gcr-unified`,
`Admin-dashboard-main`, `Dashboards-users-`) talk only to this API, and this
API is the only thing that touches Postgres. See
`docs/INTERCONNECTION_MAP.md` for how the four fit together.

---

## 0. What this repo is

One Express app (`server.js`) deployed to Vercel as a serverless function. It
is the only code that holds the Supabase service-role key and the only code
that opens a database connection — every front end, every AI agent, every
webhook goes through an HTTP route here. **That is the platform's central rule:
only this API touches Postgres, including when the caller is a model.**

It carries **two full architectural generations** in one codebase, side by side:

- **LEGACY**, keyed by `site_id` — `businesses`, `site_apps`, `site_content`,
  `connections`, `apps`. The Circle Boats / per-site era.
- **MODERN**, keyed by `entity_slug` — the `entity` table plus ~100 `entity_*`
  tables, `entity_owners`, `entity_connections`, `entity_modules`. The
  universal-spine era.

Neither has been deleted. Two files bridge them so the old front-end read/write
shapes keep working on modern tables (`routes/dashboard.js` write-side,
`routes/public.js` read-side). **Understanding that split is the key to
understanding the whole repo** — §8.

---

## 1. Entry point & boot — `server.js` (388 lines)

### 1.1 CORS (L12–70)

Was `origin: '*'` (any page could make authenticated requests from a visitor's
browser); now an allow-list. `DEFAULT_ORIGINS` is baked in so the file is
correct with zero config: the two GCR domains, `dashboard.gulfcoastradar.com`,
the two business-dashboard Vercel hosts, the two admin-dashboard Vercel hosts,
and `gcr-unified.vercel.app`. `CORS_ORIGINS` env **adds** to this list, never
replaces it, so forgetting to set it can't take the dashboards down.

Requests with no Origin header (server-to-server, curl, Twilio/Stripe webhooks,
health checks) pass through — CORS is a browser mechanism, and anything that can
omit an Origin can also forge one. Localhost is allowed only when not a
production deploy. A refused origin returns `callback(null, false)` (no header),
not an error — an error there would become a 500.

### 1.2 Body limit (L72)

`express.json({ limit: '10mb' })` — one global JSON parser, 10 MB ceiling
(image-base64 uploads ride through here).

### 1.3 Rate limits (L74–135) — three limiters

`trust proxy = 1` first, or every request behind Vercel's edge looks like one IP.

- **`authLimiter`** — 20/15 min per IP, on `/api/business-auth` and
  `/api/tourist-auth`. These spend Twilio messages; both signup systems are
  public by necessity.
- **`publicMcpLimiter`** — 600/min, on `/api/mcp/public` and
  `/api/mcp/business`. Keyed on the caller's credential (hashed authorization
  header or `x-guest-id`), falling back to IP only for anonymous traffic. This
  is deliberate: a hosted voice agent relays a thousand conversations from a
  handful of IPs, so a per-IP ceiling would throttle the whole platform at a
  dozen simultaneous calls. **The limit exists to stop someone walking the whole
  directory, not to ration a conversation.**

### 1.4 The mount loader (L137–150) — the fail-safe pattern

```js
function mount(path, loader) {
  try { app.use(path, loader()); mountedRouters.push(path); }
  catch (e) { console.error(`[mount skipped] ${path}: ${e.message}`); }
}
```

A broken/WIP route file is skipped with a warning instead of crashing boot. The
loader thunk **MUST** contain a literal `require('./...')` string so Vercel's
bundler statically traces and bundles the file — a dynamic `require(variable)`
would 404 in production. This is why every mount is written
`() => require('./routes/x')`.

### 1.5 Self-identifying root (L156–161)

`GET /` returns live build identity: commit (from `VERCEL_GIT_COMMIT_SHA`),
environment, router count, and the actual list of mounted paths. This replaced a
hand-written version string + endpoint list that went stale the moment anything
moved — which is why a live deployment used to look abandoned from the root URL.
**The root is now self-describing; trust it over any doc.**

### 1.6 Error handler (L382–385)

One catch-all: logs the error, returns 500 `{ error: err.message }`.

### 1.7 The full mount map (L164–380) — 67 live mounts, 8 commented out

**Live core:** `/api/auth`→auth · `/api/gcr`→gcr · `/api/admin`→admin **and**
admin-settings **and** (`/api/admin/gcr`) business-profile and ingest (three
routers share the `/api/admin` prefix additively) · `/api/dashboard`→dashboard ·
`/api/public`→public · `/api/user`→user · `/api/site`→site.

**Menu editing:** `/api/menu-editor` · `/api/menu-edit` · `/api/simple`→simple-menu-edit.

**Business (modern):** `/api/business`→business-data (replaced the dashboard's
direct PostgREST access — and with it, the anon key in a public browser bundle).

**AI / MCP:** `/api/mcp/public`→mcp-public · `/api/mcp/business/:slug`→mcp-public.pinned
· `/api/mcp`→mcp (token-authed, writable).

**Auth systems** (two, deliberately separate, no shared code):
`/api/business-auth` · `/api/admin/signups` · `/api/tourist-auth` ·
`/api/tourist` · `/api/tourist/groups` · `/api/admin/tourists`.

**Capability / booking engine (modern):** `/api/admin/platform`→admin-platform ·
`/api/platform`→platform (the ONE universal booking + module engine, slug-scoped).

**Composio App Store:** `/api/admin/connections`→composio (admin catalog) ·
`/api/connections`→composio.ownerRouter.

**Admin extras:** `/api/admin/setup-questions` · `/api/admin/analytics` ·
`/api/intake` + `/api/admin/intake` · `/api/dashboard-sms` · `/api/embed`.

**Google:** `/api/google-business` — remounted; `oauth_tokens` now exists, keyed
by `entity_slug`, OAuth state signed. **Carries proof: Google made the business
verify its address, so connecting is evidence the business is real.**

**Payments:** `/api/stripe` · `/api/square` · `/api/webhooks`→webhooks **and**
email-webhook (two routers on the same prefix).

**Booking types (modern live):** `/api/availability` · `/api/transportation` ·
`/api/platform`. Third-party: `/api/integrations/fareharbor`.

**Mini-site feature routes:** `/api/reviews` · `/api/team` · `/api/gallery` ·
`/api/faqs` · `/api/blog` · `/api/bookings` · `/api/analytics` · `/api/artists`
· `/api/artist-bookings` · `/api/cooperatives` · `/api/goals` ·
`/api/meta-webhook` · `/api/rentals` · `/api/services` · `/api/live-photo` ·
`/api/ai-provider` · `/api/voice-notes` · `/api/deals` · `/api/ocr` ·
`/api/verify-dns`.

**QR / links / updates:** `/api/qr` · `/api/ar-hunts` · `/api/links` ·
`/api/update` (+ `/update`) · `/api/sms`.

**Deep-crawl / photo repair:** `/api/gcr/deep-crawl` · `/api/gcr/admin`→rehost-photos.

**COMMENTED-OUT (dead, each with a reason in the file):** `/api/apps`
(superseded by composio; backing tables empty & schema drifted) · `/api/modules`
· `/api/boat-rental` · `/api/charter` · `/api/rides` (superseded by
`/api/transportation`) · `/api/photographer` · `/api/messaging` ·
`/api/whatsapp` — all: *"backing tables don't exist in the live DB — the ONE
universal engine (`/api/platform`) replaced these."*

**Duplicate mounts (both live, additive):** `/api/admin/gcr` twice
(business-profile.js + ingest.js) · `/api/webhooks` twice (webhooks.js +
email-webhook.js) · `/api/email-parser` twice (same file, L374–375 — a redundant
double mount).

---

## 2. The database layer

**`db.js` (13)** — the one client.
`createClient(GCR_SUPABASE_URL || SUPABASE_URL, GCR_SUPABASE_SERVICE_KEY ||
SUPABASE_KEY)`. Service-role, full access. Almost every route imports this.
Exits the process on boot if the env vars are missing.

**`db-old.js` (8)** — legacy duplicate client, older env-var names. Superseded.
Still on disk; harmless but redundant.

**Client sprawl:** several files create their own Supabase client instead of
importing `db.js` — `lib/staff-commands.js`, `lib/edit-log.js`,
`utils/ai-provider.js`, `routes/gcr.js`, `routes/admin.js`, `routes/menu-editor.js`.
Same credentials, minor inconsistency, not dead.

---

## 3. Authentication — two generations, one bridge

**`middleware/auth.js` (82) — LEGACY (`site_id` world).** `authRequired` tries
an Express JWT first (`JWT_SECRET` → `req.userId`, `req.siteId`, `req.role`); on
failure falls back to a Supabase JWT, looking the user up in `users` by
`auth_id` then by email (the Circle Boats path, back-filling `auth_id`), else
treats it as a GCR Supabase JWT (`req.gcrUserId`, `req.isGCR`).
`adminRequired` = `authRequired` + `role === 'admin'`.

**`middleware/ownerAuth.js` (98) — MODERN (`entity_slug` world).**
`sessionRequired` verifies the Supabase token and attaches identity only (used
by `GET /api/business/me`, whose whole job is to report whether the account owns
anything — so it can't sit behind a guard that 403s when it doesn't).
`ownerRequired` verifies the token, then resolves the business from
`entity_owners` by `user_id` → `req.entitySlug`. **The slug is never taken from
the request.** An admin (checked against `platform_admins`) may act on a
business, but only by naming it explicitly (`?business=`, `?slug=`, body, or
`:slug`), and only because they're vouched for.

**`lib/entity-resolver.js` (81) — THE BRIDGE.** Resolves `{ id, slug }` across
three fallbacks: (1) `entity_owners` by `user_id`, (1b) `entity_owners` by
`siteId` (BookPro/platform accounts store the business id there), (2)
`users.entity_id`/`entity_slug`, (3) `entity.legacy_site_id === req.siteId`.
This is what lets the legacy write-mirror operate on modern entity-keyed tables.
**It is the seam between the two generations.**

**`lib/find-existing-entity.js` (41) — duplicate prevention.** Every path that
writes a new entity row (deep-crawl, CSV import, self-signup) calls this. Matches
only on exact `google_place_id` or exact phone via RPC `find_existing_entity` —
safe to auto-act on. Fuzzy name similarity (`fuzzy_entity_search`) is surfaced
as an advisory (`possibleFuzzyDuplicate`) for a human, never auto-merged,
**because a wrong merge misattributes data to a live page — worse than the
duplicate it would fix.**

---

## 4. Core shared libraries (`lib/`, 13 files, 2,678 lines)

**`lib/industry-contract.js` (57) — the no-hardcoded-tables router.** The DB
table `industry_table_contract` maps every `industry_code` → which tables that
industry reads/writes (`'*'` = the universal spine every business gets), plus
each industry has one `industry_<code>` facts table keyed by `entity_slug`.
`loadContract` (5-min cache), `getContractForIndustry`, `getIndustryFacts`. This
is the mechanism behind "nothing hardcoded per-industry" — **the routes and the
AI resolve tables from data, never from a code list.** Falls back to empty on
failure so a missing contract never 500s the entity payload.

**`lib/businessTables.js` (283) — the schema allow-list + public/private
firewall.** The single copy of the three guards the dashboard and the MCP
servers both use (*two copies of a security check drift until one has a hole*).
No table list anywhere: it reads PostgREST's OpenAPI doc and treats any table
with an `entity_slug` column as a business section — add a table, it appears;
drop one, it disappears, no deploy.

- `getSchema` — live schema, 5-min cache, in-flight fan-in, stale-beats-nothing
  fallback.
- `SYSTEM_COLUMNS` — `id`, `entity_slug`, `entity_id`, `site_id`, `created_at`,
  `updated_at`, `search_vector`, `embedding` — never settable by hand.
- `allowTable` / `cleanBody` — resolve a table against the live allow-list;
  strip system + unknown columns from a write.
- **The public boundary** (for the passwordless `/api/mcp/business/:slug`):
  `PERSONAL_COLUMN` regex (email / user_id / customer_/guest_/etc / payment /
  signature / ip), `PRIVATE_TABLE` regex
  (booking/reserv/orders/waiver/payment/oauth/log/etc), `SENSITIVE_COLUMN` regex
  → `whyPrivate()` explains **which column made a table private**. The switch
  `PUBLIC_MCP_HIDE_PERSONAL` (default off) decides whether the public agent sees
  everything or has personal rows/columns stripped — *a decision about your own
  customers' data, so it's config, not hardcoded.* Plus `publicTables`,
  `allowPublicTable`, `scrubRow`, `textColumns`.

**`lib/composioClient.js` (225) — the App Store engine.** Composio API v3
client. Key held server-side (`COMPOSIO_API_KEY`), never reaches a browser. v1
was retired 2026-07-03, which is why the old connect flow was already dead.
Managed auth = Composio maintains the OAuth apps, so hundreds of toolkits are one
integration (no Google Cloud project, no Facebook app review per provider).
`userIdFor(slug)` = `gcr__<slug>`. Functions: `composio` (single call,
version-overridable because categories live on v3.1 while the rest are v3),
`composioAll`, `listToolkits` / `listToolkitsPage` (paged, *because a serverless
function is killed before a full catalog walk finishes*), `listCategories`,
`listAuthConfigs`, `linkAccount`, `accountStatus`, `deleteAccount`, `health`.

**`lib/conciergeTools.js` (1,097) — the shared AI brain.** 9 read-only tools over
every active business, no slug scope, no session (public-site data):
`search_businesses`, `get_business_details`, `check_availability`,
`find_item_prices`, `find_available`, `whats_on`, `industry_sections`,
`list_categories`, `compare_businesses`. Dispatched by `runConciergeTool(name,
input)`. Lifted out of `tourist.js` so `mcp-public.js` can hand the identical
tools to any outside agent — **one copy means a better search improves the phone
agent, the chat widget, and the website at once.** `industry_sections` is itself
a runtime router: it samples businesses of a subtype and counts which sections
they actually fill (15-min cache) rather than reading a written-down list.

Reads across `entity`, `menu_items`, `drink_items`, `happy_hour_items`,
`entity_offer`(+price/fee/deposit), `inventory_items`, `subtype_taxonomy`,
`entity_events`, `entity_specials`, `business_availability`, `availability`,
`booking_calendar`, `bookable_resources`, `entity_tags`, `entity_amenities`,
`entity_hours`. Every tool returns real rows and, where data is missing, a note
telling the model to say it doesn't know — **because the failure that matters is
a confident wrong price read aloud at the door.**

**`lib/mcpServer.js` (207) — MCP protocol wrapper.** JSON-RPC 2.0 over a single
POST, answered with a plain JSON body. Everything that varies between MCP
servers — who may call, what tools exist, what they do — is passed in; nothing
about the protocol is. `createMcpRouter({ serverInfo, instructions, tools,
runTool, authenticate, authNote })`. **The two MCP servers share nothing except
this file — one transport, two policies.**

**`lib/touristMemory.js` (175) — the shared memory tools.** `remember` /
`recall` / `forget` over `tourist_memories`, keyed by user, lifted out of
`tourist.js`'s tool loop so the MCP offers the same three over the same table.
*One copy means a memory saved by the voice agent is there in the web chat and on
the phone.* `loadMemories`, `briefing(userId)`, `runMemoryTool`. Its header
states the thesis: *"an assistant that answers perfectly and remembers nothing is
a search box with a voice."*

⟲ **`lib/serviceArea.js` (218) — the coastline gate.** *(Missing from the
original §4; its behaviour appears only in Appendix L.1.)* `isInServiceArea()`
and `SERVICE_AREA_MILES`, consumed by `business-auth.js:34` (the signup gate) and
`google-business.js:31` (which uses it at L578 to set `entity.listed_on_gcr`
during profile sync).

Its header argues its own design: GCR covers **the coastline, not a region**, so
the service area is a strip drawn along ~22 anchor points between New Orleans and
Mexico Beach rather than a radius — *"Panama City is 115 miles from Orange Beach.
A circle wide enough to reach it reaches just as far north — pulling in
Montgomery, Dothan and half of inland Alabama."* A point list rather than a
polygon because it needs no geo extension, is readable, and *"adding a town is
one line."* Tunable with `GCR_SERVICE_AREA_MILES` (default 25).

**`lib/menu-gcr.js` (128)** — read/write helpers for `dashboard.js` over the
three menu table families (`menu_items`/`menu_sections`,
`drink_items`/`drink_sections`, `happy_hour_items`/`happy_hour_sections`), keyed
by `entity_id`. `listAllMenuItems`, `createMenuItem` (creates the section if
missing), `updateMenuItem`/`deleteMenuItem` (detect which of the three tables the
id lives in).

**`lib/staff-commands.js` (82)** — SMS quick-toggles for staff. Recognizes a
staff phone in `business_staff` and treats their text as a command instead of
tourist input. Toggle-only booleans (SOLD OUT / AVAILABLE / CATCH OF DAY / ON TAP
/ SPECIAL ON/OFF) on `menu_items` / `entity_specials`, **so a "staff" role can be
given only this channel.** Logs every change via edit-log. Own Supabase client.

**`lib/edit-log.js` (23) — the audit trail.** `logEdit()` → one row in
`entity_edit_log` (who / channel / table / field / old→new). **Never throws — a
logging failure must not take down the write it describes.**

**`lib/analyze-photo.js` (61)** — Claude vision (`claude-haiku-4-5`) turns an
uploaded photo into `{ description, tags }` for swipe-deck analytics (specific
subjects: "dolphin", "seafood platter", not "outdoor"). Best-effort; never
blocks a photo save.

---

## 5. Utilities (`utils/`, 11 files, 2,009 lines)

**`ai-provider.js` (225)** — one call, any provider: Anthropic / OpenAI / Google
/ Groq / Mistral / Ollama, chosen per task from the `ai_provider_config` table
(60-s cache), default `anthropic` / `claude-sonnet-4-6`. `callAI(task, prompt,
opts)`, `getProviderConfig`, `invalidateCache`, `PROVIDERS` (the admin dropdown).
Supports image input for vision-capable providers. Own Supabase client.

**`type-config.js` (214)** — the universal upload→sections engine. `CARD_FIELDS`,
`SECTION_TEMPLATES` (required vs data-driven), `PAYLOAD_KEY_TO_SECTION`,
`SECTION_RENDER_TYPE`. `resolveSectionsForUpload()` merges required templates +
data-detected sections + **any unknown array key as a `custom_<key>` section** —
so `section_type` stays free text and a new kind of content needs no code.

**`entity-types.js` (84)** — the one genuinely hardcoded enum: 11
`VALID_ENTITY_TYPES` → 7 `VALID_PAGES` via `TYPE_TO_PAGE`, plus `SUBTYPES` and
validators. The clean canonical `entity_type` list (primary page assignment).

**`listing-category-map.js` (167)** — ⚠ **MIRROR of
`gcr-unified/src/categoryMap.js`.** A large `SUBTYPE_TO_CATEGORY` map
(Google-Places subtype → listing page). The file itself warns it must be kept in
sync with the frontend **or the server-paginated endpoint and the client filter
will silently disagree.** `subtypeToCategory`, `subtypesForCategory` (builds a
SQL `.in()` filter). Deliberately separate from `entity-types.js`.

> Mitigation on the client side: `gcr-unified` calls `GET /api/gcr/taxonomy` at
> boot and merges the live 293-subtype list over its static copy. The static map
> is still what renders first paint.

**`ical-feed.js` (65) / `ical-parse.js` (46)** — RFC 5545 generate/parse for
two-way calendar sync: GCR emits a `.ics` of blocked dates for
Airbnb/VRBO/Google to import, and reads their export feeds back in.

**`sms.js` (292)** — Twilio sender + `sms_log` + owner-relay mode (redirects
customer SMS to the owner's phone for manual forwarding when configured) +
opt-out check + `normalizePhone`. The customer SMS core.
**`sendSms.js` (6)** — a shim redirecting a broken legacy import path.

**`email.js` (371)** — the Brevo transactional email layer.
`sendEmail({to,subject,html,…})`, `smsOwnerRelay` (strips HTML → an SMS preview),
and branded builders `customerConfirmationHtml`,
`gcrReservationConfirmationHtml`. Every confirmation, review link and payment-key
link sends through here.

**`upload-processor.js` (293)** — `processBusiness(db, payload)` resolves which
sections/data a raw business payload has via `type-config` and writes everything
correctly separated by type. The write side behind `admin.js`'s importers and
deep-crawl.

**`google-places-import.js` (246)** — `googlePlaceToEntity(place)` converts a
Google Places response (v1-new and legacy) into a GCR entity upload payload;
`GOOGLE_TYPE_MAP`, `slugify`, `googlePlacesToEntities`.

### Extractors (`extractors/`)

**`cashapp.js` (66) / `venmo.js` (61)** — regex parsers that pull a `REQ-…` code,
amount, sender, memo (and CashApp `$cashtag`) out of a payment-confirmation email
→ a structured transaction. **This is the payment half of the verified-transaction
thesis:** the REQ code ties the payment back to a pre-checkout `booking_opt_ins`
row (created by `gcr.js /opt-in`), so a real peer-to-peer payment becomes a
verified transaction that can anchor a trusted review.

---

## 6. The route layer — every file, by subsystem

Each file with its line count, endpoint count, and the tables it touches.

### 6.1 Auth & accounts

- **`auth.js` (765, 13 routes)** — legacy + bridge auth: business-signup, signup,
  invite/:token, accept-invite, login, oauth-sync, logout, refresh, session,
  verify, forgot/reset-password, create-profile. Tables: `users`, `businesses`,
  `entity`, `entity_owners`, `business_invites`, `site_apps`, `site_content`.
  bcrypt 12 rounds, 7-day JWT `{userId, siteId, role}`.
- **`business-auth.js` (715, 9)** — MODERN business signup: phone → 6-digit code
  → account, plus signin/refresh/signout and a `/similar` duplicate check.
  Tables: `business_signups`, `entity`, `entity_owners`, `platform_config`.
  **The counterfeit gate** — Appendix L.1.
- **`admin-signups.js` (136, 3)** — the approval gate: nothing self-created goes
  public until an admin flips it.
- **`tourist-auth.js` (803, 11)** — tourist accounts: email+password and
  phone-OTP, add-email-to-phone-account, reset. Own product, no shared code with
  business auth. Includes `backfillAnonymousActivity(userId, visitorId)` — the
  other half of the guest model — and a self-healing Twilio Verify service
  resolver (*the env var has historically held an `AC…` account SID instead of a
  `VA…` Verify service SID*).

### 6.2 The universal spine reader — `gcr.js` (2,762, 36 routes)

`buildFullEntity()` lives here: the single source of truth that assembles a
complete entity by reading ~90 tables — the widest table footprint in the repo.
Serves the website and the AI. **Full line-by-line read in Appendix A.**

### 6.3 The universal booking + module engine — `platform.js` (2,186, 34)

The ONE engine that replaced boat-rental/charter/rides/photographer/messaging.
Slug-scoped via `entity_owners`. **Appendix E.**

### 6.4 The two mirrors (see §8)

- **`dashboard.js` (5,640, 206)** — the write-side legacy mirror. The single
  biggest file. **Appendix B.**
- **`public.js` (3,301, 52)** — the read-side legacy mirror. **Appendix D.**

### 6.5 Admin

- **`admin.js` (3,950, 188)** — the operator API. **Appendix C.**
- **`admin-platform.js` (2,224, 58)** — admin view over the booking engine.
  **Appendix J.**
- **`admin-settings.js` (261, 13)** — `platform_settings`, `business_leads`,
  `community_photos`, `category_cards`, `/provider-status`. Additive on `/api/admin`.
- **`admin-analytics.js` (271, 3)** — read-only `/entity/:slug`, `/platform`,
  `/health`. **Reports what is not tracked alongside what is.**
- **`admin-tourists.js` (167, 7)** — tourist admin.
- **`business-profile.js` (353, 5)** — one business as its own dashboard would
  show it: every slug-keyed table that actually has rows, discovered per request.
- **`ingest.js` (228, 1)** — `POST /ingest/:slug/:table`: proposes real column
  values for any slug-keyed table; **proposes only, writes nothing without review.**
- **`intake.js` (280, 9)** — a business submits links, every webhook endpoint is
  notified, operator works the queue.

### 6.6 Business dashboard (modern) — `business-data.js` (304, 8)

Everything the modern business dashboard reads/writes about its own business,
resolved from the session via `entity_owners`. `/me`, `/schema`, `/sections`,
`/industries`, and generic `/:table` CRUD gated by the `businessTables`
allow-list + column filter. **This is what removed the anon key from the browser.**

### 6.7 The App Store / Composio — `composio.js` (532, 16)

Two routers in one file. Admin router (`/api/admin/connections`) and
`ownerRouter` (`/api/connections`), the same surface scoped to the signed-in
business's own slug.

### 6.8 Tourist app — `tourist.js` (1,998, 41)

The consumer product API and the reference modern AI concierge. **Appendix F.**
Plus `tourist-groups.js` (298, 9) and `sms.js` (390, 7).

### 6.9 Owner-scoped mini-site content routes

Small, session-resolved, each one table: `reviews.js` (`entity_reviews`) ·
`team.js` (`entity_team_members`) · `gallery.js`
(`entity_gallery`/`entity_photos`) · `faqs.js` (`entity_faqs`) · `blog.js`
(`entity_blog_posts`). **The `:slug` in the path is honored only for admins;
owners resolve from session.**

### 6.10 Booking-type & vertical routes (modern, live)

`availability.js` (284, 5) · `bookings.js` (236, 6) · `rentals.js` (316, 8) /
`services.js` (261, 7) · `transportation.js` (379, 10 — the live replacement for
rides.js) · `cooperatives.js` (218) / `goals.js` (220) / `artists.js` (316) /
`artist-bookings.js` (161) — the live-music/artist economy · `deals.js` (318) ·
`ar-hunts.js` (320).

### 6.11 Menu editing (three coexisting editors)

`menu-editor.js` (1,048, 39 — PIN-authed, **Appendix I**) · `menu-edit.js` (231,
6 — lighter, id-based) · `simple-menu-edit.js` (276, 6) · `update-link.js` (1,376,
50 — the tokenized magic-link editor, **Appendix H**) · `links.js` (83, 1).

### 6.12 Payments

`stripe.js` (887, 17) · `square.js` (512, 8) · `webhooks.js` (215, 3) ·
`email-webhook.js` (289, 1). **Appendix M.**

### 6.13 The transaction-verification pipeline — `email-parser.js` (1,467, 10)

**Appendix G.**

### 6.14 MCP surface

`mcp-public.js` (568) · `mcp.js` (492). **Appendix N.**

### 6.15 Integrations & misc

`google-business.js` (603, 11) · `fareharbor.js` (439, 7 — dormant) ·
`meta-webhook.js` (323, 2) · `embed.js` (376, 3 — *public, unauthenticated, runs
on other people's domains; returns only counts/statuses, never a guest or
booking*) · `qr.js` (741, 26) · `analytics.js` (251, 5) · `dashboard-sms.js` (405,
7) · `live-photo.js` (211) / `voice-notes.js` (107) / `ocr.js` (83) /
`verify-dns.js` (56) / `setup-questions.js` (104) / `ai-provider.js` route (102) ·
`gcr/deep-crawl.js` (525, 5) · `rehost-photos.js` (145, 4).

### 6.16 The legacy `site_id` routes (still mounted)

`site.js` (456, 41) — the pure legacy `site_id` API · `user.js` (467, 34) — a
legacy owner API over `entity_*` by session.

---

## 7. Dead / orphaned / duplicated code (DELETE NOTHING — inventory only)

**Commented-out mounts (8 route files):** `apps.js`, `boat-rental.js`,
`charter.js`, `photographer.js`, `rides.js`, `messaging.js`, `modules.js`,
`whatsapp.js` — each unmounted in `server.js` with a reason; all touch tables the
comments say don't exist in the live DB.

⟲ **Correction — `routes/capabilities.js` (512) and
`routes/availability-engine.js` (324) are NOT dead.** The original §7 called them
*"genuinely dead — no require for either exists in `server.js`."* The premise is
right and the conclusion is wrong. They are not *mounted*, but they are required
as libraries:

```
routes/admin-platform.js:1131   require('./availability-engine')
routes/admin-platform.js:1628   require('./capabilities')
routes/embed.js:30              require('./availability-engine')
```

They are **load-bearing** — they back the operator console's capability editor,
`/match`, and the public embed widget. Appendix K describes them correctly as
*"the load-bearing intelligence under the operator console and the embed
widget."* They are libraries that happen to live in `routes/`; arguably they
belong in `lib/`, which is likely how the confusion arose.

**Redundant/legacy libs:** `db-old.js` (superseded by `db.js`).

**Duplicate mounts (both live, additive):** `/api/admin/gcr` (business-profile +
ingest), `/api/webhooks` (webhooks + email-webhook), `/api/email-parser` mounted
twice on the same file.

**Known mirror (must-stay-in-sync):** `utils/listing-category-map.js` ↔
`gcr-unified/src/categoryMap.js`.

**Dormant integration:** `fareharbor.js` — mounted, but no partnership.

**Orphaned from the front ends' side** (see `docs/INTERCONNECTION_MAP.md` §3):
`google-business.js` (603 lines, no UI anywhere), `analytics.js`,
`cooperatives.js` + `goals.js`, `verify-dns.js`, `site.js` + `user.js`.

**37 root scaffolding scripts** — one-off ops/import/fix tools, plus `scripts/`
(create-admin, insert-* seeders, and the guard scripts in §12).

---

## 8. The two-generations architecture (the thing to internalize)

```
     LEGACY (site_id)                        MODERN (entity_slug)
businesses, site_apps,                  entity + ~100 entity_* tables,
site_content, connections, apps         entity_owners, entity_connections,
                                        entity_modules
     │                                            │
middleware/auth.js                        middleware/ownerAuth.js
(JWT + site_id + Circle Boats)            (Supabase token → entity_owners)
     │                                            │
     └──────────── lib/entity-resolver.js ────────┘   ← the bridge
                             │
     ┌───────────────────────┴────────────────────────┐
dashboard.js (WRITE mirror)                    public.js (READ mirror)
old dashboard shape → modern tables      legacy site_id read shape ← modern
                                          tables (via entity.legacy_site_id)
```

Every "why are there two of these?" traces to this: two app-catalog systems
(`apps`+`site_apps` vs `platform_connections`+`entity_connections` vs
`entity_modules`), two auth middlewares, two DB clients, legacy
`site.js`/`user.js` beside modern `business-data.js`/`gcr.js`/`platform.js`. The
modern side is canonical; the legacy side is kept alive by the two mirrors so
nothing that still points at the old shape breaks. **The universal engine
(`/api/platform`) and the universal reader (`buildFullEntity`) are where new work
goes.**

---

## 9. External-service connection map

| Service | Where | Purpose |
|---|---|---|
| **Supabase** (Postgres + Auth + Storage) | `db.js` (+ per-file clients) | The only datastore. Service-role key held here only. Auth verifies both dashboards' tokens. Storage holds entity photos. |
| **Composio (v3)** | `lib/composioClient.js`, `routes/composio.js` | The App Store — hundreds of third-party toolkits as one managed-auth integration (`gcr__<slug>` identity). |
| **Twilio** | `utils/sms.js`, `routes/sms.js`, `transportation.js`, `webhooks.js` | Customer SMS, OTP, blasts, owner-relay, ride dispatch, inbound webhook. |
| **Stripe** | `routes/stripe.js`, `webhooks.js` | Connect onboarding, per-business keys, payment intents, refunds, platform fee. |
| **Square** | `routes/square.js` | Alternate processor: OAuth, credentials, payments. |
| **Google** | `routes/google-business.js`, `utils/google-places-import.js` | Business Profile OAuth + reviews (the one non-Composio integration; **carries address-verification proof**). Plus Places enrichment. |
| **Anthropic / OpenAI / Google AI / Groq / Mistral / Ollama** | `utils/ai-provider.js`, `lib/analyze-photo.js`, `routes/ai-provider.js` | Per-task provider selection from `ai_provider_config`; vision tagging on Claude Haiku. |
| **Brevo** | `utils/email.js`, `dashboard-sms.js` | Transactional email; the SMS-to-dashboard Q&A channel. |
| **Meta (FB/IG)** | `routes/meta-webhook.js` | Social posts, photos, hours-exception ingest. |
| **FareHarbor** | `routes/fareharbor.js` | Dormant — no partnership; belongs in Composio. |
| **Airbnb/VRBO/Google Calendar** | `utils/ical-feed.js` / `ical-parse.js`, `email-parser.js` | Two-way availability sync via `.ics`. |

---

## 10. How the three front ends attach

Summarised here; the computed matrix is in `docs/INTERCONNECTION_MAP.md`.

- **`gcr-unified` (tourist)** — 101 paths across 22 routers. Mostly
  `/api/gcr/*`, `/api/tourist*`, `/api/tourist-auth/*`, `/api/platform/*`,
  `/api/deals`, `/api/reviews`, `/api/ar-hunts`. Plus 9 static HTML pages served
  by Vercel rewrites that never reach React.
- **`Admin-dashboard-main` (operator)** — 258 paths in 43 groups. `/api/admin/*`
  (145), `/api/admin/platform/*` (42), `/api/admin/connections` (8), plus a
  dozen public routers. Registry-driven, not hardcoded.
- **`Dashboards-users-` (business)** — 28 paths. `/api/business/*` (7 endpoints
  = the entire product), `/api/business-auth` (10), `/api/connections` (4),
  `/api/auth` (3), `/api/gcr` (4). Schema-discovery-driven, cleanest/newest.
  **Does not call the legacy `site_apps` screens.**

⟲ The original §10 noted a hardcoded prod-URL fallback in
`gcr-unified/src/services/gcrApi.js`. Confirmed: `src/config.js` carries
`API_BASE = VITE_API_BASE || 'https://gcr-api-clean.vercel.app'`, and at least
four other files re-derive it independently.

---

## 11. Honesty ledger

**§0–11 + Appendices A–S represent a complete line-by-line read of the
application code** at `b75300c` — 8 giant route files (A–J), both engines (K),
and all remaining route files, libs, utils and extractors grouped into subsystem
appendices (L identity/auth · M payments · N App-Store/MCP · O booking verticals
· P consumer/discovery · Q messaging/webhooks · R business-data/admin · S
libs/utils). ~52,800 lines, nothing characterized-by-role-only.

⟲ **What that read did not cover, and this file now adds as §12:** the
deployment, configuration and verification layer — `vercel.json`,
`package.json`, `.env.example`, the `sql/` tree, and the six guard scripts.
~4,300 lines with no entry anywhere in the original.

---

## 12. ⟲ The deployment, config & verification layer *(new)*

### 12.1 `vercel.json` — four scheduled crons

| Path | Schedule | Router |
|---|---|---|
| `/api/platform/cron/reminders` | `0 * * * *` (hourly) | `platform.js` |
| `/api/gcr/deep-crawl/run` | `*/30 * * * *` | `gcr/deep-crawl.js` |
| `/api/email-parser/ical-import/run` | `0 * * * *` (hourly) | `email-parser.js` |
| `/api/transportation/expire` | `*/5 * * * *` | `transportation.js` |

The appendices mention the cron *endpoints*; this is what is actually scheduled
and how often. Given HEAD's own commit is *"Stop the runaway image-liveness cron
from the one path still answering,"* the set of things this API runs on a timer
is exactly the kind of fact worth recording.

Build: `@vercel/node` on `server.js`, with every route rewritten to it.

### 12.2 `package.json`

```
start         node server.js
dev           node --watch server.js
verify        check:sql && check:columns && test:mcp && test:concierge
vercel-build  node scripts/stop-image-cron.mjs    ← runs on EVERY deploy
```

Runtime dependencies (13): `@anthropic-ai/sdk`, `@supabase/supabase-js`, `axios`,
`bcrypt`, `cors`, `dotenv`, `express`, `express-rate-limit`, `firebase-admin`,
`jsonwebtoken`, `multer`, `stripe`, `twilio`.

### 12.3 The guard scripts (~1,150 lines)

| Script | Lines | Role |
|---|---|---|
| `scripts/test-mcp.js` | 522 | 27 checks — MCP protocol + scoping. No credentials, no network. |
| `scripts/test-concierge.js` | 397 | the shared concierge-tools suite |
| `scripts/check-capability-columns.mjs` | 100 | **fails the build** if `routes/capabilities.js` names a column `sql/capability_tables.sql` doesn't create |
| `scripts/verify-db-connection.mjs` | 91 | says which database the API is actually talking to |
| `scripts/stop-image-cron.mjs` | 82 | runs on every Vercel build |
| `scripts/check-sql-safety.mjs` | 60 | the SQL safety gate |

⚠ **`check-capability-columns.mjs` checks against the SQL file, not the live
database.** `Admin-dashboard-main/HANDOFF.md` records the consequence: the two
capability screens are built on a schema the live database does not have, and the
build passes anyway. See `docs/INTERCONNECTION_MAP.md` §6.5.

### 12.4 The SQL layer (3,029 lines)

`schema.sql` (662) · 13 files in `sql/` (1,846) · 3 in `migrations/` (254) · 1 in
`supabase/migrations/` (6) · `TOURIST_TABLES.sql` +
`TOURIST_SCHEMA_EXTENSIONS.sql` (246) · `admin_users_setup.sql` (12).

Notable: `sql/capability_tables.sql` (520) is the schema `capabilities.js` is
mechanically checked against · `sql/business_mcp_tokens.sql` backs `/api/mcp` ·
`sql/business_signups.sql` backs the counterfeit gate ·
`sql/composio_connections.sql` backs the App Store · `sql/00_legacy_rename.sql`
is the two-generations migration.

### 12.5 `.env.example` — genuinely documentary

Beyond the variable list it records operational facts that exist nowhere else:

- **Composio** billing is per *call*, not per connected business (free tier
  20,000/month) — *"connecting 500 businesses costs nothing extra."* One variable
  required; three have working defaults and *"only exist because Composio has
  moved its host and version more than once, and a hardcoded one is how an
  integration quietly dies."*
- **Google Business Profile** API access *"has an approval process measured in
  weeks, so apply before you need it."* Until all four vars are set the routes
  answer 503 with what is missing.
- **`OAUTH_TOKEN_ENCRYPTION_KEY`** (AES-256-GCM, 32 bytes hex) — *"Changing it
  makes every stored token unreadable and every business has to reconnect, so set
  it once and keep it."*
- **`GCR_SERVICE_AREA_MILES`** (default 25) tunes `lib/serviceArea.js`.
- **`BUSINESS_PHONE_LOGIN_DOMAIN`** — `.invalid` is RFC 2606 reserved and can
  never be a real domain; nothing is ever sent to it.

---

## Appendices

The line-by-line reads. Each appendix's status line records exactly what was read
in full versus confirmed mechanical.

- **A — `gcr.js` (2,762)** · fully read. `buildFullEntity()` L73–503 (25 core
  tables in parallel, 7 conditional packs, item nesting, assembly), then all 36
  endpoints. Own DB client. **One carryover bug on disk: L308 `meeting_points`
  selects `lat,lng`; the live columns are `latitude,longitude`** — verified still
  present at `b75300c`. Hardcoded content spots: `/sections` typeMap,
  `/category-page-config` copy.
- **B — `dashboard.js` (5,640)** · architecture, `syncToGcr`, both dual-path
  dispatch styles, the full section map, and every distinct non-CRUD handler read;
  repetitive CRUD confirmed mechanical. Two latent bugs noted: the raw-fetch
  add-ons anomaly (L1108), and **AI-block column drift** — the GCR queries in the
  assistant use `entity_id`/`tag`/`open_time`/`image_url` rather than the current
  `entity_slug`/`tag_name`/`opens_at`/`url`, so the AI's "live listing" view may
  silently read empty.
- **C — `admin.js` (3,950)** · setup/auth/entity-CRUD/import engine read in full;
  all engines located and characterized. **A THIRD auth implementation** (L35–63).
  The RAG reindex route is a stub returning `chunks_indexed: 0`.
- **D — `public.js` (3,301)** · read mirror + booking flow + all three AI chat
  paths. **⚠ The AI-layer schism: all three public chatbots run on the LEGACY
  schema** and none use `buildFullEntity`, `searchEntitySlugs` or the nine shared
  `conciergeTools`. Modern `entity_slug` data is invisible to the public AI.
- **E — `platform.js` (2,186)** · the model spec (L1–27, verbatim contract),
  identity/install helpers, the universal record store, the availability model,
  and the universal submit handler read in full. **⚠ Concurrency note:** unlike
  the other three booking paths it checks availability in JS then inserts and
  syncs separately — a wider race window than the legacy engine it replaces.
- **F — `tourist.js` (1,998)** · fully read. Three auth flavors, a ledger of
  already-fixed silent-failure bugs, the preference-scoring engine, and **the
  MODERN AI concierge** — the counter-model that makes D.4 a wiring gap rather
  than a missing capability.
- **G — `email-parser.js` (1,467)** · fully read. ~24 platform extractors + a
  generic fallback, the write layer (`mirrorToCalendar`, `upsertAvailability`,
  `maybeCreateAutoDeal`), the routes, and the iCal import side.
- **H — `update-link.js` (1,376)** · token model, the daily-rotation triple-sync,
  and the AI setup read in full; ~30 per-section CRUD endpoints confirmed
  mechanical.
- **I — `menu-editor.js` (1,048)** · fully read. PIN auth, **the only write
  surface with a real audit trail**, `buildTabManifest`, and the modern
  slug-native QR menu. `POST /create` is a self-documented gap in the counterfeit
  gate.
- **J — `admin-platform.js` (2,224)** · fully read. The CRUD mirror, the parser/
  capacity/calendar operator views, **the capability-driven listing editor**, and
  **`/match`** — the industry-blind structural + availability search.
- **K — the two engines** ⟲ *(paths corrected: `routes/`, not `lib/`)* ·
  **`routes/capabilities.js` (512)** — the capability registry
  (*"A capability is a THING a business can have… Not an industry. ANY slug can
  have ANY capability."*) · **`routes/availability-engine.js` (324)** — the
  three-source merge, whose `expand()` rule is the most important in the system:
  *"a missing row is not 'full,' it's 'nothing has claimed this date.'"*
- **L — identity/auth cluster (8 files, 3,457)** · `business-auth.js` (the
  counterfeit gate) read closely; `auth.js`, `tourist-auth.js`, `site.js`,
  `user.js`, `verify-dns.js`, `links.js`, `setup-questions.js` by route map +
  targeted reads. **Three identity systems live at once.**
- **M — payments (1,401)** · Stripe Connect + BYO encrypted key, the marketplace
  charge (`transfer_data.destination` + `application_fee_amount`), the
  no-login tokenized key-link, and Square as the alternate processor.
- **N — App-Store/MCP (1,903)** · `mcp-public.js` (the read-only public agent
  surface behind the `businessTables` firewall), `mcp.js` (writable, token-authed,
  same firewall), and the two retired first-generation app files.
- **O — booking verticals (13 files, ~4,700)** · **three generations of booking
  code side by side**: per-vertical tables (dead), one generic resource table
  (live), and the one universal `bookings` table (canonical).
- **P — consumer/discovery (10 files, ~2,900)** · `qr.js` attribution and
  `live-photo.js` (the photo→review loop) read closely; the rest by route map.
- **Q — messaging/webhooks (9 files, ~2,200)** · the two deliberately separate SMS
  brains, the inbound webhook hub, the AI ingest proposer, and two retired channels.
- **R — business-data/admin (17 files, ~4,700)** · `google-business.js` read
  closely (**signed OAuth state** — *"an unsigned state is a slug anyone can
  edit"*). Records that there are **five distinct menu-editing surfaces**, all
  writing the same tables.
- **S — libs/utils (7 files, ~1,400)** · `mcpServer`, `touristMemory`,
  `upload-processor`, `google-places-import`, `email`, and the two payment
  extractors.

---

## What this repo is, in one paragraph

`gcr-api-clean` is the single Postgres-touching spine for the whole platform —
three front ends and every AI agent go through it. It runs two architectural
generations side by side (legacy `site_id` ↔ modern `entity_slug`), bridged by
two mirrors (`dashboard.js` write-side, `public.js` read-side) and one resolver.
Its universal reader (`buildFullEntity`) and universal engine (`/api/platform`)
are the modern canon; a capability registry + availability engine make one editor
and one search work for any industry; a shared concierge-tools layer + MCP
transport expose the whole directory as a callable tool to any AI; a
transaction-verification pipeline (email + iCal + payment extractors) turns real
bookings into verified availability and verified reviews; and payments flow
through per-business Stripe/Square with the platform taking a fee. The main open
threads: the public chatbots still run the legacy schema while the modern
concierge is ready to replace them; five menu editors and four booking systems
await consolidation; the counterfeit gate is bypassed by `menu-editor /create`
and admin ad-hoc inserts; and the capability layer's build check validates
against SQL rather than the live database.
