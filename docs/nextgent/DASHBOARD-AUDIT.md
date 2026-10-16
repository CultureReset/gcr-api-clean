# DASHBOARD AUDIT: Admin-dashboard-main (ADM) + Dashboards-users- (USR), plus module inventory, UI/UX gaps and reference products
Read-only. Pulled latest: ADM@9836d6c (2026-10-14, "Add the Paperclip screens"), USR@e797cc1 (2026-10-14, "Add the Paperclip store as a tab"). Routes verified against gcr-api-clean main@a652fda (2026-10-11): 1,257 routes parsed from server.js mounts → routes/*.js (script /workspace/audit/routes.py, analyzer an.py). Paperclip routes were checked in paperclip-ng routes/store.ts. Other sources: CCB = cybercheck-backend/cybercheck-dashboard-platform (index.html + js/*.js, 2026-03-02); CCL = cybercheck-login@8b3d6df.
Method: for each module, follow its relative imports, collect endpoint keys and literal /api paths, resolve them through endpoints.js, and match against gcr routes (params are wildcards).
Analyzer false positives, checked by hand and treated as alive:
- `setupQuestions.*`: the route exists through combinedRouter in setup-questions.js:100.
- `/api/business/` prefix literal (apiClient check).
- `store.status` (enable/disable exist).
- Modules that import `registry.js` (Overview, Sections, Settings, Trip Swipe Overview) pull in the whole tree; their own calls were verified via sectionMap.generated.json.

## 0. Summary counts
| repo | modules | reuse-as-is | gut-and-keep-skeleton | discard |
|---|---|---|---|---|
| ADM | 99 registry entries (92 visible + 7 hidden detail/legacy) | 32 | 64 | 3 |
| USR | 26 screens/components (8 pages, 15 section renderers incl. registry, 3 shell components; plus Platform + AddSection) | 14 | 10 | 2 |
Real broken calls found:
- ADM engagement/Messaging.jsx → `unverified.messaging` /api/admin/gcr/messaging/:id (no route; messaging.js unmounted).
- ADM platform/Integrations.jsx:28 probes `/api/square/config` (no such route; square.js has none).
Nothing else in either repo calls a missing route. Nothing is mock data. "Gut" mostly means **alive but it's an app, not dashboard core**.

## 1. Structure and tangling
| | ADM | USR |
|---|---|---|
| layout | src/{api, auth, components, hooks, lib, modules/<group>/<Screen>.jsx, shell, ui}; api/[...path] Vercel proxy (`api/paperclip`) | src/{components, lib, pages, sections}; api/paperclip proxy |
| module unit | one registry entry → lazy `load()` → one screen file (modules/registry.js:45-1004) | pages (tabs) + section renderers keyed by table (sections/registry.jsx) |
| self-contained? | **mostly**. Cross-imports: content/Rails, Seo → directory/entitySchema, useEntityRecord; menu/MenuBuilder → directory/useEntityFull; directory/BusinessProfile → engagement/charts; tripswipe/Analytics, AiFeedback → engagement/Analytics; store/StoreItem → automations/Rollouts. registry.js imported by home/Overview, Sections, platform/Settings, ai/AiConfig, AiSettings, tripswipe/Overview | **tangled in Dashboard.jsx**: it owns all state (entity, tableRows, allTables, 6 show* booleans, :23-36) and switches tabs by hand (:158-174). Sections are pure renderers; libs are shared |
| shared state | EntityProvider (components/EntityPicker.jsx useEntities) used by many modules; AuthContext | AuthContext; Dashboard.jsx local state; schema cache (schemaDiscovery.js:22) |
| backends | gcr-api-clean (api/client.js) + Paperclip via /api/paperclip (api/paperclip.js:20, :41-74) | gcr-api-clean (lib/apiClient.js) + Paperclip (lib/paperclip.js, pages/Platform.jsx) |

## 2. Shared components and patterns worth keeping
| pattern | where | keep? |
|---|---|---|
| Module registry → generated routes + sidebar + `hidden` | ADM modules/registry.js, shell/AppShell.jsx:37, Sidebar.jsx | **YES**: the base of the new module contract (add installed/entitled gating) |
| Per-section endpoint map | ADM modules/sectionMap.generated.json + scripts/ | YES (module → API manifest) |
| One API client: token, timeout, HTML-not-JSON guard | ADM api/client.js:120-199; USR lib/apiClient.js | YES: merge into one |
| endpoints.js (paths as functions, `seg()` encoding) | both | YES: one per module |
| createResource + useResource / useAsync | ADM api/createResource.js, hooks/useResource.js, useAsync.js; ui/CrudSection.jsx | **YES**: generic CRUD module skeleton |
| UI kit | ADM ui/ (primitives, DataTable, SchemaForm, Field, Modal, Tabs, Toast, MonthCalendar) | **YES** |
| Schema-driven sections | USR lib/schemaDiscovery.js, discoverSections.js, sectionCatalog.js, writeEntityData.js, tableMap.js; components/RowEditor.jsx; sections/GenericSection.jsx | YES for "profile data" editing; gate by install, not by rows |
| AppStoreView | identical in both (components/AppStoreView.jsx) | YES (store/catalog grid) |
| Paperclip proxy + client | ADM api/paperclip.js; USR lib/paperclip.js | YES |
| Auth contexts | ADM auth/AuthContext.jsx + tokenStore; USR lib/AuthContext.jsx + authStore | merge into one |
| EntityPicker / business scoping | ADM components/EntityPicker.jsx | YES (becomes company/business switcher) |
| SectionBoundary (error boundary per module) | ADM shell/SectionBoundary.jsx | YES |

## 3. ADM: every module
"routes ok/missing" = resolved gcr-api-clean paths found / not found.
| id | group | path | file | hidden | routes ok/missing | state | verdict | reason |
|---|---|---|---|---|---|---|---|---|
| ng-store | nextgent | /nextgent | nextgent/StorePublishing.jsx:47 |  | Paperclip 8 calls | alive (Paperclip) | reuse-as-is | core, alive, self-contained |
| ng-core-menu | nextgent | /nextgent/menu | nextgent/CoreMenu.jsx:56 |  | Paperclip 5 calls | alive (Paperclip) | reuse-as-is | core, alive, self-contained |
| ng-businesses | nextgent | /nextgent/businesses | nextgent/Businesses.jsx:65 |  | Paperclip 4 calls | alive (Paperclip) | reuse-as-is | core, alive, self-contained |
| ng-users | nextgent | /nextgent/users | nextgent/Users.jsx:74 |  | Paperclip 4 calls | alive (Paperclip) | reuse-as-is | core, alive, self-contained |
| overview | home | / | home/Overview.jsx:84 |  | (imports registry) | alive | reuse-as-is | core, alive, self-contained |
| sections | home | /sections | home/Sections.jsx:93 |  | (imports registry) | alive | reuse-as-is | core, alive, self-contained |
| menu-builder | menu | /menu/builder | menu/MenuBuilder.jsx:105 |  | 12/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| qr-menus | menu | /menu/qr-menus | menu/QrMenus.jsx:114 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| qr-tracker | menu | /menu/qr-tracker | menu/QrTracker.jsx:123 |  | 7/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| reviews | menu | /menu/reviews | menu/Reviews.jsx:132 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| referral-partners | menu | /menu/referral-partners | menu/ReferralPartners.jsx:141 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| daily-update-links | menu | /menu/daily-update-links | menu/DailyUpdateLinks.jsx:150 |  | 4/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| menu-editors-hub | menu | /menu/editors-hub | menu/MenuEditorsHub.jsx:159 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Menus/QR app; keep the UI, move behind the app module |
| gcr-businesses | directory | /directory/businesses | directory/Businesses.jsx:170 |  | 3/0 | alive | reuse-as-is | core companies |
| gcr-entity-editor | directory | /directory/entity | directory/EntityEditor.jsx:179 |  | 38/0 | alive | gut-and-keep-skeleton | alive but belongs to Listings app; keep the UI, move behind the app module |
| gcr-entity-editor-slug | directory | /directory/entity/:slug | directory/EntityEditor.jsx:188 | Y | 38/0 | alive | gut-and-keep-skeleton | alive but belongs to Listings app; keep the UI, move behind the app module |
| gcr-business-profile | directory | /directory/profile | directory/BusinessProfile.jsx:196 |  | 6/0 | alive | gut-and-keep-skeleton | alive but belongs to Listings app; keep the UI, move behind the app module |
| platform-text-dashboard | platform | /platform/text | platform/TextTheDashboard.jsx:206 |  | 4/0 | alive | gut-and-keep-skeleton | SMS app |
| platform-intake | platform | /platform/intake | platform/Intake.jsx:216 |  | 6/0 | alive | reuse-as-is | core intake/webhooks |
| engagement-behaviour | engagement | /engagement/behaviour | engagement/Behaviour.jsx:226 |  | 2/0 | alive | reuse-as-is | core analytics |
| gcr-business-profile-slug | directory | /directory/profile/:slug | directory/BusinessProfile.jsx:236 | Y | 6/0 | alive | gut-and-keep-skeleton | alive but belongs to Listings app; keep the UI, move behind the app module |
| gcr-site-editor | directory | /directory/site-editor | directory/SiteEditor.jsx:244 |  | 4/0 | alive | gut-and-keep-skeleton | alive but belongs to Listings app; keep the UI, move behind the app module |
| gcr-claims | directory | /directory/claims | directory/Claims.jsx:254 |  | 2/0 | alive | reuse-as-is | core accounts |
| booking-overview | booking | /booking | booking/Overview.jsx:281 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-offerings | booking | /booking/offerings | booking/Offerings.jsx:290 |  | 5/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-bookings | booking | /booking/bookings | booking/BookingsLedger.jsx:299 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-date-claims | booking | /booking/date-claims | booking/Calendar.jsx:308 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-promos | booking | /booking/promos | booking/Promos.jsx:318 |  | 4/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-sources | booking | /booking/sources | booking/Sources.jsx:327 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-feeds | booking | /booking/feeds | booking/CalendarFeeds.jsx:337 |  | 4/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-inventory | booking | /booking/inventory | booking/Inventory.jsx:347 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-availability | booking | /booking/availability | booking/Availability.jsx:357 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-business-calendar | booking | /booking/calendar | booking/BusinessCalendar.jsx:367 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-industries | booking | /booking/industries | booking/Industries.jsx:386 |  | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-match | booking | /booking/match | booking/Match.jsx:405 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-search | booking | /booking/search | booking/AvailabilitySearch.jsx:415 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-website-calendar | booking | /booking/website-calendar | booking/WebsiteCalendar.jsx:425 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-openings | booking | /booking/openings | booking/Openings.jsx:435 |  | 6/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| gcr-events | content | /content/events | content/Events.jsx:447 |  | 6/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| gcr-artists | content | /content/artists | content/Artists.jsx:456 |  | 4/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| artist-profiles | content | /content/artist-profiles | content/ArtistProfiles.jsx:465 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| gcr-specials | content | /content/specials | content/Specials.jsx:474 |  | 5/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| gcr-ads | content | /content/ads | content/Ads.jsx:483 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| gcr-rails | content | /content/rails | content/Rails.jsx:492 |  | 7/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| ai-config | content | /content/ai-config | ai/AiConfig.jsx:501 |  | 2/0 | alive | reuse-as-is | core AI admin |
| gcr-coupons | content | /content/coupons | content/Coupons.jsx:510 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| gcr-seo | content | /content/seo | content/Seo.jsx:519 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| bulk-upload | content | /content/bulk-upload | content/BulkUpload.jsx:528 |  | 7/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| bulk-events | content | /content/bulk-events | content/BulkEvents.jsx:537 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to content apps; keep the UI, move behind the app module |
| ai-chat | ai | /ai/chat | ai/AiChat.jsx:548 |  | 1/0 | alive | reuse-as-is | core, alive, self-contained |
| ai-organize | ai | /ai/organize | ai/AiOrganize.jsx:557 |  | 4/0 | alive | reuse-as-is | core, alive, self-contained |
| rag-index | ai | /ai/rag-index | ai/RagIndex.jsx:566 |  | 3/0 | alive | reuse-as-is | core, alive, self-contained |
| ai-settings | ai | /ai/settings | ai/AiSettings.jsx:575 |  | 6/1 | alive | reuse-as-is | alive; /api/ai-provider mention is a comment only |
| gcr-analytics | engagement | /engagement/analytics | engagement/Analytics.jsx:586 |  | 2/0 | alive | reuse-as-is | core analytics |
| gcr-reviews | engagement | /engagement/reviews | engagement/GcrReviews.jsx:595 |  | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to engagement apps; keep the UI, move behind the app module |
| gcr-customers | engagement | /engagement/customers | engagement/Customers.jsx:604 |  | 1/0 | alive | gut-and-keep-skeleton | CRM, thin resource list |
| gcr-messaging | engagement | /engagement/messaging | engagement/Messaging.jsx:613 |  | 1/1 | broken | discard | calls `unverified` /api/admin/gcr/messaging; messaging routes unmounted |
| gcr-social | engagement | /engagement/social | engagement/Social.jsx:623 |  | 5/0 | alive | gut-and-keep-skeleton | alive but belongs to engagement apps; keep the UI, move behind the app module |
| tripswipe-overview | tripswipe | /tripswipe | tripswipe/Overview.jsx:634 |  | (imports registry) | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-businesses | tripswipe | /tripswipe/businesses | tripswipe/Businesses.jsx:643 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-tourists | tripswipe | /tripswipe/tourists | tripswipe/Tourists.jsx:652 |  | 7/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-analytics | tripswipe | /tripswipe/analytics | tripswipe/Analytics.jsx:661 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-ai | tripswipe | /tripswipe/ai | tripswipe/AiFeedback.jsx:670 |  | 4/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-concierge-test | tripswipe | /tripswipe/concierge-test | tripswipe/ConciergeTest.jsx:679 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| trip-swipe-questions | tripswipe | /tripswipe/questions | tripswipe/SwipeQuestions.jsx:688 |  | 0/3 | unknown | gut-and-keep-skeleton | alive (route via combinedRouter); Trip Swipe app |
| tripswipe-sponsored | tripswipe | /tripswipe/sponsored | tripswipe/Sponsored.jsx:697 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-tonight | tripswipe | /tripswipe/tonight | tripswipe/TonightCards.jsx:706 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-points | tripswipe | /tripswipe/points | tripswipe/Points.jsx:715 |  | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| tripswipe-sms-qr | tripswipe | /tripswipe/sms-qr | tripswipe/SmsQr.jsx:725 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| platform-auth | tripswipe | /tripswipe/auth-settings | tripswipe/AuthSettings.jsx:734 |  | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| trip-swipe-button | tripswipe | /tripswipe/button | tripswipe/ButtonConfig.jsx:744 |  | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| sms-settings | tripswipe | /tripswipe/sms-settings | tripswipe/SmsSettings.jsx:753 |  | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| sms-blasts | tripswipe | /tripswipe/sms-blasts | tripswipe/SmsBlasts.jsx:763 |  | 3/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| business-leads | tripswipe | /tripswipe/business-leads | tripswipe/BusinessLeads.jsx:772 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| community-photos | tripswipe | /tripswipe/community-photos | tripswipe/CommunityPhotos.jsx:782 |  | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Trip Swipe app; keep the UI, move behind the app module |
| automations | automation | /automations | automations/Automations.jsx:796 |  | 2/0 | alive | reuse-as-is | core, alive, self-contained |
| automation-builder | automation | /automations/build/:id | automations/Builder.jsx:806 | Y | 13/0 | alive | reuse-as-is | core, alive, self-contained |
| automation-rollouts | automation | /automations/rollouts | automations/Rollouts.jsx:814 |  | 1/0 | alive | reuse-as-is | core, alive, self-contained |
| automation-runs | automation | /automations/runs | automations/Runs.jsx:823 |  | 1/0 | alive | reuse-as-is | core, alive, self-contained |
| store-item | appstore | /store/items/:id | store/StoreItem.jsx:858 | Y | 14/0 | alive | reuse-as-is | core |
| app-manager | appstore | /apps/manager | appstore/AppManager.jsx:889 | Y | 3/0 | legacy (hidden) | discard | legacy apps table; replaced by Store |
| biz-apps | appstore | /apps/business-apps | appstore/BusinessApps.jsx:899 | Y | 3/0 | legacy (hidden) | discard | legacy site_apps; replaced by Store |
| ghost-boxes | platform | /platform/ghost | platform/GhostBoxes.jsx:911 |  | 3/0 | alive | reuse-as-is | core, alive, self-contained |
| businesses | platform | /platform/businesses | platform/Businesses.jsx:920 |  | 4/0 | alive | reuse-as-is | core, alive, self-contained |
| leads | platform | /platform/leads | platform/Leads.jsx:929 |  | 2/0 | alive | reuse-as-is | core CRM |
| bookings | platform | /platform/bookings | platform/Bookings.jsx:938 |  | 4/0 | alive | gut-and-keep-skeleton | bookings app view |
| sales-pages | platform | /platform/sales-pages | platform/SalesPages.jsx:947 |  | 2/0 | alive | gut-and-keep-skeleton | sales tool, not core |
| ar-hunts | platform | /platform/ar-hunts | platform/ArHunts.jsx:956 |  | 4/0 | alive | gut-and-keep-skeleton | own app |
| integrations | platform | /platform/integrations | platform/Integrations.jsx:965 |  | 9/1 | alive | gut-and-keep-skeleton | probes /api/square/config which does not exist |
| people | platform | /platform/people | platform/People.jsx:975 |  | 6/0 | alive | reuse-as-is | core, alive, self-contained |
| users | platform | /platform/users | platform/Users.jsx:985 |  | 1/0 | alive | reuse-as-is | core, alive, self-contained |
| api-keys | platform | /platform/api-keys | platform/ApiKeys.jsx:994 |  | 1/0 | alive | reuse-as-is | core, alive, self-contained |
| settings | platform | /platform/settings | platform/Settings.jsx:1004 |  | (imports registry) | alive | reuse-as-is | core, alive, self-contained |
| gcr-signups | directory | /directory/signups | platform/Signups.jsx |  | 3/0 | alive | reuse-as-is | core accounts |
| booking-business-calendar-slug | booking | /booking/calendar/:slug | booking/BusinessCalendar.jsx | Y | 2/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| booking-industry | booking | /booking/industries/:vertical | booking/IndustryCalendar.jsx | Y | 1/0 | alive | gut-and-keep-skeleton | alive but belongs to Bookings app; keep the UI, move behind the app module |
| store | appstore | /store | store/Store.jsx |  | 6/0 | alive | reuse-as-is | core add-on mechanism |
| app-store | appstore | /apps/store | appstore/Connections.jsx |  | 4/0 | alive | reuse-as-is | core connectors |
| booking-connections | appstore | /booking/connections | booking/Connections.jsx |  | 8/0 | alive | reuse-as-is | core connectors (misfiled under booking) |
## 4. USR: every screen
| screen | file | data | state | verdict | reason |
|---|---|---|---|---|---|
| Login (phone OTP / password) | pages/Login.jsx | /api/business-auth/signin, signin-verify, password | alive | reuse-as-is | core auth |
| Sign-up | pages/SignUp.jsx | /api/business-auth/phone, verify, similar, register | alive | reuse-as-is | core |
| Claim | pages/Claim.jsx | /api/gcr/claim, entities | alive | reuse-as-is | core |
| Accept invite | pages/AcceptInvite.jsx | /api/auth/invite/:t, accept-invite | alive | reuse-as-is | core |
| Business picker (admin acting as) | pages/BusinessPicker.jsx | /api/gcr/entities, /api/business/me | alive | reuse-as-is | core company switcher |
| Dashboard shell | pages/Dashboard.jsx | schema, sections, automations count | alive, tangled | gut-and-keep-skeleton | hand-rolled tab state; replace with router + registry |
| Store | pages/Store.jsx | /api/store, install, update, enable/disable, config | alive | reuse-as-is | core add-ons |
| Platform (Paperclip store) | pages/Platform.jsx | /api/paperclip/* | alive (new) | reuse-as-is | Paperclip store tab; must merge with Store |
| Automations | pages/Automations.jsx | /api/business/automations* | alive | reuse-as-is | core engine view |
| App Store (Composio) | pages/AppStore.jsx + components/AppStoreView.jsx | /api/connections* | alive | reuse-as-is | rename to Connections |
| Ghost | pages/Ghost.jsx | /api/nodes* | alive | reuse-as-is | devices |
| TopBar / BottomNav / MainContent | components/*.jsx | — | alive | gut-and-keep-skeleton | mobile bottom nav; rebuild from registry |
| AddSection | components/AddSection.jsx | /api/business/schema | alive | discard | "add a table" UX → replaced by store install |
| RowEditor | components/RowEditor.jsx | /api/business/:table | alive | reuse-as-is | generic row form |
| EditableSection / GenericSection | sections/*.jsx | via Dashboard | alive | reuse-as-is | generic schema renderer |
| Hours, Photos, FAQs, Policies, Progress | sections/*Section.jsx | via Dashboard | alive | reuse-as-is | profile (core listing data) |
| Menu, HappyHour, Specials, Events, Offerings, PriceList, Reviews | sections/*Section.jsx | via Dashboard | alive | gut-and-keep-skeleton | app data (Menus, Events, Bookings, Reviews apps); show as summary tile |
| sections/registry.jsx | table → renderer map | — | alive | discard | replaced by per-module registry |
USR counts: reuse 14 rows (some grouped), gut 4 rows (≈10 screens), discard 2.

## 5. MISSING: UI/UX and modules absent from BOTH React repos (ADM and USR)
CCL = cybercheck-login, CCB = cybercheck-backend dashboard-platform, CB = Circle Boats dashboard (CCL beachside-circle-boats-dashboard.html), MS = myset.vip, A9 = a9ent.co.
| # | missing | where it exists (example) | note |
|---|---|---|---|
| 1 | Client (owner) **overview home**: stats cards + quick-action buttons | CCB index.html:171-182 (Edit profile, Manage fleet, Bookings, Connect payments, Publish); CB page-overview :189 | USR opens straight into a list of sections |
| 2 | Owner **sidebar nav grouped by job** (Business / Fleet / Bookings / Customers / Marketing / Website) | CCB index.html:21-136 (25 nav items in groups) | USR has a bottom nav only |
| 3 | **Website builder**: section list + live preview, theme, pages, domain (subdomain/custom/buy, DNS, SSL), publish + revisions | CCB js/site-editor.js, theme.js, pages.js, domain.js (697 lines), publish.js; CB :823-893 | ADM has an admin SiteEditor for the GCR site only; USR nothing |
| 4 | **SEO** per page, sitemap, robots | CCB js/seo.js | ADM content/Seo.jsx is admin/GCR only |
| 5 | Owner **bookings** list, calendar view, filters, stats | CCB js/bookings.js, calendar-view.js | USR has no bookings screen |
| 6 | **Inventory / fleet**, **availability** day toggles, **blackout dates**, **add-ons & docks**, **locations** | CCB inventory.js, availability.js, addons.js, locations.js; CB :403-540 | ADM booking/* is admin-wide, not owner-scoped |
| 7 | **Waivers** (templates, section editor, signed list, settings) | CCB waivers.js; CCL waiver.html (sign) | none in React |
| 8 | **Waitlist** with SMS template | CCB waitlist.js | none |
| 9 | **Customers CRM** for owners (tags, notes, add customer, built from bookings) | CCB customers.js | ADM Customers is an admin list only |
| 10 | **Coupons + campaigns** (owner) | CCB coupons.js | ADM Coupons admin only |
| 11 | **Messaging** settings: phone numbers, notification toggles, customer/owner SMS templates with tokens + preview | CCB messaging.js; CB :629-667 | ADM Messaging broken |
| 12 | **Reviews** (owner): stats, filters, publish, review questions, review requests | CCB reviews.js; CCAD reviews.js:77 | USR shows a read-only section |
| 13 | **Social**: connect accounts, post composer, schedule, analytics | CCB social.js; CB modal-post-composer :1270 | ADM Social is a scraper only |
| 14 | **Owner analytics** (top pages, traffic sources, funnel, revenue, period switch) | CCB analytics.js; CB :922-935 | none for owners |
| 15 | **Billing** (current plan, usage, plan grid, payment method, invoices) | CCB billing.js | none (store plans only) |
| 16 | **Payment connections** (Stripe Connect onboarding, Square, Google) | CCB oauth.js; CCL enter-stripe-key.html | none |
| 17 | **Staff / team** management | CCB staff.js | none for owners |
| 18 | **Media library** grid + detail | CCB media.js | USR Photos section only |
| 19 | **Menu editor with categories + AI extract from photo** | CB modal-menu-extract :1369; CCL menu-editor.html; ADM MenuBuilder (admin) | USR MenuSection is basic |
| 20 | **Public pages**: QR menu (q.html), song request (song-request.html), waiver sign, digital card + card builder (card.html, card-builder.html), booking page (book.html), link page | CCL | the React repos have no public surfaces (by design: these are apps) |
| 21 | **Onboarding wizard + onboarding links** | CCL onboarding.html, onboarding-links.html, tool-selection.html | none |
| 22 | **Automation templates gallery / AI workflow creation** | CCL automation-templates.html, create-workflow-ai.html (static/mock) | ADM builder only; no template gallery |
| 23 | **Per-industry dashboards** (charter, restaurant) | CCL dashboard-charter.html, dashboard-restaurant.html (mock) | presets missing |
| 24 | **App catalog with 69 setup manifests** (per-app setup fields) | CCL apps/*.json | not imported |
| 25 | **Merch / product shop** (sizes/options, sold-out stays visible, flat postage, pickup code, "make a request", Stripe payouts) | MS /you/shop | **missing in all 4 sources** |
| 26 | **Paid membership / diary** (members-only posts, blurred locked posts, forum, $1-100/mo) | MS /you/diary | missing in all 4 |
| 27 | **Gig/night business ledger** (what the venue paid, splits, cash tips, merch sold, costs, hours; per-hour rates; PDF report) | MS Studio dashboard | missing in all 4 |
| 28 | **Vote-based setlist** (free votes, buy votes via Stripe, ranked live queue, one tap to play, lyrics, paid requests) | MS | CCL song-request + GCR artists have requests/tips only, no voting |
| 29 | **Public what's-on feed + map** (country/city, artists and venues auto-linked by name, recurring events) | MS /artists, venues | partial: GCR gcr.js events, live-now |
| 30 | **Venue ↔ artist "Want to perform here?"** with stats attached | MS | missing |
| 31 | **Peer community / Green Room** (threads, upvotes, leaderboard Board) | MS | missing |
| 32 | **Fan account** (Fan Studio: follow, keep nights) | MS /fan-studio | partial: GCR tourist profiles |
| 33 | **Save contact (vCard), NFC card, unique QR** | A9 | partial: CCL card.html, gcr.js nfc-card-lead |
| 34 | **Listings with per-listing contact actions** (call, WhatsApp, email, Calendly, form) | A9 | GCR entity listing exists; per-item CTAs missing |
| 35 | **Valuation / quote request form with photos** | A9 | missing (generic forms app: CCL apps/forms.json, no backend) |
| 36 | **"Join our team" recruiting CTA** | A9 | missing |
| 37 | **Tracking pixels** (Meta, TikTok, Google) per business | A9 | missing (CCB tracking.js is first-party only) |
| 38 | **AI media**: branded covers, listing videos, photo enhancement, credit-metered | A9 | missing (GCR has AI text/vision; no credits) |
| 39 | **Team/brokerage**: one page per agent under a team, team-level management, consistent branding | A9 | missing (Paperclip companies/members could carry it) |
| 40 | **Done-for-you setup** (48-hour build service) + 7-day trial | A9 | missing (store/billing has no trial) |
| 41 | **Agents / Paperclip in the owner dashboard** | Plat-admin; USR Platform tab (store only) | no agent/task UI for owners |

## 6. UI/UX: how each module works today (CCL/CCB vs React)
Shell patterns:
| source | shell | nav | forms | feel |
|---|---|---|---|---|
| CCL admin.html | one 23k-line page; `showPage()` (:76-334) | left sidebar, 11 emoji groups, about 60 items | inline forms + modals; entity editor has 15 tabs (:644-658) | dense operator console |
| CCB / CB client dashboard | index.html + js modules; `navigateTo()`; router.js toggleSidebar | grouped left sidebar (25 items) + overview quick-action buttons | modal per entity (modal-page, -inventory, -addon, -booking, -coupon, -waiver, -menu-item, -special, -event, -post-composer, -qrc-edit; CB :1088-1460); stats cards on each page | Squarespace-like owner backend; many screens keep data in localStorage |
| ADM | React + router from registry; Sidebar with text filter + TopBar + EntityPicker | left sidebar, same groups as admin.html (mirrors it, registry.js:41-44) | SchemaForm / CrudSection / DataTable / Modal / Tabs | clean, consistent; operator-only |
| USR | React, no router; tab state | **mobile bottom nav** (sections, Tools, Store, My Ghost, Automations, Add) + TopBar ("← All businesses") | RowEditor generic per row; specialized renderers for hours/menu/etc. | phone-first data editor, no overview, no website |

Per module (CyberCheck → React):
| module | CyberCheck UX (main screens, key actions) | React UX | gap |
|---|---|---|---|
| Overview | CB/CCB: stats + quick actions + onboarding progress | ADM Overview (claims, ads, rails counts); USR none | owner home |
| Profile & hours | CCB profile.js: form + hours editor with day-closed toggles + logo upload | USR HoursSection, EditableSection; ADM entity editor tabs | logo upload, closed-day toggles |
| Media | grid, upload, detail modal | USR PhotosSection | library and detail |
| Menu | CB modals: category, item, AI extract from photo; CCL menu-editor (dark/popup, PIN staff) | ADM MenuBuilder (sections/items/options/variations); USR MenuSection | owner-side AI extract and categories; staff PIN editor |
| Specials / events | modal forms | ADM CRUD; USR sections | parity OK |
| QR | CB qr-codes page + QR edit/scans modals; CCL q.html public | ADM QrMenus/QrTracker (admin) | owner QR screen |
| Bookings | CCB table + filters + stats + calendar view; CCL book.html public checkout (Stripe) | ADM 17 admin screens; USR none | owner bookings + public checkout surface |
| Inventory / availability / add-ons / locations | CCB pages + modals | ADM admin-wide | owner-scoped |
| Waivers / waitlist | CCB editors + settings; public sign page | none | entire module |
| Customers / coupons | CCB list, filters, tags, notes, campaigns | ADM admin lists | owner CRM |
| Messaging | CCB numbers, toggles, templates with token insert + preview | ADM broken | entire owner module |
| Reviews | CCB stats, filters, publish, questions | ADM admin; USR read-only | owner management + requests |
| Social | CCB connect, composer, schedule, stats | ADM scraper | composer |
| Website builder | CCB site-editor (section list + editor + CSS editor + data tokens + live preview), theme, pages, domain wizard, publish + revisions | none (ADM GCR SiteEditor only) | entire module |
| SEO | CCB pages, sitemap, robots | ADM GCR SEO | owner SEO |
| Analytics | CCB charts, period switch | ADM admin analytics | owner analytics |
| Billing | CCB plan grid, usage, invoices | ADM store plans | owner billing |
| Connections | CCB oauth.js toggles (Stripe/Google/social) | USR AppStore (Composio) | payment onboarding UX |
| App store | CCL app-store.html grid + install (dead route); CB app-store page | USR Store + AppStoreView; ADM Store | parity better in React |
| Song requests | CCL song-request.html (request + tip); ADM ArtistProfiles queue | ADM queue | voting, live queue, lyrics (MS) |
| Automations | CCL builder/templates (static) | ADM builder/rollouts/runs; USR list/run | templates gallery |
| AI | CCL admin AI tabs, ai-chat.html | ADM AI screens | owner AI assistant (CCB ai-assistant.js) |

## 7. Combined module inventory (4 sources) + placement in the new build
Columns: ADM | USR | CCB | CCL. W = working, S = stub/mock/localStorage, D = dead route, - = absent. Placement: **A**dmin, **U**ser, **B**oth, **T** = separate app surfaced as a tile.
| module | ADM | USR | CCB | CCL | placement | notes / overlaps |
|---|---|---|---|---|---|---|
| Auth / login / sign-up / invite / claim | W | W | W (auth.js) | W (login, claim-business) | B | 4 implementations → 1 |
| Users / people / admins | W | - | - | W (admin users) | A | |
| Companies / businesses / picker | W | W | - | W | B | ADM Businesses, PA ng-businesses, USR BusinessPicker overlap |
| Claims / sign-ups / leads | W | W (claim) | - | W | A (+U claim) | |
| Store / installs / plans / grants | W (+ Paperclip) | W (+ Platform tab) | - | D (app-store.html) | B | GCR store and Paperclip store both surfaced: **duplicate** |
| Connections | W | W | S (oauth.js) | S (connection-manager) | B | |
| Billing | partial | - | S | S (admin-pricing) | B | missing for owners |
| Settings / API keys | W | - | S (tabs/settings) | W | A | |
| Agents / Paperclip | W (ng-*) | W (Platform) | - | - | B | owner agent UI missing |
| Automations | W | W | - | S | B (engine core; automations are add-ons) | |
| AI tools | W | - | S (ai-assistant) | W | A (+T concierge) | |
| Analytics | W | - | S | W | B | owner view missing |
| Ghost / devices | W | W | - | - | B | |
| Profile / hours / photos / FAQs / team | W | W | S | W | U (+A) | listing core data |
| Listings / directory | W | - | - | W | A + T (directory site) | |
| Menus | W | W | S (menu.js) | W (menu-editor*) | T | 6 backend copies; Boxes menu app |
| QR | W | - | - | W (q.html) | T | |
| Daily update links | W | - | - | W | T (automation) | |
| Specials | W | W | S | W | T | |
| Events | W | W | S (events.js) | W | T | |
| Bookings / availability / inventory / add-ons / locations | W | partial (offerings) | S | W (book.html) + S (booking.html, bookpro) | T | 3 data models |
| Waivers | - | - | S | W (waiver.html) | T | missing in React |
| Waitlist | - | - | S | - | T | missing in React |
| Customers / CRM | W (admin) | - | S | S | B | |
| Coupons / promos / loyalty | W (admin) | - | S | S (js/loyalty-rewards) | T | |
| Reviews | W | W (read) | S | S | T | |
| SMS / messaging / blasts | partial (Messaging broken) | - | S | S | T | |
| Social | W (scraper) | - | S | S | T | |
| Website builder / pages / theme / domain / publish | W (GCR site only) | - | S | S (manage.html, page.html) | T | missing in React |
| SEO | W (GCR) | - | S | W | T | |
| Link hub / card / NFC | - | - | - | W (card, card-builder) | T | missing in React |
| Song requests / artists / tips | W | W (artist tables) | - | W (song-request.html) | T | |
| Trip Swipe | W | - | - | W | A + T | |
| AR hunts | W | - | - | W | T | |
| Ads / rails / category cards | W | - | - | W | A | directory admin |
| Intake / webhooks | W | - | - | - | A | |
| Text-the-dashboard | W | - | - | - | T | |
| Payments (Stripe/Square) | partial (probe) | - | S | W (book, enter-stripe-key) | B (connector) | |
| Onboarding wizard | - | - | S (tabs/overview) | S | U | missing in React |
| Staff | - | - | S | - | U | missing in React |
| Media library | partial | partial | S | - | U | |
| Merch shop | - | - | - | - | T | **missing everywhere** (MS) |
| Paid membership / diary / forum | - | - | - | - | T | missing (MS) |
| Business ledger (nights, splits, hours, PDF) | - | - | - | - | T | missing (MS) |
| Vote setlist | - | - | - | partial (song-request) | T | missing (MS) |
| What's-on feed + map | partial (GCR) | - | - | - | T | |
| Community / peer forum / leaderboard | - | - | - | - | T | missing (MS) |
| Save contact / vCard | - | - | - | partial (card) | T | missing (A9) |
| Lead forms (valuation/quote with photos) | - | - | - | S (apps/forms.json) | T | missing (A9) |
| Tracking pixels | - | - | partial (tracking.js) | - | U (setting) | missing (A9) |
| AI media + credits | - | - | - | - | T | missing (A9) |
| Teams (multi-member pages) | - | - | - | - | B | missing (A9) |
**Duplicates/overlaps:**
- ADM and Plat-admin both have store and businesses screens.
- USR Store and Platform tab: two stores.
- ADM App Manager / Business Apps vs Store.
- ADM Connections appears twice (appstore + booking).
- Menu editors: ADM MenuBuilder, CCL menu-editor ×3, CB modal, USR section, Boxes.
- Booking: ADM 17 screens, CCB, CCL book/booking/bookpro, CB.
- Auth ×4.
- Analytics: ADM ×3 (Analytics, Behaviour, Trip Swipe analytics).

## 8. Reference products as universal modules (myset.vip, a9ent.co)
### myset.vip (artist + venue platform; studied /, /about, /artists, /venues, /studio, /fan-studio)
| feature | how it works for the end user | universal module (any business) | in our sources? |
|---|---|---|---|
| Link page `myset.vip/name` | one page: socials, streaming, show dates, merch, bookings, tipping, YouTube, voting, community | **Link Page**: blocks from installed modules (menu, book, shop, tips, events, reviews) | partial (CCL card.html, links.js) |
| QR on tables, no app/no account | scan → web page → act | **QR Entry**: any module's public page behind a QR | yes (qr.js) |
| Setlist voting | free votes per night, spend several on one song, buy more via Stripe, ranked live queue, one tap starts winner, lyrics button | **Live Poll / Vote Queue**: charter "next stop", restaurant "special of the night", trivia | partial (song requests only) |
| Paid requests | requests off by default; cost votes; artist adds / marks done / declines | **Requests**: song, custom order, menu request | yes (song_requests) |
| Tips | tip button, Stripe straight to the artist's account | **Tips / Tip Jar**: crew tips on a dolphin cruise, server tips | partial (tipjar manifest, no payments) |
| **Merch shop** `/name/shop` | products with sizes/options; sold-out stays visible; flat postage set by the seller; ship or pick up at the gig (item says which); each order gets a **pickup code** read at the table; "Make a request" for unlisted items (if made, it appears); Stripe payouts weekly (free) or daily (paid); one tap from the profile and from the voting page | **Shop**: products + services, variants, stock/sold-out, fulfilment (ship / pickup / at-venue with code), custom-request intake, Stripe Connect payouts; shows as a block on the link page and in-app (voting/menu/booking pages) | **missing** |
| Calendar / residency | gigs once, residencies repeat; tour poster | **Events / Schedule**: recurring departures, nightly specials | yes (events, charter schedules) |
| Rules | free votes per person, price to bring a song back, value of extra votes | per-module config | — |
| Diary / membership | members-only posts, locked posts shown blurred, forum, $1-100/mo, email + 6-digit code login, post notifications | **Membership / Club**: VIP charter club, restaurant wine club, realtor insider list | missing |
| Business ledger | log a night: venue pay, band splits, cash tips, merch, costs, hours on stage/travel/setup; per-hour rates; residency deal inherited; PDF report | **Job Ledger**: per trip/shift/showing earnings and costs | missing |
| Stats proof | people, votes, tips per night; used to pitch venues | **Engagement stats** | partial (analytics) |
| Book button | short form → Studio Messages, no email exposed | **Inquiry / Booking request** | partial (artist_booking_requests, leads) |
| Venues: auto-populated events, what's-on feed + map, "Want to perform here?", one code with music + menu + offers | venue page fills from artists' calendars by name | **Venue Page + Local Feed** | partial (GCR directory, live-now) |
| Green Room + Board | peer forum (Talk/Gigs/Services/Business), upvotes, monthly leaderboard by real nights | **Peer Community** (industry network) | missing |
| Fan Studio | optional fan account to follow and keep nights | **Customer Account** | partial (tourist profiles) |
| Song import | paste list, CSV, Spotify playlist; genres auto-tag | **Catalog import** (menu/products from CSV or URL) | partial (bulk import, AI extract) |
| Plans | free page + 10 shows; paid tiers add shop, paid diary, dashboard, daily payouts | store plans/entitlements | yes (store plans) |

### a9ent.co (realtor link-card platform)
| feature | how it works | universal module | in our sources? |
|---|---|---|---|
| Personal page / link ("front door", keeps the existing site) | profile + listings + contact actions | **Link Page** | partial |
| Listings (unlimited, categories, status, price) | add/edit/remove; client goes from a property straight to the agent | **Listings/Catalog**: boats, menu items, rentals, homes | partial (GCR entities, fleet, offerings) |
| Leads & CRM | capture and manage leads from any listing | **Leads/CRM** | partial (business_leads, customers) |
| Contact actions per listing | call, WhatsApp, email, Calendly, forms, custom links (agent chooses) | **CTA buttons** on any item | missing |
| QR code (unique), Save Contact (vCard), metal NFC card | scan or tap → page; one-tap save contact | **Card / QR / NFC** | partial (card.html, nfc-card-lead, qr.js) |
| Open-house QR | visitors view property, save contact, submit details | **Event check-in / sign-in sheet** | missing |
| Valuation request with photos | homeowner form with property details + photos | **Quote / Request form** (charter quote, catering quote) | missing |
| Join-our-team CTA | recruiting link | **Recruiting/Jobs** | missing |
| Pixels + analytics | Meta, TikTok, Google pixels; views, clicks, inquiries in real time | **Tracking & Analytics** | partial |
| AI media on credits | branded covers, listing videos, photo enhancement | **AI Studio (credits)** | missing (GCR AI text/vision; no credits) |
| Integrations | WhatsApp, Calendly, email, socials, CRM links | **Connections** | yes (Composio) |
| Done-for-you setup in 48 h; 7-day trial; per-agent pricing; team/brokerage | onboarding service, team pages | **Onboarding + Teams + Trial** | missing |

## 9. Business-type presets (bundle of modules + theme)
| preset | modules installed | theme / link-page blocks |
|---|---|---|
| Artist / band | Link Page, Vote Queue + Requests, Tips, Shop (merch, pickup code), Events (residencies), Membership/Diary, Job Ledger, Booking requests, Community | dark stage theme; blocks: vote, tip, shop, shows, book |
| Venue / bar | Venue Page, Events (auto from artists), Menus, Specials, QR, Local Feed, "Perform here" intake, Reviews | blocks: tonight, menu, offers |
| Restaurant | Menus, QR menu, Specials, Daily update links, Reviews, Online ordering/Shop, Events, Waitlist, Loyalty | food theme; blocks: menu, order, specials, reserve |
| Fishing charter | Listings (boats/trips), Bookings + availability + add-ons + docks, Waivers, Tips (crew), Shop (photos, gear), Reviews, Weather/what to bring, Job Ledger | marine theme; blocks: book, trips, waiver, reviews |
| Dolphin cruise / tours | Bookings (departures), Waivers, Tips, Shop (photo packages), Vote/Poll (optional), Reviews, Coupons, SMS reminders | coastal theme; blocks: book, times, photos |
| Rental (boats, Circle Boats) | Inventory/fleet, Availability, Blackout dates, Add-ons, Locations, Waivers, Bookings, Payments, Website builder | CB theme; blocks: rent, fleet, waiver |
| Realtor / team | Link Page, Listings with CTAs, Leads/CRM, Card + QR + NFC + Save contact, Open-house check-in, Valuation form, Recruiting, Pixels, AI Studio, Teams | brand theme; blocks: listings, contact, valuation |
| Photographer / services | Bookings, Client galleries, Shop (prints), Quote form, Reviews | gallery theme |
**Gaps the new build must fill:** Shop (with pickup code and requests), Membership, Job Ledger, Vote Queue, CTA buttons, Quote/Request forms, Open-house check-in, Teams, Trial, AI credits, Tracking pixels, Owner website builder, Waivers/Waitlist UIs, Owner overview/sidebar.
