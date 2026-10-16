# NEXT GENT BUILD PLAN
Read-only planning. Inputs: DASHBOARD-AUDIT.md, SOURCE-PICK.md, HUB-MAP.md, DASHBOARD-STRUCTURE.md, MODULE-BUILD-SPEC.md, PAPERCLIP-TENANCY.md.
Baselines: gcr-api-clean main@a652fda (+ branch codex/nextgent-integration-20261005@4375aee), Admin-dashboard-main@9836d6c, Dashboards-users-@e797cc1, paperclip-ng@051bc6a, cybercheck-api-database@d64cd86.

## 0. Decisions (fixed)
| layer | system | role |
|---|---|---|
| API + DB | **gcr-api-clean** (Supabase `mkepugvdlktfsossumox`) | the only business API/DB. Cleaned in place, split into modules. Reviews + SMS lifted from cybercheck-api-database |
| Admin UI | **Admin-dashboard-main** | the only operator console (React, registry) |
| User UI | **Dashboards-users-** | the only business-owner dashboard (React; becomes registry-driven) |
| Orchestrator | **Paperclip (paperclip-ng)** | Jarvis → Paperclip tasks → agents (Hermes/OpenClaw) → plugin-cybercheck tools → gcr-api-clean |
| Link | gcr-api-clean `routes/nextgent.js` (merge from branch) ↔ Paperclip `nextgent-store.ts`, `nextgent-gcr-client.ts`, `routes/nextgent.ts` | installs, entitlement, per-install tokens, business link, devices |
| Apps | separate front+back **modules** (menu/QR, bookings, shop, song requests, website builder, waivers, …) | surfaced in dashboards as **tiles** plus small admin/user screens; own public pages |

## 1. Module standard
### 1.1 Folder layout (one module = one folder in each repo that hosts a part of it)
```
gcr-api-clean/modules/<id>/
  manifest.json            # the contract (below)
  routes/admin.js          # mounted at /api/admin/m/<id>
  routes/owner.js          # mounted at /api/m/<id>        (business-scoped by session)
  routes/public.js         # mounted at /api/p/<id>/:slug   (no auth / install token)
  sql/001_init.sql         # own tables, prefixed <id>_ (or shared core tables by reference only)
  events.js                # emits/consumes (see §4)
  service.js               # logic; the only file that touches its tables
  tests/
Admin-dashboard-main/src/modules/<id>/
  index.js                 # registry entry export(s) (routes, nav, screens)
  screens/*.jsx            # admin screens
  api.js                   # endpoints for this module only
Dashboards-users-/src/modules/<id>/
  index.js                 # registry entry export(s) (tile, routes, screens, settings form)
  screens/*.jsx  tile.jsx  settings.jsx  api.js
apps/<id>/ (optional, separate deploy)   # public front end (QR menu page, shop, booking checkout, link page blocks)
  blocks/*.jsx             # link-page / website blocks this module provides
```
Rules:
- A module touches only its own tables plus core read APIs (entity, owners, media).
- Cross-module effects happen through events (§4), never through imports.
- Shared UI lives only in the ui kit; no module imports another module.

### 1.2 Manifest fields
| field | type | meaning |
|---|---|---|
| id, name, version, kind | string | kind ∈ core / app / automation / connector / agent / layout (maps to Paperclip store kinds; gcr store kinds collapse into these) |
| description, icon, category | string | store card |
| tables | [{name, owner:true/false, rls}] | tables owned; core tables read |
| routes | {admin:[…], owner:[…], public:[…]} | method + path, for the generated route map and route-existence tests |
| permissions | ["menu:read","menu:write",…] | install-token scopes (gcr-ng lib/businessTables.js:469 pattern) |
| admin | {nav:{group,label,icon,path}, screens:[…]} | admin registry entry |
| user | {tile:{label,icon,summaryEndpoint}, screens:[…], nav:{group,order}} | user registry entry |
| public | {pages:[{path:"/:slug/menu", component}], blocks:[…]} | public pages + link-page/website blocks |
| settings | JSON Schema | rendered by SchemaForm (ADM ui/SchemaForm.jsx) in both dashboards |
| events | {emits:[…], consumes:[…]} | §4 |
| theme | {slots:[…], variants:{screen:[…]}} | §3 |
| entitlements | {access:"free"/"plan"/"grant", plans:[…], price, trial_days, limits:{…}} | Paperclip entitlement + gcr store_plan_items |
| presets | ["restaurant","artist",…] | default-on in which business-type presets |
| dependsOn | [moduleId] | e.g. qr → menus |
| mcp | {sections:[…]} | which sections the plugin-cybercheck tools may read/write |

