# The Four-Repo Interconnection Map

How `gcr-api-clean`, `Admin-dashboard-main`, `Dashboards-users-` and
`gcr-unified` actually connect. Every number here is computed from source at
the commits below — the router mounts extracted from `server.js`, and each
front end's call surface extracted from its own code, not from its docs.

| Repo | HEAD | Role |
|---|---|---|
| `gcr-api-clean` | `b75300c` | the spine — the only thing that touches Postgres |
| `Admin-dashboard-main` | `66c8ab1` | operator console |
| `Dashboards-users-` | `f323f55` | business dashboard |
| `gcr-unified` | `d8e5d63` | tourist site |

Companion papers: `gcr-api-clean/docs/BLUEPRINT_VERIFICATION.md`,
`Admin-dashboard-main/docs/BLUEPRINT.md`,
`Dashboards-users-/docs/BLUEPRINT.md`, `gcr-unified/docs/BLUEPRINT.md`.

---

## 1. The shape in one picture

```
   OPERATOR                BUSINESS                 TOURIST
   Admin-dashboard-main    Dashboards-users-        gcr-unified
   258 paths               28 paths                 101 paths
   Express JWT role=admin  Supabase → entity_owners Supabase tourist / X-Guest-Id
        │                       │                        │
        │                       │                        ├── + 9 static HTML pages
        │                       │                        │     (public/, no React)
        └───────────────────────┼────────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │    gcr-api-clean      │  67 live mounts
                    │  ─────────────────    │  8 commented out
                    │  the ONLY code with   │  4 Vercel crons
                    │  the service-role key │
                    └───────────┬───────────┘
                                ▼
                    Supabase "cyber check"
                    mkepugvdlktfsossumox
                    ~563 tables · anon writes revoked
```

**387 front-end→API calls across 41 routers.** No front end reaches Postgres.

---

## 2. Who calls what — the full matrix

Computed by resolving every path in each front end to the router that serves it.
`A` = Admin, `B` = Business, `T` = Tourist.

| Router | A | B | T | Notes |
|---|---:|---:|---:|---|
| `/api/admin` | **145** | – | 4 | the operator API. **The tourist site's 4 calls are a defect — §6.2** |
| `/api/admin/platform` | **42** | – | – | the capability + booking operator layer |
| `/api/gcr` | 11 | 4 | **20** | **the only router all three share** |
| `/api/tourist` | – | – | 20 | consumer app + the modern AI concierge |
| `/api/business-auth` | – | 10 | – | the counterfeit gate |
| `/api/tourist-auth` | – | – | 10 | consumer accounts |
| `/api/admin/connections` | 8 | – | – | Composio, admin catalog |
| `/api/qr` | 8 | – | – | QR + referral attribution |
| `/api/business` | – | **7** | – | **the whole business dashboard** |
| `/api/admin/intake` · `/api/admin/tourists` | 6 · 6 | – | – | |
| `/api/dashboard` | – | – | **6** | **legacy `site_id` router, called from an unroutable page — §6.3** |
| `/api/tourist/groups` | – | – | 6 | shared trip groups |
| `/api/reviews` | 5 | – | 2 | |
| `/api/platform` | – | – | 5 | the universal booking engine, consumer side |
| `/api/connections` | – | 4 | – | Composio, owner-scoped |
| `/api/artists` | 3 | – | 4 | |
| `/api/bookings` | 4 | – | 2 | |
| `/api/auth` | – | 3 | – | invite links only |
| `/api/admin/analytics` · `/api/admin/setup-questions` · `/api/menu-editor` | 3 each | – | – | |
| `/api/deals` · `/api/services` | – · 1 | – | 3 · 3 | |
| `/api/ar-hunts` · `/api/rentals` · `/api/availability` · `/api/email-parser` · `/api/gallery` · `/api/sms` | 2·1·–·–·–·2 | – | 2·2·2·2·2·– | |
| `/api/blog` · `/api/faqs` · `/api/team` · `/api/public` · `/api/transportation` · `/api/artist-bookings` | – | – | 1 each | tourist mini-site sections |
| `/api/ai-provider` · `/api/apps` · `/api/dashboard-sms` · `/api/embed` · `/api/update` | 1 each | – | – | |

**Totals: Admin 258 · Business 28 · Tourist 101.**

Three facts fall out of the matrix:

