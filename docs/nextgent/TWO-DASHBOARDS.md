# TWO DASHBOARDS: one admin, one user, with every app and automation as an add-on
Read-only. Commits checked: Admin-dashboard-main@8053f8e, Dashboards-users-@e9ea28f, gcr-api-clean@e3495a1, cybercheck-login@8b3d6df, paperclip-ng (see PAPERCLIP-TENANCY.md).
Short names: **ADM** = CultureReset/Admin-dashboard-main/src, **USR** = CultureReset/Dashboards-users-/src, **CCL** = cybercheck-login, **API** = gcr-api-clean, **PC** = paperclip-ng.
Full 336-module inventory: DASHBOARD-MODULES.md §1–2. This file covers only the pick and the wiring.

## 0. How each base connects
| piece | entry | backend | auth |
|---|---|---|---|
| ADM | api/client.js:120 `request()`; base env.js:61 default `https://gcr-api-clean.vercel.app`, :69 `VITE_API_BASE_URL`; client.js:186 | API `/api/admin/*` (endpoints.js:36), `/api/gcr/*` (:37) | Bearer admin token client.js:139; login `/api/admin/login` (endpoints.js:45), verify `/api/admin/gcr/claims?limit=1` (:47) |
| USR | lib/config.js:19-21 `VITE_GCR_API_BASE` → API (no Supabase key, config.js:1-10) | API `/api/business/*` (lib/endpoints.js:19), `/api/business-auth`, `/api/store`, `/api/connections`, `/api/nodes`, `/api/business/automations` | phone OTP / password (endpoints.js:29-50); slug from session via entity_owners. Admin acting-as uses `?slug` (apiClient.js:172) |
| CCL | ~62 root HTML + js/*.js (≈100 files) | mix: API absolute URL (15 refs), Supabase direct (admin.html, admin-dashboard.html, gcr-entity-manager.html, onboarding-links.html, sql-setup.html, js/module-loader.js:59 `site_apps`), dead `/api/dashboard/*`, `/api/apps`, `/api/modules` | per page |
| USR dynamic sections | pages/Dashboard.jsx:70 `fetchEntityTables()` → lib/schemaDiscovery.js:67-68 `GET /api/business/schema`; :116 `discoverSections`; add-section catalog components/AddSection.jsx:21 → lib/sectionCatalog.js:110 | API `/api/business/:table` CRUD (endpoints.js:55-66) | session |

## A. ADMIN dashboard: base = ADM (Plat-admin is a near-copy pointed at PC; merge its `nextgent` module in)
Registry: ADM modules/registry.js (groups :27-37). Endpoints are in ADM api/endpoints.js.
| admin module | best source (file:line) | backend (API unless noted) |
|---|---|---|
| Overview | registry.js:48 → home/Overview.jsx | /api/admin/gcr/ads, claims, page-rails |
| All sections | registry.js:57 → home/Sections.jsx | /api/admin/entities/:slug/sections (endpoints.js:126) |
| **Users (accounts)** | registry.js:949 → platform/Users.jsx → api/resources.js:222 | GET /api/admin/users (endpoints.js:48) |
| **People (users+businesses+customers+tourists+claims, one view)** | registry.js:939 → platform/People.jsx:38,54,70,86,102 | /api/admin/users, /businesses, /gcr/customers, /tourists, /gcr/claims |
| **Claims** | registry.js:218 → directory/Claims.jsx:34,56 | GET/PATCH /api/admin/gcr/claims(/:id) (endpoints.js:284-285) |
| Sign-ups | registry.js:231 → platform/Signups.jsx | /api/admin/signups (endpoints.js:297) |
| Businesses / link user / invite | registry.js:884 → platform/Businesses.jsx | /api/admin/businesses, /link-user, /invite-business (endpoints.js:482-484) |
| Sales pages (invite) | registry.js:911 → platform/SalesPages.jsx | /api/admin/invite-business |
| Leads | registry.js:893 → platform/Leads.jsx (resources.js:190) | /api/admin leads |
| GCR businesses / entity editor / profiles / site editor | registry.js:134,143,160,208 → directory/*.jsx | /api/admin/gcr/entities*, /gcr/profile*, /gcr/category-cards, settings |
| Menu builder, QR menus, QR tracker, reviews, referral, daily SMS links, editors hub | registry.js:69-126 → menu/*.jsx | /api/admin/gcr/menu-*, drink-*, hh-*; /api/qr/*; /api/update/*; /api/menu-editor |
| Booking platform (17 screens) | registry.js:245-402 → booking/*.jsx | bookingPlatform.* (endpoints.js:587-718), /api/embed |
| Content: events, artists, **song requests & tips**, specials, ads, rails, coupons, SEO, bulk | registry.js:411-504 → content/*.jsx (ArtistProfiles = song queue) | /api/admin/gcr/events, specials, ads, page-rails, coupons, imports; /api/admin/artists (:467), /api/artists |
| AI chat / organizer / RAG / settings | registry.js:512-542 → ai/*.jsx | /api/admin/gcr/ask, ai-organize, rag-status, ai-config |
| Engagement: analytics, reviews, customers, SMS, social, behaviour | registry.js:550-590, 190 → engagement/*.jsx | /api/admin/gcr/analytics, platform-analytics, customers, social-posts; Messaging = `unverified` endpoint |
| Trip Swipe (17 screens) | registry.js:598-749 → tripswipe/*.jsx | /api/admin/tripswipe/*, tourists, setup-questions, sms-blast, settings |
| **Automations: list/builder/rollouts/runs** | registry.js:760-790 → automations/*.jsx | /api/admin/automations* (API routes/automations.js:147-455) |
| **Store: catalog/versions/deploy/plans/grants/business plan** | registry.js:813,822 → store/Store.jsx, StoreItem.jsx | /api/admin/store/* (API routes/store.js:75-466; kinds :42) |
| Connections catalog (Composio) | registry.js:833 → appstore/Connections.jsx | /api/admin/connections/* (server.js:285) |
| App Manager / Business Apps (legacy) | registry.js:853,863 | /api/admin/apps, /site-apps (admin.js:3771-3810, `site_apps`) |
| Ghost boxes | registry.js:875 → platform/GhostBoxes.jsx | /api/admin/ghost/* (admin-ghost.js) |
| Intake + webhooks; Text-the-dashboard; AR hunts; Integrations; API keys; Settings; Bookings | registry.js:180,170,920,929,958,968,902 → platform/*.jsx | /api/admin/intake*, /api/dashboard-sms/*, /api/ar-hunts, provider-status, settings |
| **Missing in ADM; take from Plat-admin** | Plat-admin src/modules/registry.js:48-75 (ng-store, ng-core-menu, ng-businesses, ng-users); src/api/paperclip.js:65-73 | PC /store/admin/* |
| **Missing everywhere** | PC routes/entitlement.ts:42-104; store deploy audience store.ts:292; agents/skills/routines | PC /entitlement/admin/*, /companies/:id/agents etc. |
| CCL admin pages (retire) | admin.html, admin-dashboard.html, admin-pricing.html, audit.html, photo-repair.html, gcr-entity-manager.html, sql-setup.html | API absolute URL + direct Supabase (admin.html / admin-dashboard.html / gcr-entity-manager.html) |

## B. USER dashboard: base = USR (Play-user is the same code)
### B1. Core sections (always on)
| section | source | backend |
|---|---|---|
| Login / sign-up / claim / invite / business picker | pages/Login.jsx, SignUp.jsx, Claim.jsx, AcceptInvite.jsx, BusinessPicker.jsx; App.jsx:67-77 | /api/business-auth/*, /api/auth/invite, /api/gcr/claim, /api/business/me |
| Profile sections (dynamic) | pages/Dashboard.jsx:70,116; sections/registry.jsx:29-40 (hours, photos, menu, drinks, happy hour, events, specials, reviews…) + GenericSection | /api/business/schema, /sections, /:table CRUD (any `entity_*` slug table) |
| Add section | components/AddSection.jsx:21 → lib/sectionCatalog.js:64,110 | schema-driven; not store-gated |
| Store (my add-ons) | pages/Store.jsx:21,35,53,165; Dashboard.jsx:168 | /api/store (+ /:id/install, update, enable/disable, DELETE, config) → API store.js:552-639; tables store_items/versions/installs/grants/plan_items |
| Automations (installed) | pages/Automations.jsx; lib/automations.js:13-29; Dashboard.jsx:172 | /api/business/automations* → API automations.js:483-595; entity_automations, automation_runs |
| App Store (connections) | pages/AppStore.jsx; lib/appStore.js:21-32; Dashboard.jsx:174 | /api/connections* → composio.js; entity_connections, platform_connections |
| Ghost box | pages/Ghost.jsx; Dashboard.jsx:170 | /api/nodes* → nodes.js; ghost_nodes, ghost_node_requests |

### B2. Add-on catalog. "API store" = API store_items kind (store.js:42: app, module, map, parser, automation, box_release, integration). "PC store" = PC kind (plugin, pack, skill, automation, connector, agent, app, layout). **No seeded store_items found in API SQL. No catalog item exists in either store for any row below: the kind exists, the item does not.**
| add-on | best source repo+file | backend endpoint / table | CCL manifest | API kind | PC kind |
|---|---|---|---|---|---|
| Song requests & tips | ADM content/ArtistProfiles.jsx; USR lib/artistModule.js:18-71; CCL song-request.html | /api/artists (server.js:388) → artist_profiles, song_requests; /api/business/artist_goals… | apps/song-request.json, tipjar.json, shoutouts.json, crowdfund.json | app/module (no item) | app (no item) |
| Artist shows / fans / setlist / bookings | USR lib/artistModule.js:20-31 | /api/business/artist_shows, artist_follows, songs, artist_booking_requests | — | module | app |
| QR menu | ADM menu/QrMenus.jsx, QrTracker.jsx; Boxes apps/menu/app/admin/qr-menus/page.tsx; CCL q.html | /api/qr/* (server.js:350) → qr_codes, qr_scans, qr_locations; /api/admin/gcr/menu-* | qr-codes.json, qr-redirect.json | app | app (external app needs URL; see D) |
| Menus (food/drinks/HH/specials) | USR sections MenuSection, HappyHourSection, SpecialsSection; ADM menu/MenuBuilder.jsx; CCL menu-editor.html | /api/menu-editor (server.js:187) → menu_sections, menu_items, drink_*, happy_hour_*, entity_specials; /api/business/:table | menu.json, specials.json, ordering.json | module | app |
| Daily menu update SMS | ADM menu/DailyUpdateLinks.jsx; CCL restaurant-editor.html | /api/update/generate, send-sms, today | — | automation | automation |
| Bookings / availability / calendar | ADM booking/*.jsx (admin side); USR OfferingsSection, PriceListSection; CCL book.html, booking.html, bookpro*.html | /api/bookings (server.js:384) → entity_bookings, entity_availability; availability-engine → booking_calendar; /api/embed/availability.js | booking.json, availability.json, book-*.json (7), reserve-table.json, waitlist.json | app/module | app |
| Website calendar embed | ADM booking/WebsiteCalendar.jsx | /api/embed/availability.js (endpoints.js:720) | — | integration | layout/app |
| Waivers | CCL waiver.html | /api/platform/waiver-info, waiver-sign | waivers.json | app | app |
| Link hub / digital card | CCL card.html, card-builder.html, biz.html | /api/gcr/lead-notify, /api/platform/page | links.json, contact.json | app | app |
| Reviews | USR ReviewsSection; ADM menu/Reviews.jsx | /api/reviews; entity reviews | reviews.json | module | app |
| Events | USR EventsSection; ADM content/Events.jsx | /api/admin/gcr/events, /api/business/entity_events | events.json | module | app |
| Coupons / loyalty / gift cards / rewards | ADM content/Coupons.jsx; CCL js/coupons.js, loyalty-rewards.js | /api/admin/gcr/coupons; others dead (/api/dashboard/*) | coupons.json, loyalty.json, gift-cards.json, reward-offers.json, memberships.json | module | app |
| Payments / checkout | CCL book.html, enter-stripe-key.html | /api/stripe/* | payments.json, checkout.json | integration | connector |
| Connections (Square, Google, IG, 1000 Composio tools) | USR pages/AppStore.jsx; ADM appstore/Connections.jsx | /api/connections* → entity_connections | oauth-*.json | integration | connector |
| Trip Swipe listing / sponsored | ADM tripswipe/*.jsx (admin only) | /api/admin/tripswipe/* | gcr-listing.json | module | app |
| AI concierge / chat | CCL ai-chat.html; ADM ai/AiChat.jsx | /api/dashboard/ai-chat (CCL; mounted? unverified); /api/admin/gcr/ask | ai-concierge.json | app | agent/skill |
| Ghost box | USR pages/Ghost.jsx | /api/nodes | — | box_release | plugin |
| Email parser / intake | ADM platform/Intake.jsx | /api/admin/intake*, email-parser.js | email-parser.json | parser | automation |
| Messaging / SMS blasts / reminders | ADM tripswipe/SmsBlasts.jsx | /api/admin/sms-blast(s), /api/sms/send | messaging.json, reminders.json | automation | automation |
| **Any automation** (builder output) | ADM automations/Builder.jsx; USR pages/Automations.jsx; engine API lib/automationEngine.js | /api/admin/automations/:id/publish, deploy → entity_automations; owner /api/business/automations | — (CCL automation-*.html are STATIC/MOCK) | automation (separate pipeline from store) | automation (content.sync creates routines) |
| AI agents (Hermes/OpenClaw) | PC agents; store-pc server.js | PC /companies/:id/agents | — | — | agent/pack |
| Others in CCL apps/ (≈40 more: gallery, faq, hero, staff, fleet, inventory, forms, seo…) | CCL apps/*.json (69 files incl. _categories, _presets, index) | page-builder blocks; installs land in `site_apps` (js/module-loader.js:59) | yes | map to module/layout | layout |

## C. How a user picks add-ons today
| repo | mechanism | file:line | backend | state |
|---|---|---|---|---|
| USR / Play-user | Store tab: install, update, enable, disable, uninstall, config | pages/Store.jsx:21-165; lib/endpoints.js:76-81 | API /api/store (store.js:552-639), entitlement via store_grants/plan_items | **WORKING. Wired end to end with ADM store/StoreItem** |
| USR | Automations tab: toggle, config, run, upgrade | lib/automations.js:13-29 | API /api/business/automations (separate from store) | WORKING, but a second picker |
| USR | App Store tab = Composio connections | lib/appStore.js:21-32 | /api/connections | WORKING (tools only, not apps) |
| USR | Add section (schema tables) | components/AddSection.jsx:21 | /api/business/schema | WORKING, not gated |
| ADM | Store admin: publish versions, deploy to audience, plans, grants | modules/store/*.jsx; endpoints.js:759-776 | /api/admin/store | WORKING |
| ADM | legacy App Manager / Business Apps | appstore/AppManager.jsx, BusinessApps.jsx | /api/admin/apps, site_apps | legacy |
| CCL | app-store.html / app-dashboard.html / onboarding.html → `/api/apps/install`; modular-dashboard.html → `/api/modules/` | those pages | **unmounted** (API server.js:332-333). Every install call 404s | DEAD |
| CCL | apps/*.json manifests + js/app-registry.js:28 + module-loader.js:59 (site_apps via Supabase) | — | direct Supabase | half-dead, but the manifests are worth keeping |
| Plat-admin | PC store admin | src/api/paperclip.js:65-73 | PC /store/admin/* | admin only, no user picker |
| PC | /store UI; /companies/:id/store/:item/install | PC routes/store.ts:254-298; services/store.ts:599 (assertEntitled → content.sync → gcr bridge.activate) | PC + pushes app manifest into API (store-content.ts:352) | WORKING in PC; no CultureReset dashboard calls it |

**Standardize on: the PC store as the catalog and entitlement source of truth (kinds, plans, grants, audience, agents, skills). Its existing bridge projects installs into API. USR's `/api/store` UI becomes the user-facing picker, and ADM `store/` plus Plat-admin `nextgent` the admin side.** Pragmatic step 1 if the PC bridge is not live: use the API store (`/api/store` + `/api/admin/store`), which both chosen dashboards already call. Fold automations into store kind `automation` so there is one picker, and retire CCL `/api/apps`, `/api/modules` and `site_apps`.

## D. Missing connections
| # | gap | evidence | fix (wiring) |
|---|---|---|---|
| 1 | Two stores: API store_items vs PC store_items; no sync defined between them | API routes/store.js:42 kinds ≠ PC services/store.ts:28 kinds | Make PC the catalog. API store holds projected installs only (store-content.ts:352 gcr.install). Map kinds: module/map/parser/box_release/integration → PC app/layout/automation/plugin/connector |
| 2 | Automations have their own install pipeline, separate from store | API automations.js:327 deploy → entity_automations; store kind 'automation' exists too | Publish automations as store items. Deploy only via store. USR Automations tab shows store installs of kind automation |
| 3 | No catalog items exist for song requests, QR menu, menus, bookings… | no store_items inserts in API SQL; CCL apps/*.json not imported | Import the 69 CCL manifests as store items (draft, unlisted) |
| 4 | Store gates nothing in USR: sections and artist tables appear when a schema table has rows | USR Dashboard.jsx:116 discoverSections; sectionCatalog.js:110 | Filter sections by installed store items (manifest → tables) |
| 5 | Standalone apps (Boxes menu, Play-user song requests) do not use install tokens | PAPERCLIP-TENANCY.md gap table; PC nextgent.ts:187-209 | Call /companies/:id/installs/:installId/token server-side. Add a URL field or register as connector |
| 6 | ADM has no PC wiring; Plat-admin has PC but none of ADM's automations/store/ghost | DASHBOARD map: 190/191 shared files | Port Plat-admin `nextgent` module + paperclip.js into ADM |
| 7 | No entitlement or plan UI on PC | no 'entitlement' in PC ui/src | ADM store/Store.jsx plans/grants screens → re-point at PC /entitlement/admin/* |
| 8 | Identity split: API users (business-auth/entity_owners) vs PC companies/members (better-auth) | USR endpoints.js:29-50; PC auth/better-auth.ts:333 | Map business slug ↔ PC companyId (PC business-link, nextgent.ts:144) and show it in ADM People |
| 9 | CCL pages call dead or unmounted routes | /api/apps, /api/modules (server.js:332-333); /api/dashboard/* (js/*.js); Supabase direct in admin.html, module-loader.js:59 | Retire. Keep only the manifests and public pages (q.html, song-request.html, waiver.html, card.html, book.html) as add-on front ends |
| 10 | ADM Messaging reads an `unverified` endpoint | ADM endpoints.js:807; engagement/Messaging.jsx | Confirm the route in API or drop it |
| 11 | Users ≠ People: ADM Users lists /api/admin/users only; no per-user add-on view | resources.js:222; People.jsx:38-102 | Add a store installs column per business (/api/admin/store/businesses/:slug, store.js:444) to People |
| 12 | Composio "App Store" name collides with the store | USR AppStore.jsx vs Store.jsx | Rename to "Connections"; store kind connector |
