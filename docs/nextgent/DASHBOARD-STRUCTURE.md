# DASHBOARD STRUCTURE: Admin-dashboard-main (ADM) and Dashboards-users- (USR)
Read-only. ADM = CultureReset/Admin-dashboard-main@8053f8e, USR = CultureReset/Dashboards-users-@e9ea28f. Local clones are in /workspace/dashboards/ (also /workspace/repo-read/). Both call only gcr-api-clean.

## 1. ADM (operator/admin)
| part | file:line | notes |
|---|---|---|
| entry | src/main.jsx → src/App.jsx | |
| auth gate | App.jsx:20-28 (checking → LoginPage); auth/AuthContext.jsx:27-58; auth/tokenStore.js | admin JWT; verified by GET /api/admin/gcr/claims?limit=1 (api/endpoints.js:47) |
| providers | App.jsx:32-36 EntityProvider → BrowserRouter → AppShell | the entity list is fetched once and shared |
| shell | shell/AppShell.jsx:28 Sidebar, :34 TopBar, :36-60 Routes | |
| routing | AppShell.jsx:37 `modules.map(m => <Route path=m.path>)` with lazy + Suspense :43 | routes generated from the registry |
| registry | modules/registry.js: NAV_GROUPS :26-37; definitions :48-971; `modules` :999; `navigation` :1007-1010 filters `!m.hidden` | 11 groups, about 100 modules |
| sidebar | shell/Sidebar.jsx:27-85 (text filter only) | |
| data | api/client.js:120 request(), Bearer :139, base env.js:61/:69 (`VITE_API_BASE_URL`, default gcr-api-clean); api/endpoints.js; api/resources.js + createResource.js; hooks/useResource.js, useAsync.js | /api/admin/*, /api/gcr/*, plus some /api/qr, /api/update, /api/sms |
| endpoint map | modules/sectionMap.generated.json | which endpoints each section uses |
| **gating** | static only: `hidden: true` (registry.js:155,203,345,364,773,825,858,868) plus admin role | **no per-user or per-company gating. Every admin sees everything** |

Component tree: `App → AuthProvider → (LoginPage | EntityProvider → BrowserRouter → AppShell → [Sidebar, TopBar, Routes → lazy(module.component)])`

Groups and modules (registry.js line):
- home :48-60
- menu :69-126
- directory :134-234
- booking :245-402
- content :411-504
- ai :512-542
- engagement :550-590
- tripswipe :598-749
- automation :760-790
- appstore (store :813-824, connections :833-847, legacy :853-866)
- platform :875-971 (ghost, businesses, leads, bookings, sales-pages, ar-hunts, integrations, people, users, api-keys, settings)

## 2. USR (business owner)
| part | file:line | notes |
|---|---|---|
| entry | src/main.jsx → src/App.jsx | **no router**. Navigation is component state |
| auth gate | App.jsx:15 useAuth {user, isAdmin, gcrSlug}; :31 AcceptInvite (?token); :46 SignUp; :47-50 Claim / Login; :54 BusinessPicker (admin with no slug); :77 `<Dashboard/>` | lib/AuthContext.jsx, authStore.js |
| shell | pages/Dashboard.jsx:149 TopBar, :166 MainContent, BottomNav, :176 AddSection | TopBar:54 "← All businesses" (admin acting as a business) |
| "routing" | Dashboard.jsx:28 `activeKey` (section) + :32-35 booleans showApps / showGhost / showStore / showAutomations; :168-174 render Store / Ghost / Automations / AppStore | BottomNav.jsx:13 sections, :22 Tools, :31 Store, :40 My Ghost, :49 Automations, :61 Add |
| section renderers | sections/registry.jsx:29-43 (hours, photos, menu_sections, drink_sections, happy_hour_sections, events, specials, reviews, sections→Offerings…) + GenericSection / EditableSection | |
| data | lib/config.js:19-21 `VITE_GCR_API_BASE` (gcr-api-clean only); lib/apiClient.js (`?slug` when acting :172); lib/endpoints.js | /api/business/*, /api/business-auth/*, /api/auth/*, /api/store, /api/connections, /api/nodes, /api/business/automations, /api/gcr/* |
| schema | lib/schemaDiscovery.js:67-68 GET /api/business/schema; lib/entityTables.js:52-53 GET /api/business/sections; writes via lib/writeEntityData.js:51 /api/business/:table | state: entity, tableRows, allTables (Dashboard.jsx:23-31); no global store |
| **gating** | lib/discoverSections.js:183-195: **a section shows if its table has rows** (`hasData`); AddSection offers the rest (lib/sectionCatalog.js:51 isInternal, :64 isOfferable, :110 buildCatalog) | **Store installs do NOT gate sections.** Store, Automations and Ghost tabs are always shown. Admin vs owner differs only by acting-as |

Component tree: `App → (AcceptInvite | SignUp | Claim | Login | BusinessPicker | Dashboard → [TopBar, MainContent → (Section renderer | Store | Ghost | Automations | AppStore | AddSection), BottomNav])`

## 3. Where QR menu and bookings live: EXTERNAL APPS (the dashboard should only surface or link to them)
| app | repo | files | routes / API |
|---|---|---|---|
| QR menu | ADM | modules/menu/QrMenus.jsx, QrTracker.jsx, ReferralPartners.jsx, MenuEditorsHub.jsx, DailyUpdateLinks.jsx (registry.js:78-126) | /api/qr/* (endpoints.js:434-453), menu.editorQrMenu → /api/menu-editor/:slug/qr-menu, /api/update/* |
| QR menu | USR | lib/artistModule.js:31 `artist_qr_codes` (generic section); no QR screen | /api/business/artist_qr_codes |
| QR menu (real app) | Boxes apps/menu; CCL q.html | — | own backend; gcr-api-clean qr.js:96 /r/:code |
| Bookings | ADM | modules/booking/* (17 files, registry.js:245-402: Overview, Offerings, BookingsLedger, Promos, Sources, CalendarFeeds, Inventory, Availability, BusinessCalendar, Industries, Match, AvailabilitySearch, WebsiteCalendar, Openings, Connections); platform/Bookings.jsx (:902) | bookingPlatform.* endpoints.js:587-718 (/api/admin/platform/*), /api/embed (:719), bookings.* (:520) |
| Bookings | USR | sections/OfferingsSection.jsx (registry.jsx:43 `sections`), PriceListSection.jsx; tableMap.js:73 offerings; artistModule.js:30 artist_booking_requests; sectionCatalog.js:26 excludes bookings from Add | /api/business/offerings… |

## 4. Flag list: app vs core
| section | file | verdict | why |
|---|---|---|---|
| QR menus / tracker / referral | ADM modules/menu/Qr*.jsx, ReferralPartners.jsx | **APP** | public scan surface, own tables (qr_*), own backend in Boxes |
| Menu builder / editors hub / daily SMS links | ADM modules/menu/MenuBuilder.jsx, MenuEditorsHub.jsx, DailyUpdateLinks.jsx; USR sections/MenuSection.jsx, HappyHourSection.jsx | **APP** (Menus) | own data model (menu_*, drink_*, hh_*), public render, PIN staff editor |
| Bookings (17 screens) | ADM modules/booking/*, platform/Bookings.jsx; USR OfferingsSection.jsx, PriceListSection.jsx | **APP** | availability engine, iCal, embed widget, payments: a product of its own |
| Song requests & tips / artists | ADM content/ArtistProfiles.jsx, Artists.jsx; USR lib/artistModule.js | **APP** | public request page (CCL song-request.html), queue, tips |
| Events | ADM content/Events.jsx, BulkEvents.jsx; USR sections/EventsSection.jsx | APP (or listing content) | public calendar feed |
| Specials / coupons | ADM content/Specials.jsx, Coupons.jsx; USR SpecialsSection.jsx | APP | promo product |
| Website builder / site editor / SEO | ADM directory/SiteEditor.jsx, content/Seo.jsx | **APP** | publishes a site; domains |
| Reviews | ADM engagement/GcrReviews.jsx, menu/Reviews.jsx; USR ReviewsSection.jsx | APP | review requests, Google sync |
| SMS / messaging / blasts / text-the-dashboard | ADM engagement/Messaging.jsx, tripswipe/Sms*.jsx, platform/TextTheDashboard.jsx | APP | channel product |
| Social posts | ADM engagement/Social.jsx | APP | — |
| Trip Swipe (17) | ADM modules/tripswipe/* | **APP** (consumer product admin) | separate consumer app |
| AR hunts | ADM platform/ArHunts.jsx | APP | — |
| Ads / page rails / category cards | ADM content/Ads.jsx, Rails.jsx | APP (GCR directory site) | admin of the public directory |
| GCR directory / entity editor / business profile / photos / hours | ADM directory/*; USR Dashboard sections | APP (Listings) | directory product; profile data shared by apps |
| Intake / webhooks | ADM platform/Intake.jsx | APP (or connector) | — |
| Website calendar embed | ADM booking/WebsiteCalendar.jsx | APP (bookings widget) | — |
| Payments / Stripe | (none in ADM/USR; CCL only) | APP / connector | — |
| AI chat / organize / RAG | ADM modules/ai/* | CORE tool (admin), app for concierge | platform AI |
| Analytics / behaviour | ADM engagement/Analytics.jsx, Behaviour.jsx | CORE (cross-app) | — |
| Auth / login / invite / claim / signup | ADM auth/*; USR pages/Login, SignUp, Claim, AcceptInvite | **CORE** | identity |
| Users / people / businesses (companies) / claims / signups / leads | ADM platform/Users.jsx, People.jsx, Businesses.jsx, directory/Claims.jsx, platform/Signups.jsx, Leads.jsx; USR BusinessPicker.jsx | **CORE** | accounts and tenants |
| Store (catalog, plans, grants, installs) | ADM store/Store.jsx, StoreItem.jsx; USR pages/Store.jsx | **CORE** (app installs + billing plans) | the add-on mechanism |
| Connections (Composio) | ADM appstore/Connections.jsx, booking/Connections.jsx; USR pages/AppStore.jsx | **CORE** (connectors) | — |
| Automations | ADM automations/*; USR pages/Automations.jsx | CORE engine; each automation is an add-on | — |
| Ghost boxes | ADM platform/GhostBoxes.jsx; USR pages/Ghost.jsx | CORE (devices/agents) | agent runtime |
| Settings / API keys / integrations status | ADM platform/Settings.jsx, ApiKeys.jsx, Integrations.jsx | **CORE** | — |
| Billing | ADM store plans only; no billing screen | CORE (missing screen) | — |
| Agents (Paperclip) | none in ADM/USR (Plat-admin modules/nextgent) | CORE (missing) | — |
| Legacy App Manager / Business Apps | ADM appstore/AppManager.jsx, BusinessApps.jsx | drop | replaced by Store |
| Add section (schema catalog) | USR components/AddSection.jsx | CORE mechanism, but should be replaced by store-gated install | — |

## 5. Gaps against "dashboard core + surfaced apps"
- ADM has no per-company scoping of modules; apps are full admin screens rather than links into the apps.
- USR shows app data (menu, offerings, events, artist tables) inline as editable sections, gated by "table has rows" rather than by Store install (discoverSections.js:183). It should be: installed app → tile/link (plus a small summary) → open the app.
- Store install state (`/api/store`) is not read by Dashboard.jsx to decide what shows.