1. **`/api/gcr` is the only genuinely shared router.** `buildFullEntity()` and
   the deep search in `routes/gcr.js` (2,762 lines) serve the operator, the
   business and the tourist. It is the single highest-leverage file in the
   platform: a change there moves all three front ends at once.
2. **The business dashboard's whole surface is 7 endpoints on one router.**
   `/api/business/{me,schema,sections,industries,:table,:table/:id}` is an entire
   product. That is the schema-discovery architecture paying off.
3. **The operator console is 65% of all traffic** and calls `/api/admin` 145
   times — one router, 188 routes, 3,950 lines.

---

## 3. What the API serves that no front end calls

**24 of 67 live mounts have no front-end caller.** Most are correct; four are
not.

### Correct — machine callers, by design

| Router | Called by |
|---|---|
| `/api/webhooks` · `/api/meta-webhook` | Stripe, Twilio, Google, Meta |
| `/api/stripe` · `/api/square` | OAuth callbacks + signature-verified webhooks |
| `/api/mcp` · `/api/mcp/public` · `/api/mcp/business/:slug` | **outside AI agents** — the whole point |
| `/api/gcr/deep-crawl` · `/api/gcr/admin` | Vercel crons + the photo-repair worker |
| `/api/embed` | third-party sites via `public/embed.js` |
| `/api/update` + `/update` | the `cybercheck-links` texted-link surface |

### Correct — served to surfaces outside these four repos

`/api/menu-edit`, `/api/simple`, `/api/links`, `/api/live-photo`, `/api/ocr`,
`/api/voice-notes` — the standalone editors and utilities.

⟲ **And `/api/cooperatives`, `/api/qr/scan`, `/api/gcr/nfc-card-lead`, `/api/stripe/config` — reached only from `gcr-unified/public/`.** Nine static HTML pages call the API directly without touching React, so a router with no React caller is not necessarily an orphan. The full audit is in `gcr-unified/docs/BLUEPRINT.md` Appendix F.

### Not correct — real orphans

| Router | Lines | Why it matters |
|---|---|---|
| **`/api/google-business`** | 603 | The one non-Composio integration, and the platform's only **proof a business is real** — Google made them verify their address. Fully built, OAuth state signed, tokens encrypted. **No front end offers a "Connect Google" button.** The business dashboard's App Store shows Composio toolkits and not this. |
| **`/api/analytics`** | 251 | Public pageview/conversion/event ingest. `gcr-unified` tracks through `/api/gcr/track` instead, so this parallel ingest path collects nothing. |
| **`/api/goals`** | 220 | Artist goals. `grep` over both `src/` and `public/` in `gcr-unified` finds **no caller anywhere** — a backend plus inbound email webhooks (`email-webhook.js` writes `goal_contributions`) with no surface at all. ⟲ `/api/cooperatives` (218) was listed here too and is **not** an orphan: `public/song-request.html`, served at the live URL `/:slug/profile`, calls `GET /api/cooperatives/:slug/cooperatives` and `POST …/:id/contribute`. Song crowdfunding is wired — through the static surface, not React. |
| **`/api/verify-dns`** | 56 | Custom-domain checking with no UI. |
| **`/api/site` + `/api/user`** | 923 | The legacy `site_id` API. Nothing in these four repos calls them. |

### The eight commented out

`apps` · `boat-rental` · `charter` · `messaging` · `modules` · `photographer` ·
`rides` · `whatsapp` — the per-vertical era `/api/platform` replaced. Only one
front end still points at any of them: `Admin-dashboard-main`'s Messaging
screen, which says so on screen rather than pretending.

---

## 4. Shared and duplicated code across repos

Five places where the same thing exists twice. Each is a drift risk, and each
is at a different stage of being handled.