### 1.3 Example manifest (menus)
```json
{
  "id": "menus", "name": "Menus", "version": "1.0.0", "kind": "app", "category": "food",
  "icon": "🍽️", "description": "Food, drinks and happy-hour menus shown everywhere your business appears.",
  "tables": [
    {"name": "menu_sections", "owner": true}, {"name": "menu_items", "owner": true},
    {"name": "drink_sections", "owner": true}, {"name": "drink_items", "owner": true},
    {"name": "happy_hour_sections", "owner": true}, {"name": "happy_hour_items", "owner": true},
    {"name": "entity", "owner": false}
  ],
  "routes": {
    "admin": ["GET /api/admin/m/menus/:slug", "POST /api/admin/m/menus/import"],
    "owner": ["GET /api/m/menus", "POST /api/m/menus/items", "PATCH /api/m/menus/items/:id", "DELETE /api/m/menus/items/:id", "POST /api/m/menus/extract"],
    "public": ["GET /api/p/menus/:slug"]
  },
  "permissions": ["menus:read", "menus:write"],
  "admin": {"nav": {"group": "apps", "label": "Menus", "icon": "🍽️", "path": "/apps/menus"}, "screens": ["MenuBuilder", "MenuEditorsHub"]},
  "user":  {"tile": {"label": "Menu", "summaryEndpoint": "/api/m/menus/summary"}, "screens": ["MenuEditor", "AiExtract"], "nav": {"group": "sell", "order": 10}},
  "public": {"pages": [{"path": "/:slug/menu", "component": "PublicMenu"}], "blocks": ["MenuBlock", "SpecialsStrip"]},
  "settings": {"type": "object", "properties": {
    "currency": {"type": "string", "default": "USD"},
    "showPrices": {"type": "boolean", "default": true},
    "staffPin": {"type": "string", "format": "pin"}}},
  "events": {"emits": ["menus.item.created", "menus.item.updated", "menus.item.deleted", "menus.published"], "consumes": ["media.photo.uploaded"]},
  "theme": {"slots": ["menu.header", "menu.itemCard", "menu.sectionTitle"], "variants": {"PublicMenu": ["list", "cards", "dark-board"], "MenuEditor": ["table", "cards"]}},
  "entitlements": {"access": "plan", "plans": ["starter", "pro"], "trial_days": 7, "limits": {"items": 500}},
  "presets": ["restaurant", "venue", "food-truck"],
  "dependsOn": [],
  "mcp": {"sections": ["menu_sections", "menu_items", "drink_items", "happy_hour_items"]}
}
```

