# gcr-api-clean — Technical Audit

Full line-by-line read of every file in this repo (routes/, lib/, utils/, middleware/, extractors/, root scripts, server.js, db.js). Purpose: a permanent reference so nobody has to re-read the whole repo to remember what's real, what's dead, and what's broken. Update this file when you fix something instead of re-auditing from scratch.

Last full audit: 2026-07-27.

## 0. SECURITY — fix before anything else

- **`run_migration.js:3-4`** — hardcoded live Supabase **service-role** JWT (full DB read/write/admin, bypasses RLS) for project `mkepugvdlktfsossumox.supabase.co`, expires 2036. Rotate immediately.
- **`find-missing-venues.js:3`** — hardcoded live Google Maps API key `AIzaSyBP1yLnGq3IQXsqkbqiFhTGVyj1XV5_Rjc`. Rotate.
- **`setup-menu-editor.js:32`** — hardcoded default admin password `Admin123!@#` (only used if `--password` CLI arg omitted).
- Multiple routes have **zero auth on write endpoints**, gated only by knowing/guessing an `entity_slug`: `email-parser.js` (all routes incl. admin log + capacity setup), `simple-menu-edit.js` (all routes), `blog.js`/`faqs.js`/`gallery.js`/`reviews.js`/`team.js` (POST/PUT/DELETE), `live-photo.js` PUT/DELETE (approve/reject any business's photo by ID), `gcr.js`'s `/entity/:slug/set-pin` (no rate limit), `gcr/deep-crawl.js`'s `/status`/`/jobs`/`/results` (fully public).
- `menu-edit.js:11` — `PASSCODE = '1234'` hardcoded and shared across every business using this legacy editor.

## 1. Architecture — read this before touching anything

**One physical database, two data models.** `db.js` creates a single Supabase client: `createClient(GCR_SUPABASE_URL || SUPABASE_URL, GCR_SUPABASE_SERVICE_KEY || SUPABASE_KEY)`. There is no separate `gcr-db.js`. In production `GCR_SUPABASE_URL` wins, so every route — GCR-branded or not — hits the same physical Supabase project.

Despite sharing a database, there are **two distinct, only-sometimes-linked data models**:
- **`businesses` table** — the CyberCheck dashboard account. Created by `auth.js`'s `/signup`. Used by `dashboard.js` (the 5640-line business-owner API), `site.js`, `public.js`. This is "your CyberCheck account."
- **`entity` table** (+ `entity_hours`, `entity_photos`, `entity_tags`, `entity_sections`, `menu_sections`/`menu_items`, etc.) — a GCR directory listing. Used by `admin.js`'s GCR panels, `gcr.js` (public discovery API), `platform.js`, `menu-editor.js` (via `entity.menu_pin`). This is "a business's public listing in the Gulf Coast Radar directory."
- **They are not automatically the same record.** A `businesses` row and an `entity` row for what is conceptually the same real-world business are two separate rows unless explicitly linked via the `entity_owners` table (see `platform.js:74-87`'s `ownedSlug()`, and `admin.js`'s `/link-user` endpoint `:2811`). A business can have a CyberCheck dashboard account with no GCR listing, a GCR listing with no dashboard account (most of the directory), or both, linked or unlinked.
- `meta-webhook.js` is the one file that ignores the `GCR_`-prefixed convention and builds its own client from bare `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` — silently broken if that exact pair isn't separately set in the deployment env.

**The "ONE universal engine" comment.** `server.js` explicitly says several single-purpose booking systems were superseded by `platform.js`, mounted at `/api/platform`. That's real — `platform.js` is mounted and working. But 8 of the superseded files are still sitting in the repo, fully built, just unreachable (see §3).

## 2. server.js — mount list (the ground truth for what's actually live)

Uses a fail-safe `mount(path, loader)` wrapper (`server.js:16-22`) — if a route file throws on `require()`, it's silently skipped with a console warning instead of crashing the boot. A broken file won't even show up as a 500 at startup; check server logs for `[mount skipped]`.

**Explicitly UNMOUNTED (commented out, "superseded by /api/platform"):**

| File | Would-be path | Why it matters |
|---|---|---|
| `modules.js` | `/api/modules` | The *richer* app-store/module-marketplace backend — see §3 |
| `google-business.js` | `/api/google-business` | Full OAuth2 + Google Business Profile v4, complete |
| `boat-rental.js` | `/api/boat-rental` | Stripe Connect deposit booking — has a live bug, needs fixing before remount |
| `charter.js` | `/api/charter` | Same bug as boat-rental.js |
| `rides.js` | `/api/rides` | Superseded by the live `transportation.js`, safe to leave dead |
| `photographer.js` | `/api/photographer` | Complete, no bugs, safe to remount as-is |
| `messaging.js` | `/api/messaging` | Owner↔guest conversation threading, complete |
| `whatsapp.js` | `/api/whatsapp` | Full Meta/WhatsApp Cloud API, complete |

## 3. Full route-file inventory

### auth.js — CyberCheck account auth (mounted `/api/auth`)
DB: main (`businesses`/`users`). All WORKING: `POST /signup` `:16`, `GET /invite/:token` `:156`, `POST /accept-invite` `:182`, `POST /login` `:262`, `POST /oauth-sync` `:335`, `POST /logout` `:370`, `POST /refresh` `:377`, `GET /session` `:389`, `GET /verify` `:418`, `POST /forgot-password` `:435`, `POST /reset-password` `:466`, `POST /create-profile` `:516`. Comments at `:83-88,212-214,286-288` note prior schema-mismatch bugs that have since been fixed — this file gets iteratively patched against the real live schema.

### admin.js — GCR/platform superadmin backend (mounted `/api/admin`), 3906 lines
DB: own `getDb()` client (`:11-20`). Powers `admin.html`. Own `authRequired` (`:35-63`, API-key-or-JWT-role-admin). **No stubs found anywhere in this file.** Full inventory:
- `POST /login` `:87` (bcrypt vs `admin_users`)
- GCR entity CRUD (list/create/update/patch/delete, hours, availability, menu/drink/HH sections+items, events, specials, photos) `:134-746`
- Bulk import pipeline (AI-assisted): `/gcr/import-entity`, `import-menu`, `import-drinks`, `import-happyhour`, `import-events`, `import-specials`, `import-section-based`, `import-photos`, `import-master`, `import-gcr-items` `:747-1225,2949`
- Flexible sections `/entities/:slug/sections` `:1225-1315`
- Trip Swipe admin `/tourists*`, `/tripswipe-analytics`, `/tripswipe/sponsored`, `/tripswipe/promo-cards`, `/tripswipe/settings*` `:1315-1707`
- `POST /ai-organize` `:1779` (Claude content classifier)
- `/gcr/upload-image`, `/gcr/backfill-photo-analysis` `:1872-1940`
- Artists CRUD `:1941-2018`
- `POST /sms-blast` `:2019`, `GET /sms-blasts` `:2156`, `POST /sms-blast/preview` `:2171` (real Twilio)
- `GET /gcr/claims`, `PATCH /gcr/claims/:id` `:2249-2273`; `/sales-leads*` `:2274-2299`
- `GET /rag-status`, `POST /gcr/reindex/:slug` `:2300-2324`
- Deep per-entity generic editors (pricing-items, whats-included, requirements, faqs, sides, daily-features, menu-item options/variations, "profile-rows"/"profile-singleton", secondary-hours, schedules, team, reviews, policies, blog) `:2325-2800` — this is what `admin.html` uses to edit every one of the ~60 GCR child tables
- `POST /gcr/ask` `:2801` (unauthenticated AI Q&A)
- `POST /link-user`, `POST /invite-business`, `GET/DELETE /link-user`, `GET /users` `:2811-2948` — the owner-linking + business-invite flow that connects a `businesses` account to an `entity` row
- Ads CRUD `/gcr/ads*` `:3012-3065`, coupons `/gcr/coupons*` `:3066-3101`, `GET /gcr/customers` `:3102-3127`, page-rails CRUD `:3128-3239`
- `/ai-config*` `:3240-3315` (per-task AI model/prompt config)
- `GET /repair-photos/status`, `POST /repair-photos`, `POST /gcr/rehost-photos` `:3316-3465` (duplicate of `rehost-photos.js`'s implementation — see §5)
- `POST /social-posts/scrape` `:3466`, CRUD `:3585-3667`
- Apps marketplace CRUD `:3668-3737`, `GET /businesses` `:3738`, `/site-apps` `:3767-3794`
- `POST /gcr/parse-raw-data`, `POST /gcr/save-parsed-items` `:3795-3906` (free-text → structured entity)

### admin-tourists.js (mounted `/api/admin/tourists`)
DB: main. All `adminRequired`, all WORKING: `GET /` `:29`, `GET /:user_id` `:84`, delete saves/itinerary/user `:106-120`, `GET /:user_id/preferences` `:128`, `POST /:user_id/recompute-preferences` `:154`.

### ai-provider.js (mounted `/api/ai-provider`)
`POST /call` `:91` (authRequired) — provider-agnostic Claude/OpenAI/Groq wrapper. WORKING. Exports helpers used by `tourist.js`, `update-link.js`, `dashboard.js`.

### apps.js (mounted `/api/apps`)
DB: main, all `authRequired`. `GET /` `:8`, `POST /install` `:36`, `DELETE /uninstall/:appId` `:56`. WORKING — the **simple** install/uninstall system backing `app-store.html`. Contrast with `modules.js` (unmounted, richer).

### ar-hunts.js (mounted `/api/ar-hunts`)
DB: main. Server-side GPS distance check prevents spoofed captures (`:233-239`). Admin (`authRequired`): `GET /` `:68`, `POST /` `:79`, `PATCH /:id` `:111`, `DELETE /:id` `:148`, `POST /redeem` `:275`, `GET /:id/captures` `:310`. Public: `GET /nearby` `:159`, `POST /:id/capture` `:194` (rate-limited `:33-36,202-211`). WORKING, well-guarded, standalone GCR/tourism feature — no CyberCheck-dashboard exposure found.

### artist-bookings.js / artists.js / cooperatives.js / goals.js
DB: main. Full live-music monetization stack (song requests, tip cooperatives, fan-funded goals, artist bookings). All real inserts, REQ-code generation, mixed public/`authRequired`. WORKING throughout, no stubs.

### analytics.js (mounted `/api/analytics`)
DB: main, **no auth on any route including `/stats`** (code comment at `:198` admits it needs auth). `POST /pageview` `:14`, `/conversion` `:81`, `/event` `:144` (**STUB — pure `console.log`, never writes to a table**), `/duration` `:173`, `GET /stats` `:196`. Mostly superseded by `dashboard.js`'s richer analytics and `public.js`'s `/track`/`/events`/`/funnel`.

### availability.js (mounted `/api/availability`)
DB: main, no auth. `GET /search` `:15`, `/categories` `:139`, `/calendar/:site_id/:item_id` `:154`, `/resource/:id` `:185`, `/resource/:id/quote` `:223`. WORKING — cross-platform availability engine, backs FareHarbor-synced slots + rental resources via 2 Postgres RPCs (`resource_blocked_dates`, `resource_is_available`).

### blog.js / faqs.js / gallery.js / reviews.js / team.js
Each instantiates its own GCR client rather than importing `db.js` (functionally identical). **No auth on any route** — public write access. All WORKING against `entity_*` tables **except**: **`gallery.js` reads from `entity_photos` (`:27`) but its POST/PUT/DELETE write to `entity_gallery` (`:78,104,129`)** — read and write paths target different tables, so anything posted through this route's write endpoints never appears on its own read endpoint. Bug, not yet fixed.

### boat-rental.js / charter.js — UNMOUNTED
Complete Stripe Connect deposit-booking systems. **Both share a live bug**: reference a bare `stripe` identifier that's never declared/required — `boat-rental.js:134`, `charter.js:193`. `POST /book` would throw `ReferenceError` immediately if remounted. Fix: `const stripe = require('stripe')(...)` like `photographer.js:290` does correctly.

### bookings.js (mounted `/api/bookings`)
DB: GCR client. Public create + `authRequired` GET/PUT/DELETE for owner. WORKING, simple slot/capacity model.

### dashboard.js (mounted `/api/dashboard`), 5640 lines — THE business-owner dashboard API
DB: main (`supabase`) + `gcr()` for entity-linked writes. `router.use(authRequired)` at `:84` gates the whole file. **`server.js` mounts this despite a `// TODO: has missing module dependencies` comment** — verify it actually boots clean in production logs. ~180 endpoints; key ones:
- `GET /overview` `:126`, `/declined-bookings` `:168`
- Profile/hours/services/gallery/faqs/social/team `:284-519`
- Menu items/categories/subcategories, events `:520-731`
- **Domain**: `GET/PUT /domain` `:2330,2340` — just a string field on `businesses`; `:2365` TODO "Add domain to Caddy via API" — **no real DNS/reverse-proxy automation**
- **SEO**: `GET/PUT /seo` `:2302,2312` — `seo_title`/`seo_description` only, no sitemap/keywords/rank data
- **Billing**: `GET /billing` `:2373` — read-only `plan`/`status` label + sum of installed app prices. **No Stripe subscription/checkout/invoice endpoint for CyberCheck charging the business owner** (Stripe elsewhere is entirely the business charging *their* customers)
- Domain/booking/fleet/time-slots/pricing/addons/group-rates `:732-1194`
- Bookings CRUD `:1195-1365`; **Orders `:1366-1400` — targets the `orders` table, which does not exist in the live DB** (see §4)
- **Customers/CRM** `:1401-1484` — flat table, search, cross-referenced against signed waivers. **No leads/pipeline/stage concept anywhere. No "tasks" table/routes anywhere in the repo** (confirmed via grep across `dashboard.js` and `admin.js`)
- Reviews, review-questions, waivers, documents, menu-editor-link, policies `:1490-1948`
- Coupons `:1949-2002` (real, dual-path GCR/main), Specials `:2008-2041`, qr-theme `:2042-2065`, Connections `:2066-2089`, Pages/Theme incl. `POST /theme/ai-design` `:2197` (AI-generated site theme) `:2090-2301`
- Apps `:2400-2454`, Notifications `:2455-2492`, SMS log `:2493-2507`, availability blocks `:2508-2562`
- `GET /activity` `:2563`, `POST /export/:type` `:2612`, `POST /publish` `:2636`
- Messaging settings + **`POST /sms/campaign` `:2701`** (real Twilio segment blast, opt-out-aware), `GET /sms/campaigns` `:2788`
- Loyalty (settings/members/summary/earn/history) `:2806-2997`
- `GET /stripe-status` `:2998`, `GET /calendar` `:3019`, `GET /analytics` `:3062` (real rollups)
- Media library `:3113-3229`, per-unit availability blocks `:3230-3317`, rental units CRUD `:3318-3404`
- iCal import/export (feed-url/regenerate/external CRUD/sync-now) `:3405-3514`
- AI Profile/QA pairs `:3515-3579`
- **`POST /ai-chat` `:3580-4715`** (1135 lines) — the business-owner AI assistant. WORKING, real: pulls live bookings/revenue/customers/fleet/reviews/FAQs into context, has long-term memory (`business_memories` table), tool-calling loop
- AI chat conversations/memories CRUD `:4716-4784`
- `POST /search-structured` `:4785`, website-content `:4911-4954`, modules `:4955-4981`
- **Duplicate `/faqs` CRUD** — a second implementation at `:4982-5050`, distinct from `:433-466`
- Onboarding `:5051-5084` (real 6-step tracker)
- `POST /resend-confirmation` `:5087`
- Menu AI extraction, vision providers, events extraction, business-card OCR (`/contacts/scan-card` `:5263`) `:5129-5305`
- Promotions full CRUD + `/promotions/claim` + `/promotions/public` `:5306-5482`
- `POST /menu/generate-design` `:5483`

**No working Google/FB/IG OAuth or WhatsApp integration reachable from this file** — social fields are plain text URL inputs; the real integrations exist in the unmounted `google-business.js`/`whatsapp.js`. **No voice/IVR anywhere in the repo** — "AI assistant"/"voice assistant" means this text chat endpoint, not phone calls. `voice-notes.js` is unrelated audio-memo storage, not a voice AI feature.

### deals.js (mounted `/api/deals`)
DB: main, no auth. Self-serve submission, auto-generation from email parser, admin activation, click tracking. WORKING except `POST /:id/click` `:288` uses `db.raw(...)` (`:293`) which doesn't exist on the Supabase JS client — if the `increment_deal_clicks` RPC is missing, the fallback itself throws and is silently swallowed. Click tracking may silently no-op.

### email-parser.js (mounted `/api/email-parser`)
DB: main, **no auth on any route** (including `/log` and `/setup/:slug`, despite doc comments implying admin-only). 24 platform-specific extractors (FareHarbor, Peek Pro, BoatBooker, Airbnb, VRBO, Booking.com, OpenTable, Resy, Toast, Vagaro, MindBody, Square, HoneyBook, Acuity, Calendly, Booksy, GlossGenius, Yelp, generic fallback) feeding `business_availability`, plus auto-deal creation and iCal 2-way sync. WORKING, extensive, but wide-open write access on `/setup/:slug` (sets `daily_capacity`) and the log viewer.

### email-webhook.js (mounted `/api/webhooks`, alongside `webhooks.js` — no path collision, different sub-routes)
`POST /email` `:33`, optional `EMAIL_WEBHOOK_SECRET` header check. Parses Venmo/CashApp/Airbnb/VRBO/Booking.com/Toast payment-notification emails via `extractors/venmo.js`+`cashapp.js`, matches pending song-requests/cooperative/goal contributions, SMS-notifies artist. WORKING.

### fareharbor.js (mounted `/api/integrations/fareharbor`)
DB: main, `authRequired` on owner routes, none on `/webhook`/`/sync-all` (CRON_SECRET-gated if set). Connect, initial+90-day availability sync, webhook capacity decrement, item listing. WORKING. `decrypt()` (`:92-103`) worth a dedicated look — not exercised on a genuine encrypted round-trip in this pass, flagged as "verify" not confirmed-broken.

### gcr.js (mounted `/api/gcr`), 2670 lines — the public discovery API
DB: GCR client, no auth (correct, it's public). `buildFullEntity()` (`:72-502`) assembles a full profile from ~50 tables. No stubs found. Endpoints: `/entities` `:505`, `/entities/paginated` `:671`, `/page-rails/:page` `:898`, `/ads*` `:930-960`, `/industry-contract/:code` `:966`, `/entity/:slug` `:977`, `/entity/:slug/set-pin` `:990` (no rate limit — security note), `/entity/:slug/daily-update` `:1005` (x-menu-pin header), `/events` `:1069`, `/specials` `:1121`, `/happy-hours` `:1164`, `/search` `:1302` (deep multi-table + pg_trgm fuzzy, shared with AI concierge), `/search/suggest` `:1529`, `/entity/:slug/availability-month` `:1574`, `/taxonomy` `:1635`, `/sections` `:1663`, `/category-page-config/:category` `:1710`, `/entities/:parentSlug/children` `:1773`, `/stay-units` `:1821`, `/live-now` `:1913`, `/track` `:1937`, `/claim` `:1969`, `/locations/autocomplete` `:1993`, `/nfc-card-lead` `:2009`, `/home-feed` `:2032`, `/availability-search` `:2156`, `/social-posts/feed` `:2382`, `/entity/:slug/social-posts` `:2453,2467`, `/social-posts/:id` `:2507`, `/artist/:slug/live` `:2519`, `/opt-in` `:2576`, `/waiver/:slug/sign` `:2603`, `/lodging-search` `:2640`. Exports `buildFullEntity`/`searchEntitySlugs` reused by `tourist.js`.

### gcr/deep-crawl.js (mounted `/api/gcr/deep-crawl`)
Own client. Claude-powered site crawler for onboarding new GCR businesses from a job queue. `GET /status` `:280` and `/jobs` `:306` **fully public, no auth**. `POST /run` `:340` and `/retry-failed` `:486` check `CRON_SECRET` only if set — if unset, open, and `/run` burns real Anthropic credits (up to 20 businesses/request). `/results` `:507` also public. WORKING logic, weak auth.

### google-business.js — UNMOUNTED
Complete OAuth2 + Google Business Profile v4 (auth/callback/status/locations/reviews/reply/sync-reviews/disconnect), AES-256-GCM token encryption. Fully built, unreachable.

### links.js (mounted `/api/links`)
`GET /menu` `:8` — parallel-fetch QR menu page assembly. WORKING.

### live-photo.js (mounted `/api/live-photo`)
Public upload with AI food-verification (Claude vision), storage upload, loyalty-point award, delayed review-request SMS. **`PUT /:id`/`DELETE /:id` have no auth — anyone can approve/delete any business's customer photo by ID.** WORKING otherwise.

### menu-edit.js (mounted `/api/menu-edit`)
DB: GCR client. Legacy passcode-gated editor. **`PASSCODE = '1234'` hardcoded** (`:11`, own TODO acknowledges it). WORKING CRUD, trivial auth.

### menu-editor.js (mounted `/api/menu-editor`) — pre-read in an earlier pass
29 `pinAuth`-gated routes (create, auth, data, availability, menu/drink/hh sections+items, specials, events, staff, availability, fuel, upload, save, qr-menu, set-hero, photo). `pinAuth` (`makeToken = SHA256(slug:pin:GCR_SUPABASE_SERVICE_KEY)`) is defined only in this file, not reused elsewhere. Backs `restaurant-menu-editor-MAIN-`.

### messaging.js — UNMOUNTED
Real conversation/message threading (owner ↔ guest/artist) with optional SMS relay via `utils/sendSms.js`. Complete, unreachable.

### meta-webhook.js (mounted `/api/meta-webhook`)
Own client from **bare** `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (`:29-32`) — the one file not using the `GCR_`-prefixed vars. `GET /` `:37` (webhook handshake), `POST /` `:53` (HMAC-verified IG/FB post events) → Claude photo classification → auto-save to gallery / hours-exception write (`analyzePost()`/`applyAnalysis()` `:97-175`). Sophisticated, WORKING, but silently dependent on a non-standard env var pair.

### modules.js — UNMOUNTED, the RICHER app-store backend
`module_manifest`/`user_modules` tables, large seed-SQL comment cataloguing every planned module (bookings, waitlist, waivers, QR codes, coupons, staff, AI assistant, WaveAgent, data-sync, CSV import, FareHarbor/Square/Google Business integrations, GCR directory, Trip Swipe). Complete, deliberately superseded per `server.js`'s comment ("now run through the ONE universal engine /api/platform"), not accidentally orphaned — but this is what a real modular app-store backend should probably be built on if `apps.js`'s simple install/uninstall isn't enough.

### ocr.js (mounted `/api/ocr`)
`POST /receipt` `:13`, no auth. Claude-vision receipt parser. WORKING.

### photographer.js — UNMOUNTED
Complete session-booking (availability schedule, Stripe Connect deposit, gallery delivery SMS). Correctly instantiates `stripe` locally (`:290`) — no bug, safe to remount as-is.

### platform.js (mounted `/api/platform`) — pre-read in an earlier pass, the "ONE universal booking engine"
`ownedSlug()` (`:74-87`) uses `.maybeSingle()` — **limits an account to one owned entity.** Endpoints: `/state`, `/registry` (GET/POST/DELETE), `/records/:dataKey` (GET/POST/PATCH/DELETE — the generic CRUD that makes forms/customers/reviews/loyalty modular), `/upload`, `/calendar`(+`/calendar/import`), `/page/:slug`(+`/availability`,`/promo/:code`,`/submit/:appId`), `/manage/:id`(+`/cancel`,`/reschedule`), `/waiver-info/:slug`, `/waiver-sign/:slug`, `/cron/reminders`, `/sms/business`, `/my-bookings`, `/my-share`, `/rewards/:slug`, `/redeem`, `/reviews`, `/u/:code`, `/review-token/:id`. This is what `modular-dashboard.html` (cybercheck-login) and gcr-unified's `public/*.html` micro-apps both call — confirmed real and connected on both ends.

### public.js (mounted `/api/public`), 3287 lines — public storefront/booking API
DB: main. `requireSite` middleware (`:133-169`, applied `:476`) resolves `site_id` from domain/query params. No user-identity auth (correct — public API). **Two duplicate dead routes**: `POST /waivers/send-link` defined at both `:174` and `:3037` (second unreachable, Express uses first match); `POST /resend-confirmation` likewise at `:264` and `:2685`. Comment at `:514-516` shows the team already caught and fixed one similar duplicate (`/menu`) but missed these two. Key endpoints: waivers `:174-473`, profile/services/gallery/reviews/faqs/hours/team/specials/social/fleet `:481-670`, blackout-dates/availability/hold/bookings (RPC-backed, overbooking-safe) `:675-1113`, tracking (`/track`,`/events`,`/funnel`) `:1118-1206`, `/contact` `:1211`, **`/chat` `:1304`** (dual-mode: tourist Grok chat or full OpenAI function-calling concierge that checks availability/holds/books/texts — real, not a toy), **`/gcr-chat` `:1902`** (GPT-4o-mini local-expert search), waiver GET/POST non-token `:1986-2110`, reviews `:2117-2351` — **`POST /review` calls `sendSmsAsync(...)` at `:2344`, a function never defined or imported in this file — `ReferenceError` on every review submission with an owner phone configured, silently caught by the surrounding try/catch (`:2338-2347`). Owner SMS notifications for new reviews never send. Confirmed live bug.** Loyalty balance/signup/redeem `:2357-2534`, **`/order` `:2409` writes to the nonexistent `orders` table** (see §4), site-data/locations/docks/links-page/addons/modules/save-section `:2539-2680`, `/payment-config` `:2803`, `/business` `:2844`, `/menu` `:2912` (canonical menu endpoint, GCR→legacy `businesses` fallback chain), waiver send-link/reminders cron `:3037-3195`, `/gcr-stats` `:3198`, `/ical/:slug/:tokenFile` `:3217` (outbound .ics for Airbnb/VRBO), `/business-lead` `:3271`.

### qr.js (mounted `/api/qr`)
DB: main, `authRequired` owner/admin routes, public scan/track/capture/partner/digest routes. Numbered QR batches, per-scan lead scoring (`:300-334`), instant SMS alerts, full referral-partner commission system (`:381-550`), cron daily/weekly SMS digests (`:586-675`). All WORKING.

### rehost-photos.js (mounted `/api/gcr/admin`)
Token-gated (`REHOST_ADMIN_TOKEN`, refuses to run if unset — `:46`). Bulk migration of externally-hosted photos into owned Supabase Storage. WORKING, well-guarded. **Duplicate implementation of `admin.js:3413`'s `/gcr/rehost-photos`** — two versions of the same migration exist.

### rentals.js / services.js (own paths)
DB: main, `authRequired` owner routes. Booking-resource CRUD (`bookable_resources`/`booking_events`). WORKING, straightforward.

### rides.js — UNMOUNTED
Complete SMS-dispatch taxi-bidding (rotation, Stripe Connect payment links). Superseded by the live `transportation.js`.

### setup-questions.js (mounted `/api/admin/setup-questions`)
**Routing bug, confirmed live:** exports a `combinedRouter` that mounts a `publicRouter` (route `/setup-questions`) at its own root (`:92-96`); `server.js` mounts the whole thing at `/api/admin/setup-questions` (`server.js:59`). Doc comment (`:4-5`) claims the public route is `GET /api/tourist/setup-questions`, but as wired it actually resolves to `GET /api/admin/setup-questions/setup-questions` — not the documented path. Meanwhile `tourist.js:119-142` independently defines its own `GET /setup-questions` returning a **hardcoded** array, and that's the one actually reachable at `/api/tourist/setup-questions`. **Net effect: admin edits to the DB-backed setup-questions table never reach real users**, who get the hardcoded stub instead.

### simple-menu-edit.js (mounted `/api/simple`)
DB: GCR client, **no auth on any route** (not even a passcode). Full menu/specials/photo-upload CRUD by slug alone. WORKING logic, zero access control.

### site.js (mounted `/api/site`)
DB: main, all `authRequired`. CRUD for `menu_items`/`services`/`bookings`/`orders`/`customers`/`connections`/`specials`/`events` + rental-specific fleet/time-slots/pricing/addons/waivers. **`/orders` GET/PUT (`:208-237`) targets the nonexistent `orders` table** (see §4).

### sms.js (mounted `/api/sms`)
Own client, `adminRequired` on outbound-send, `verifyTwilioSignature` on inbound. Tourist SMS signup state machine, staff quick-toggle commands, QR campaign tracking. **Outbound replies are intentionally disabled right now** (`:153-159` — A2P 10DLC registration still pending, Twilio would silently drop replies anyway; state/tokens still save, just skips `twiml.message(...)`). Deliberate, not a bug.

### square.js (mounted `/api/square`)
DB: main. Manual-key save + OAuth-connect, AES-256-GCM key encryption, `create-payment` with full post-payment SMS/email/waiver flow mirroring `stripe.js`. WORKING, thorough.

### stripe.js (mounted `/api/stripe`), 887 lines
DB: main. Connect OAuth, manual-key save/status/mode, `create-payment-intent` (platform-fee/Connect-destination routing), disconnect, publishable-key/config, secure key-setup-link email flow (lets an owner submit their Stripe key without logging in), `payment/charge`, `payment/refund`, `/refund`, `/webhook` (duplicate of `webhooks.js`'s Stripe handler). All real. **`:671-678`** — live-key verification on the secure-link submission path is explicitly disabled (`// TODO: Re-enable once platform account is reinstated`), currently a no-op.

### team.js — covered under blog/faqs/gallery group above.

### tourist-auth.js (mounted `/api/tourist-auth`)
DB: main + own admin client. Email 6-digit-code signup/verify/resend/signin/forgot/reset, Firebase phone-auth token verification, **Twilio Verify** phone OTP (deliberately separate infra from the main Twilio number to dodge A2P 10DLC, `:404-410`), magic-link phone sign-in, add-email-to-phone flow, defensive multi-candidate Twilio credential resolution because env vars have historically held the wrong SID type (`:414-483`, long self-documented workaround). Backfills anonymous guest activity into a real account on signup (`:71-136`). All WORKING.

### tourist-groups.js (mounted `/api/tourist/groups`)
DB: main. Create/join/list/get/leave, shareable invite links, saves-based overlap computation. File header confirms it was **rewritten** because the original assumed schema columns that don't exist on the live tables (`:14-23`). WORKING now.

### tourist.js (mounted `/api/tourist`), 2251 lines
DB: main + GCR client. `touristAuth`/`touristAuthOptional` (guest-UUID-tolerant). Profile/saves/itinerary bundle, swipe-event recording with decayed preference scoring, `/recommendations`, SMS opt-in, itinerary email (Brevo), **AI itinerary builder** (`/build-itinerary`), **AI concierge chat** (`/ai-chat`, `:998-1742`) — Claude tool-use loop with 7 tools (`search_businesses`, `get_business_details`, `check_availability`, `find_item_prices`, `compare_businesses`, `save_memory`/`update_memory`/`delete_memory`), reuses `gcr.js`'s `buildFullEntity`/`searchEntitySlugs`, persisted conversations + long-term memory. Community photo/video upload, phone-verified reviews, points/rewards ledger, geofenced SMS deal-pinging (`checkGeofence`, `:2070-2176`), admin tag-based SMS campaign blasts. `GET /setup-questions` `:119-142` is the hardcoded stub that shadows `setup-questions.js` (see above). Everything else real.

### transportation.js (mounted `/api/transportation`)
DB: main. Live replacement for `rides.js`: entity_slug-keyed SMS dispatch/bid/confirm for pickup/dropoff/luggage. Provider/vehicle CRUD, company toggle, cron dispatch expiry. **Unlike `rides.js`, does not appear to mint a Stripe Payment Link on confirm** — worth checking against `rides.js:360-406` if payment collection on this path matters to you.

### update-link.js (mounted at both `/api/update` and `/update`), 1376 lines
DB: main + GCR client. Token-based (`validateToken`, `:102-140`) full mobile daily-editor: menu/drinks/happy-hour/events/specials/catch-of-the-day/pricing/whats-included/faqs/requirements/sides/daily-features/secondary-hours CRUD, AI "daily rotation" picker (GCR + main-DB write-through), AI menu-setup onboarding (image → vision extraction, website-text → AI extraction). Admin routes `adminRequired`; token routes need the link's `passcode` (**default `'000000'` if none set**, `:109`) or nothing beyond the token for `GET /` and `GET /:token/data`. All WORKING.

### user.js (mounted `/api/user`)
DB: GCR client. `authRequired` + `req.isGCR` gate (`:9-12`) — restricted to GCR-native Supabase-auth accounts specifically. Full owner-side profile/menu/drinks/happy-hours/specials/events/photos/hours/modules/fleet/bookings/features CRUD, resolved through `profiles.slug` → fallback `entity_owners.entity_slug` (`:16-44`). WORKING.

### verify-dns.js (mounted `/api/verify-dns`)
`POST /check` `:9`, `GET /status/:domain` `:40` — raw DNS lookups, no auth, no persistence. WORKING utility.

### voice-notes.js (mounted `/api/voice-notes`)
Own client, `authRequired`. Audio-file upload/get/delete against `voice_notes` table + `entity-media` storage. WORKING but is audio-memo storage — not a "voice AI" feature, don't conflate the two.

### webhooks.js (mounted `/api/webhooks`, alongside `email-webhook.js`)
`POST /stripe` `:9` — duplicate of `stripe.js:835`'s Stripe webhook handler (two receivers exist; check which is actually registered in the live Stripe dashboard, possibly one is legacy). Explicitly documents (`:55-58`) its `orders` branch **cannot fire** — nothing ever sets `metadata.order_id` on a real payment intent, and the table doesn't exist anyway. `POST /twilio` `:131` — STOP/START opt-out compliance + inbound logging, WORKING. `POST /google` `:204` — **pure TODO stub**, logs payload, returns `{received:true}`, does nothing else.

### whatsapp.js — UNMOUNTED
Real Graph API send/connect/disconnect/status. Complete, unreachable.

## 4. Cross-cutting bugs (confirmed, ranked by impact)

1. **`orders` table doesn't exist in the live DB** (confirmed via comments in `webhooks.js:55-58`) — yet 3 route files still target it: `site.js:208-237`, `public.js:2409-2444`, `dashboard.js:1366-1400`. **Restaurant/online ordering has no working backend at all**, despite 3 separate implementations.
2. **`sendSmsAsync` is undefined** in `public.js:2344` — live, mounted, silently breaks owner SMS notification on every review submission.
3. **`stripe` is undefined** in `boat-rental.js:134` and `charter.js:193` — moot while unmounted, must fix before ever remounting either.
4. **`gallery.js`** reads `entity_photos`, writes `entity_gallery` — disjoint tables.
5. **`setup-questions.js`** — admin-edited questions never reach the real Trip Swipe flow (`tourist.js` hardcoded stub wins).
6. **Duplicate routes in `public.js`**: `/waivers/send-link` (×2), `/resend-confirmation` (×2) — second copies dead.
7. **`deals.js:293`** — `db.raw(...)` doesn't exist on the Supabase JS client, click-tracking fallback silently no-ops.
8. **Two independent Stripe webhook receivers** (`webhooks.js:9`, `stripe.js:835`) and **two independent photo-rehost implementations** (`rehost-photos.js`, `admin.js:3413`) — functional duplication, consolidate when convenient.
9. **`meta-webhook.js`** — non-standard env var pair (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` instead of `GCR_`-prefixed), silent-failure risk.

## 5. Dashboard feature → backend reality matrix

| Feature | Backing route(s) | Status |
|---|---|---|
| Bookings | `dashboard.js:1195-1365`, `public.js:897`, `platform.js` | **Working** |
| CRM / customers | `dashboard.js:1401-1484` | **Working** (flat, no pipeline) |
| Leads (pipeline/stages) | — | **No backing route** (only a platform-level lead insert on NFC card capture) |
| Tasks | — | **No backing route anywhere in the repo** |
| SMS automations/campaigns | `dashboard.js:2701,2493`, `sms.js`, `email-parser.js` | **Working** |
| Coupons | `dashboard.js:1949-2002` | **Working** |
| Reviews | `dashboard.js:1490-1622`, `public.js:2117-2351`, `reviews.js` | **Working**, minus the `sendSmsAsync` bug |
| Billing (platform charges the business) | `dashboard.js:2373` | **Stub** — read-only label only |
| Domain | `dashboard.js:2330-2367` | **Stub** — string field, no DNS wiring |
| SEO | `dashboard.js:2302-2324` | **Thin but working** |
| Analytics | `dashboard.js:3062-3106`, `public.js:1118-1206` | **Working** |
| Social OAuth (FB/IG/Google) | `google-business.js` (built, unmounted) | **Not working** — text fields only |
| WhatsApp | `whatsapp.js` (built, unmounted) | **Not working** — complete, unreachable |
| Voice/AI assistant | `dashboard.js:3580`, `tourist.js:998` | **Working** — text chat, not phone/IVR |
| Waivers | `dashboard.js:1690-1948`, `public.js:174-473,1986-2110,3037-3195`, `gcr.js:2603` | **Working** |
| QR codes | `qr.js`, `dashboard.js:2042` (theme only) | **Working** |
| Onboarding | `dashboard.js:5051-5084` | **Working** |
| Boat rental/Charter/Photographer as standalone modules | unmounted | **Not reachable** |
| Restaurant online ordering | `public.js:2409`, `site.js:208`, `dashboard.js:1366` | **Broken** — target table doesn't exist |
| App-store/modules marketplace | `modules.js` (unmounted, richer), `apps.js` (mounted, basic) | **Partial** |

## 6. One-off root scripts (~40 files) — not part of the deployed app

All connect to **live production Supabase**. Reference `/Users/owner/...` local paths, confirming they're not portable/runnable outside the original dev machine — i.e. genuinely one-time/completed, not scheduled or wired into any pipeline.
- **Diagnostic/reusable**: `audit-db.js`, `check-db.js`, `check-schema.js`, `check_db.js`, `check_table_exists.js`, `inspect-tables.js`, `get-table-info.js`, `scan-images.js` (checks all entity photos for broken/black/corrupt images against live prod API).
- **Completed one-time imports/migrations** (touch `entity`, `entity_photos`, `entity_hours`, `entity_tags`, menu/drink/HH tables, `entity_events`): `import-11-missing-venues.js`, `import-3-new-venues.js`, `import-activity-listings.js`, `import-cobalt.js` (hardcodes one restaurant's menu, sets `menu_pin:'1234'`), `import-gulf-coast-events.js`, `import-local-photos.js`, `import-missing-venues.js`, `import-the-wharf.js` (158-business import), `fix-wolf-bay.js`, `fix-wolf-bay-full.js`, `fix-wolf-ginny.js`, `find-missing-venue-ids.js`, `find-missing-venues.js`, `find-place-ids.js`, `pull-missing-images.js`, `pull-missing-photos.js` (resume-safe via manifest), `match-tripshock-to-places.js`, `upload-tripshock-images.js`, `migrate-from-source-db.js` (generic migrator, needs `SOURCE_URL`/`SOURCE_KEY` not in `.env.example` — dormant).
- **Admin/setup**: `deploy-schema.js` (prints manual SQL, doesn't execute — Supabase JS has no raw-SQL RPC), `delete-admin.js`, `set-pin.js`, `setup-menu-editor.js` (creates demo businesses + admin user), `run_migration.js` (also prints manual SQL), `verify-save.js`/`verify-save-fixed.js` (near-duplicate one-off verifiers for entity `tiki-raw-bar`).

## 7. lib/ and utils/ — all real, all working

**lib/**: `analyze-photo.js` (Claude vision photo tagging, never throws), `edit-log.js` (audit log, fire-and-forget), `entity-resolver.js` (3-path fallback: `entity_owners`→`users.entity_id/slug`→`entity.legacy_site_id`), `find-existing-entity.js` (dedup via RPCs `find_existing_entity`/`fuzzy_entity_search`, advisory only), `industry-contract.js` (industry→table router, 5-min cache), `menu-gcr.js` (menu/drink/HH CRUD by entity UUID), `staff-commands.js` (SMS toggle commands like `SOLD OUT <item>`).

**utils/**: `ai-provider.js` (multi-provider dispatcher, DB-configured, 60s cache), `email.js` (Brevo API sender, booking-confirmation HTML + .ics generation, SMS-relay-of-email fallback via Twilio), `entity-types.js` (canonical enum), `google-places-import.js`, `ical-feed.js`/`ical-parse.js` (RFC 5545, no recurrence/timezone support by design), `listing-category-map.js` (**manually duplicates `gcr-unified/src/categoryMap.js` — must be kept in sync by hand, drift silently breaks the paginated entities endpoint**), `sendSms.js` (shim → `sms.js`), `sms.js` (real Twilio + opt-out check + owner-relay + Brevo-alt path), `type-config.js`, `upload-processor.js` (universal bulk-upload writer, one pass across entity/hours/tags/photos/events/specials/menu/drinks/HH/sections).

**extractors/**: `cashapp.js`, `venmo.js` — payment-notification regex parsers, functionally equivalent.

## 8. middleware/auth.js

`authRequired`/`adminRequired`. Tries Express JWT (`JWT_SECRET`) → falls back to Supabase JWT lookup by `auth_id` then `email` (self-healing, backfills `auth_id` on match) → falls back to raw GCR Supabase JWT (`req.isGCR = true`). Real, multi-path, working.