| # | What | Where | Status |
|---|---|---|---|
| 1 | **`AppStoreView.jsx` + `.css`** | `Admin-dashboard-main/src/components/` **and** `Dashboards-users-/src/components/` | **Literally the same file.** Everything host-specific arrives as props; `curating = typeof onToggleOffer === 'function'` is the only mode switch. Deliberate, documented in both — but two copies with no sync mechanism. |
| 2 | **`categoryMap.js` ↔ `utils/listing-category-map.js`** | `gcr-unified/src/` ↔ `gcr-api-clean/utils/` | **Declared mirror.** The API file warns it must stay in sync *"or the server-paginated endpoint and the client filter will silently disagree."* Mitigated at runtime by `hydrateTaxonomy()` pulling `GET /api/gcr/taxonomy` at boot — but the static map is still what renders first paint. |
| 3 | **`SYSTEM_COLUMNS`** (8 column names) | `Dashboards-users-/src/lib/schemaDiscovery.js:50` ↔ `gcr-api-clean/lib/businessTables.js` | Verbatim copy. Documented as a fallback for stale caches, not an independent check — but a second copy of a list. |
| 4 | **`apiClient.js` / `client.js` + `endpoints.js`** | `Dashboards-users-/src/lib/` ↔ `Admin-dashboard-main/src/api/` | **Deliberate convergence, not duplication.** The business dashboard's header says it: *"the same shape as Admin-dashboard-main […] so the two stay recognisably the same code rather than drifting into two different ideas of how a request is made."* Two implementations of one pattern; each has what the other doesn't (token refresh vs `unwrapList`). |
| 5 | **`MonthCalendar` semantics** | `Admin-dashboard-main/src/ui/MonthCalendar.jsx` ↔ `gcr-api-clean/routes/availability-engine.js` | Not code duplication — **rule duplication.** The engine's `expand()` says a missing row means "nothing has claimed this date," and the component renders `assumed` days hollow to match. If either changes alone, the UI lies. |

**And one deliberate non-share:** `gcr.js` keeps its own inline copy of the
three-source availability merge for public search, while `admin-platform.js`
and `embed.js` use `routes/availability-engine.js`. The API blueprint records
this as intentional.

---

## 5. The end-to-end flows

Six paths that cross repo boundaries. These are what break when a boundary
moves.

### 5.1 A business gets on the platform

```
tourist site  ClaimBusiness.jsx → POST /api/gcr/claim → business_claims (status 'new')
                                          │
business dash SignUp.jsx → /business-auth/phone → /verify → /register
                                          │  Twilio OTP · findSimilar · isInServiceArea
                                          ▼
                            entity (is_active:false, show_in_listings:false)
                            entity_owners · business_signups (pending)
                                          │
admin console Claims.jsx  PATCH /api/admin/gcr/claims/:id      ─┐
              admin-signups.js  flips the entity active         ─┴─ the human step
                                          ▼
                            the listing goes public
```

**Three doors, one gate.** `business-auth.js /register` is the only path with
phone verification, duplicate capture, service-area check and
inactive-until-approved. The API blueprint records **two bypasses**:
`menu-editor.js /create` (adminRequired, but no verification) and admin ad-hoc
entity inserts. Neither is reachable from these three front ends — both are
operator-side.

### 5.2 A date becomes unavailable everywhere

```
Airbnb/FareHarbor/OpenTable confirmation email
        → gcr-<slug>@parse.gulfcoastradar.com
        → email-parser.js  (24 platform extractors)
        → booking_calendar + business_availability
                    │
external .ics feed  → ical-import cron (hourly)  ─────┘
                    │
                    ├→ availability-engine.js  three-source merge, block wins
                    │        ├→ admin  Availability · Openings · IndustryCalendar
                    │        ├→ tourist  Search (availability-search) · Reserve
                    │        └→ third-party sites  /api/embed
                    │
                    └→ maybeCreateAutoDeal()  1–5 spots left
                             → gcr_deals
                                 ├→ tourist  /deals · swipe deck · LiveFeed
                                 └→ admin  Openings → SMS blast to saved tourists
```

A cancellation on FareHarbor becomes a last-minute deal card in the tourist app
with no API credential anywhere in the chain. **`entity.daily_capacity` is the
single point of failure** — without it the parser logs bookings forever and
never reports an opening, which is why `Admin-dashboard-main`'s Inventory screen
exists.

### 5.3 A business edits its own page — five ways

| Surface | Auth | Repo |
|---|---|---|
| Business dashboard | Supabase session → `entity_owners` | `Dashboards-users-` |
| PIN menu editor | 4-digit PIN → sha256 token | standalone (`menu-editor.js`) |
| Texted magic link | per-link secret + passcode | `cybercheck-links` (`update-link.js`) |
| Daily-menu page | `x-menu-pin` header | `gcr-unified/public/menu-update.html` |
| Admin, on their behalf | Express JWT `role=admin` | `Admin-dashboard-main` |