## 2. Install / entitlement gating in both registries
| step | where | detail |
|---|---|---|
| Source of truth | Paperclip store_installs + entitlement (PC services/store.ts:599 install → assertEntitled) **projected** into gcr-api-clean store_installs via nextgent routes (gcr-ng nextgent.js:344-682) | one install row per (business, module) with status installed/disabled + version + config + permissions |
| Read API | NEW `GET /api/me/modules` (owner) and `GET /api/admin/businesses/:slug/modules` | returns [{id, version, status, config, permissions, entitlement}] joined with manifests |
| Registry contract (both dashboards) | `registry.js` imports every `modules/*/index.js`; each entry carries `moduleId` and `core: bool` | ADM pattern registry.js:999-1010 extended |
| User gating | Dashboards-users- registry filters `core || installed(moduleId)`; tiles render installed apps; un-installed shows in Store only | replaces discoverSections "has rows" (discoverSections.js:183) and AddSection |
| Admin gating | global admin sees all modules; **business scope** (EntityPicker) filters business-level screens to that business's installs; role scopes (owner/admin/member) from Paperclip membership | registry `scope: platform/business` |
| Route guard | gcr-api-clean middleware `requireInstall(moduleId, perm)` on owner/public routes; install token or session | lib/businessTables.js:469 permission check |
| Install flow (user) | Store → card → consent to permissions (PC nextgent-store.ts:129 describePermissions) → install → module `onInstall` creates default rows → tile appears | Store.jsx flow kept |
| Grant flow (admin) | ADM Store item → deploy audience (companies, plan, kind) → installs created → tiles appear | PC store.ts:292 audience |
| Trial / plans | entitlement access free/plan/grant; trial_days in manifest; billing via store plans | add trial to entitlement |

## 3. Theming and UI/UX pick-and-choose
### 3.1 Theme tokens (one JSON per business: `business_theme`)
| token group | tokens |
|---|---|
| color | primary, secondary, accent, bg, surface, text, muted, success, warning, danger; mode light/dark |
| type | fontHeading, fontBody, scale (sm/md/lg), weightHeading |
| shape | radius (0/6/12/24), shadow (none/soft/strong), border |
| layout | density (compact/comfortable), maxWidth, navStyle (sidebar/bottom/top) |
| brand | logo, cover image/video, favicon, social image |
| motion | none/subtle |
Implementation: CSS variables (ADM already uses css vars in ui/primitives.css, shell/useTheme.js; USR lib/useTheme.js). The same tokens drive dashboards, public pages and link page.

### 3.2 Layout blocks (public site / link page / in-app pages)
| block | provided by | reference look |
|---|---|---|
| Hero (photo/video, name, CTA row) | core site | CB website hero; MySet profile top |
| Link buttons / socials | link-page | MySet link page; A9ENT card |
| Contact actions (call, WhatsApp, email, Calendly, form) | contact | A9ENT |
| Save contact (vCard) + QR + NFC | card | A9ENT; CCL card.html |
| Menu / Specials strip | menus, specials | CCL q.html; Boxes menu |
| Book now / availability calendar | bookings | CB circle-boats-website booking widget; ADM WebsiteCalendar embed |
| Shop grid | shop | MySet /shop |
| Tip button | tips | MySet |
| Vote queue / requests | live-vote, song-requests | MySet voting page; CCL song-request.html |
| Events / shows list | events | MySet calendar |
| Listings grid with CTAs | listings | A9ENT listings |
| Reviews | reviews | CCB reviews |
| Membership wall (locked posts) | membership | MySet diary |
| Gallery | media | CCB media |
| FAQ, policies, hours, map | core profile | USR sections |
| Form (quote/valuation/inquiry) | forms | A9ENT valuation |

### 3.3 Per-business screen variants
Each module's manifest lists `theme.variants` per screen. Business settings store `{screenId: variant}`. Variants are taken from reference sources:
| screen | variants (source) |
|---|---|
| Owner dashboard shell | `sidebar-grouped` (CCB index.html:21-136), `bottom-nav-mobile` (USR BottomNav), `tiles-home` (new) |
| Owner overview | `stats+quick-actions` (CCB index.html:171-182), `tiles` |
| Public menu | `list`, `cards`, `dark-board` (CCL menu-editor-dark, q.html) |
| Booking page | `calendar-first` (CB website), `trip-cards` (charter), `slot-list` |
| Link page | `stack` (MySet), `card` (A9ENT), `grid` |
| Shop | `grid`, `list`, `table-merch` (MySet) |
| Editors | `table` (ADM DataTable), `cards` (USR sections), `modal-forms` (CCB modals) |

### 3.4 Presets by business type (`presets` table: modules + theme + variants + default content)
| preset | modules | theme | variants |
|---|---|---|---|
| restaurant | profile, menus, qr, specials, events, reviews, waitlist, loyalty, shop(order), daily-updates, sms | warm, cards | public menu cards; overview stats |
| venue/bar | profile, events (auto from artists), menus, specials, qr, local-feed, perform-here intake, reviews | dark | board menu |
| artist/band | link-page, live-vote, song-requests, tips, shop(merch), events, membership, ledger, booking-requests, community | dark stage | link stack |
| fishing charter | profile, listings(trips), bookings, waivers, tips, shop(photos/gear), reviews, sms reminders, ledger | marine | trip-cards |
| dolphin cruise / tours | bookings(departures), waivers, tips, shop(photo packs), coupons, reviews, sms | coastal | calendar-first |
| boat rental (Circle Boats) | inventory, availability, add-ons, locations, bookings, waivers, payments, website builder | CB | calendar-first |
| realtor/team | link-page(card), listings+CTAs, leads/CRM, card/QR/NFC, open-house check-in, quote form, recruiting, pixels, ai-studio, teams | brand | card |
| photographer/services | bookings, galleries, shop(prints), quote form, reviews | gallery | grid |
Preset apply = Paperclip store "pack" (kind pack) installing several modules + `layout` item for theme and blocks.