All five write the **same** `entity_slug` tables. Only one — the PIN editor —
records an audit trail (`entity_edit_log`). The API blueprint calls this a
consolidation candidate; from the map it is five products' worth of surface
area on one data model.

### 5.4 The AI layer — three tiers, and the gap

```
conciergeTools.js  9 read-only tools, one copy
        ├→ /api/tourist/ai-chat   → gcr-unified AiChat.jsx        ✅ modern
        ├→ /api/mcp/public        → outside agents (Grok, voice)   ✅ modern
        └→ /api/mcp/business/:slug → per-business pinned           ✅ modern

public.js  /chat · /chat (booking) · /gcr-chat                     ❌ LEGACY
        reads businesses + site_content, not entity_slug
        → invisible to any business imported through admin.js
```

The tourist front end already calls the modern one. The three legacy chatbots
in `public.js` are reachable from `public.js`'s own consumers, not from these
four repos — **so the fix is a wiring change on the API side, and no front end
has to move.**

### 5.5 The App Store — two catalogues, two UIs

```
platform_connections + entity_connections   ← Composio, managed auth
        ├→ admin   /api/admin/connections   Connections.jsx  (catalog + status)
        └→ business /api/connections        AppStore.jsx      (own slug only)
                    both render the SAME AppStoreView.jsx

apps + site_apps                             ← the retired site_id era
        └→ admin   /api/admin/apps          AppManager.jsx · BusinessApps.jsx
                    no business-facing surface; routes/apps.js is unmounted
```

`AppManager.jsx` names the split itself: *"The two are not the same table and do
not sync. Which one should be canonical is an open decision."* From the map:
the modern one has two front ends and the legacy one has one, and the legacy
one's router is commented out in `server.js`.

### 5.6 The verified-transaction loop

```
payment email (Venmo/CashApp)  → extractors/  → REQ-code
booking email                  → email-parser  → booking_calendar
        │                                          │
        └──────────── booking_opt_ins ─────────────┘   (gcr.js /opt-in, from Reserve.jsx)
                            │
                            ▼
              a real payment tied to a real booking
                            │
        ┌───────────────────┼───────────────────┐
   tourist /reviews    verified-review.html   live-photo.js
   (login required,    (/r/:slug, static)     (photo → SMS → review link)
    entity_reviews.user_id)
```

Three entry points, three repos, one loop. The consumer entry
(`/api/tourist/reviews`) is the strongest — a review can only be written by a
logged-in tourist, so it is provably tied to a real phone account.

---

## 6. Cross-repo defects — things only the map shows

Each of these is invisible inside a single repo.

### 6.1 The tourist site calls four admin-only endpoints

`gcr-unified` calls `/api/admin/sms-config` (`Swipe.jsx`) and
`/api/admin/tripswipe/{settings,sponsored,promo-cards}` (`services/gcrApi.js`).
All four are `adminRequired`. From a tourist browser they can only 401/403 —
and `AppContext`'s helpers return `null` on every failure, so **the swipe deck
renders without sponsored placements or promo cards and reports nothing.**

Sponsored inventory is revenue. The API side has the fix pattern already:
`mcp-public.js` shows how to expose a scrubbed public projection.

### 6.2 `Admin-dashboard-main` believes 58 endpoints are missing that now exist

`docs/ENDPOINT-STATUS.md` reports 18 sections / 58 endpoints returning 404 on
the API's `main`, pending a branch merge. **That merge has happened** — verified
route by route at `b75300c`: `/api/admin/platform/*`, `/api/admin/connections/*`,
`/api/admin/settings`, `/api/admin/provider-status`, category cards, and
`/api/embed/*` are all mounted.

Consequence: sections still carrying `status: 'partial'` show an amber `!` and a
"route not deployed" notice **on screens that now work**. A working screen
telling the operator it is broken is worse than the original gap.

**Fix:** `node scripts/audit-endpoints.mjs ../gcr-api-clean` and clear the
stale flags.

### 6.3 `gcr-unified` still pins the legacy `site_id` API

`Dashboard.jsx` (434 lines) calls `/api/dashboard/*` — the legacy write-mirror
that `Dashboards-users-` was built to replace. It is **not routed in
`App.jsx`**, so it is unreachable, yet it still ships in the bundle and keeps a
legacy dependency alive in the newest consumer product.

### 6.4 Nothing offers Google Business Profile