## 4. Change-event bus and Paperclip fan-out
### 4.1 Bus (gcr-api-clean)
| piece | design |
|---|---|
| table | `events_outbox(id, business_slug, module_id, type, entity_id, payload jsonb, created_at, delivered_at)` |
| emit | every write in a module service calls `emit(type, payload)` in the same transaction (menus.item.updated …) |
| deliver | worker (cron tick already exists: automations.js:615) delivers to: (a) in-process consumers (other modules' `events.js`); (b) automations with trigger `event:<type>`; (c) Paperclip signed webhook `POST /api/nextgent/events` (new on the PC side; PC already accepts signed receipts/conversations, routes/nextgent.ts:338-347) |
| subscribe registry | built from manifests `events.consumes` + store installs (only installed modules receive) |
| idempotency | event id; consumers record the last id |
| audit | outbox doubles as the activity log (missing today) |

### 4.2 "Update my menu" flow
| # | step | system | exists? |
|---|---|---|---|
| 1 | Matt: "add crab legs $24 to dinner" | Jarvis chat | yes (NEXT_GENT.md:13) |
| 2 | Jarvis creates a task, assigns the business-editor agent | Paperclip MCP paperclipCreateIssue | yes |
| 3 | Agent reads sections, writes the row | plugin-cybercheck business_read_section / update_row → gcr `/api/mcp` → service | yes; route through module service so events fire (**new**) |
| 4 | Optional approval "publish?" | Paperclip approvals | yes |
| 5 | menus service emits `menus.item.created` | outbox | **new** |
| 6 | In-process consumers: qr (regenerate PDF/cache), website (rebuild page), listing (reindex RAG, gcr.js cache), link-page (refresh block), concierge (reindex) | module events.js | **new** |
| 7 | Connector consumers: Google Business menu, Square catalog, Yelp | connector modules (composio/google-business.js/square.js) | **new consumers** |
| 8 | Paperclip receives the event → routine posts "menu updated on 6 places" back on the task, or triggers follow-ups (social post draft) | PC routines | **new webhook** |
| 9 | Result shown in Jarvis and in both dashboards' activity feed | outbox → activity | **new** |
Prerequisite: one menu model (§6). Otherwise the legacy site_id path (public.js:2968) and menu_categories (dashboard.js:579) miss the change.

## 5. Every module
Type: C = core, A = app (tile + own public page), X = connector, T = automation/agent. Phase: see §7.
| module | type | source to lift (repo file) | tables | admin screen | user screen | public page | work needed | phase |
|---|---|---|---|---|---|---|---|---|
| auth | C | gcr auth.js:426, business-auth.js:301; USR Login/SignUp/AcceptInvite; ADM auth/* | users (one store), entity_owners, invites | Users | Login, SignUp, Invite | — | merge 4 user stores; Paperclip identity link | 1 |
| companies/businesses | C | gcr admin.js businesses/link-user; nextgent link; ADM Businesses + ng-businesses; USR BusinessPicker | entity, entity_owners, company link | Businesses | Picker/switcher | — | slug ↔ companyId map | 1 |
| people/claims/sign-ups/leads | C | ADM People, Claims, Signups, Leads; gcr admin-signups.js | business_claims, business_signups, business_leads | People, Claims, Signups, Leads | Claim | claim form | one people endpoint | 1 |
| store/installs/entitlements | C | gcr store.js; gcr-ng nextgent.js; PC store.ts/entitlement.ts; ADM store/*, ng-store; USR Store/Platform | store_* (projection) | Store, Item, Plans/Grants | Store | — | PC = source of truth; merge the two store UIs; /api/me/modules | 1 |
| registry gating | C | ADM registry.js; USR new registry | — | — | — | — | §2 | 1 |
| billing | C | gcr billing.js; CCB billing.js UI | billing_* | Plans, Invoices | Billing | — | trial, invoices, Stripe billing | 3 |
| connections | X | gcr composio.js; ADM Connections; USR AppStore | platform_connections, entity_connections | Connections catalog | Connections | — | rename; add payment onboarding | 1 |
| events bus + activity | C | new (gcr automations cron tick) | events_outbox | Activity | Activity | — | build | 1 |
| automations | T | gcr automations.js + automationEngine.js; ADM automations/*; USR Automations | automations, versions, entity_automations, runs | Builder, Rollouts, Runs | Automations | — | event triggers; install via store only; template gallery (CCL automation-templates) | 2 |
| agents (Paperclip) | T | PC agents, plugin-cybercheck; ADM ng-*; USR Platform | PC | Agents, Store publishing | Jarvis/Agents tab | — | owner agent/task UI; business-editor skill | 2 |
| settings/API keys | C | gcr admin-settings.js; ADM Settings, ApiKeys | platform_settings | Settings | Business settings | — | — | 1 |
| profile (hours, photos, FAQs, team, policies) | C | gcr business-data.js; USR sections, RowEditor | entity_* profile tables | Entity editor | Profile | in site | gate by core; logo upload, closed days (CCB profile.js) | 1 |
| media | C | gcr gallery.js, rehost-photos.js; CCB media.js | entity_photos, entity_gallery | Photos | Media library | gallery block | storage, library UI | 2 |
| analytics | C | gcr analytics.js, admin-analytics.js; ADM Analytics; CCB analytics.js | page_views, conversions | Analytics | Owner analytics | tracking.js | owner view; pixels | 3 |
| AI tools | C | gcr admin.js:2801, ai-provider.js, conciergeTools.js; ADM ai/* | ai_* | AI | Assistant | concierge | credits metering | 3 |
| devices (Ghost) | C | gcr nodes.js, admin-ghost.js; ADM GhostBoxes; USR Ghost | ghost_* | Ghost boxes | My Ghost | — | — | 2 |
| MCP access | C | gcr mcp.js:139-228 | business_mcp_tokens | Tokens | — | — | route writes through services | 1 |
| listings/directory | A | gcr gcr.js:978, deep-crawl; ADM directory/* | entity, taxonomy | Directory, Entity editor | (profile) | GCR site | split admin.js /gcr into module | 2 |
| menus | A | gcr menu-editor.js, lib/menu-gcr.js; ADM MenuBuilder; CCL menu-editor; CB menu modals | menu_*, drink_*, happy_hour_*, entity_sides, entity_daily_features | Menu builder, Editors hub | Menu editor + AI extract | /:slug/menu | one model; staff PIN editor; events | 2 |
| qr | A | gcr qr.js:96; ADM QrMenus, QrTracker, ReferralPartners; CCL q.html; Boxes apps/menu | qr_*, referral_* | QR codes, Tracker | QR codes | /q/:code | consume menus events | 2 |
| specials | A | gcr admin.js:710; ADM Specials | entity_specials | Specials | Specials | block | drop `specials` table | 2 |
| daily update links | T | gcr update-link.js; ADM DailyUpdateLinks | daily_rotation_* | Daily links | Daily update | /u/:token | — | 2 |
| events | A | gcr admin.js:654; ADM Events; USR EventsSection | entity_events | Events, Bulk | Events | /:slug/events | recurring (MySet residencies) | 2 |
| bookings | A | gcr bookings.js, availability.js, rentals.js, services.js, availability-engine.js, admin-platform.js; ADM booking/*; CCB bookings/inventory/availability/addons/locations; CB website booking | bookable_resources, availability_slots, booking_events, offerings, offering_prices | Booking platform (17) | Bookings, Inventory, Availability, Add-ons, Locations | /:slug/book (checkout) | one data model; owner screens; public checkout | 3 |
| waivers | A | gcr public.js:175, platform.js waiver-sign; CCB waivers.js; CCL waiver.html | waivers, signed_waivers | Waivers | Waivers editor | /:slug/waiver | dedupe 5 copies | 3 |
| waitlist | A | CCB waitlist.js (UI only) | waitlist (new) | — | Waitlist | /:slug/waitlist | backend new | 4 |
| song requests / artists | A | gcr artists.js, cooperatives.js, goals.js, artist-bookings.js; ADM ArtistProfiles; CCL song-request.html; USR artistModule | artist_*, song_requests, songs | Artists, Requests | Requests queue, Setlist | /:slug/request | — | 3 |
| live vote queue | A | new (MySet reference); extend song requests | vote_sessions, votes | — | Live queue | /:slug/vote | build | 4 |
| tips | A | new; CCL apps/tipjar.json | tips (ledger) | — | Tips | block | Stripe Connect | 3 |
| shop (products/services, merch) | A | new (MySet /shop reference); gcr stripe.js | shop_products, shop_variants, shop_orders, shop_requests | Shop overview | Products, Orders (pickup codes), Requests | /:slug/shop | build | 3 |
| payments | X | gcr stripe.js:304, square.js; CCB oauth.js | connections, payments ledger (new) | Payments | Payment setup | checkout | ledger table | 3 |
| reviews | A | **cybercheck-api-database reviews.js:77** + gcr google-business.js:351; CCB reviews.js | entity_reviews, review_requests, consents | Reviews | Reviews, Requests | /:slug/review | lift CCAD routes | 2 |
| SMS / messaging | A | **cybercheck-api-database sms.js:287, :434** + gcr sms.js:258; CCB messaging.js | sms_log, threads, templates, opt_outs | SMS, Blasts | Inbox, Templates, Notifications | — | lift CCAD inbox/reminders; fix ADM Messaging | 2 |
| social | A | gcr meta-webhook.js; CCB social.js | social_posts | Social | Composer, Schedule | — | composer backend | 4 |
| coupons/loyalty | A | gcr dashboard.js coupons/loyalty; ADM Coupons; CCB coupons.js | coupons, loyalty_* | Coupons | Coupons, Campaigns | block | merge | 4 |
| customers/CRM | C | gcr dashboard.js customers; CCB customers.js | customers | Customers | CRM | — | owner CRM | 3 |
| website builder | A | gcr dashboard.js:4911/2090/2636, site.js, verify-dns.js; CCB site-editor, theme, pages, domain, publish, seo | site_pages, site_content → blocks, domains | Sites | Website editor, Domain, Publish, SEO | the site | block-based; consume events; real publish | 3 |
| link page / card / NFC | A | gcr links.js; CCL card.html, card-builder.html; gcr.js nfc-card-lead | link_pages (new) | — | Link page editor | /:slug | vCard, QR, NFC | 3 |
| contact actions + forms (quote/valuation) | A | new (A9ENT); CCL apps/forms.json | forms, form_submissions | Forms | Forms, Submissions | form block | build | 4 |
| membership/diary | A | new (MySet) | posts, memberships | — | Posts, Members | /:slug/club | build | 5 |
| job ledger | A | new (MySet) | ledger_entries | — | Ledger, Reports | — | build | 5 |
| community / local feed | A | gcr gcr.js events, live-now; MySet | — | Feed admin | — | /feed | extend | 5 |
| teams | C | PC membership | — | Teams | Team pages | — | build | 4 |
| open-house check-in | A | new (A9ENT) | checkins | — | Check-ins | /:slug/checkin | build | 5 |
| AI studio (media on credits) | A | new (A9ENT) | ai_credits | Credits | AI studio | — | build | 5 |
| Trip Swipe | A | gcr tourist*.js, setup-questions.js; ADM tripswipe/* | tourist_* | Trip Swipe (17) | — | consumer app | keep admin | 2 |
| AR hunts | A | gcr ar-hunts.js; ADM ArHunts | ar_hunt_* | AR hunts | — | app | — | 5 |
| ads / rails / category cards | C (directory) | gcr admin.js, admin-settings.js; ADM Ads/Rails | ads, page_rails, category_cards | Ads, Rails | — | GCR site | — | 2 |
| intake / webhooks | C | gcr intake.js; ADM Intake | intake_*, webhook_* | Intake | — | — | — | 2 |
| text-the-dashboard | T | gcr dashboard-sms.js; ADM TextTheDashboard | dashboard_sms_* | Text dashboard | — | — | fold into Jarvis | 4 |
| transportation | A | gcr transportation.js | transportation_* | — | — | — | screens | 5 |
| voice notes | A | gcr voice-notes.js | voice_notes | — | — | — | screens | 5 |
| onboarding / presets | C | CCL onboarding.html, tool-selection.html; presets (§3.4) | presets | Presets | Onboarding wizard | — | build | 2 |

## 6. gcr-api-clean cleanup list
| # | item | evidence | action |
|---|---|---|---|
| 1 | Merge the Paperclip link | branch codex/nextgent-integration-20261005 routes/nextgent.js, lib/businessTables.js | merge to main; set GCR_API_URL + NEXTGENT_SERVICE_SECRET on Paperclip |
| 2 | One user store | users (auth.js), admin_users (admin.js /login), tourist_profiles (tourist-auth.js), entity_owners + business-auth | one `accounts` table + roles; business access via entity_owners; tourists = role consumer; admin = role platform |
| 3 | One menu model | menu_categories / menu_subcategories (dashboard.js:579); menu_items by site_id (public.js:2968) | migrate onto menu_sections / menu_items (entity_slug, section_id); drop the old routes |
| 4 | specials vs entity_specials | public.js:605; dashboard.js:2008 | keep entity_specials |
| 5 | events vs entity_events; faqs vs entity_faqs; reviews vs entity_reviews | site.js, dashboard.js | keep entity_* |
| 6 | Three booking models | entity_bookings / bookable_resources+booking_events / bookings+booking_calendar | keep bookable_resources + availability_slots + booking_events; migrate |
| 7 | Six menu APIs | menu-editor.js, menu-edit.js, simple-menu-edit.js, user.js /menu, dashboard.js /menu-*, admin.js /gcr/menu-* | keep the menus module only |
| 8 | Legacy app/module systems | apps.js, modules.js (unmounted), site_apps, module_manifest, user_modules, installed_modules, entity_modules; admin/dashboard/site/public app routes | delete; the store replaces them |
| 9 | Unmounted vertical routes | boat-rental, charter, rides, photographer, messaging, whatsapp (server.js:365-403) | delete (replaced by bookings/SMS modules) |
| 10 | Duplicate mounts | email-parser ×2 (server.js:405-406); /api/webhooks shared by webhooks.js + email-webhook.js (:361, :392) | one mount; rename email-webhook to /api/webhooks/email |
| 11 | Broken routes the dashboards call | /api/admin/gcr/messaging (ADM Messaging, `unverified`); /api/square/config (ADM Integrations.jsx:28) | build in the SMS module / add a status route or change the probe |
| 12 | Oversized monoliths | dashboard.js 5,640 lines; admin.js 3,950; public.js 3,301; platform.js 2,186; tourist.js 1,998 | split into modules/<id>/routes |
| 13 | Waivers ×5, customers ×4, hours ×3 | dashboard, public, platform, site, stripe/square | one module each |
| 14 | Publish only flips a flag | dashboard.js:2636 | website module builds and caches pages; event-driven rebuild |
| 15 | No change events / audit | — | events_outbox (§4) |
| 16 | Store seed + kinds | store.js:42 kinds ≠ Paperclip kinds; no store_items seeded | align kinds; import CCL apps/*.json as draft items |
| 17 | Lift from cybercheck-api-database | reviews.js:77 (requests, consent, POS, inbound SMS); sms.js:287 inbox/thread, :434 reminders | port into modules/reviews, modules/sms |
| 18 | Route-existence test | 1,257 routes (audit/routes.py) | CI: every dashboard endpoint must resolve to a mounted route |
| 19 | No schema source in repo | only 66 tables in sql/ | dump live schema into per-module sql/ |

## 7. Phased build order
| phase | tasks | done when |
|---|---|---|
| **0. Foundations (1-2 wk)** | (a) merge gcr nextgent branch, set env, verify a PC install creates a gcr install token. (b) dump the live schema; write per-module sql. (c) add the route-existence CI (audit/routes.py) to both dashboards. (d) write manifest JSON Schema + module folder template. (e) module loader in gcr server.js mounting modules/*/routes. | PC store install → gcr install row + token; CI fails on a missing route; one empty module mounts through the loader |
| **1. Core platform (2-3 wk)** | auth → one account store; companies (slug ↔ companyId); store/installs as projection of PC; `/api/me/modules`; registry gating in ADM (scope platform/business) and USR (new registry + router replacing Dashboard.jsx state, tiles home, grouped sidebar + bottom nav variants); events_outbox + worker + PC webhook; activity feed; profile core; settings; connections; MCP writes through services | owner sees only core + installed tiles; installing from Store adds a tile without reload; a profile edit emits an event visible in the activity feed and at Paperclip |
| **2. First apps + fan-out (3-4 wk)** | menus (one model, owner editor + AI extract + staff PIN), qr, specials, events, daily links, listings split, reviews (CCAD lift), SMS (CCAD lift; fixes ADM Messaging), automations event triggers, agents tab + business-editor skill, media library, onboarding wizard + presets (restaurant, venue, charter), Trip Swipe kept as admin app, ads/rails, intake | "Update my menu" via Jarvis changes the item, and the listing, QR menu, link block and concierge show it within 1 minute; the activity shows all consumers; Google Business consumer queued |
| **3. Commerce + site (4-6 wk)** | bookings (one model; owner bookings/inventory/availability/add-ons/locations; public checkout), waivers, payments ledger + Stripe Connect onboarding, tips, shop (products/services, variants, sold-out, postage, pickup codes, requests), song requests public page, website builder (blocks, theme tokens, variants, domain, real publish), link page + vCard/QR/NFC, customers CRM, billing (plans, trial, invoices), owner analytics + pixels, AI credits | a fishing-charter preset business takes a booking with waiver + payment + tip on its own site; a band sells a shirt with a pickup code from its link page; publish produces a live site that updates on events |
| **4. Engagement (3-4 wk)** | live vote queue, coupons/loyalty merge, social composer, forms (quote/valuation) + contact actions, waitlist, teams, text-the-dashboard folded into Jarvis | artist preset runs a voting night end to end; realtor preset captures a valuation request with photos into CRM |
| **5. Extras** | membership/diary, job ledger, community/local feed + "perform here", open-house check-in, AI studio, AR hunts, transportation, voice notes | each ships as a store item with manifest, tile and settings, behind entitlement |
| **Cleanup (runs alongside 1-3)** | delete legacy apps/modules routes and tables, unmounted verticals, duplicate menu/booking/waiver routes; fix double mounts; split monoliths as each module lands | route count drops; no dashboard endpoint unresolved; no table written by two modules |

Exit criteria for the whole build:
- Every row in §5 is a store item with a manifest.
- Both dashboards render from manifests plus installs.
- Every write emits an event.
- Jarvis can change any module's data through Paperclip, and the change appears everywhere it is shown.