`google-business.js` (603 lines) is complete: signed OAuth state, encrypted
tokens in `oauth_tokens`, review read/reply, profile sync, and
`isInServiceArea` feeding `entity.listed_on_gcr`. It carries the platform's only
external proof a business is real.

**No front end has a button for it.** The business dashboard's App Store lists
Composio toolkits; this integration is deliberately outside Composio and
therefore outside that list. It is the largest built-and-unreachable capability
in the platform.

### 6.5 The two capability screens are built on a schema that isn't there

`Admin-dashboard-main/HANDOFF.md` records it, and it is a *cross-repo* fact:
`AttributesPanel.jsx` (591) and `Match.jsx` (484) render from
`gcr-api-clean/routes/capabilities.js`, which describes `units`, `vessels` with
`vessel_type`/`max_passengers`, an `amenities` catalog and a `species` catalog.
The live database has `bookable_resources` (1,055 rows), `vessels` with
`vessel_category`/`passenger_max`, `amenities`/`entity_amenities` as plain text,
and `fish_species`.

`scripts/check-capability-columns.mjs` checks `capabilities.js` against
`sql/capability_tables.sql` — **not against the live database**, which is why
the build passes.

### 6.6 The API blueprint calls two load-bearing files dead

`gcr-api-clean` §7 lists `routes/capabilities.js` and
`routes/availability-engine.js` as *"genuinely dead."* They are unmounted but
required by `admin-platform.js:1131,1628` and `embed.js:30` — and they are what
`Admin-dashboard-main`'s Listing Data, Find a Match and Website Calendar screens
run on. Deleting either on the strength of §7 would break three operator screens
and the public embed widget. Detail in `docs/BLUEPRINT_VERIFICATION.md`.

### 6.8 Two static pages call routes that do not exist

Found by opening all 24 files in `gcr-unified/public/` and checking each call
against `server.js` and the route files.

**`rides.html` posts to `/api/rides/request`.** `server.js:336` has that router
commented out — *"backing tables don't exist in the live DB […] Superseded by
`/api/transportation`."* The live replacement is `POST /api/transportation/request`,
which `TransportationRequest.jsx` and `Reserve.jsx` both already use. The page
cannot work.

**`review.html` calls `/api/reviews/request` and `/api/reviews/submit`.**
`routes/reviews.js` has only `GET /:slug`, `GET /:slug/stats`, `POST /:slug`
(ownerRequired), `PUT /:slug/:id`, `DELETE /:slug/:id`.

`POST /api/reviews/submit` **does not 404** — it binds to `POST /api/reviews/:slug`
with `slug = "submit"`. Only `ownerRequired` prevents a review being filed against
a business named "submit."

This is precisely the SHADOWED class that
`Admin-dashboard-main/scripts/audit-endpoints.mjs` exists to catch, and that
`menu/Reviews.jsx` explicitly refuses to reproduce — *"`POST /api/reviews/request`
matching `POST /api/reviews/:slug` would have created a review against a business
named 'request'."* The admin console avoided it; the static surface walked into it.

**Neither page is covered by any check in any repo.** `audit-endpoints.mjs` reads
`Admin-dashboard-main/src/api/endpoints.js`; nothing reads `public/*.html`.
Pointing the existing audit at those files is the cheapest fix available here.

### 6.7 A production `service_role` key is committed in `gcr-unified`

`dump-entire-db.mjs` and `export-supabase-complete.mjs` each carry a hardcoded
Supabase JWT: `role: service_role`, `ref: mkepugvdlktfsossumox`, valid to 2036.

**Not in any browser bundle** — both sit outside `src/`, so Vite never bundles
them. But they are committed and in history, and `service_role` bypasses
row-level security entirely. It is the key class `db.js` holds, in a repo whose
platform rule is *"No dashboard holds a Supabase key."*

**Rotate it, move both to `process.env.SUPABASE_SERVICE_KEY`, and purge from
history.** Highest-severity finding across the four repos.

---

## 7. The two generations, seen from all four repos

The API's `site_id` ↔ `entity_slug` split shows up differently in each front
end. This table is the clearest single view of where the platform actually is:

| | legacy (`site_id`) | modern (`entity_slug`) |
|---|---|---|
| **API** | `businesses`, `site_apps`, `site_content`, `connections`, `apps` | `entity` + ~100 `entity_*`, `entity_owners`, `entity_modules` |
| bridged by | `dashboard.js` (write mirror) · `public.js` (read mirror) · `entity-resolver.js` | — |
| **Admin console** | App Manager · Business Apps · Platform Businesses | everything else — 83 of 86 sections |
| **Business dash** | *nothing* | **all of it** |
| **Tourist site** | `Dashboard.jsx` (unroutable) · `/api/public/menu` | everything else |
| booking | `dashboard.js` engine · `public.js` customer path | `/api/platform` — the canonical one |
| app store | `apps` + `site_apps` | `platform_connections` + `entity_connections` |
| auth | Express JWT + `site_id` | Supabase → `entity_owners` |

**Read left to right: the newest repo has no legacy surface at all.** The
business dashboard is the proof the modern side is complete enough to build a
whole product on. The remaining legacy exposure is three admin screens and one
unroutable tourist page.

---

## 8. If you change X, check Y

The practical output of the map.

| Change | Then check |
|---|---|
| `buildFullEntity()` in `gcr.js` | all three front ends — it is the only shared router |
| a table rename in `buildFullEntity`'s output | `Dashboards-users-/src/lib/tableMap.js` (73 entries) — an unmapped key makes every write to that section 404 |
| add/remove a slug-keyed table | nothing — discovery picks it up in the business dashboard and `business-profile.js`. **This is the payoff of the whole design.** |
| `lib/businessTables.js` guards | `/api/business/*` **and** `/api/mcp` — one copy, two consumers |
| `conciergeTools.js` | tourist `AiChat`, `/api/mcp/public`, `/api/mcp/business/:slug` — one copy, three consumers |
| an `/api/admin/*` route | `Admin-dashboard-main/src/api/endpoints.js` (one line) then `npm run audit:endpoints` |
| a subtype→category rule | **both** `gcr-api-clean/utils/listing-category-map.js` and `gcr-unified/src/categoryMap.js` |
| `availability-engine.js`'s `expand()` | `MonthCalendar`'s hollow `assumed` rendering — the rule is expressed in two places |
| `AppStoreView.jsx` | copy to the other dashboard — two identical files, no sync |
| `capabilities.js` columns | `check-capability-columns.mjs` passes on SQL, **not** on the live DB — verify against the database |
| the `entity_owners.user_id` convention | `platform.js` writes `businesses.id`, `provision-accounts.mjs` writes `auth.users.id`, the proposed RLS enforces `auth.uid()` — three id spaces, one column |

---

## 9. The shortest list that matters

Ordered by cost of leaving it alone.

1. **Rotate the committed `service_role` key** (`gcr-unified`, §6.7).
2. **Re-audit and clear the stale `partial` flags** (`Admin-dashboard-main`,
   §6.2) — one script run.
3. **Fix `§7` of the API blueprint** before anyone deletes
   `routes/capabilities.js` or `routes/availability-engine.js` (§6.6).
4. **Settle `entity_owners.user_id`** before the ownership RLS is applied — three
   id spaces in one column.
5. **Give the tourist deck a public sponsored/promo endpoint** (§6.1) — revenue
   inventory currently fails silently.
6. **Add profile-row and nested-row editing to the business dashboard** — name,
   phone, hours and *adding a dish to a menu* are not possible today.
7. **Point `public.js`'s three chatbots at `conciergeTools`** (§5.4) — the good
   implementation already exists one file over.
8. **Decide the app-store catalogue** (§5.5) and the five menu editors (§5.3).
9. **Surface Google Business Profile** (§6.4) — 603 lines of built, unreachable
   proof-of-realness.

---

## 10. In one paragraph

Four repositories, one database, and exactly one process allowed to touch it.
The operator console, the business dashboard and the tourist site make 387 calls
across 41 routers, and share precisely one — `/api/gcr`, whose
`buildFullEntity()` assembles a business from roughly ninety tables for all
three. Everything downstream of that is a variation on a single idea: the
database describes itself, so the business dashboard has no feature list, the
operator's listing editor has no industry logic, the AI has no hardcoded table
map, and adding a table to Postgres adds a screen to two products with no
deploy. The gaps are all at the seams the map makes visible and no single repo
does — a tourist deck quietly 403ing on revenue inventory, an operator console
warning about routes that shipped weeks ago, a capability layer built against a
schema the live database never had, and a production service-role key sitting in
a repository that was never supposed to hold one.
