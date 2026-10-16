# DASHBOARD-MODULES — inventory across CultureReset dashboard repos

Generated 2026-10-15 (read-only scan of local clones in /workspace/repo-read, `_branches/`, plus fresh shallow clones of ghost-platform, nextgent-shell, nextgent-assembly in /workspace/extra). Status is heuristic from code: WORKING = calls a real API; WORKING+mock-fallback = calls API but has sample data fallback; MOCK/STUB = no API call, sample data; STATIC = no data calls; PARTIAL = registry marks endpoint not served; API-only = backend surface with no UI.

Raw entries: **963**  |  Distinct modules: **336**  |  Function groups: **21**

Notes: Universal-dashboard-/catalog.json is empty (`"apps": []`) — no "22 app modules" registry was found in any scanned repo. No dedicated Paper Trail UI exists (WHAT-MATT-IS-BUILDING.md:81 "no dedicated repo"); nearest = orchestrator receipts/ledger, Paperclip Activity/Costs, Play-user branch Activity screen. Plat-admin and Admin-dashboard-main share one registry (src/modules/registry.js); cybercheck-login and gcr-admin are near-identical static-HTML copies; admin.html in those is the legacy monolith that Plat-admin mirrors.

## 1. Master list (deduped, by function)

| Group | Distinct modules | Raw entries |
|---|---:|---:|
| AI tools | 5 | 21 |
| Analytics & overview | 19 | 53 |
| App Store / Connections / Modules | 39 | 91 |
| Artist / Song requests & tips | 6 | 48 |
| Automations | 9 | 21 |
| Bookings & availability | 37 | 117 |
| Box / Ghost / Phone | 38 | 42 |
| Directory / Business profile & content | 17 | 76 |
| Events | 2 | 15 |
| Fleet / Paperclip / Agents | 31 | 46 |
| Ledger / Paper Trail / Audit | 4 | 5 |
| Link hub / bio / cards | 17 | 27 |
| Menu / QR / Specials | 21 | 71 |
| Messaging / Marketing / Social | 10 | 50 |
| Onboarding / Setup | 11 | 15 |
| Payments & billing | 4 | 12 |
| People / CRM / Accounts & auth | 16 | 61 |
| Reviews | 1 | 18 |
| Settings / System / Misc | 17 | 51 |
| Trip Swipe / Consumer engagement | 19 | 71 |
| Website / Site builder / Publish | 13 | 52 |

### AI tools

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| ai chat | 4 | WORKING×4, WORKING+mock-fallback×2 | /api/dashboard/ai-chat; ai; inline JS in admin.html → API_BASE gcr-api-clean | Plat-admin → `src/modules/registry.js:549 → src/modules/ai/AiChat.jsx (/ai/chat)`<br>Admin-dashboard-main → `src/modules/registry.js:511 → src/modules/ai/AiChat.jsx (/ai/chat)`<br>cybercheck-login → `admin.html:180`<br>gcr-admin → `admin.html:134`<br>cybercheck-login → `ai-chat.html:1`<br>gcr-admin → `ai-chat.html:1` |
| ai organize | 4 | WORKING×4 | ai; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:558 → src/modules/ai/AiOrganize.jsx (/ai/organize)`<br>Admin-dashboard-main → `src/modules/registry.js:520 → src/modules/ai/AiOrganize.jsx (/ai/organize)`<br>cybercheck-login → `admin.html:184`<br>gcr-admin → `admin.html:138` |
| ai settings | 4 | WORKING×4 | /api/ai-provider,ai,photos; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:576 → src/modules/ai/AiSettings.jsx (/ai/settings)`<br>Admin-dashboard-main → `src/modules/registry.js:538 → src/modules/ai/AiSettings.jsx (/ai/settings)`<br>cybercheck-login → `admin.html:192`<br>gcr-admin → `admin.html:146` |
| rag index | 4 | WORKING×4 | ai,entities; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:567 → src/modules/ai/RagIndex.jsx (/ai/rag-index)`<br>Admin-dashboard-main → `src/modules/registry.js:529 → src/modules/ai/RagIndex.jsx (/ai/rag-index)`<br>cybercheck-login → `admin.html:188`<br>gcr-admin → `admin.html:142` |
| ai config | 3 | WORKING×3 | ai; inline JS in admin.html → API_BASE gcr-api-clean | Plat-admin → `src/modules/registry.js:502 → src/modules/ai/AiConfig.jsx (/content/ai-config)`<br>Admin-dashboard-main → `src/modules/registry.js:464 → src/modules/ai/AiConfig.jsx (/content/ai-config)`<br>cybercheck-login → `admin.html:157` |

### Analytics & overview

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| analytics | 6 | WORKING×9, STATIC×1 | CC.getAnalytics; analytics; inline JS in admin.html → API_BASE gcr-api-clean | Plat-admin → `src/modules/registry.js:587 → src/modules/engagement/Analytics.jsx (/engagement/analytics)`<br>Admin-dashboard-main → `src/modules/registry.js:549 → src/modules/engagement/Analytics.jsx (/engagement/analytics)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:101 → js/analytics.js`<br>cybercheck-login → `app-dashboard.html:155 → js/analytics.js`<br>cybercheck-login → `admin.html:199`<br>gcr-admin → `app-dashboard.html:139 → js/analytics.js`<br>gcr-admin → `admin.html:153`<br>gcr-admin → `analytics.html:1`<br>cyber-admin → `dashboard/index.html:120`<br>cyber-admin → `beachside-dashboard/index.html:105` |
| dashboard | 6 | WORKING×4, MOCK/STUB×1, WORKING+mock-fallback×1 | /api/admin/costs,/api/admin/costs/per-lead,/api/admin/costs/summary,/api/admin/dashboard/activity,/api/admin/s; VITE_GCR_API_BASE → gcr-api-clean /api/business, | Play-user → `src/pages/Dashboard.jsx:1 (App.jsx:5)`<br>Dashboards-users- → `src/pages/Dashboard.jsx:1 (App.jsx:5)`<br>admin-dashboard- → `src/pages/Dashboard.jsx:1 (App.jsx:5)`<br>gcr-admin → `dashboard.html:1`<br>cyber-admin → `admin/admin-dashboard.html:1`<br>gcr-unified → `src/pages/Dashboard.jsx:1` |
| overview | 6 | WORKING×8, local-only×4, MOCK/STUB×2, STATIC×1 | CC_API_BASE (default localhost:3000); ads,claims,rails; bookingPlatform | Plat-admin → `src/modules/registry.js:85 → src/modules/home/Overview.jsx (/overview)`<br>Plat-admin → `src/modules/registry.js:282 → src/modules/booking/Overview.jsx (/booking)`<br>Admin-dashboard-main → `src/modules/registry.js:47 → src/modules/home/Overview.jsx (/)`<br>Admin-dashboard-main → `src/modules/registry.js:244 → src/modules/booking/Overview.jsx (/booking)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:21`<br>cybercheck-login → `app-dashboard.html:23 → js/overview.js`<br>cybercheck-login → `admin.html:76 → js/overview.js`<br>gcr-admin → `app-dashboard.html:23 → js/overview.js`<br>gcr-admin → `admin.html:46 → js/overview.js`<br>cyber-admin → `beachside-dashboard/tabs/overview.html:1`<br>cyber-admin → `dashboard/tabs/overview.html:1`<br>cyber-admin → `dashboard/index.html:21`<br>cyber-admin → `beachside-dashboard/index.html:21`<br>cyber-admin → `dashboard-booking/index.html:20`<br>cyber-admin → `dashboard-circleboat/index.html:20` |
| home | 3 | WORKING×2, WORKING+mock-fallback×1 | /api/public/gcr-stats; daemon /api/home; paperclip approvals,store,tasks; business bookings,events,messages,payments | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:4 → src/screens/Home.jsx`<br>Boxes → `shell/src/screens/settings/Settings.tsx:468`<br>gcr-admin → `home.html:1` |
| beachside circle boats dashboard | 2 | WORKING+mock-fallback×2 | /api/apps,/api/apps/install,/api/apps/uninstall/ | cybercheck-login → `beachside-circle-boats-dashboard.html:1`<br>gcr-admin → `beachside-circle-boats-dashboard.html:1` |
| customer dashboard | 2 | MOCK/STUB×2 |  | cybercheck-login → `customer-dashboard.html:1`<br>gcr-admin → `customer-dashboard.html:1` |
| text the dashboard | 2 | WORKING×2 | dashboardSms | Plat-admin → `src/modules/registry.js:207 → src/modules/platform/TextTheDashboard.jsx (/platform/text)`<br>Admin-dashboard-main → `src/modules/registry.js:169 → src/modules/platform/TextTheDashboard.jsx (/platform/text)` |
| visitor behaviour | 2 | WORKING×2 | analytics | Plat-admin → `src/modules/registry.js:227 → src/modules/engagement/Behaviour.jsx (/engagement/behaviour)`<br>Admin-dashboard-main → `src/modules/registry.js:189 → src/modules/engagement/Behaviour.jsx (/engagement/behaviour)` |
| business home | 1 | WORKING×1 | business listings,profile (schema discovery) | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:5 → src/screens/Business.jsx` |
| history | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard/index.html:88` |
| modular dashboard | 1 | WORKING+mock-fallback×1 | /api/auth/login,/api/auth/signup,/api/platform,/api/square/connect-url,/api/square/disconnect,/api/square/save | cybercheck-login → `modular-dashboard.html:1` |
| reports | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard-booking/index.html:83` |
| route /dashboard | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/page.tsx:1` |
| route /dashboard/build | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/build/page.tsx:1` |
| route /dashboard/build/ | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/build/[listingId]/page.tsx:1` |
| route /dashboard/build/describe | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/build/describe/page.tsx:1` |
| route /dashboard/design | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/design/page.tsx:1` |
| route /dashboard/settings/ai | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/settings/ai/page.tsx:1` |
| status | 1 | MOCK/STUB×1 |  | gcr-admin → `status.html:1` |

### App Store / Connections / Modules

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| app store | 6 | WORKING×5, WORKING+mock-fallback×2 | /api/apps,/api/apps/install,/api/apps/uninstall/; /api/connections; VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | Plat-admin → `src/modules/registry.js:811 → src/modules/appstore/Connections.jsx (/apps/store)`<br>Admin-dashboard-main → `src/modules/registry.js:832 → src/modules/appstore/Connections.jsx (/apps/store)`<br>Play-user → `src/pages/AppStore.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/AppStore.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/Dashboard.jsx:174`<br>cybercheck-login → `app-store.html:1`<br>gcr-admin → `app-store.html:1` |
| connections | 6 | WORKING×6, STATIC×3 | CC_API_BASE (default localhost:3000); connections; inline | Plat-admin → `src/modules/registry.js:822 → src/modules/booking/Connections.jsx (/booking/connections)`<br>Admin-dashboard-main → `src/modules/registry.js:843 → src/modules/booking/Connections.jsx (/booking/connections)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:124`<br>cybercheck-login → `app-dashboard.html:189`<br>gcr-admin → `app-dashboard.html:173`<br>cyber-admin → `dashboard/index.html:143`<br>cyber-admin → `beachside-dashboard/index.html:128`<br>cyber-admin → `dashboard-booking/index.html:89`<br>cyber-admin → `dashboard-circleboat/index.html:67` |
| integrations | 5 | PARTIAL×2, WORKING×2, STATIC×1, WORKING+mock-fallback×1 | /api/admin/ai-config,/api/admin/connections/status,/api/admin/platform/summary,/api/analytics/stats,/api/integrations/fa; /api/admin/integrations,/api/admin/int | Plat-admin → `src/modules/registry.js:896 → src/modules/platform/Integrations.jsx (/platform/integrations)`<br>Admin-dashboard-main → `src/modules/registry.js:928 → src/modules/platform/Integrations.jsx (/platform/integrations)`<br>cybercheck-login → `admin.html:322`<br>gcr-admin → `admin.html:268`<br>gcr-admin → `integrations.html:1`<br>cyber-admin → `admin/admin-integrations.html:1` |
| api keys | 4 | PARTIAL×2, WORKING×2 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; settings | Plat-admin → `src/modules/registry.js:925 → src/modules/platform/ApiKeys.jsx (/platform/api-keys)`<br>Admin-dashboard-main → `src/modules/registry.js:957 → src/modules/platform/ApiKeys.jsx (/platform/api-keys)`<br>cybercheck-login → `admin.html:330`<br>gcr-admin → `admin.html:276` |
| app manager | 3 | WORKING×3 | appsResource; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:831 → src/modules/appstore/AppManager.jsx (/apps/manager)`<br>cybercheck-login → `admin.html:293`<br>gcr-admin → `admin.html:239` |
| business apps | 3 | WORKING×3 | apps,businesses; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:840 → src/modules/appstore/BusinessApps.jsx (/apps/business-apps)`<br>cybercheck-login → `admin.html:297`<br>gcr-admin → `admin.html:243` |
| store (publish/install) | 3 | WORKING×4 | /api/store; VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr; adminApi | Plat-admin → `src/modules/registry.js:48 → src/modules/nextgent/StorePublishing.jsx (/)`<br>Admin-dashboard-main → `src/modules/registry.js:812 → src/modules/store/Store.jsx (/store)`<br>Dashboards-users- → `src/pages/Store.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/Dashboard.jsx:168` |
| alfio | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/alfio/alfio.html:1`<br>gcr-admin → `integrations/alfio/alfio.html:1` |
| apps | 2 | WORKING×2 | /api/companies/* (paperclip); adminApi | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:92 → src/modules/console/Apps.jsx (/apps)`<br>Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:6 → src/screens/Apps.jsx` |
| artist schedule | 2 | STATIC×2 |  | cybercheck-login → `integrations/artist-schedule/artist-schedule.html:1`<br>gcr-admin → `integrations/artist-schedule/artist-schedule.html:1` |
| bookings | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/booking/booking.html:1`<br>gcr-admin → `integrations/booking/booking.html:1` |
| castopod | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/castopod/castopod.html:1`<br>gcr-admin → `integrations/castopod/castopod.html:1` |
| connection manager | 2 | WORKING+mock-fallback×2, STATIC×2 |  | cybercheck-login → `connection-manager-dynamic.html:1`<br>cybercheck-login → `connection-manager.html:1`<br>gcr-admin → `connection-manager-dynamic.html:1`<br>gcr-admin → `connection-manager.html:1` |
| easy appointments | 2 | WORKING×2 | /api/v1/services | cybercheck-login → `integrations/easy-appointments/easy-appointments.html:1`<br>gcr-admin → `integrations/easy-appointments/easy-appointments.html:1` |
| events | 2 | STATIC×2 |  | cybercheck-login → `integrations/events/events.html:1`<br>gcr-admin → `integrations/events/events.html:1` |
| frappe | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/frappe/frappe.html:1`<br>gcr-admin → `integrations/frappe/frappe.html:1` |
| happy hour | 2 | MOCK/STUB×2 |  | cybercheck-login → `integrations/happy-hour/happy-hour.html:1`<br>gcr-admin → `integrations/happy-hour/happy-hour.html:1` |
| installed apps | 2 | MOCK/STUB×2 |  | cybercheck-login → `installed-apps.html:1`<br>gcr-admin → `installed-apps.html:1` |
| menu no images | 2 | STATIC×2 |  | cybercheck-login → `integrations/menu-no-images/menu-no-images.html:1`<br>gcr-admin → `integrations/menu-no-images/menu-no-images.html:1` |
| menu with images | 2 | MOCK/STUB×2 |  | cybercheck-login → `integrations/menu-with-images/menu-with-images.html:1`<br>gcr-admin → `integrations/menu-with-images/menu-with-images.html:1` |
| open food network | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/open-food-network/open-food-network.html:1`<br>gcr-admin → `integrations/open-food-network/open-food-network.html:1` |
| open loyalty | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/open-loyalty/open-loyalty.html:1`<br>gcr-admin → `integrations/open-loyalty/open-loyalty.html:1` |
| open table alt | 2 | WORKING+mock-fallback×2 | supabase | cybercheck-login → `integrations/open-table-alt/open-table-alt.html:1`<br>gcr-admin → `integrations/open-table-alt/open-table-alt.html:1` |
| rallly | 2 | WORKING×2 | supabase | cybercheck-login → `integrations/rallly/rallly.html:1`<br>gcr-admin → `integrations/rallly/rallly.html:1` |
| shared | 2 | MOCK/STUB×2 |  | cybercheck-login → `integrations/shared/shared.html:1`<br>gcr-admin → `integrations/shared/shared.html:1` |
| specials | 2 | MOCK/STUB×2 |  | cybercheck-login → `integrations/specials/specials.html:1`<br>gcr-admin → `integrations/specials/specials.html:1` |
| tool selection | 2 | MOCK/STUB×2 |  | cybercheck-login → `tool-selection.html:1`<br>gcr-admin → `tool-selection.html:1` |
| add integration | 1 | WORKING+mock-fallback×1 | /api/admin/integrations | cyber-admin → `admin/admin-add-integration.html:1` |
| app catalog | 1 | EMPTY×1 | read by saas-cybercheck Paperclip plugin | Universal-dashboard- → `catalog.json:2` |
| developer dashboard | 1 | STATIC×1 |  | gcr-admin → `developer-dashboard.html:1` |
| developer portal | 1 | WORKING+mock-fallback×1 | /api/developers/register,/api/developers/stripe/connect | gcr-admin → `developer-portal.html:1` |
| installs | 1 | API-only×1 | /api/b/:slug/installs | cybercheck-orchestrator → `src/http/server.js:39` |
| modules | 1 | WORKING×1 | src/lib/gent/store.ts | nextgent-shell → `src/components/gent/app.tsx:69` |
| oauth | 1 | WORKING×2 | /api/oauth/ | cyber-admin → `beachside-dashboard/tabs/oauth.html:1`<br>cyber-admin → `dashboard/tabs/oauth.html:1` |
| package manager | 1 | WORKING+mock-fallback×1 | /api/features,/api/features/,/api/offers,/api/offers/,/api/packages,/api/packages/ | cyber-admin → `admin/admin-package-manager.html:1` |
| packages/marketplace | 1 | API-only×1 | /api/packages | cybercheck-orchestrator → `src/http/server.js:37` |
| providers | 1 | API-only×1 | /api/b/:slug/providers | cybercheck-orchestrator → `src/http/server.js:225` |
| route /dashboard/apps/ | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/apps/[installId]/page.tsx:1` |
| route /dashboard/store | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/store/page.tsx:1` |

### Artist / Song requests & tips

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| Artist profiles | 7 | WORKING×11 | artists,artistsResource; gcr-api-clean; gcr-api-clean /api/business/* table artist_aliases | Plat-admin → `src/modules/registry.js:457 → src/modules/content/Artists.jsx (/content/artists)`<br>Admin-dashboard-main → `src/modules/registry.js:419 → src/modules/content/Artists.jsx (/content/artists)`<br>Play-user → `src/lib/artistModule.js:19`<br>Play-user → `src/lib/artistModule.js:33`<br>Dashboards-users- → `src/lib/artistModule.js:19`<br>Dashboards-users- → `src/lib/artistModule.js:33`<br>admin-dashboard- → `src/lib/artistModule.js:19`<br>admin-dashboard- → `src/lib/artistModule.js:33`<br>cybercheck-login → `admin.html:137`<br>cybercheck-login → `admin.html:141`<br>gcr-unified → `src/pages/ArtistProfile.jsx:1` |
| Song requests, tips, shoutouts, crowdfund | 6 | WORKING×23, WORKING+mock-fallback×1 | artists; gcr-api-clean /api/business/* table artist_goal_contributions; gcr-api-clean /api/business/* table artist_goals | Plat-admin → `src/modules/registry.js:466 → src/modules/content/ArtistProfiles.jsx (/content/artist-profiles)`<br>Admin-dashboard-main → `src/modules/registry.js:428 → src/modules/content/ArtistProfiles.jsx (/content/artist-profiles)`<br>Play-user → `src/lib/artistModule.js:21`<br>Play-user → `src/lib/artistModule.js:22`<br>Play-user → `src/lib/artistModule.js:23`<br>Play-user → `src/lib/artistModule.js:24`<br>Play-user → `src/lib/artistModule.js:25`<br>Play-user → `src/lib/artistModule.js:26`<br>Play-user → `src/lib/artistModule.js:27`<br>Dashboards-users- → `src/lib/artistModule.js:21`<br>Dashboards-users- → `src/lib/artistModule.js:22`<br>Dashboards-users- → `src/lib/artistModule.js:23`<br>Dashboards-users- → `src/lib/artistModule.js:24`<br>Dashboards-users- → `src/lib/artistModule.js:25`<br>Dashboards-users- → `src/lib/artistModule.js:26`<br>Dashboards-users- → `src/lib/artistModule.js:27`<br>admin-dashboard- → `src/lib/artistModule.js:21`<br>admin-dashboard- → `src/lib/artistModule.js:22`<br>admin-dashboard- → `src/lib/artistModule.js:23`<br>admin-dashboard- → `src/lib/artistModule.js:24`<br>admin-dashboard- → `src/lib/artistModule.js:25`<br>admin-dashboard- → `src/lib/artistModule.js:26`<br>admin-dashboard- → `src/lib/artistModule.js:27`<br>cybercheck-login → `song-request.html:1` |
| Artist shows / live | 4 | WORKING×4 | gcr-api-clean; gcr-api-clean /api/business/* table artist_shows | Play-user → `src/lib/artistModule.js:28`<br>Dashboards-users- → `src/lib/artistModule.js:28`<br>admin-dashboard- → `src/lib/artistModule.js:28`<br>gcr-unified → `src/pages/ArtistLive.jsx:1` |
| Artist booking requests | 3 | WORKING×3 | gcr-api-clean /api/business/* table artist_booking_requests | Play-user → `src/lib/artistModule.js:30`<br>Dashboards-users- → `src/lib/artistModule.js:30`<br>admin-dashboard- → `src/lib/artistModule.js:30` |
| Fan list | 3 | WORKING×3 | gcr-api-clean /api/business/* table artist_follows | Play-user → `src/lib/artistModule.js:29`<br>Dashboards-users- → `src/lib/artistModule.js:29`<br>admin-dashboard- → `src/lib/artistModule.js:29` |
| Setlist | 3 | WORKING×3 | gcr-api-clean /api/business/* table songs | Play-user → `src/lib/artistModule.js:20`<br>Dashboards-users- → `src/lib/artistModule.js:20`<br>admin-dashboard- → `src/lib/artistModule.js:20` |

### Automations

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| automations | 6 | WORKING×4, MOCK/STUB×2, API-only×1 | /api/b/:slug/automations; /api/business/automations; VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | Admin-dashboard-main → `src/modules/registry.js:759 → src/modules/automations/Automations.jsx (/automations)`<br>Dashboards-users- → `src/pages/Automations.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/Dashboard.jsx:172`<br>Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:8 → src/screens/Automations.jsx`<br>cybercheck-login → `automations.html:1`<br>gcr-admin → `automations.html:1`<br>cybercheck-orchestrator → `src/http/server.js:156` |
| automation builder | 2 | STATIC×2 |  | cybercheck-login → `automation-builder.html:1`<br>gcr-admin → `automation-builder.html:1` |
| automation setup | 2 | MOCK/STUB×2 |  | cybercheck-login → `automation-setup.html:1`<br>gcr-admin → `automation-setup.html:1` |
| automation templates | 2 | STATIC×2 |  | cybercheck-login → `automation-templates.html:1`<br>gcr-admin → `automation-templates.html:1` |
| create workflow ai | 2 | WORKING+mock-fallback×2 |  | cybercheck-login → `create-workflow-ai.html:1`<br>gcr-admin → `create-workflow-ai.html:1` |
| workflow logs | 2 | WORKING×2 |  | cybercheck-login → `workflow-logs.html:1`<br>gcr-admin → `workflow-logs.html:1` |
| deployments | 1 | WORKING×1 | adminApi,automations | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:212 → src/modules/console/Deployments.jsx (/deployments)` |
| rollouts | 1 | WORKING×1 | automations | Admin-dashboard-main → `src/modules/registry.js:777 → src/modules/automations/Rollouts.jsx (/automations/rollouts)` |
| workflows | 1 | MOCK/STUB×2 |  | cyber-admin → `beachside-dashboard/tabs/workflows.html:1`<br>cyber-admin → `dashboard/tabs/workflows.html:1` |

### Bookings & availability

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| availability | 7 | WORKING×5, WORKING+mock-fallback×2, MOCK/STUB×1 | CC.getAvailability,CC.setAvailability; CC_API_BASE (default localhost:3000); bookingPlatform | Plat-admin → `src/modules/registry.js:358 → src/modules/booking/Availability.jsx (/booking/availability)`<br>Admin-dashboard-main → `src/modules/registry.js:320 → src/modules/booking/Availability.jsx (/booking/availability)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:48 → js/availability.js`<br>cybercheck-login → `app-dashboard.html:82 → js/availability.js`<br>gcr-admin → `app-dashboard.html:82 → js/availability.js`<br>cyber-admin → `dashboard/index.html:48`<br>cyber-admin → `beachside-dashboard/index.html:48`<br>cybercheck-orchestrator → `modules/availability/manifest.json:1` |
| bookings | 6 | WORKING×8, WORKING+mock-fallback×5, STATIC×2 | /api/dashboard/declined-bookings,/api/public/resend-confirmation,/api/public/waivers/send-link,/api/stripe/ref; /api/stripe/refund,CC.getBookings,CC.getToken,CC | Plat-admin → `src/modules/registry.js:300 → src/modules/booking/BookingsLedger.jsx (/booking/bookings)`<br>Plat-admin → `src/modules/registry.js:869 → src/modules/platform/Bookings.jsx (/platform/bookings)`<br>Admin-dashboard-main → `src/modules/registry.js:262 → src/modules/booking/BookingsLedger.jsx (/booking/bookings)`<br>Admin-dashboard-main → `src/modules/registry.js:901 → src/modules/platform/Bookings.jsx (/platform/bookings)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:60 → js/bookings.js`<br>cybercheck-login → `app-dashboard.html:102 → js/bookings.js`<br>cybercheck-login → `admin.html:310 → js/bookings.js`<br>gcr-admin → `app-dashboard.html:98 → js/bookings.js`<br>gcr-admin → `admin.html:256 → js/bookings.js`<br>cybercheck-login → `booking.html:1`<br>gcr-admin → `booking.html:1`<br>cyber-admin → `dashboard/index.html:60`<br>cyber-admin → `beachside-dashboard/index.html:60`<br>cyber-admin → `dashboard-booking/index.html:24`<br>cyber-admin → `dashboard-circleboat/index.html:24` |
| inventory / fleet types | 6 | WORKING×6, WORKING+mock-fallback×3 | CC.createFleetType,CC.deleteFleetType,CC.getFleetTypes,CC.updateFleetType; bookingPlatform; supabase (inline) / dashboard/js | Plat-admin → `src/modules/registry.js:348 → src/modules/booking/Inventory.jsx (/booking/inventory)`<br>Admin-dashboard-main → `src/modules/registry.js:310 → src/modules/booking/Inventory.jsx (/booking/inventory)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:44 → js/inventory.js`<br>cybercheck-login → `app-dashboard.html:78 → js/inventory.js`<br>gcr-admin → `app-dashboard.html:78 → js/inventory.js`<br>cyber-admin → `dashboard/index.html:44`<br>cyber-admin → `beachside-dashboard/index.html:44`<br>cyber-admin → `dashboard-booking/index.html:39`<br>cyber-admin → `dashboard-circleboat/index.html:35` |
| offerings | 5 | WORKING×5 | bookingPlatform; gcr-api-clean /api/business/* (schema-discovered tables) | Plat-admin → `src/modules/registry.js:291 → src/modules/booking/Offerings.jsx (/booking/offerings)`<br>Admin-dashboard-main → `src/modules/registry.js:253 → src/modules/booking/Offerings.jsx (/booking/offerings)`<br>Play-user → `src/sections/OfferingsSection.jsx (registry.jsx:10)`<br>Dashboards-users- → `src/sections/OfferingsSection.jsx (registry.jsx:10)`<br>admin-dashboard- → `src/sections/OfferingsSection.jsx (registry.jsx:10)` |
| add-ons | 4 | WORKING×6 | CC.createAddon,CC.deleteAddon,CC.getAddons,CC.updateAddon; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:52 → js/addons.js`<br>cybercheck-login → `app-dashboard.html:94 → js/addons.js`<br>gcr-admin → `app-dashboard.html:90 → js/addons.js`<br>cyber-admin → `dashboard/index.html:52`<br>cyber-admin → `beachside-dashboard/index.html:52`<br>cyber-admin → `dashboard-booking/index.html:43` |
| locations | 4 | WORKING×6 | CC.createLocation,CC.deleteLocation,CC.getLocations,CC.updateLocation; site_content; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:56 → js/locations.js`<br>cybercheck-login → `app-dashboard.html:98 → js/locations.js`<br>gcr-admin → `app-dashboard.html:94 → js/locations.js`<br>cyber-admin → `dashboard/index.html:56`<br>cyber-admin → `beachside-dashboard/index.html:56`<br>cyber-admin → `dashboard-booking/index.html:71` |
| waitlist | 4 | WORKING×4, MOCK/STUB×1 | CC.deleteWaitlistEntry,CC.getWaitlist,CC.updateWaitlistEntry,CC.updateWaitlistSettings; CC_API_BASE (default localhost:3000); supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:69 → js/waitlist.js`<br>cybercheck-login → `app-dashboard.html:119 → js/waitlist.js`<br>gcr-admin → `app-dashboard.html:107 → js/waitlist.js`<br>cyber-admin → `dashboard/index.html:69`<br>cyber-admin → `beachside-dashboard/index.html:69` |
| waivers | 4 | WORKING×4, WORKING+mock-fallback×3, MOCK/STUB×1 | /api/platform/waiver-info/,/api/platform/waiver-sign/; CC.deleteDocument,CC.getWaiverTemplate,CC.getWaivers,CC.updateWaiverTemplate,CC.uploadDocument; CC.getSit | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:65 → js/waivers.js`<br>cybercheck-login → `app-dashboard.html:107 → js/waivers.js`<br>gcr-admin → `app-dashboard.html:103 → js/waivers.js`<br>cybercheck-login → `waiver.html:1`<br>cyber-admin → `dashboard/index.html:65`<br>cyber-admin → `beachside-dashboard/index.html:65`<br>cyber-admin → `dashboard-booking/index.html:61`<br>cyber-admin → `dashboard-circleboat/index.html:53` |
| calendar feeds | 3 | WORKING×3 | CC.addExternalCalendar,CC.deleteExternalCalendar,CC.getExternalCalendars,CC.getIcalFeedUrl,CC.regenerateIcalFe; bookingPlatform | Plat-admin → `src/modules/registry.js:338 → src/modules/booking/CalendarFeeds.jsx (/booking/feeds)`<br>Admin-dashboard-main → `src/modules/registry.js:300 → src/modules/booking/CalendarFeeds.jsx (/booking/feeds)`<br>cybercheck-login → `app-dashboard.html:90 → js/calendar-sync.js` |
| pricing | 3 | MOCK/STUB×2, WORKING×2, STATIC×1 | supabase (inline) / dashboard/js | cybercheck-login → `admin-pricing.html:1`<br>gcr-admin → `admin-pricing.html:1`<br>gcr-admin → `pricing.html:1`<br>cyber-admin → `dashboard-booking/index.html:47`<br>cyber-admin → `dashboard-circleboat/index.html:39` |
| availability search | 2 | WORKING×2 | bookingPlatform | Plat-admin → `src/modules/registry.js:416 → src/modules/booking/AvailabilitySearch.jsx (/booking/search)`<br>Admin-dashboard-main → `src/modules/registry.js:378 → src/modules/booking/AvailabilitySearch.jsx (/booking/search)` |
| blackout dates | 2 | WORKING×2 | CC.addBlackoutDate,CC.deleteBlackoutDate,CC.getBlackoutDates | cybercheck-login → `app-dashboard.html:86 → js/blackout-dates.js`<br>gcr-admin → `app-dashboard.html:86 → js/blackout-dates.js` |
| business calendar | 2 | STATIC×2 |  | Plat-admin → `src/modules/registry.js:368 → src/modules/booking/BusinessCalendar.jsx (/booking/calendar)`<br>Admin-dashboard-main → `src/modules/registry.js:330 → src/modules/booking/BusinessCalendar.jsx (/booking/calendar)` |
| calendar | 2 | WORKING×3 | business availability,bookings,events; paperclip routines,tasks; supabase (inline) / dashboard/js | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:9 → src/screens/Calendar.jsx`<br>cyber-admin → `dashboard-booking/index.html:29`<br>cyber-admin → `dashboard-circleboat/index.html:29` |
| charter dashboard | 2 | STATIC×2 |  | cybercheck-login → `dashboard-charter.html:1`<br>gcr-admin → `dashboard-charter.html:1` |
| date claims | 2 | WORKING×2 | bookingPlatform | Plat-admin → `src/modules/registry.js:309 → src/modules/booking/Calendar.jsx (/booking/date-claims)`<br>Admin-dashboard-main → `src/modules/registry.js:271 → src/modules/booking/Calendar.jsx (/booking/date-claims)` |
| find a match | 2 | WORKING×2 | bookingPlatform | Plat-admin → `src/modules/registry.js:406 → src/modules/booking/Match.jsx (/booking/match)`<br>Admin-dashboard-main → `src/modules/registry.js:368 → src/modules/booking/Match.jsx (/booking/match)` |
| industries | 2 | STATIC×2 |  | cybercheck-login → `industries.html:1`<br>gcr-admin → `industries.html:1` |
| industry calendars | 2 | WORKING×2 | bookingPlatform | Plat-admin → `src/modules/registry.js:387 → src/modules/booking/Industries.jsx (/booking/industries)`<br>Admin-dashboard-main → `src/modules/registry.js:349 → src/modules/booking/Industries.jsx (/booking/industries)` |
| openings | 2 | WORKING×2 | bookingPlatform,sms | Plat-admin → `src/modules/registry.js:436 → src/modules/booking/Openings.jsx (/booking/openings)`<br>Admin-dashboard-main → `src/modules/registry.js:398 → src/modules/booking/Openings.jsx (/booking/openings)` |
| portfolio | 2 | WORKING+mock-fallback×2 | /api/portfolio | cybercheck-login → `app-dashboard.html:65 → js/portfolio.js`<br>gcr-admin → `app-dashboard.html:65 → js/portfolio.js` |
| promos | 2 | WORKING×2 | /api/admin/gcr/coupons,promosResource | Plat-admin → `src/modules/registry.js:319 → src/modules/booking/Promos.jsx (/booking/promos)`<br>Admin-dashboard-main → `src/modules/registry.js:281 → src/modules/booking/Promos.jsx (/booking/promos)` |
| rooms | 2 | WORKING×1, WORKING+mock-fallback×1 | /api/rooms; CC.addExternalCalendar,CC.createUnit,CC.deleteExternalCalendar,CC.deleteUnit,CC.getExternalCalendars,CC.getUni | cybercheck-login → `app-dashboard.html:73 → js/rooms.js`<br>gcr-admin → `app-dashboard.html:73 → js/rooms.js` |
| services | 2 | WORKING+mock-fallback×2 | /api/services | cybercheck-login → `app-dashboard.html:69 → js/services.js`<br>gcr-admin → `app-dashboard.html:69 → js/services.js` |
| sources | 2 | WORKING×2 | bookingPlatform | Plat-admin → `src/modules/registry.js:328 → src/modules/booking/Sources.jsx (/booking/sources)`<br>Admin-dashboard-main → `src/modules/registry.js:290 → src/modules/booking/Sources.jsx (/booking/sources)` |
| transportation | 2 | WORKING×2 | CC.addTransportProvider,CC.deleteTransportProvider,CC.getTransportProviders,CC.getTransportRequests,CC.getTran; supabase (inline) / dashboard/js | cybercheck-login → `app-dashboard.html:115 → js/transportation.js`<br>cyber-admin → `beachside-dashboard/index.html:148` |
| website calendar | 2 | WORKING×2 | embed | Plat-admin → `src/modules/registry.js:426 → src/modules/booking/WebsiteCalendar.jsx (/booking/website-calendar)`<br>Admin-dashboard-main → `src/modules/registry.js:388 → src/modules/booking/WebsiteCalendar.jsx (/booking/website-calendar)` |
| book | 1 | WORKING+mock-fallback×1 | /api/platform/page/,/api/stripe/config,/api/stripe/create-payment-intent | cybercheck-login → `book.html:1` |
| bookpro | 1 | MOCK/STUB×1, STATIC×1 |  | cybercheck-login → `bookpro-start.html:1`<br>cybercheck-login → `bookpro.html:1` |
| dock | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard-circleboat/index.html:43` |
| drivers | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard/index.html:76` |
| manifest | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard-booking/index.html:33` |
| pricing control | 1 | WORKING+mock-fallback×1 |  | cyber-admin → `admin/admin-pricing-control.html:1` |
| resources | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard-booking/index.html:51` |
| rides | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard/index.html:80` |
| social feeds | 1 | MOCK/STUB×2 |  | cyber-admin → `beachside-dashboard/tabs/business-details/social-feeds.html:1`<br>cyber-admin → `dashboard/tabs/business-details/social-feeds.html:1` |
| taxi business dashboard | 1 | WORKING+mock-fallback×1 | /api/taxi | cyber-admin → `taxi-business-dashboard.html:1` |

### Box / Ghost / Phone

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| devices | 3 | WORKING×3 | daemon /api/devices; gcr-api-clean; ghost | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:176 → src/modules/console/Devices.jsx (/devices)`<br>Dashboards-users-@claude/new-session-66c2e9 → `src/pages/Devices.jsx:1`<br>Boxes → `shell/src/screens/settings/Settings.tsx:582` |
| ghost boxes / nodes | 2 | WORKING×3 | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr; endpoints.nodes (/api/business/nodes…); ghost | Admin-dashboard-main → `src/modules/registry.js:874 → src/modules/platform/GhostBoxes.jsx (/platform/ghost)`<br>Dashboards-users- → `src/pages/Ghost.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/Dashboard.jsx:170` |
| about | 1 | WORKING×1 | daemon /api/about | Boxes → `shell/src/screens/settings/Settings.tsx:360` |
| addresses | 1 | WORKING×1 | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | ghost-platform (operator console) → `console/src/components/ghost/live.tsx:200` |
| agents | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:38` |
| appearance | 1 | WORKING×1 | daemon /api/appearance | Boxes → `shell/src/screens/settings/Settings.tsx:244` |
| apps | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:37` |
| automations | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:39` |
| bluetooth | 1 | WORKING×1 | daemon /api/bluetooth | Boxes → `shell/src/screens/settings/Settings.tsx:147` |
| box page endpoint / | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:165` |
| box page endpoint /api/capture | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:183` |
| box page endpoint /api/catalog | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:173` |
| box page endpoint /api/maps | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:177` |
| box page endpoint /api/maps/run | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:187` |
| box page endpoint /api/mcp | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:191` |
| box page endpoint /api/status | 1 | WORKING×1 | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | ghost-platform (box page) → `box/server.js:171` |
| business home | 1 | WORKING×1 | daemon /api/business/{menu,hours,specials,reviews,availability} | Boxes@claude/agent-ecosystem-architecture-nzexu1 → `shell/src/screens/BusinessHome.tsx:1` |
| calendar | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:41` |
| cinemahome | 1 | WORKING×1 | daemon /api/home,/api/layout,/api/worlds | Boxes → `shell/src/screens/homes/CinemaHome.tsx:1` |
| computer | 1 | WORKING×1 | /api/companies/* devices (paperclip) | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:11 → src/screens/Computer.jsx` |
| dashboardhome | 1 | WORKING×1 | daemon /api/home,/api/layout,/api/worlds | Boxes → `shell/src/screens/homes/DashboardHome.tsx:1` |
| device apps | 1 | API-only×1 | /api/b/:slug/device/apps | cybercheck-orchestrator → `src/http/server.js:111` |
| device screen | 1 | API-only×1 | /api/b/:slug/device/screen | cybercheck-orchestrator → `src/http/server.js:136` |
| display | 1 | WORKING×1 | daemon /api/display | Boxes → `shell/src/screens/settings/Settings.tsx:209` |
| files | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:40` |
| home | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:36` |
| install | 1 | WORKING×1 | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | ghost-platform (operator console) → `console/src/components/ghost/live.tsx:176` |
| livinghome | 1 | WORKING×1 | daemon /api/home,/api/layout,/api/worlds | Boxes → `shell/src/screens/homes/LivingHome.tsx:1` |
| power | 1 | WORKING×1 | daemon /api/power | Boxes → `shell/src/screens/settings/Settings.tsx:300` |
| route /dashboard/ghost | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/dashboard/ghost/page.tsx:1` |
| settings | 1 | WORKING+mock-fallback×1 | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | Boxes → `shell/src/modules/registry.tsx:42` |
| sound | 1 | WORKING×1 | daemon /api/sound | Boxes → `shell/src/screens/settings/Settings.tsx:180` |
| storage | 1 | WORKING×1 | daemon /api/storage | Boxes → `shell/src/screens/settings/Settings.tsx:324` |
| updates | 1 | WORKING×1 | daemon /api/updates | Boxes → `shell/src/screens/settings/Settings.tsx:341` |
| vault | 1 | WORKING×1 | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | ghost-platform (operator console) → `console/src/components/ghost/live.tsx:219` |
| wifi | 1 | WORKING×1 | daemon /api/wifi | Boxes → `shell/src/screens/settings/Settings.tsx:95` |
| work | 1 | WORKING×1 | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | ghost-platform (operator console) → `console/src/components/ghost/live.tsx:95` |
| worlds | 1 | WORKING×1 | daemon /api/worlds | Boxes → `shell/src/screens/settings/Settings.tsx:506` |

### Directory / Business profile & content

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| business profile | 7 | WORKING×11, WORKING+mock-fallback×2 | /api/profile/update; /api/site-data,CC.getProfile,CC.updateProfile; CC.getProfile,CC.updateProfile | Plat-admin → `src/modules/registry.js:197 → src/modules/directory/BusinessProfile.jsx (/directory/profile)`<br>Admin-dashboard-main → `src/modules/registry.js:159 → src/modules/directory/BusinessProfile.jsx (/directory/profile)`<br>Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:203 → src/modules/console/DataHome.jsx (/data)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:25 → js/profile.js`<br>cybercheck-login → `app-dashboard.html:27 → js/profile.js`<br>gcr-admin → `app-dashboard.html:27 → js/profile.js`<br>cybercheck-login → `profile-editor.html:1`<br>gcr-admin → `profile-editor.html:1`<br>cyber-admin → `dashboard/index.html:25`<br>cyber-admin → `beachside-dashboard/index.html:25`<br>cyber-admin → `dashboard-booking/index.html:67`<br>cyber-admin → `dashboard-circleboat/index.html:59`<br>cybercheck-orchestrator → `modules/business_profile/index.js:1` |
| media/gallery | 7 | WORKING×7, WORKING+mock-fallback×3, MOCK/STUB×2 | CC.getGallery; gcr-api-clean /api/business/* (schema-discovered tables); supabase (inline) / dashboard/js | Play-user → `src/sections/PhotosSection.jsx (registry.jsx:2)`<br>Dashboards-users- → `src/sections/PhotosSection.jsx (registry.jsx:2)`<br>admin-dashboard- → `src/sections/PhotosSection.jsx (registry.jsx:2)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:29 → js/media.js`<br>cybercheck-login → `app-dashboard.html:31 → js/media.js`<br>gcr-admin → `app-dashboard.html:31 → js/media.js`<br>cyber-admin → `beachside-dashboard/tabs/business-details/gallery-editor.html:1`<br>cyber-admin → `dashboard/tabs/business-details/gallery-editor.html:1`<br>cyber-admin → `dashboard/index.html:29`<br>cyber-admin → `beachside-dashboard/index.html:29`<br>cyber-admin → `dashboard-booking/index.html:79`<br>cyber-admin → `dashboard-circleboat/index.html:63` |
| businesses | 5 | WORKING×10 | adminApi; businesses; entities | Plat-admin → `src/modules/registry.js:66 → src/modules/nextgent/Businesses.jsx (/businesses)`<br>Plat-admin → `src/modules/registry.js:171 → src/modules/directory/Businesses.jsx (/directory/businesses)`<br>Plat-admin → `src/modules/registry.js:851 → src/modules/platform/Businesses.jsx (/platform/businesses)`<br>Admin-dashboard-main → `src/modules/registry.js:133 → src/modules/directory/Businesses.jsx (/directory/businesses)`<br>Admin-dashboard-main → `src/modules/registry.js:883 → src/modules/platform/Businesses.jsx (/platform/businesses)`<br>cybercheck-login → `admin.html:114`<br>cybercheck-login → `admin.html:302`<br>gcr-admin → `admin.html:84`<br>gcr-admin → `admin.html:248`<br>nextgent-shell → `src/components/gent/app.tsx:68` |
| entity editor | 5 | WORKING×4, WORKING+mock-fallback×2 | /api/gcr/upload-photo; entities; inline JS in admin.html → API_BASE gcr-api-clean | Plat-admin → `src/modules/registry.js:180 → src/modules/directory/EntityEditor.jsx (/directory/entity)`<br>Admin-dashboard-main → `src/modules/registry.js:142 → src/modules/directory/EntityEditor.jsx (/directory/entity)`<br>cybercheck-login → `admin.html:118`<br>gcr-admin → `admin.html:88`<br>cybercheck-login → `gcr-entity-manager.html:1`<br>cyber-admin → `admin/admin-gcr-management.html:1` |
| faq | 5 | WORKING×5 | CC.createFAQ,CC.deleteFAQ,CC.getFAQs,CC.updateFAQ; gcr-api-clean /api/business/* (schema-discovered tables) | Play-user → `src/sections/FaqsSection.jsx (registry.jsx:8)`<br>Dashboards-users- → `src/sections/FaqsSection.jsx (registry.jsx:8)`<br>admin-dashboard- → `src/sections/FaqsSection.jsx (registry.jsx:8)`<br>cybercheck-login → `app-dashboard.html:167 → js/faq.js`<br>gcr-admin → `app-dashboard.html:151 → js/faq.js` |
| hours | 4 | WORKING×3, STATIC×2 | gcr-api-clean /api/business/* (schema-discovered tables) | Play-user → `src/sections/HoursSection.jsx (registry.jsx:1)`<br>Dashboards-users- → `src/sections/HoursSection.jsx (registry.jsx:1)`<br>admin-dashboard- → `src/sections/HoursSection.jsx (registry.jsx:1)`<br>cyber-admin → `beachside-dashboard/tabs/business-details/hours-editor.html:1`<br>cyber-admin → `dashboard/tabs/business-details/hours-editor.html:1` |
| policies | 4 | WORKING×3, WORKING+mock-fallback×1 | CC.deleteDocument,CC.getPolicies,CC.updatePolicies,CC.uploadDocument; gcr-api-clean /api/business/* (schema-discovered tables) | Play-user → `src/sections/PoliciesSection.jsx (registry.jsx:9)`<br>Dashboards-users- → `src/sections/PoliciesSection.jsx (registry.jsx:9)`<br>admin-dashboard- → `src/sections/PoliciesSection.jsx (registry.jsx:9)`<br>cybercheck-login → `app-dashboard.html:111 → js/policies.js` |
| generic | 3 | WORKING×3 | gcr-api-clean /api/business/* (schema-discovered tables) | Play-user → `src/sections/GenericSection.jsx (registry.jsx:24)`<br>Dashboards-users- → `src/sections/GenericSection.jsx (registry.jsx:24)`<br>admin-dashboard- → `src/sections/GenericSection.jsx (registry.jsx:24)` |
| pricelist | 3 | WORKING×3 | gcr-api-clean /api/business/* (schema-discovered tables) | Play-user → `src/sections/PriceListSection.jsx (registry.jsx:11)`<br>Dashboards-users- → `src/sections/PriceListSection.jsx (registry.jsx:11)`<br>admin-dashboard- → `src/sections/PriceListSection.jsx (registry.jsx:11)` |
| progress | 3 | WORKING×3 | gcr-api-clean /api/business/* (schema-discovered tables) | Play-user → `src/sections/ProgressSection.jsx (registry.jsx:12)`<br>Dashboards-users- → `src/sections/ProgressSection.jsx (registry.jsx:12)`<br>admin-dashboard- → `src/sections/ProgressSection.jsx (registry.jsx:12)` |
| website content | 3 | WORKING+mock-fallback×2, WORKING×2 | /api/dashboard/addons,/api/dashboard/addons/sync,/api/dashboard/fleet,/api/dashboard/fleet/,/api/dashboard/med; /api/dashboard/addons,/api/dashboard/addons/sync | cybercheck-login → `app-dashboard.html:193 → js/website-content.js`<br>gcr-admin → `app-dashboard.html:177 → js/website-content.js`<br>cyber-admin → `dashboard/index.html:147`<br>cyber-admin → `beachside-dashboard/index.html:132` |
| about | 2 | MOCK/STUB×2, STATIC×1 |  | gcr-admin → `about.html:1`<br>cyber-admin → `beachside-dashboard/tabs/business-details/about-editor.html:1`<br>cyber-admin → `dashboard/tabs/business-details/about-editor.html:1` |
| content manager | 1 | WORKING+mock-fallback×1 | /api/content/platform,/api/content/platform/ | cyber-admin → `admin/admin-content-manager.html:1` |
| gcr discover | 1 | WORKING+mock-fallback×1 |  | cyber-admin → `admin/admin-gcr-discover.html:1` |
| gcr featured | 1 | WORKING+mock-fallback×1 |  | cyber-admin → `admin/admin-gcr-featured.html:1` |
| listing | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `beachside-dashboard/index.html:144` |
| photo repair | 1 | WORKING×1 | /api/admin/repair-photos,/api/admin/repair-photos/status | cybercheck-login → `photo-repair.html:1` |

### Events

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| events | 7 | WORKING×11 | /api/dashboard/events/extract,CC.compressImage,CC.createEvent,CC.deleteEvent,CC.getEvents,CC.updateEvent; events; gcr-api-clean /api/business/* (schema-discover | Plat-admin → `src/modules/registry.js:448 → src/modules/content/Events.jsx (/content/events)`<br>Admin-dashboard-main → `src/modules/registry.js:410 → src/modules/content/Events.jsx (/content/events)`<br>Play-user → `src/sections/EventsSection.jsx (registry.jsx:5)`<br>Dashboards-users- → `src/sections/EventsSection.jsx (registry.jsx:5)`<br>admin-dashboard- → `src/sections/EventsSection.jsx (registry.jsx:5)`<br>cybercheck-login → `app-dashboard.html:58 → js/events.js`<br>cybercheck-login → `admin.html:133`<br>cybercheck-login → `admin-dashboard.html:1373 → js/events.js`<br>gcr-admin → `app-dashboard.html:58 → js/events.js`<br>gcr-admin → `admin.html:103`<br>gcr-admin → `admin-dashboard.html:1369 → js/events.js` |
| bulk events | 4 | WORKING×4 | imports; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:538 → src/modules/content/BulkEvents.jsx (/content/bulk-events)`<br>Admin-dashboard-main → `src/modules/registry.js:500 → src/modules/content/BulkEvents.jsx (/content/bulk-events)`<br>cybercheck-login → `admin.html:173`<br>gcr-admin → `admin.html:127` |

### Fleet / Paperclip / Agents

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| agents | 6 | WORKING×6 | OpenJarvis backend; Paperclip server /api/companies/*; adminApi | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:101 → src/modules/console/Agents.jsx (/agents)`<br>Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:7 → src/screens/Agents.jsx`<br>cyber-admin → `beachside-dashboard/index.html:91`<br>paperclip (fork, master) → `ui/src/components/Sidebar.tsx:243 (/agents)`<br>nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:59`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:59` |
| dashboard | 3 | WORKING×3 | OpenJarvis backend; Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:168 (/dashboard)`<br>nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:57`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:57` |
| settings | 3 | WORKING×3 | OpenJarvis backend; Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:268 (/company/settings)`<br>nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:61`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:61` |
| approvals | 2 | WORKING×1, API-only×1 | /api/b/:slug/approvals; adminApi | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:194 → src/modules/console/Approvals.jsx (/approvals)`<br>cybercheck-orchestrator → `src/http/server.js:69` |
| chat | 2 | WORKING×2 | OpenJarvis backend | nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:56`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:56` |
| data sources | 2 | WORKING×2 | OpenJarvis backend | nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:58`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:58` |
| get started | 2 | WORKING×2 | OpenJarvis backend | nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:62`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:62` |
| logs | 2 | WORKING×2 | OpenJarvis backend | nextgent-openjarvis → `frontend/src/components/Sidebar/Sidebar.tsx:60`<br>Open-jarvis → `frontend/src/components/Sidebar/Sidebar.tsx:60` |
| activity | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:267 (/activity)` |
| artifacts | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:204 (/artifacts)` |
| audit | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:246 (/activity)` |
| cases | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:206 (/cases)` |
| conference room | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:191 (/board-chat)` |
| connectors | 1 | WORKING×2 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:245 (/apps)`<br>paperclip (fork, master) → `ui/src/components/Sidebar.tsx:264 (/apps)` |
| costs | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:266 (/costs)` |
| executions | 1 | WORKING×1 | ghost | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:185 → src/modules/console/Executions.jsx (/executions)` |
| goals | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:212 (/goals)` |
| harness | 1 | API-only×1 | /api/b/:slug/harness | cybercheck-orchestrator → `src/http/server.js:245` |
| mcp | 1 | API-only×1 | /mcp/:slug | cybercheck-orchestrator → `src/http/server.js:167` |
| org | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:263 (/org)` |
| pipelines | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:209 (/pipelines)` |
| projects | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:199 (/projects)` |
| routines | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:203 (/routines)` |
| routing | 1 | API-only×1 | /api/b/:slug/routing | cybercheck-orchestrator → `src/http/server.js:241` |
| search | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:167 (/search)` |
| skills | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:244 (/skills)` |
| status | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:188 (/status)` |
| tasks | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:196 (/issues)` |
| timeline | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:265 (/timeline)` |
| tokens | 1 | API-only×1 | /api/b/:slug/tokens | cybercheck-orchestrator → `src/http/server.js:179` |
| workspaces | 1 | WORKING×1 | Paperclip server /api/companies/* | paperclip (fork, master) → `ui/src/components/Sidebar.tsx:221 (/workspaces)` |

### Ledger / Paper Trail / Audit

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| audit | 2 | STATIC×2 |  | cybercheck-login → `audit.html:1`<br>gcr-admin → `audit.html:1` |
| activity | 1 | WORKING×1 | paperclip activity,agents,receipts | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:12 → src/screens/Activity.jsx` |
| receipts | 1 | API-only×1 | /api/b/:slug/receipts | cybercheck-orchestrator → `src/http/server.js:85` |
| run log | 1 | WORKING×1 | automations | Admin-dashboard-main → `src/modules/registry.js:786 → src/modules/automations/Runs.jsx (/automations/runs)` |

### Link hub / bio / cards

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| pages | 4 | WORKING×5 | CC.createPage,CC.deletePage,CC.getPages,CC.updatePage; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:33 → js/pages.js`<br>cybercheck-login → `app-dashboard.html:35 → js/pages.js`<br>gcr-admin → `app-dashboard.html:35 → js/pages.js`<br>cyber-admin → `dashboard/index.html:33`<br>cyber-admin → `beachside-dashboard/index.html:33` |
| public | 3 | STATIC×2, MOCK/STUB×1 |  | cybercheck-login → `public.html:1`<br>gcr-admin → `public.html:1`<br>cyber-admin → `apps/biopage/public.html:1` |
| card | 2 | WORKING+mock-fallback×2 | /api/gcr/lead-notify | cybercheck-login → `card.html:1`<br>gcr-admin → `card.html:1` |
| card builder | 2 | MOCK/STUB×2 |  | cybercheck-login → `card-builder.html:1`<br>gcr-admin → `card-builder.html:1` |
| onboarding links | 2 | WORKING×2 | sb:installed_modules,sb:profiles | cybercheck-login → `onboarding-links.html:1`<br>gcr-admin → `onboarding-links.html:1` |
| page | 2 | WORKING×2 | https://gcr-api-clean.vercel.app/api/gcr; https://gcr-api.vercel.app/api/gcr | cybercheck-login → `page.html:1`<br>gcr-admin → `page.html:1` |
| contact | 1 | MOCK/STUB×1 |  | gcr-admin → `contact.html:1` |
| link page | 1 | API-only×1 | /l/:slug | cybercheck-orchestrator → `src/http/server.js:191` |
| linkspage | 1 | WORKING×1 | gcr-api-clean | gcr-unified → `src/pages/LinksPage.jsx:1` |
| live feed | 1 | WORKING×1 | gcr-api-clean | gcr-unified → `src/pages/LiveFeed.jsx:1` |
| public availability search | 1 | API-only×1 | /public/:slug/availability/search | cybercheck-orchestrator → `src/http/server.js:203` |
| public booking | 1 | MOCK/STUB×1 |  | cyber-admin → `apps/booking/public-booking.html:1` |
| public simple | 1 | MOCK/STUB×1 |  | cyber-admin → `apps/biopage/public-simple.html:1` |
| q | 1 | WORKING×1 | /api/qr/scan/ | cybercheck-login → `q.html:1` |
| route / | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/page.tsx:1` |
| route /u/ | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/u/[handle]/page.tsx:1` |
| route /u/[handle]/ | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/u/[handle]/[slug]/page.tsx:1` |

### Menu / QR / Specials

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| menu | 7 | WORKING×11 | /api/dashboard/ai/vision-providers,/api/dashboard/menu/extract,CC.compressImage,CC.createMenuItem,CC.deleteMen; drinks,happyHour,menu; gcr-api-clean /api/busine | Plat-admin → `src/modules/registry.js:106 → src/modules/menu/MenuBuilder.jsx (/menu/builder)`<br>Admin-dashboard-main → `src/modules/registry.js:68 → src/modules/menu/MenuBuilder.jsx (/menu/builder)`<br>Play-user → `src/sections/MenuSection.jsx (registry.jsx:3)`<br>Dashboards-users- → `src/sections/MenuSection.jsx (registry.jsx:3)`<br>admin-dashboard- → `src/sections/MenuSection.jsx (registry.jsx:3)`<br>cybercheck-login → `app-dashboard.html:46 → js/menu.js`<br>cybercheck-login → `admin.html:83`<br>cybercheck-login → `admin-dashboard.html:1369 → js/menu.js`<br>gcr-admin → `app-dashboard.html:46 → js/menu.js`<br>gcr-admin → `admin.html:53`<br>gcr-admin → `admin-dashboard.html:1365 → js/menu.js` |
| specials | 7 | WORKING×11 | /api/dashboard/events/extract,CC.compressImage,CC.createSpecial,CC.deleteSpecial,CC.getSpecials,CC.updateSpeci; gcr-api-clean /api/business/* (schema-discovered | Plat-admin → `src/modules/registry.js:475 → src/modules/content/Specials.jsx (/content/specials)`<br>Admin-dashboard-main → `src/modules/registry.js:437 → src/modules/content/Specials.jsx (/content/specials)`<br>Play-user → `src/sections/SpecialsSection.jsx (registry.jsx:6)`<br>Dashboards-users- → `src/sections/SpecialsSection.jsx (registry.jsx:6)`<br>admin-dashboard- → `src/sections/SpecialsSection.jsx (registry.jsx:6)`<br>cybercheck-login → `app-dashboard.html:54 → js/specials.js`<br>cybercheck-login → `admin.html:145`<br>cybercheck-login → `admin-dashboard.html:1372 → js/specials.js`<br>gcr-admin → `app-dashboard.html:54 → js/specials.js`<br>gcr-admin → `admin.html:107`<br>gcr-admin → `admin-dashboard.html:1368 → js/specials.js` |
| happy hour | 5 | WORKING×3, STATIC×2 | gcr-api-clean /api/business/* (schema-discovered tables); inline | Play-user → `src/sections/HappyHourSection.jsx (registry.jsx:4)`<br>Dashboards-users- → `src/sections/HappyHourSection.jsx (registry.jsx:4)`<br>admin-dashboard- → `src/sections/HappyHourSection.jsx (registry.jsx:4)`<br>cybercheck-login → `admin-dashboard.html:1371`<br>gcr-admin → `admin-dashboard.html:1367` |
| qr codes | 5 | WORKING×3, MOCK/STUB×2 | gcr-api-clean /api/business/* table artist_qr_codes; inline | Play-user → `src/lib/artistModule.js:31`<br>Dashboards-users- → `src/lib/artistModule.js:31`<br>admin-dashboard- → `src/lib/artistModule.js:31`<br>cybercheck-login → `app-dashboard.html:50 → js/qr-codes.js`<br>gcr-admin → `app-dashboard.html:50 → js/qr-codes.js` |
| daily sms links | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; updateLinks | Plat-admin → `src/modules/registry.js:151 → src/modules/menu/DailyUpdateLinks.jsx (/menu/daily-update-links)`<br>Admin-dashboard-main → `src/modules/registry.js:113 → src/modules/menu/DailyUpdateLinks.jsx (/menu/daily-update-links)`<br>cybercheck-login → `admin.html:103`<br>gcr-admin → `admin.html:73` |
| qr menus | 4 | WORKING×4, WORKING+mock-fallback×1 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; menu | Plat-admin → `src/modules/registry.js:115 → src/modules/menu/QrMenus.jsx (/menu/qr-menus)`<br>Admin-dashboard-main → `src/modules/registry.js:77 → src/modules/menu/QrMenus.jsx (/menu/qr-menus)`<br>cybercheck-login → `admin.html:87`<br>gcr-admin → `admin.html:57`<br>gcr-admin → `qr-menu.html:1` |
| qr tracker | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; qr,qrCodesResource,qrLocationsResource | Plat-admin → `src/modules/registry.js:124 → src/modules/menu/QrTracker.jsx (/menu/qr-tracker)`<br>Admin-dashboard-main → `src/modules/registry.js:86 → src/modules/menu/QrTracker.jsx (/menu/qr-tracker)`<br>cybercheck-login → `admin.html:91`<br>gcr-admin → `admin.html:61` |
| menu editors hub | 3 | WORKING×3 | inline JS in admin.html → API_BASE gcr-api-clean; menu | Plat-admin → `src/modules/registry.js:160 → src/modules/menu/MenuEditorsHub.jsx (/menu/editors-hub)`<br>Admin-dashboard-main → `src/modules/registry.js:122 → src/modules/menu/MenuEditorsHub.jsx (/menu/editors-hub)`<br>cybercheck-login → `admin.html:107` |
| drinks | 2 | STATIC×2 | inline | cybercheck-login → `admin-dashboard.html:1370`<br>gcr-admin → `admin-dashboard.html:1366` |
| menu editor | 2 | WORKING+mock-fallback×5 | /api/menu-editor/ | cybercheck-login → `menu-editor-dark.html:1`<br>cybercheck-login → `menu-editor-popup.html:1`<br>cybercheck-login → `menu-editor.html:1`<br>gcr-admin → `menu-editor-dark.html:1`<br>gcr-admin → `menu-editor.html:1` |
| menu setup | 2 | WORKING+mock-fallback×2 |  | cybercheck-login → `menu-setup.html:1`<br>gcr-admin → `menu-setup.html:1` |
| menu update | 2 | MOCK/STUB×2, WORKING+mock-fallback×1 | https://gcr-api-clean.vercel.app/api/gcr | cybercheck-login → `menu-update.html:1`<br>cybercheck-login → `menu-updates.html:1`<br>gcr-admin → `menu-updates.html:1` |
| restaurant dashboard | 2 | MOCK/STUB×2 |  | cybercheck-login → `dashboard-restaurant.html:1`<br>gcr-admin → `dashboard-restaurant.html:1` |
| restaurant editor | 2 | WORKING+mock-fallback×2 |  | cybercheck-login → `restaurant-editor.html:1`<br>gcr-admin → `restaurant-editor.html:1` |
| core menu | 1 | WORKING×1 | adminApi | Plat-admin → `src/modules/registry.js:57 → src/modules/nextgent/CoreMenu.jsx (/menu)` |
| menu app route / | 1 | WORKING×1 | apps/menu/app/api/ai/generate-theme, /api/upload | Boxes → `apps/menu/app/page.tsx` |
| menu app route /admin/qr menus | 1 | WORKING×1 | apps/menu/app/api/ai/generate-theme, /api/upload | Boxes → `apps/menu/app/admin/qr-menus/page.tsx` |
| menu app route /edit/ | 1 | WORKING×1 | apps/menu/app/api/ai/generate-theme, /api/upload | Boxes → `apps/menu/app/edit/[slug]/page.tsx` |
| menu app route /editor | 1 | WORKING×1 | apps/menu/app/api/ai/generate-theme, /api/upload | Boxes → `apps/menu/app/editor/page.tsx` |
| menu app route /menu/ | 1 | WORKING×1 | apps/menu/app/api/ai/generate-theme, /api/upload | Boxes → `apps/menu/app/menu/[id]/page.tsx` |
| menu app route /menus | 1 | WORKING×1 | apps/menu/app/api/ai/generate-theme, /api/upload | Boxes → `apps/menu/app/menus/page.tsx` |

### Messaging / Marketing / Social

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| coupons | 6 | WORKING×6, WORKING+mock-fallback×3 | /api/dashboard/sms/campaign,/api/dashboard/sms/campaigns,CC.createCoupon,CC.deleteCoupon,CC.getCoupons,CC.upda; couponsResource; inline JS in admin.html → API_B | Plat-admin → `src/modules/registry.js:511 → src/modules/content/Coupons.jsx (/content/coupons)`<br>Admin-dashboard-main → `src/modules/registry.js:473 → src/modules/content/Coupons.jsx (/content/coupons)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:80 → js/coupons.js`<br>cybercheck-login → `app-dashboard.html:134 → js/coupons.js`<br>cybercheck-login → `admin.html:161`<br>gcr-admin → `app-dashboard.html:118 → js/coupons.js`<br>gcr-admin → `admin.html:115`<br>cyber-admin → `dashboard/index.html:99`<br>cyber-admin → `beachside-dashboard/index.html:80` |
| messaging | 6 | WORKING×4, WORKING+mock-fallback×3, PARTIAL×2 | /api/dashboard/messaging-settings; /api/whatsapp/send,CC.getMessaging,CC.updateMessaging; inline JS in admin.html → API_BASE gcr-api-clean | Plat-admin → `src/modules/registry.js:614 → src/modules/engagement/Messaging.jsx (/engagement/messaging)`<br>Admin-dashboard-main → `src/modules/registry.js:576 → src/modules/engagement/Messaging.jsx (/engagement/messaging)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:87 → js/messaging.js`<br>cybercheck-login → `app-dashboard.html:141 → js/messaging.js`<br>cybercheck-login → `admin.html:211`<br>gcr-admin → `app-dashboard.html:125 → js/messaging.js`<br>gcr-admin → `admin.html:165`<br>cyber-admin → `dashboard/index.html:106`<br>cyber-admin → `beachside-dashboard/index.html:87` |
| social | 6 | WORKING×9 | CC.createSocialPost,CC.deleteSocialPost,CC.disconnectSocialAccount,CC.getSocialMedia,CC.updateSocialPost; inline JS in admin.html → API_BASE gcr-api-clean; inli | Plat-admin → `src/modules/registry.js:624 → src/modules/engagement/Social.jsx (/engagement/social)`<br>Admin-dashboard-main → `src/modules/registry.js:586 → src/modules/engagement/Social.jsx (/engagement/social)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:109 → js/social.js`<br>cybercheck-login → `app-dashboard.html:163 → js/social.js`<br>cybercheck-login → `admin.html:215`<br>gcr-admin → `app-dashboard.html:147 → js/social.js`<br>gcr-admin → `admin.html:169`<br>cyber-admin → `dashboard/index.html:128`<br>cyber-admin → `beachside-dashboard/index.html:113` |
| ad network | 4 | WORKING×4 | adsResource; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:484 → src/modules/content/Ads.jsx (/content/ads)`<br>Admin-dashboard-main → `src/modules/registry.js:446 → src/modules/content/Ads.jsx (/content/ads)`<br>cybercheck-login → `admin.html:149`<br>gcr-admin → `admin.html:111` |
| bulk upload | 4 | WORKING×4, STATIC×2 | imports; inline; inline JS in admin.html → API_BASE gcr-api-clean | Plat-admin → `src/modules/registry.js:529 → src/modules/content/BulkUpload.jsx (/content/bulk-upload)`<br>Admin-dashboard-main → `src/modules/registry.js:491 → src/modules/content/BulkUpload.jsx (/content/bulk-upload)`<br>cybercheck-login → `admin.html:169`<br>cybercheck-login → `admin-dashboard.html:1374`<br>gcr-admin → `admin.html:123`<br>gcr-admin → `admin-dashboard.html:1370` |
| leads | 4 | WORKING×2, MOCK/STUB×2 | inline; salesLeadsResource | Plat-admin → `src/modules/registry.js:860 → src/modules/platform/Leads.jsx (/platform/leads)`<br>Admin-dashboard-main → `src/modules/registry.js:892 → src/modules/platform/Leads.jsx (/platform/leads)`<br>cybercheck-login → `admin.html:306 → js/leads.js`<br>gcr-admin → `admin.html:252 → js/leads.js` |
| referral partners | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; qr,qrPartnersResource | Plat-admin → `src/modules/registry.js:142 → src/modules/menu/ReferralPartners.jsx (/menu/referral-partners)`<br>Admin-dashboard-main → `src/modules/registry.js:104 → src/modules/menu/ReferralPartners.jsx (/menu/referral-partners)`<br>cybercheck-login → `admin.html:99`<br>gcr-admin → `admin.html:69` |
| page rails | 3 | WORKING×3 | inline JS in admin.html → API_BASE gcr-api-clean; rails | Plat-admin → `src/modules/registry.js:493 → src/modules/content/Rails.jsx (/content/rails)`<br>Admin-dashboard-main → `src/modules/registry.js:455 → src/modules/content/Rails.jsx (/content/rails)`<br>cybercheck-login → `admin.html:153` |
| customer phones | 1 | WORKING+mock-fallback×1 | /api/admin/businesses,/api/admin/businesses/,/api/customer/calls | cyber-admin → `admin/admin-customer-phones.html:1` |
| messages | 1 | WORKING×1 | business messages; paperclip store | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:10 → src/screens/Messages.jsx` |

### Onboarding / Setup

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| onboarding | 3 | WORKING+mock-fallback×2, WORKING×1 | /api/apps,/api/apps/install,/api/site/content | Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/screens/Onboarding.jsx`<br>cybercheck-login → `onboarding.html:1`<br>gcr-admin → `onboarding.html:1` |
| all sections | 2 | WORKING×2 | js | Plat-admin → `src/modules/registry.js:94 → src/modules/home/Sections.jsx (/sections)`<br>Admin-dashboard-main → `src/modules/registry.js:56 → src/modules/home/Sections.jsx (/sections)` |
| intake | 2 | WORKING×2 | intake | Plat-admin → `src/modules/registry.js:217 → src/modules/platform/Intake.jsx (/platform/intake)`<br>Admin-dashboard-main → `src/modules/registry.js:179 → src/modules/platform/Intake.jsx (/platform/intake)` |
| add what you're renting or offering | 1 | WORKING×1 | API_BASE + path (onboarding.html:731) | cybercheck-saas → `public/onboarding.html:319` |
| biz | 1 | WORKING×1 | /api/platform/page/ | cybercheck-login → `biz.html:1` |
| connect your payment account | 1 | WORKING×1 | API_BASE + path (onboarding.html:731) | cybercheck-saas → `public/onboarding.html:336` |
| design your booking page | 1 | WORKING×1 | API_BASE + path (onboarding.html:731) | cybercheck-saas → `public/onboarding.html:360` |
| setup | 1 | WORKING×1 | gcr-api-clean | gcr-unified → `src/pages/Setup.jsx:1` |
| tell us about your business | 1 | WORKING×1 | API_BASE + path (onboarding.html:731) | cybercheck-saas → `public/onboarding.html:261` |
| what kind of business are you? | 1 | WORKING×1 | API_BASE + path (onboarding.html:731) | cybercheck-saas → `public/onboarding.html:215` |
| you're ready to go live! | 1 | WORKING×1 | API_BASE + path (onboarding.html:731) | cybercheck-saas → `public/onboarding.html:375` |

### Payments & billing

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| billing | 4 | MOCK/STUB×3, WORKING×2, STATIC×1 | CC_API_BASE (default localhost:3000); inline; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:116 → js/billing.js`<br>cybercheck-login → `app-dashboard.html:181 → js/billing.js`<br>gcr-admin → `app-dashboard.html:165 → js/billing.js`<br>gcr-admin → `billing.html:1`<br>cyber-admin → `dashboard/index.html:135`<br>cyber-admin → `beachside-dashboard/index.html:120` |
| Payment confirmations / verification | 3 | WORKING×3 | gcr-api-clean /api/business/* table payment_confirmations | Play-user → `src/lib/artistModule.js:32`<br>Dashboards-users- → `src/lib/artistModule.js:32`<br>admin-dashboard- → `src/lib/artistModule.js:32` |
| enter stripe key | 2 | WORKING+mock-fallback×2 |  | cybercheck-login → `enter-stripe-key.html:1`<br>gcr-admin → `enter-stripe-key.html:1` |
| earnings | 1 | WORKING×1 | supabase (inline) / dashboard/js | cyber-admin → `dashboard/index.html:84` |

### People / CRM / Accounts & auth

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| login | 7 | WORKING×4, WORKING+mock-fallback×4, MOCK/STUB×1 | /api/auth/create-profile; /api/auth/create-profile,https://gcr-api-clean.vercel.app/api/admin/login; API_BASE /auth/*, /public/booking | Play-user → `src/pages/Login.jsx:1 (App.jsx:3)`<br>Dashboards-users- → `src/pages/Login.jsx:1 (App.jsx:3)`<br>admin-dashboard- → `src/pages/Login.jsx:1 (App.jsx:3)`<br>cybercheck-login → `login.html:1`<br>gcr-admin → `login.html:1`<br>cyber-admin → `admin/admin-login.html:1`<br>cyber-admin → `beachside-dashboard/login.html:1`<br>cyber-admin → `dashboard/login.html:1`<br>cybercheck-saas → `public/login.html:1` |
| signup | 7 | WORKING×5, MOCK/STUB×2 | API_BASE /auth/*, /public/booking; VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr; signups | Plat-admin → `src/modules/registry.js:268 → src/modules/platform/Signups.jsx (/directory/signups)`<br>Admin-dashboard-main → `src/modules/registry.js:230 → src/modules/platform/Signups.jsx (/directory/signups)`<br>Play-user → `src/pages/SignUp.jsx:1 (App.jsx:4)`<br>Dashboards-users- → `src/pages/SignUp.jsx:1 (App.jsx:8)`<br>cybercheck-login → `signup.html:1`<br>gcr-admin → `signup.html:1`<br>cybercheck-saas → `public/signup.html:1` |
| customers | 6 | WORKING×8, WORKING+mock-fallback×3 | /api/dashboard/contacts/scan-card,CC.createCustomer,CC.getCustomers,CC.getToken,CC.updateCustomer; CC.createCustomer,CC.getCustomers; customersResource | Plat-admin → `src/modules/registry.js:605 → src/modules/engagement/Customers.jsx (/engagement/customers)`<br>Admin-dashboard-main → `src/modules/registry.js:567 → src/modules/engagement/Customers.jsx (/engagement/customers)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:76 → js/customers.js`<br>cybercheck-login → `app-dashboard.html:130 → js/customers.js`<br>cybercheck-login → `admin.html:207`<br>gcr-admin → `app-dashboard.html:114 → js/customers.js`<br>gcr-admin → `admin.html:161`<br>cyber-admin → `dashboard/index.html:95`<br>cyber-admin → `beachside-dashboard/index.html:76`<br>cyber-admin → `dashboard-booking/index.html:57`<br>cyber-admin → `dashboard-circleboat/index.html:49` |
| claim | 4 | WORKING×3, WORKING+mock-fallback×1 | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | Play-user → `src/pages/Claim.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/Claim.jsx:1 (App.jsx:4)`<br>admin-dashboard- → `src/pages/Claim.jsx:1 (App.jsx:4)`<br>cybercheck-login → `claim-business.html:1` |
| claims | 4 | WORKING×4 | claims; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:255 → src/modules/directory/Claims.jsx (/directory/claims)`<br>Admin-dashboard-main → `src/modules/registry.js:217 → src/modules/directory/Claims.jsx (/directory/claims)`<br>cybercheck-login → `admin.html:126`<br>gcr-admin → `admin.html:96` |
| staff/team | 4 | WORKING+mock-fallback×3, WORKING×3, MOCK/STUB×2 | CC.createStaff,CC.deleteStaff,CC.getStaff,CC.updateStaff; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:37 → js/staff.js`<br>cybercheck-login → `app-dashboard.html:39 → js/staff.js`<br>gcr-admin → `app-dashboard.html:39 → js/staff.js`<br>cyber-admin → `beachside-dashboard/tabs/business-details/team-editor.html:1`<br>cyber-admin → `dashboard/tabs/business-details/team-editor.html:1`<br>cyber-admin → `dashboard/index.html:37`<br>cyber-admin → `beachside-dashboard/index.html:37`<br>cyber-admin → `dashboard-booking/index.html:75` |
| users | 4 | WORKING×5 | adminApi; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:75 → src/modules/nextgent/Users.jsx (/users)`<br>Plat-admin → `src/modules/registry.js:916 → src/modules/platform/Users.jsx (/platform/users)`<br>Admin-dashboard-main → `src/modules/registry.js:948 → src/modules/platform/Users.jsx (/platform/users)`<br>cybercheck-login → `admin.html:326`<br>gcr-admin → `admin.html:272` |
| business picker | 3 | WORKING×3 | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | Play-user → `src/pages/BusinessPicker.jsx:1 (App.jsx:6)`<br>Dashboards-users- → `src/pages/BusinessPicker.jsx:1 (App.jsx:6)`<br>admin-dashboard- → `src/pages/BusinessPicker.jsx:1 (App.jsx:6)` |
| accept invite | 2 | WORKING×2 | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | Play-user → `src/pages/AcceptInvite.jsx:1 (App.jsx:-)`<br>Dashboards-users- → `src/pages/AcceptInvite.jsx:1 (App.jsx:7)` |
| people | 2 | WORKING×2 | auth,businesses,claims,customers,tourists | Plat-admin → `src/modules/registry.js:906 → src/modules/platform/People.jsx (/platform/people)`<br>Admin-dashboard-main → `src/modules/registry.js:938 → src/modules/platform/People.jsx (/platform/people)` |
| & owner accounts | 1 | WORKING×1 | usersResource | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:1061 → src/modules/platform/Users.jsx (/platform/users)` |
| business accounts | 1 | WORKING×1 | businesses | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:996 → src/modules/platform/Businesses.jsx (/platform/businesses)` |
| crm | 1 | WORKING+mock-fallback×1 | /api/crm/fields,/api/crm/fields/,/api/crm/fields/all,/api/crm/mappings,/api/crm/mappings/,/api/crm/sections,/a | cyber-admin → `admin/admin-crm.html:1` |
| forgot password | 1 | WORKING×1 | API_BASE /auth/*, /public/booking | cybercheck-saas → `public/forgot-password.html:1` |
| route /login | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/login/page.tsx:1` |
| route /signup | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/signup/page.tsx:1` |

### Reviews

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| reviews | 9 | WORKING×11, WORKING+mock-fallback×5, MOCK/STUB×2 | /api/dashboard/google-business/status,/api/dashboard/google-business/sync-reviews,CC.createReviewQuestion,CC.c; CC.getReviews,CC.updateReview; entityReviewsReso | Plat-admin → `src/modules/registry.js:133 → src/modules/menu/Reviews.jsx (/menu/reviews)`<br>Plat-admin → `src/modules/registry.js:596 → src/modules/engagement/GcrReviews.jsx (/engagement/reviews)`<br>Admin-dashboard-main → `src/modules/registry.js:95 → src/modules/menu/Reviews.jsx (/menu/reviews)`<br>Admin-dashboard-main → `src/modules/registry.js:558 → src/modules/engagement/GcrReviews.jsx (/engagement/reviews)`<br>Play-user → `src/sections/ReviewsSection.jsx (registry.jsx:7)`<br>Dashboards-users- → `src/sections/ReviewsSection.jsx (registry.jsx:7)`<br>admin-dashboard- → `src/sections/ReviewsSection.jsx (registry.jsx:7)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:94 → js/reviews.js`<br>cybercheck-login → `app-dashboard.html:148 → js/reviews.js`<br>cybercheck-login → `admin.html:95 → js/reviews.js`<br>cybercheck-login → `admin.html:203`<br>gcr-admin → `app-dashboard.html:132 → js/reviews.js`<br>gcr-admin → `admin.html:65 → js/reviews.js`<br>gcr-admin → `admin.html:157`<br>cybercheck-login → `reviews.html:1`<br>gcr-admin → `reviews.html:1`<br>cyber-admin → `dashboard/index.html:113`<br>cyber-admin → `beachside-dashboard/index.html:98` |

### Settings / System / Misc

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| settings | 7 | WORKING×6, MOCK/STUB×3, WORKING+mock-fallback×1 | /api/dashboard/domain; auth; gcr-api-clean | Plat-admin → `src/modules/registry.js:935 → src/modules/platform/Settings.jsx (/platform/settings)`<br>Admin-dashboard-main → `src/modules/registry.js:967 → src/modules/platform/Settings.jsx (/platform/settings)`<br>Play-user@claude/agent-ecosystem-architecture-nzexu1 → `src/app/nav.js:13 → src/screens/Settings.jsx`<br>Dashboards-users-@claude/new-session-66c2e9 → `src/pages/Settings.jsx:1`<br>cybercheck-login → `admin.html:334`<br>gcr-admin → `admin.html:280`<br>cybercheck-login → `settings.html:1`<br>gcr-admin → `settings.html:1`<br>cyber-admin → `beachside-dashboard/tabs/settings.html:1`<br>cyber-admin → `dashboard/tabs/settings.html:1` |
| index | 4 | MOCK/STUB×9, STATIC×6, WORKING+mock-fallback×6, WORKING×1 | /api/dashboard/loyalty/members,/api/dashboard/loyalty/stats; /api/taxi; API_BASE /auth/*, /public/booking | cybercheck-login → `index.html:1`<br>gcr-admin → `index.html:1`<br>cyber-admin → `admin/index.html:1`<br>cyber-admin → `apps/ai-training/index.html:1`<br>cyber-admin → `apps/analytics/index.html:1`<br>cyber-admin → `apps/biopage/index.html:1`<br>cyber-admin → `apps/booking/index.html:1`<br>cyber-admin → `apps/loyalty/index.html:1`<br>cyber-admin → `apps/menu/index.html:1`<br>cyber-admin → `apps/ordering/index.html:1`<br>cyber-admin → `apps/referrals/index.html:1`<br>cyber-admin → `apps/sms-automation/index.html:1`<br>cyber-admin → `apps/sms/index.html:1`<br>cyber-admin → `apps/social/index.html:1`<br>cyber-admin → `beachside-dashboard/index.html:1`<br>cyber-admin → `beachside-dashboard/tabs/business-details/index.html:1`<br>cyber-admin → `dashboard-booking/index.html:1`<br>cyber-admin → `dashboard-circleboat/index.html:1`<br>cyber-admin → `dashboard-taxi/index.html:1`<br>cyber-admin → `dashboard/index.html:1`<br>cyber-admin → `dashboard/tabs/business-details/index.html:1`<br>cybercheck-saas → `site-template/index.html:1` |
| demo | 2 | MOCK/STUB×2 |  | cybercheck-login → `demo.html:1`<br>gcr-admin → `demo.html:1` |
| navigation demo | 2 | STATIC×2 |  | cybercheck-login → `navigation-demo.html:1`<br>gcr-admin → `navigation-demo.html:1` |
| platform | 2 | STATIC×2 |  | cybercheck-login → `platform.html:1`<br>gcr-admin → `platform.html:1` |
| sql setup | 2 | WORKING×2 | supabase | cybercheck-login → `sql-setup.html:1`<br>gcr-admin → `sql-setup.html:1` |
| changelog | 1 | MOCK/STUB×1 |  | gcr-admin → `changelog.html:1` |
| help center | 1 | MOCK/STUB×1 |  | gcr-admin → `help-center.html:1` |
| hub | 1 | MOCK/STUB×1 |  | cyber-admin → `admin/admin-hub.html:1` |
| manage | 1 | WORKING×1 | /api/platform/manage/,/api/platform/page/ | cybercheck-login → `manage.html:1` |
| panel | 1 | WORKING+mock-fallback×1 | /api/admin/api-keys,/api/admin/test-connection/,/api/admin/verify | cyber-admin → `admin/admin-panel.html:1` |
| privacy | 1 | STATIC×1 |  | gcr-admin → `privacy.html:1` |
| sandbox deploy | 1 | MOCK/STUB×1 |  | gcr-admin → `sandbox-deploy.html:1` |
| sandbox editor | 1 | MOCK/STUB×1 |  | gcr-admin → `sandbox-editor.html:1` |
| sandbox projects | 1 | STATIC×1 |  | gcr-admin → `sandbox-projects.html:1` |
| system | 1 | WORKING×1 | adminApi,settings | Plat-admin@claude/agent-ecosystem-architecture-nzexu1 → `src/modules/registry.js:221 → src/modules/console/System.jsx (/system)` |
| terms | 1 | STATIC×1 |  | gcr-admin → `terms.html:1` |

### Trip Swipe / Consumer engagement

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| ai feedback | 4 | WORKING×4 | ai,analytics; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:671 → src/modules/tripswipe/AiFeedback.jsx (/tripswipe/ai)`<br>Admin-dashboard-main → `src/modules/registry.js:633 → src/modules/tripswipe/AiFeedback.jsx (/tripswipe/ai)`<br>cybercheck-login → `admin.html:238`<br>gcr-admin → `admin.html:192` |
| ar hunts | 4 | WORKING×4 | arHunts,arHuntsResource; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:887 → src/modules/platform/ArHunts.jsx (/platform/ar-hunts)`<br>Admin-dashboard-main → `src/modules/registry.js:919 → src/modules/platform/ArHunts.jsx (/platform/ar-hunts)`<br>cybercheck-login → `admin.html:318`<br>gcr-admin → `admin.html:264` |
| auth settings | 4 | PARTIAL×2, WORKING×2 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; settings,settingsKeys | Plat-admin → `src/modules/registry.js:735 → src/modules/tripswipe/AuthSettings.jsx (/tripswipe/auth-settings)`<br>Admin-dashboard-main → `src/modules/registry.js:697 → src/modules/tripswipe/AuthSettings.jsx (/tripswipe/auth-settings)`<br>cybercheck-login → `admin.html:266`<br>gcr-admin → `admin.html:212` |
| business leads | 4 | PARTIAL×2, WORKING×2 | businessLeadsResource; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:773 → src/modules/tripswipe/BusinessLeads.jsx (/tripswipe/business-leads)`<br>Admin-dashboard-main → `src/modules/registry.js:735 → src/modules/tripswipe/BusinessLeads.jsx (/tripswipe/business-leads)`<br>cybercheck-login → `admin.html:282`<br>gcr-admin → `admin.html:228` |
| button config | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; tripswipe | Plat-admin → `src/modules/registry.js:745 → src/modules/tripswipe/ButtonConfig.jsx (/tripswipe/button)`<br>Admin-dashboard-main → `src/modules/registry.js:707 → src/modules/tripswipe/ButtonConfig.jsx (/tripswipe/button)`<br>cybercheck-login → `admin.html:270`<br>gcr-admin → `admin.html:216` |
| community photos | 4 | PARTIAL×2, WORKING×2 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; photos | Plat-admin → `src/modules/registry.js:783 → src/modules/tripswipe/CommunityPhotos.jsx (/tripswipe/community-photos)`<br>Admin-dashboard-main → `src/modules/registry.js:745 → src/modules/tripswipe/CommunityPhotos.jsx (/tripswipe/community-photos)`<br>cybercheck-login → `admin.html:286`<br>gcr-admin → `admin.html:232` |
| concierge test | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; tourists,tripswipe | Plat-admin → `src/modules/registry.js:680 → src/modules/tripswipe/ConciergeTest.jsx (/tripswipe/concierge-test)`<br>Admin-dashboard-main → `src/modules/registry.js:642 → src/modules/tripswipe/ConciergeTest.jsx (/tripswipe/concierge-test)`<br>cybercheck-login → `admin.html:242`<br>gcr-admin → `admin.html:196` |
| sms blasts | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; sms | Plat-admin → `src/modules/registry.js:764 → src/modules/tripswipe/SmsBlasts.jsx (/tripswipe/sms-blasts)`<br>Admin-dashboard-main → `src/modules/registry.js:726 → src/modules/tripswipe/SmsBlasts.jsx (/tripswipe/sms-blasts)`<br>cybercheck-login → `admin.html:278`<br>gcr-admin → `admin.html:224` |
| sms settings | 4 | PARTIAL×2, WORKING×2 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; settings,settingsKeys | Plat-admin → `src/modules/registry.js:754 → src/modules/tripswipe/SmsSettings.jsx (/tripswipe/sms-settings)`<br>Admin-dashboard-main → `src/modules/registry.js:716 → src/modules/tripswipe/SmsSettings.jsx (/tripswipe/sms-settings)`<br>cybercheck-login → `admin.html:274`<br>gcr-admin → `admin.html:220` |
| sponsored | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; sponsoredResource | Plat-admin → `src/modules/registry.js:698 → src/modules/tripswipe/Sponsored.jsx (/tripswipe/sponsored)`<br>Admin-dashboard-main → `src/modules/registry.js:660 → src/modules/tripswipe/Sponsored.jsx (/tripswipe/sponsored)`<br>cybercheck-login → `admin.html:250`<br>gcr-admin → `admin.html:204` |
| swipe analytics | 4 | WORKING×4 | analytics; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:662 → src/modules/tripswipe/Analytics.jsx (/tripswipe/analytics)`<br>Admin-dashboard-main → `src/modules/registry.js:624 → src/modules/tripswipe/Analytics.jsx (/tripswipe/analytics)`<br>cybercheck-login → `admin.html:234`<br>gcr-admin → `admin.html:188` |
| swipe questions | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; setupQuestionsResource | Plat-admin → `src/modules/registry.js:689 → src/modules/tripswipe/SwipeQuestions.jsx (/tripswipe/questions)`<br>Admin-dashboard-main → `src/modules/registry.js:651 → src/modules/tripswipe/SwipeQuestions.jsx (/tripswipe/questions)`<br>cybercheck-login → `admin.html:246`<br>gcr-admin → `admin.html:200` |
| tonight cards | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; promoCardsResource | Plat-admin → `src/modules/registry.js:707 → src/modules/tripswipe/TonightCards.jsx (/tripswipe/tonight)`<br>Admin-dashboard-main → `src/modules/registry.js:669 → src/modules/tripswipe/TonightCards.jsx (/tripswipe/tonight)`<br>cybercheck-login → `admin.html:254`<br>gcr-admin → `admin.html:208` |
| tourists | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; tourists | Plat-admin → `src/modules/registry.js:653 → src/modules/tripswipe/Tourists.jsx (/tripswipe/tourists)`<br>Admin-dashboard-main → `src/modules/registry.js:615 → src/modules/tripswipe/Tourists.jsx (/tripswipe/tourists)`<br>cybercheck-login → `admin.html:230`<br>gcr-admin → `admin.html:184` |
| trip swipe businesses | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; tripswipe | Plat-admin → `src/modules/registry.js:644 → src/modules/tripswipe/Businesses.jsx (/tripswipe/businesses)`<br>Admin-dashboard-main → `src/modules/registry.js:606 → src/modules/tripswipe/Businesses.jsx (/tripswipe/businesses)`<br>cybercheck-login → `admin.html:226`<br>gcr-admin → `admin.html:180` |
| trip swipe overview | 4 | WORKING×4 | inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh; tourists,tripswipe | Plat-admin → `src/modules/registry.js:635 → src/modules/tripswipe/Overview.jsx (/tripswipe)`<br>Admin-dashboard-main → `src/modules/registry.js:597 → src/modules/tripswipe/Overview.jsx (/tripswipe)`<br>cybercheck-login → `admin.html:222`<br>gcr-admin → `admin.html:176` |
| points & rewards | 3 | PARTIAL×2, WORKING×1 | inline JS in admin.html → API_BASE gcr-api-clean; settings,settingsKeys | Plat-admin → `src/modules/registry.js:716 → src/modules/tripswipe/Points.jsx (/tripswipe/points)`<br>Admin-dashboard-main → `src/modules/registry.js:678 → src/modules/tripswipe/Points.jsx (/tripswipe/points)`<br>cybercheck-login → `admin.html:258` |
| text sign up qr codes | 3 | WORKING×3 | inline JS in admin.html → API_BASE gcr-api-clean; sms,smsQrResource | Plat-admin → `src/modules/registry.js:726 → src/modules/tripswipe/SmsQr.jsx (/tripswipe/sms-qr)`<br>Admin-dashboard-main → `src/modules/registry.js:688 → src/modules/tripswipe/SmsQr.jsx (/tripswipe/sms-qr)`<br>cybercheck-login → `admin.html:262` |
| trip concierge dashboard | 1 | WORKING+mock-fallback×1 |  | cyber-admin → `trip-concierge-dashboard.html:1` |

### Website / Site builder / Publish

| Module | # repos | Status mix | Backend/API | Where (repo → file:line) |
|---|---:|---|---|---|
| seo | 6 | WORKING×7, STATIC×2, WORKING+mock-fallback×1 | /api/tags,/api/tags/; CC.createSEOPage,CC.generateSitemap,CC.getSEO,CC.getTrackingSettings,CC.updateRobotsTxt,CC.updateSEOPage,CC.up; CC.createSEOPage,CC.genera | Plat-admin → `src/modules/registry.js:520 → src/modules/content/Seo.jsx (/content/seo)`<br>Admin-dashboard-main → `src/modules/registry.js:482 → src/modules/content/Seo.jsx (/content/seo)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:105 → js/seo.js`<br>cybercheck-login → `app-dashboard.html:159 → js/seo.js`<br>cybercheck-login → `admin.html:165`<br>gcr-admin → `app-dashboard.html:143 → js/seo.js`<br>gcr-admin → `admin.html:119`<br>cyber-admin → `admin/admin-tags-manager.html:1`<br>cyber-admin → `dashboard/index.html:124`<br>cyber-admin → `beachside-dashboard/index.html:109` |
| site editor | 6 | WORKING×6, PARTIAL×2, WORKING+mock-fallback×2, MOCK/STUB×1 | /api/site-data; CC_API_BASE (default localhost:3000); categoryCards,categoryCardsResource,settings,settingsKeys | Plat-admin → `src/modules/registry.js:245 → src/modules/directory/SiteEditor.jsx (/directory/site-editor)`<br>Admin-dashboard-main → `src/modules/registry.js:207 → src/modules/directory/SiteEditor.jsx (/directory/site-editor)`<br>cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:128 → js/site-editor.js`<br>cybercheck-login → `app-dashboard.html:197 → js/site-editor.js`<br>cybercheck-login → `admin.html:122`<br>gcr-admin → `app-dashboard.html:181 → js/site-editor.js`<br>gcr-admin → `admin.html:92`<br>cyber-admin → `dashboard/index.html:151`<br>cyber-admin → `beachside-dashboard/index.html:136`<br>cyber-admin → `dashboard-booking/index.html:97`<br>cyber-admin → `dashboard-circleboat/index.html:75` |
| domain | 4 | WORKING+mock-fallback×3, WORKING×2 | /api/verify-dns,CC.getDomain,CC.updateDomain; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:132 → js/domain.js`<br>cybercheck-login → `app-dashboard.html:201 → js/domain.js`<br>gcr-admin → `app-dashboard.html:185 → js/domain.js`<br>cyber-admin → `dashboard/index.html:155`<br>cyber-admin → `beachside-dashboard/index.html:140` |
| publish | 4 | WORKING×7 | CC.publish; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:136 → js/publish.js`<br>cybercheck-login → `app-dashboard.html:205 → js/publish.js`<br>gcr-admin → `app-dashboard.html:189 → js/publish.js`<br>cyber-admin → `dashboard/index.html:159`<br>cyber-admin → `beachside-dashboard/index.html:152`<br>cyber-admin → `dashboard-booking/index.html:101`<br>cyber-admin → `dashboard-circleboat/index.html:79` |
| sales pages | 4 | WORKING×4 | businesses; inline JS in admin.html → API_BASE gcr-api-clean; inline JS in admin.html → API_BASE gcr-api-clean-fresh | Plat-admin → `src/modules/registry.js:878 → src/modules/platform/SalesPages.jsx (/platform/sales-pages)`<br>Admin-dashboard-main → `src/modules/registry.js:910 → src/modules/platform/SalesPages.jsx (/platform/sales-pages)`<br>cybercheck-login → `admin.html:314`<br>gcr-admin → `admin.html:260` |
| theme | 4 | WORKING×7 | CC.getTheme,CC.updateTheme; supabase (inline) / dashboard/js | cybercheck-dashboard → `cybercheck-dashboard-platform/index.html:120 → js/theme.js`<br>cybercheck-login → `app-dashboard.html:185 → js/theme.js`<br>gcr-admin → `app-dashboard.html:169 → js/theme.js`<br>cyber-admin → `dashboard/index.html:139`<br>cyber-admin → `beachside-dashboard/index.html:124`<br>cyber-admin → `dashboard-booking/index.html:93`<br>cyber-admin → `dashboard-circleboat/index.html:71` |
| sales | 2 | STATIC×2 |  | cybercheck-login → `sales.html:1`<br>gcr-admin → `sales.html:1` |
| embed section | 1 | API-only×1 | /embed/:slug/:section | cybercheck-orchestrator → `src/http/server.js:196` |
| embed.js | 1 | WORKING×1 | API_BASE /auth/*, /public/booking | cybercheck-saas → `embed.js:1` |
| preview | 1 | WORKING+mock-fallback×1 | /api/admin/save-preview-data | cybercheck-login → `preview.html:1` |
| route /preview | 1 | WORKING×1 | Next.js app (src/lib/modules spec) | App-build- → `src/app/preview/page.tsx:1` |
| templates | 1 | STATIC×1 |  | gcr-admin → `templates.html:1` |
| widget | 1 | WORKING×1 | /api/gcr/entity/ | cybercheck-login → `widget.html:1` |

## 2. Per-repo raw list

| Repo | Entries |
|---|---:|
| Admin-dashboard-main | 87 |
| App-build- | 15 |
| Boxes | 28 |
| Boxes@claude/agent-ecosystem-architecture-nzexu1 | 1 |
| Dashboards-users- | 42 |
| Dashboards-users-@claude/new-session-66c2e9 | 2 |
| Open-jarvis | 7 |
| Plat-admin | 88 |
| Plat-admin@claude/agent-ecosystem-architecture-nzexu1 | 10 |
| Play-user | 35 |
| Play-user@claude/agent-ecosystem-architecture-nzexu1 | 11 |
| Universal-dashboard- | 1 |
| admin-dashboard- | 32 |
| cyber-admin | 151 |
| cybercheck-dashboard | 25 |
| cybercheck-login | 179 |
| cybercheck-orchestrator | 17 |
| cybercheck-saas | 11 |
| gcr-admin | 173 |
| gcr-unified | 6 |
| ghost-platform (box page) | 7 |
| ghost-platform (operator console) | 4 |
| nextgent-openjarvis | 7 |
| nextgent-shell | 2 |
| paperclip (fork, master) | 22 |

### Admin-dashboard-main

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Overview [home] | `src/modules/registry.js:47 → src/modules/home/Overview.jsx (/)` | ads,claims,rails | WORKING | Analytics & overview |
| All Sections [home] | `src/modules/registry.js:56 → src/modules/home/Sections.jsx (/sections)` | js | WORKING | Onboarding / Setup |
| Menu Builder [menu] | `src/modules/registry.js:68 → src/modules/menu/MenuBuilder.jsx (/menu/builder)` | drinks,happyHour,menu | WORKING | Menu / QR / Specials |
| QR Menus [menu] | `src/modules/registry.js:77 → src/modules/menu/QrMenus.jsx (/menu/qr-menus)` | menu | WORKING | Menu / QR / Specials |
| QR Tracker [menu] | `src/modules/registry.js:86 → src/modules/menu/QrTracker.jsx (/menu/qr-tracker)` | qr,qrCodesResource,qrLocationsResource | WORKING | Menu / QR / Specials |
| Reviews [menu] | `src/modules/registry.js:95 → src/modules/menu/Reviews.jsx (/menu/reviews)` | reviews | WORKING | Reviews |
| Referral Partners [menu] | `src/modules/registry.js:104 → src/modules/menu/ReferralPartners.jsx (/menu/referral-partners)` | qr,qrPartnersResource | WORKING | Messaging / Marketing / Social |
| Daily SMS Links [menu] | `src/modules/registry.js:113 → src/modules/menu/DailyUpdateLinks.jsx (/menu/daily-update-links)` | updateLinks | WORKING | Menu / QR / Specials |
| Menu Editors Hub [menu] | `src/modules/registry.js:122 → src/modules/menu/MenuEditorsHub.jsx (/menu/editors-hub)` | menu | WORKING | Menu / QR / Specials |
| GCR Businesses [directory] | `src/modules/registry.js:133 → src/modules/directory/Businesses.jsx (/directory/businesses)` | entities | WORKING | Directory / Business profile & content |
| Entity Editor [directory] | `src/modules/registry.js:142 → src/modules/directory/EntityEditor.jsx (/directory/entity)` | entities | WORKING | Directory / Business profile & content |
| Business Profiles [directory] | `src/modules/registry.js:159 → src/modules/directory/BusinessProfile.jsx (/directory/profile)` | analytics,businessProfile,entities | WORKING | Directory / Business profile & content |
| Text the Dashboard [platform] | `src/modules/registry.js:169 → src/modules/platform/TextTheDashboard.jsx (/platform/text)` | dashboardSms | WORKING | Analytics & overview |
| Intake [platform] | `src/modules/registry.js:179 → src/modules/platform/Intake.jsx (/platform/intake)` | intake | WORKING | Onboarding / Setup |
| Visitor Behaviour [engagement] | `src/modules/registry.js:189 → src/modules/engagement/Behaviour.jsx (/engagement/behaviour)` | analytics | WORKING | Analytics & overview |
| Site Editor [directory] | `src/modules/registry.js:207 → src/modules/directory/SiteEditor.jsx (/directory/site-editor)` | categoryCards,categoryCardsResource,settings,settingsKeys | PARTIAL | Website / Site builder / Publish |
| Claims [directory] | `src/modules/registry.js:217 → src/modules/directory/Claims.jsx (/directory/claims)` | claims | WORKING | People / CRM / Accounts & auth |
| Sign-ups [directory] | `src/modules/registry.js:230 → src/modules/platform/Signups.jsx (/directory/signups)` | signups | WORKING | People / CRM / Accounts & auth |
| Overview [booking] | `src/modules/registry.js:244 → src/modules/booking/Overview.jsx (/booking)` | bookingPlatform | WORKING | Analytics & overview |
| Offerings [booking] | `src/modules/registry.js:253 → src/modules/booking/Offerings.jsx (/booking/offerings)` | bookingPlatform | WORKING | Bookings & availability |
| Bookings [booking] | `src/modules/registry.js:262 → src/modules/booking/BookingsLedger.jsx (/booking/bookings)` | bookingPlatform | WORKING | Bookings & availability |
| Date Claims [booking] | `src/modules/registry.js:271 → src/modules/booking/Calendar.jsx (/booking/date-claims)` | bookingPlatform | WORKING | Bookings & availability |
| Promos [booking] | `src/modules/registry.js:281 → src/modules/booking/Promos.jsx (/booking/promos)` | /api/admin/gcr/coupons,promosResource | WORKING | Bookings & availability |
| Booking Sources [booking] | `src/modules/registry.js:290 → src/modules/booking/Sources.jsx (/booking/sources)` | bookingPlatform | WORKING | Bookings & availability |
| Calendar Feeds [booking] | `src/modules/registry.js:300 → src/modules/booking/CalendarFeeds.jsx (/booking/feeds)` | bookingPlatform | WORKING | Bookings & availability |
| Inventory & Capacity [booking] | `src/modules/registry.js:310 → src/modules/booking/Inventory.jsx (/booking/inventory)` | bookingPlatform | WORKING | Bookings & availability |
| Availability [booking] | `src/modules/registry.js:320 → src/modules/booking/Availability.jsx (/booking/availability)` | bookingPlatform | WORKING | Bookings & availability |
| Business Calendar [booking] | `src/modules/registry.js:330 → src/modules/booking/BusinessCalendar.jsx (/booking/calendar)` |  | STATIC | Bookings & availability |
| Industry Calendars [booking] | `src/modules/registry.js:349 → src/modules/booking/Industries.jsx (/booking/industries)` | bookingPlatform | WORKING | Bookings & availability |
| Find a Match [booking] | `src/modules/registry.js:368 → src/modules/booking/Match.jsx (/booking/match)` | bookingPlatform | WORKING | Bookings & availability |
| Availability Search [booking] | `src/modules/registry.js:378 → src/modules/booking/AvailabilitySearch.jsx (/booking/search)` | bookingPlatform | WORKING | Bookings & availability |
| Website Calendar [booking] | `src/modules/registry.js:388 → src/modules/booking/WebsiteCalendar.jsx (/booking/website-calendar)` | embed | WORKING | Bookings & availability |
| Openings [booking] | `src/modules/registry.js:398 → src/modules/booking/Openings.jsx (/booking/openings)` | bookingPlatform,sms | WORKING | Bookings & availability |
| Events [content] | `src/modules/registry.js:410 → src/modules/content/Events.jsx (/content/events)` | events | WORKING | Events |
| Artists [content] | `src/modules/registry.js:419 → src/modules/content/Artists.jsx (/content/artists)` | artists,artistsResource | WORKING | Artist / Song requests & tips |
| Song Requests & Tips [content] | `src/modules/registry.js:428 → src/modules/content/ArtistProfiles.jsx (/content/artist-profiles)` | artists | WORKING | Artist / Song requests & tips |
| Specials [content] | `src/modules/registry.js:437 → src/modules/content/Specials.jsx (/content/specials)` | specials | WORKING | Menu / QR / Specials |
| Ad Network [content] | `src/modules/registry.js:446 → src/modules/content/Ads.jsx (/content/ads)` | adsResource | WORKING | Messaging / Marketing / Social |
| Page Rails [content] | `src/modules/registry.js:455 → src/modules/content/Rails.jsx (/content/rails)` | rails | WORKING | Messaging / Marketing / Social |
| AI Config [content] | `src/modules/registry.js:464 → src/modules/ai/AiConfig.jsx (/content/ai-config)` | ai | WORKING | AI tools |
| Coupons [content] | `src/modules/registry.js:473 → src/modules/content/Coupons.jsx (/content/coupons)` | couponsResource | WORKING | Messaging / Marketing / Social |
| Tags & SEO [content] | `src/modules/registry.js:482 → src/modules/content/Seo.jsx (/content/seo)` |  | STATIC | Website / Site builder / Publish |
| Bulk Upload [content] | `src/modules/registry.js:491 → src/modules/content/BulkUpload.jsx (/content/bulk-upload)` | imports | WORKING | Messaging / Marketing / Social |
| Bulk Events [content] | `src/modules/registry.js:500 → src/modules/content/BulkEvents.jsx (/content/bulk-events)` | imports | WORKING | Events |
| AI Chat [ai] | `src/modules/registry.js:511 → src/modules/ai/AiChat.jsx (/ai/chat)` | ai | WORKING | AI tools |
| AI Data Organizer [ai] | `src/modules/registry.js:520 → src/modules/ai/AiOrganize.jsx (/ai/organize)` | ai | WORKING | AI tools |
| AI Index / RAG [ai] | `src/modules/registry.js:529 → src/modules/ai/RagIndex.jsx (/ai/rag-index)` | ai,entities | WORKING | AI tools |
| AI Settings [ai] | `src/modules/registry.js:538 → src/modules/ai/AiSettings.jsx (/ai/settings)` | /api/ai-provider,ai,photos | WORKING | AI tools |
| Analytics [engagement] | `src/modules/registry.js:549 → src/modules/engagement/Analytics.jsx (/engagement/analytics)` | analytics | WORKING | Analytics & overview |
| Reviews [engagement] | `src/modules/registry.js:558 → src/modules/engagement/GcrReviews.jsx (/engagement/reviews)` | entityReviewsResource | WORKING | Reviews |
| Customers [engagement] | `src/modules/registry.js:567 → src/modules/engagement/Customers.jsx (/engagement/customers)` | customersResource | WORKING | People / CRM / Accounts & auth |
| SMS / Messaging [engagement] | `src/modules/registry.js:576 → src/modules/engagement/Messaging.jsx (/engagement/messaging)` | unverified | PARTIAL | Messaging / Marketing / Social |
| Social & Connections [engagement] | `src/modules/registry.js:586 → src/modules/engagement/Social.jsx (/engagement/social)` | socialPosts,socialPostsResource | WORKING | Messaging / Marketing / Social |
| Overview [tripswipe] | `src/modules/registry.js:597 → src/modules/tripswipe/Overview.jsx (/tripswipe)` | tourists,tripswipe | WORKING | Trip Swipe / Consumer engagement |
| Businesses [tripswipe] | `src/modules/registry.js:606 → src/modules/tripswipe/Businesses.jsx (/tripswipe/businesses)` | tripswipe | WORKING | Trip Swipe / Consumer engagement |
| Tourists [tripswipe] | `src/modules/registry.js:615 → src/modules/tripswipe/Tourists.jsx (/tripswipe/tourists)` | tourists | WORKING | Trip Swipe / Consumer engagement |
| Swipe Analytics [tripswipe] | `src/modules/registry.js:624 → src/modules/tripswipe/Analytics.jsx (/tripswipe/analytics)` | analytics | WORKING | Trip Swipe / Consumer engagement |
| AI Feedback [tripswipe] | `src/modules/registry.js:633 → src/modules/tripswipe/AiFeedback.jsx (/tripswipe/ai)` | ai,analytics | WORKING | Trip Swipe / Consumer engagement |
| Concierge Test [tripswipe] | `src/modules/registry.js:642 → src/modules/tripswipe/ConciergeTest.jsx (/tripswipe/concierge-test)` | tourists,tripswipe | WORKING | Trip Swipe / Consumer engagement |
| Swipe Questions [tripswipe] | `src/modules/registry.js:651 → src/modules/tripswipe/SwipeQuestions.jsx (/tripswipe/questions)` | setupQuestionsResource | WORKING | Trip Swipe / Consumer engagement |
| Sponsored [tripswipe] | `src/modules/registry.js:660 → src/modules/tripswipe/Sponsored.jsx (/tripswipe/sponsored)` | sponsoredResource | WORKING | Trip Swipe / Consumer engagement |
| Tonight Cards [tripswipe] | `src/modules/registry.js:669 → src/modules/tripswipe/TonightCards.jsx (/tripswipe/tonight)` | promoCardsResource | WORKING | Trip Swipe / Consumer engagement |
| Points & Rewards [tripswipe] | `src/modules/registry.js:678 → src/modules/tripswipe/Points.jsx (/tripswipe/points)` | settings,settingsKeys | PARTIAL | Trip Swipe / Consumer engagement |
| Text Sign-Up QR Codes [tripswipe] | `src/modules/registry.js:688 → src/modules/tripswipe/SmsQr.jsx (/tripswipe/sms-qr)` | sms,smsQrResource | WORKING | Trip Swipe / Consumer engagement |
| Auth Settings [tripswipe] | `src/modules/registry.js:697 → src/modules/tripswipe/AuthSettings.jsx (/tripswipe/auth-settings)` | settings,settingsKeys | PARTIAL | Trip Swipe / Consumer engagement |
| Button Config [tripswipe] | `src/modules/registry.js:707 → src/modules/tripswipe/ButtonConfig.jsx (/tripswipe/button)` | tripswipe | WORKING | Trip Swipe / Consumer engagement |
| SMS Settings [tripswipe] | `src/modules/registry.js:716 → src/modules/tripswipe/SmsSettings.jsx (/tripswipe/sms-settings)` | settings,settingsKeys | PARTIAL | Trip Swipe / Consumer engagement |
| SMS Blasts [tripswipe] | `src/modules/registry.js:726 → src/modules/tripswipe/SmsBlasts.jsx (/tripswipe/sms-blasts)` | sms | WORKING | Trip Swipe / Consumer engagement |
| Business Leads [tripswipe] | `src/modules/registry.js:735 → src/modules/tripswipe/BusinessLeads.jsx (/tripswipe/business-leads)` | businessLeadsResource | PARTIAL | Trip Swipe / Consumer engagement |
| Guest Photos [tripswipe] | `src/modules/registry.js:745 → src/modules/tripswipe/CommunityPhotos.jsx (/tripswipe/community-photos)` | photos | PARTIAL | Trip Swipe / Consumer engagement |
| Automations [automation] | `src/modules/registry.js:759 → src/modules/automations/Automations.jsx (/automations)` | automations | WORKING | Automations |
| Rollouts [automation] | `src/modules/registry.js:777 → src/modules/automations/Rollouts.jsx (/automations/rollouts)` | automations | WORKING | Automations |
| Run log [automation] | `src/modules/registry.js:786 → src/modules/automations/Runs.jsx (/automations/runs)` | automations | WORKING | Ledger / Paper Trail / Audit |
| Store [appstore] | `src/modules/registry.js:812 → src/modules/store/Store.jsx (/store)` | store | WORKING | App Store / Connections / Modules |
| Connections catalog [appstore] | `src/modules/registry.js:832 → src/modules/appstore/Connections.jsx (/apps/store)` | connections | WORKING | App Store / Connections / Modules |
| Connections [appstore] | `src/modules/registry.js:843 → src/modules/booking/Connections.jsx (/booking/connections)` | connections | WORKING | App Store / Connections / Modules |
| Ghost boxes [platform] | `src/modules/registry.js:874 → src/modules/platform/GhostBoxes.jsx (/platform/ghost)` | ghost | WORKING | Box / Ghost / Phone |
| Businesses [platform] | `src/modules/registry.js:883 → src/modules/platform/Businesses.jsx (/platform/businesses)` | businesses | WORKING | Directory / Business profile & content |
| Leads [platform] | `src/modules/registry.js:892 → src/modules/platform/Leads.jsx (/platform/leads)` | salesLeadsResource | WORKING | Messaging / Marketing / Social |
| Bookings [platform] | `src/modules/registry.js:901 → src/modules/platform/Bookings.jsx (/platform/bookings)` | bookings | WORKING | Bookings & availability |
| Sales Pages [platform] | `src/modules/registry.js:910 → src/modules/platform/SalesPages.jsx (/platform/sales-pages)` | businesses | WORKING | Website / Site builder / Publish |
| AR Hunts [platform] | `src/modules/registry.js:919 → src/modules/platform/ArHunts.jsx (/platform/ar-hunts)` | arHunts,arHuntsResource | WORKING | Trip Swipe / Consumer engagement |
| Integrations [platform] | `src/modules/registry.js:928 → src/modules/platform/Integrations.jsx (/platform/integrations)` | /api/admin/ai-config,/api/admin/connections/status,/api/admin/platform/summary,/api/analytics/stats,/api/integrations/fa | PARTIAL | App Store / Connections / Modules |
| People [platform] | `src/modules/registry.js:938 → src/modules/platform/People.jsx (/platform/people)` | auth,businesses,claims,customers,tourists | WORKING | People / CRM / Accounts & auth |
| Users [platform] | `src/modules/registry.js:948 → src/modules/platform/Users.jsx (/platform/users)` | usersResource | WORKING | People / CRM / Accounts & auth |
| API Keys [platform] | `src/modules/registry.js:957 → src/modules/platform/ApiKeys.jsx (/platform/api-keys)` | settings | PARTIAL | App Store / Connections / Modules |
| Settings [platform] | `src/modules/registry.js:967 → src/modules/platform/Settings.jsx (/platform/settings)` | auth | WORKING | Settings / System / Misc |

### App-build-

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Route /dashboard/apps/[installId] | `src/app/dashboard/apps/[installId]/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | App Store / Connections / Modules |
| Route /dashboard/build/[listingId] | `src/app/dashboard/build/[listingId]/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Analytics & overview |
| Route /dashboard/build/describe | `src/app/dashboard/build/describe/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Analytics & overview |
| Route /dashboard/build | `src/app/dashboard/build/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Analytics & overview |
| Route /dashboard/design | `src/app/dashboard/design/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Analytics & overview |
| Route /dashboard/ghost | `src/app/dashboard/ghost/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Box / Ghost / Phone |
| Route /dashboard | `src/app/dashboard/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Analytics & overview |
| Route /dashboard/settings/ai | `src/app/dashboard/settings/ai/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Analytics & overview |
| Route /dashboard/store | `src/app/dashboard/store/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | App Store / Connections / Modules |
| Route /login | `src/app/login/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | People / CRM / Accounts & auth |
| Route / | `src/app/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Link hub / bio / cards |
| Route /preview | `src/app/preview/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Website / Site builder / Publish |
| Route /signup | `src/app/signup/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | People / CRM / Accounts & auth |
| Route /u/[handle]/[slug] | `src/app/u/[handle]/[slug]/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Link hub / bio / cards |
| Route /u/[handle] | `src/app/u/[handle]/page.tsx:1` | Next.js app (src/lib/modules spec) | WORKING | Link hub / bio / cards |

### Boxes

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Screen: Home | `shell/src/modules/registry.tsx:36` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Screen: Apps | `shell/src/modules/registry.tsx:37` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Screen: Agents | `shell/src/modules/registry.tsx:38` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Screen: Automations | `shell/src/modules/registry.tsx:39` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Screen: Files | `shell/src/modules/registry.tsx:40` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Screen: Calendar | `shell/src/modules/registry.tsx:41` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Screen: Settings | `shell/src/modules/registry.tsx:42` | daemon 127.0.0.1:7770 /api/* (see daemon/src/routes) | WORKING+mock-fallback | Box / Ghost / Phone |
| Settings panel: Wifi | `shell/src/screens/settings/Settings.tsx:95` | daemon /api/wifi | WORKING | Box / Ghost / Phone |
| Settings panel: Bluetooth | `shell/src/screens/settings/Settings.tsx:147` | daemon /api/bluetooth | WORKING | Box / Ghost / Phone |
| Settings panel: Sound | `shell/src/screens/settings/Settings.tsx:180` | daemon /api/sound | WORKING | Box / Ghost / Phone |
| Settings panel: Display | `shell/src/screens/settings/Settings.tsx:209` | daemon /api/display | WORKING | Box / Ghost / Phone |
| Settings panel: Appearance | `shell/src/screens/settings/Settings.tsx:244` | daemon /api/appearance | WORKING | Box / Ghost / Phone |
| Settings panel: Power | `shell/src/screens/settings/Settings.tsx:300` | daemon /api/power | WORKING | Box / Ghost / Phone |
| Settings panel: Storage | `shell/src/screens/settings/Settings.tsx:324` | daemon /api/storage | WORKING | Box / Ghost / Phone |
| Settings panel: Updates | `shell/src/screens/settings/Settings.tsx:341` | daemon /api/updates | WORKING | Box / Ghost / Phone |
| Settings panel: About | `shell/src/screens/settings/Settings.tsx:360` | daemon /api/about | WORKING | Box / Ghost / Phone |
| Settings panel: Home | `shell/src/screens/settings/Settings.tsx:468` | daemon /api/home | WORKING | Analytics & overview |
| Settings panel: Worlds | `shell/src/screens/settings/Settings.tsx:506` | daemon /api/worlds | WORKING | Box / Ghost / Phone |
| Settings panel: Devices | `shell/src/screens/settings/Settings.tsx:582` | daemon /api/devices | WORKING | Box / Ghost / Phone |
| Home layout: CinemaHome | `shell/src/screens/homes/CinemaHome.tsx:1` | daemon /api/home,/api/layout,/api/worlds | WORKING | Box / Ghost / Phone |
| Home layout: DashboardHome | `shell/src/screens/homes/DashboardHome.tsx:1` | daemon /api/home,/api/layout,/api/worlds | WORKING | Box / Ghost / Phone |
| Home layout: LivingHome | `shell/src/screens/homes/LivingHome.tsx:1` | daemon /api/home,/api/layout,/api/worlds | WORKING | Box / Ghost / Phone |
| Menu app route / (menu landing) | `apps/menu/app/page.tsx` | apps/menu/app/api/ai/generate-theme, /api/upload | WORKING | Menu / QR / Specials |
| Menu app route /menus | `apps/menu/app/menus/page.tsx` | apps/menu/app/api/ai/generate-theme, /api/upload | WORKING | Menu / QR / Specials |
| Menu app route /menu/[id] | `apps/menu/app/menu/[id]/page.tsx` | apps/menu/app/api/ai/generate-theme, /api/upload | WORKING | Menu / QR / Specials |
| Menu app route /editor | `apps/menu/app/editor/page.tsx` | apps/menu/app/api/ai/generate-theme, /api/upload | WORKING | Menu / QR / Specials |
| Menu app route /edit/[slug] | `apps/menu/app/edit/[slug]/page.tsx` | apps/menu/app/api/ai/generate-theme, /api/upload | WORKING | Menu / QR / Specials |
| Menu app route /admin/qr-menus | `apps/menu/app/admin/qr-menus/page.tsx` | apps/menu/app/api/ai/generate-theme, /api/upload | WORKING | Menu / QR / Specials |

### Boxes@claude/agent-ecosystem-architecture-nzexu1

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Screen: BusinessHome | `shell/src/screens/BusinessHome.tsx:1` | daemon /api/business/{menu,hours,specials,reviews,availability} | WORKING | Box / Ghost / Phone |

### Dashboards-users-

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Page: AcceptInvite | `src/pages/AcceptInvite.jsx:1 (App.jsx:7)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: AppStore | `src/pages/AppStore.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | App Store / Connections / Modules |
| Page: Automations | `src/pages/Automations.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | Automations |
| Page: BusinessPicker | `src/pages/BusinessPicker.jsx:1 (App.jsx:6)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Claim | `src/pages/Claim.jsx:1 (App.jsx:4)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Dashboard | `src/pages/Dashboard.jsx:1 (App.jsx:5)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | Analytics & overview |
| Page: Ghost | `src/pages/Ghost.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | Box / Ghost / Phone |
| Page: Login | `src/pages/Login.jsx:1 (App.jsx:3)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: SignUp | `src/pages/SignUp.jsx:1 (App.jsx:8)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Store | `src/pages/Store.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | App Store / Connections / Modules |
| Section: Events | `src/sections/EventsSection.jsx (registry.jsx:5)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Events |
| Section: Faqs | `src/sections/FaqsSection.jsx (registry.jsx:8)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Generic | `src/sections/GenericSection.jsx (registry.jsx:24)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: HappyHour | `src/sections/HappyHourSection.jsx (registry.jsx:4)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Section: Hours | `src/sections/HoursSection.jsx (registry.jsx:1)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Menu | `src/sections/MenuSection.jsx (registry.jsx:3)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Section: Offerings | `src/sections/OfferingsSection.jsx (registry.jsx:10)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Bookings & availability |
| Section: Photos | `src/sections/PhotosSection.jsx (registry.jsx:2)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Policies | `src/sections/PoliciesSection.jsx (registry.jsx:9)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: PriceList | `src/sections/PriceListSection.jsx (registry.jsx:11)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Progress | `src/sections/ProgressSection.jsx (registry.jsx:12)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Reviews | `src/sections/ReviewsSection.jsx (registry.jsx:7)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Reviews |
| Section: Specials | `src/sections/SpecialsSection.jsx (registry.jsx:6)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Artist section: Artist Profile (artist_profiles) | `src/lib/artistModule.js:19` | gcr-api-clean /api/business/* table artist_profiles | WORKING | Artist / Song requests & tips |
| Artist section: Setlist (songs) | `src/lib/artistModule.js:20` | gcr-api-clean /api/business/* table songs | WORKING | Artist / Song requests & tips |
| Artist section: Prices (artist_price_tiers) | `src/lib/artistModule.js:21` | gcr-api-clean /api/business/* table artist_price_tiers | WORKING | Artist / Song requests & tips |
| Artist section: Payment Handles (tip_links) | `src/lib/artistModule.js:22` | gcr-api-clean /api/business/* table tip_links | WORKING | Artist / Song requests & tips |
| Artist section: Song Requests (song_requests) | `src/lib/artistModule.js:23` | gcr-api-clean /api/business/* table song_requests | WORKING | Artist / Song requests & tips |
| Artist section: Shoutouts (shoutouts) | `src/lib/artistModule.js:24` | gcr-api-clean /api/business/* table shoutouts | WORKING | Artist / Song requests & tips |
| Artist section: Goals (artist_goals) | `src/lib/artistModule.js:25` | gcr-api-clean /api/business/* table artist_goals | WORKING | Artist / Song requests & tips |
| Artist section: Goal Contributions (artist_goal_contributions) | `src/lib/artistModule.js:26` | gcr-api-clean /api/business/* table artist_goal_contributions | WORKING | Artist / Song requests & tips |
| Artist section: Crowdfunded Songs (song_cooperatives) | `src/lib/artistModule.js:27` | gcr-api-clean /api/business/* table song_cooperatives | WORKING | Artist / Song requests & tips |
| Artist section: Shows (artist_shows) | `src/lib/artistModule.js:28` | gcr-api-clean /api/business/* table artist_shows | WORKING | Artist / Song requests & tips |
| Artist section: Fan List (artist_follows) | `src/lib/artistModule.js:29` | gcr-api-clean /api/business/* table artist_follows | WORKING | Artist / Song requests & tips |
| Artist section: Booking Requests (artist_booking_requests) | `src/lib/artistModule.js:30` | gcr-api-clean /api/business/* table artist_booking_requests | WORKING | Artist / Song requests & tips |
| Artist section: QR Codes (artist_qr_codes) | `src/lib/artistModule.js:31` | gcr-api-clean /api/business/* table artist_qr_codes | WORKING | Menu / QR / Specials |
| Artist section: Payment Confirmations (payment_confirmations) | `src/lib/artistModule.js:32` | gcr-api-clean /api/business/* table payment_confirmations | WORKING | Payments & billing |
| Artist section: Also Known As (artist_aliases) | `src/lib/artistModule.js:33` | gcr-api-clean /api/business/* table artist_aliases | WORKING | Artist / Song requests & tips |
| Dashboard view: Store | `src/pages/Dashboard.jsx:168` | /api/store | WORKING | App Store / Connections / Modules |
| Dashboard view: Ghost (My Ghost boxes / nodes) | `src/pages/Dashboard.jsx:170` | endpoints.nodes (/api/business/nodes…) | WORKING | Box / Ghost / Phone |
| Dashboard view: Automations | `src/pages/Dashboard.jsx:172` | /api/business/automations | WORKING | Automations |
| Dashboard view: AppStore (Connections/Composio) | `src/pages/Dashboard.jsx:174` | /api/connections | WORKING | App Store / Connections / Modules |

### Dashboards-users-@claude/new-session-66c2e9

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Page: Devices | `src/pages/Devices.jsx:1` | gcr-api-clean | WORKING | Box / Ghost / Phone |
| Page: Settings | `src/pages/Settings.jsx:1` | gcr-api-clean | WORKING | Settings / System / Misc |

### Open-jarvis

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Nav: Chat | `frontend/src/components/Sidebar/Sidebar.tsx:56` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Dashboard | `frontend/src/components/Sidebar/Sidebar.tsx:57` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Data Sources | `frontend/src/components/Sidebar/Sidebar.tsx:58` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Agents | `frontend/src/components/Sidebar/Sidebar.tsx:59` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Logs | `frontend/src/components/Sidebar/Sidebar.tsx:60` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Settings | `frontend/src/components/Sidebar/Sidebar.tsx:61` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Get Started | `frontend/src/components/Sidebar/Sidebar.tsx:62` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |

### Plat-admin

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Store publishing [nextgent] | `src/modules/registry.js:48 → src/modules/nextgent/StorePublishing.jsx (/)` | adminApi | WORKING | App Store / Connections / Modules |
| Core menu [nextgent] | `src/modules/registry.js:57 → src/modules/nextgent/CoreMenu.jsx (/menu)` | adminApi | WORKING | Menu / QR / Specials |
| Businesses [nextgent] | `src/modules/registry.js:66 → src/modules/nextgent/Businesses.jsx (/businesses)` | adminApi | WORKING | Directory / Business profile & content |
| Users [nextgent] | `src/modules/registry.js:75 → src/modules/nextgent/Users.jsx (/users)` | adminApi | WORKING | People / CRM / Accounts & auth |
| Overview [home] | `src/modules/registry.js:85 → src/modules/home/Overview.jsx (/overview)` | ads,claims,rails | WORKING | Analytics & overview |
| All Sections [home] | `src/modules/registry.js:94 → src/modules/home/Sections.jsx (/sections)` | js | WORKING | Onboarding / Setup |
| Menu Builder [menu] | `src/modules/registry.js:106 → src/modules/menu/MenuBuilder.jsx (/menu/builder)` | drinks,happyHour,menu | WORKING | Menu / QR / Specials |
| QR Menus [menu] | `src/modules/registry.js:115 → src/modules/menu/QrMenus.jsx (/menu/qr-menus)` | menu | WORKING | Menu / QR / Specials |
| QR Tracker [menu] | `src/modules/registry.js:124 → src/modules/menu/QrTracker.jsx (/menu/qr-tracker)` | qr,qrCodesResource,qrLocationsResource | WORKING | Menu / QR / Specials |
| Reviews [menu] | `src/modules/registry.js:133 → src/modules/menu/Reviews.jsx (/menu/reviews)` | reviews | WORKING | Reviews |
| Referral Partners [menu] | `src/modules/registry.js:142 → src/modules/menu/ReferralPartners.jsx (/menu/referral-partners)` | qr,qrPartnersResource | WORKING | Messaging / Marketing / Social |
| Daily SMS Links [menu] | `src/modules/registry.js:151 → src/modules/menu/DailyUpdateLinks.jsx (/menu/daily-update-links)` | updateLinks | WORKING | Menu / QR / Specials |
| Menu Editors Hub [menu] | `src/modules/registry.js:160 → src/modules/menu/MenuEditorsHub.jsx (/menu/editors-hub)` | menu | WORKING | Menu / QR / Specials |
| GCR Businesses [directory] | `src/modules/registry.js:171 → src/modules/directory/Businesses.jsx (/directory/businesses)` | entities | WORKING | Directory / Business profile & content |
| Entity Editor [directory] | `src/modules/registry.js:180 → src/modules/directory/EntityEditor.jsx (/directory/entity)` | entities | WORKING | Directory / Business profile & content |
| Business Profiles [directory] | `src/modules/registry.js:197 → src/modules/directory/BusinessProfile.jsx (/directory/profile)` | analytics,businessProfile,entities | WORKING | Directory / Business profile & content |
| Text the Dashboard [platform] | `src/modules/registry.js:207 → src/modules/platform/TextTheDashboard.jsx (/platform/text)` | dashboardSms | WORKING | Analytics & overview |
| Intake [platform] | `src/modules/registry.js:217 → src/modules/platform/Intake.jsx (/platform/intake)` | intake | WORKING | Onboarding / Setup |
| Visitor Behaviour [engagement] | `src/modules/registry.js:227 → src/modules/engagement/Behaviour.jsx (/engagement/behaviour)` | analytics | WORKING | Analytics & overview |
| Site Editor [directory] | `src/modules/registry.js:245 → src/modules/directory/SiteEditor.jsx (/directory/site-editor)` | categoryCards,categoryCardsResource,settings,settingsKeys | PARTIAL | Website / Site builder / Publish |
| Claims [directory] | `src/modules/registry.js:255 → src/modules/directory/Claims.jsx (/directory/claims)` | claims | WORKING | People / CRM / Accounts & auth |
| Sign-ups [directory] | `src/modules/registry.js:268 → src/modules/platform/Signups.jsx (/directory/signups)` | signups | WORKING | People / CRM / Accounts & auth |
| Overview [booking] | `src/modules/registry.js:282 → src/modules/booking/Overview.jsx (/booking)` | bookingPlatform | WORKING | Analytics & overview |
| Offerings [booking] | `src/modules/registry.js:291 → src/modules/booking/Offerings.jsx (/booking/offerings)` | bookingPlatform | WORKING | Bookings & availability |
| Bookings [booking] | `src/modules/registry.js:300 → src/modules/booking/BookingsLedger.jsx (/booking/bookings)` | bookingPlatform | WORKING | Bookings & availability |
| Date Claims [booking] | `src/modules/registry.js:309 → src/modules/booking/Calendar.jsx (/booking/date-claims)` | bookingPlatform | WORKING | Bookings & availability |
| Promos [booking] | `src/modules/registry.js:319 → src/modules/booking/Promos.jsx (/booking/promos)` | /api/admin/gcr/coupons,promosResource | WORKING | Bookings & availability |
| Booking Sources [booking] | `src/modules/registry.js:328 → src/modules/booking/Sources.jsx (/booking/sources)` | bookingPlatform | WORKING | Bookings & availability |
| Calendar Feeds [booking] | `src/modules/registry.js:338 → src/modules/booking/CalendarFeeds.jsx (/booking/feeds)` | bookingPlatform | WORKING | Bookings & availability |
| Inventory & Capacity [booking] | `src/modules/registry.js:348 → src/modules/booking/Inventory.jsx (/booking/inventory)` | bookingPlatform | WORKING | Bookings & availability |
| Availability [booking] | `src/modules/registry.js:358 → src/modules/booking/Availability.jsx (/booking/availability)` | bookingPlatform | WORKING | Bookings & availability |
| Business Calendar [booking] | `src/modules/registry.js:368 → src/modules/booking/BusinessCalendar.jsx (/booking/calendar)` |  | STATIC | Bookings & availability |
| Industry Calendars [booking] | `src/modules/registry.js:387 → src/modules/booking/Industries.jsx (/booking/industries)` | bookingPlatform | WORKING | Bookings & availability |
| Find a Match [booking] | `src/modules/registry.js:406 → src/modules/booking/Match.jsx (/booking/match)` | bookingPlatform | WORKING | Bookings & availability |
| Availability Search [booking] | `src/modules/registry.js:416 → src/modules/booking/AvailabilitySearch.jsx (/booking/search)` | bookingPlatform | WORKING | Bookings & availability |
| Website Calendar [booking] | `src/modules/registry.js:426 → src/modules/booking/WebsiteCalendar.jsx (/booking/website-calendar)` | embed | WORKING | Bookings & availability |
| Openings [booking] | `src/modules/registry.js:436 → src/modules/booking/Openings.jsx (/booking/openings)` | bookingPlatform,sms | WORKING | Bookings & availability |
| Events [content] | `src/modules/registry.js:448 → src/modules/content/Events.jsx (/content/events)` | events | WORKING | Events |
| Artists [content] | `src/modules/registry.js:457 → src/modules/content/Artists.jsx (/content/artists)` | artists,artistsResource | WORKING | Artist / Song requests & tips |
| Song Requests & Tips [content] | `src/modules/registry.js:466 → src/modules/content/ArtistProfiles.jsx (/content/artist-profiles)` | artists | WORKING | Artist / Song requests & tips |
| Specials [content] | `src/modules/registry.js:475 → src/modules/content/Specials.jsx (/content/specials)` | specials | WORKING | Menu / QR / Specials |
| Ad Network [content] | `src/modules/registry.js:484 → src/modules/content/Ads.jsx (/content/ads)` | adsResource | WORKING | Messaging / Marketing / Social |
| Page Rails [content] | `src/modules/registry.js:493 → src/modules/content/Rails.jsx (/content/rails)` | rails | WORKING | Messaging / Marketing / Social |
| AI Config [content] | `src/modules/registry.js:502 → src/modules/ai/AiConfig.jsx (/content/ai-config)` | ai | WORKING | AI tools |
| Coupons [content] | `src/modules/registry.js:511 → src/modules/content/Coupons.jsx (/content/coupons)` | couponsResource | WORKING | Messaging / Marketing / Social |
| Tags & SEO [content] | `src/modules/registry.js:520 → src/modules/content/Seo.jsx (/content/seo)` |  | STATIC | Website / Site builder / Publish |
| Bulk Upload [content] | `src/modules/registry.js:529 → src/modules/content/BulkUpload.jsx (/content/bulk-upload)` | imports | WORKING | Messaging / Marketing / Social |
| Bulk Events [content] | `src/modules/registry.js:538 → src/modules/content/BulkEvents.jsx (/content/bulk-events)` | imports | WORKING | Events |
| AI Chat [ai] | `src/modules/registry.js:549 → src/modules/ai/AiChat.jsx (/ai/chat)` | ai | WORKING | AI tools |
| AI Data Organizer [ai] | `src/modules/registry.js:558 → src/modules/ai/AiOrganize.jsx (/ai/organize)` | ai | WORKING | AI tools |
| AI Index / RAG [ai] | `src/modules/registry.js:567 → src/modules/ai/RagIndex.jsx (/ai/rag-index)` | ai,entities | WORKING | AI tools |
| AI Settings [ai] | `src/modules/registry.js:576 → src/modules/ai/AiSettings.jsx (/ai/settings)` | /api/ai-provider,ai,photos | WORKING | AI tools |
| Analytics [engagement] | `src/modules/registry.js:587 → src/modules/engagement/Analytics.jsx (/engagement/analytics)` | analytics | WORKING | Analytics & overview |
| Reviews [engagement] | `src/modules/registry.js:596 → src/modules/engagement/GcrReviews.jsx (/engagement/reviews)` | entityReviewsResource | WORKING | Reviews |
| Customers [engagement] | `src/modules/registry.js:605 → src/modules/engagement/Customers.jsx (/engagement/customers)` | customersResource | WORKING | People / CRM / Accounts & auth |
| SMS / Messaging [engagement] | `src/modules/registry.js:614 → src/modules/engagement/Messaging.jsx (/engagement/messaging)` | unverified | PARTIAL | Messaging / Marketing / Social |
| Social & Connections [engagement] | `src/modules/registry.js:624 → src/modules/engagement/Social.jsx (/engagement/social)` | socialPosts,socialPostsResource | WORKING | Messaging / Marketing / Social |
| Overview [tripswipe] | `src/modules/registry.js:635 → src/modules/tripswipe/Overview.jsx (/tripswipe)` | tourists,tripswipe | WORKING | Trip Swipe / Consumer engagement |
| Businesses [tripswipe] | `src/modules/registry.js:644 → src/modules/tripswipe/Businesses.jsx (/tripswipe/businesses)` | tripswipe | WORKING | Trip Swipe / Consumer engagement |
| Tourists [tripswipe] | `src/modules/registry.js:653 → src/modules/tripswipe/Tourists.jsx (/tripswipe/tourists)` | tourists | WORKING | Trip Swipe / Consumer engagement |
| Swipe Analytics [tripswipe] | `src/modules/registry.js:662 → src/modules/tripswipe/Analytics.jsx (/tripswipe/analytics)` | analytics | WORKING | Trip Swipe / Consumer engagement |
| AI Feedback [tripswipe] | `src/modules/registry.js:671 → src/modules/tripswipe/AiFeedback.jsx (/tripswipe/ai)` | ai,analytics | WORKING | Trip Swipe / Consumer engagement |
| Concierge Test [tripswipe] | `src/modules/registry.js:680 → src/modules/tripswipe/ConciergeTest.jsx (/tripswipe/concierge-test)` | tourists,tripswipe | WORKING | Trip Swipe / Consumer engagement |
| Swipe Questions [tripswipe] | `src/modules/registry.js:689 → src/modules/tripswipe/SwipeQuestions.jsx (/tripswipe/questions)` | setupQuestionsResource | WORKING | Trip Swipe / Consumer engagement |
| Sponsored [tripswipe] | `src/modules/registry.js:698 → src/modules/tripswipe/Sponsored.jsx (/tripswipe/sponsored)` | sponsoredResource | WORKING | Trip Swipe / Consumer engagement |
| Tonight Cards [tripswipe] | `src/modules/registry.js:707 → src/modules/tripswipe/TonightCards.jsx (/tripswipe/tonight)` | promoCardsResource | WORKING | Trip Swipe / Consumer engagement |
| Points & Rewards [tripswipe] | `src/modules/registry.js:716 → src/modules/tripswipe/Points.jsx (/tripswipe/points)` | settings,settingsKeys | PARTIAL | Trip Swipe / Consumer engagement |
| Text Sign-Up QR Codes [tripswipe] | `src/modules/registry.js:726 → src/modules/tripswipe/SmsQr.jsx (/tripswipe/sms-qr)` | sms,smsQrResource | WORKING | Trip Swipe / Consumer engagement |
| Auth Settings [tripswipe] | `src/modules/registry.js:735 → src/modules/tripswipe/AuthSettings.jsx (/tripswipe/auth-settings)` | settings,settingsKeys | PARTIAL | Trip Swipe / Consumer engagement |
| Button Config [tripswipe] | `src/modules/registry.js:745 → src/modules/tripswipe/ButtonConfig.jsx (/tripswipe/button)` | tripswipe | WORKING | Trip Swipe / Consumer engagement |
| SMS Settings [tripswipe] | `src/modules/registry.js:754 → src/modules/tripswipe/SmsSettings.jsx (/tripswipe/sms-settings)` | settings,settingsKeys | PARTIAL | Trip Swipe / Consumer engagement |
| SMS Blasts [tripswipe] | `src/modules/registry.js:764 → src/modules/tripswipe/SmsBlasts.jsx (/tripswipe/sms-blasts)` | sms | WORKING | Trip Swipe / Consumer engagement |
| Business Leads [tripswipe] | `src/modules/registry.js:773 → src/modules/tripswipe/BusinessLeads.jsx (/tripswipe/business-leads)` | businessLeadsResource | PARTIAL | Trip Swipe / Consumer engagement |
| Guest Photos [tripswipe] | `src/modules/registry.js:783 → src/modules/tripswipe/CommunityPhotos.jsx (/tripswipe/community-photos)` | photos | PARTIAL | Trip Swipe / Consumer engagement |
| App Store [appstore] | `src/modules/registry.js:811 → src/modules/appstore/Connections.jsx (/apps/store)` | connections | WORKING | App Store / Connections / Modules |
| Connections [appstore] | `src/modules/registry.js:822 → src/modules/booking/Connections.jsx (/booking/connections)` | connections | WORKING | App Store / Connections / Modules |
| App Manager (legacy) [appstore] | `src/modules/registry.js:831 → src/modules/appstore/AppManager.jsx (/apps/manager)` | appsResource | WORKING | App Store / Connections / Modules |
| Business Apps (legacy) [appstore] | `src/modules/registry.js:840 → src/modules/appstore/BusinessApps.jsx (/apps/business-apps)` | apps,businesses | WORKING | App Store / Connections / Modules |
| Businesses [platform] | `src/modules/registry.js:851 → src/modules/platform/Businesses.jsx (/platform/businesses)` | businesses | WORKING | Directory / Business profile & content |
| Leads [platform] | `src/modules/registry.js:860 → src/modules/platform/Leads.jsx (/platform/leads)` | salesLeadsResource | WORKING | Messaging / Marketing / Social |
| Bookings [platform] | `src/modules/registry.js:869 → src/modules/platform/Bookings.jsx (/platform/bookings)` | bookings | WORKING | Bookings & availability |
| Sales Pages [platform] | `src/modules/registry.js:878 → src/modules/platform/SalesPages.jsx (/platform/sales-pages)` | businesses | WORKING | Website / Site builder / Publish |
| AR Hunts [platform] | `src/modules/registry.js:887 → src/modules/platform/ArHunts.jsx (/platform/ar-hunts)` | arHunts,arHuntsResource | WORKING | Trip Swipe / Consumer engagement |
| Integrations [platform] | `src/modules/registry.js:896 → src/modules/platform/Integrations.jsx (/platform/integrations)` | /api/admin/ai-config,/api/admin/connections/status,/api/admin/platform/summary,/api/analytics/stats,/api/integrations/fa | PARTIAL | App Store / Connections / Modules |
| People [platform] | `src/modules/registry.js:906 → src/modules/platform/People.jsx (/platform/people)` | auth,businesses,claims,customers,tourists | WORKING | People / CRM / Accounts & auth |
| Users [platform] | `src/modules/registry.js:916 → src/modules/platform/Users.jsx (/platform/users)` | usersResource | WORKING | People / CRM / Accounts & auth |
| API Keys [platform] | `src/modules/registry.js:925 → src/modules/platform/ApiKeys.jsx (/platform/api-keys)` | settings | PARTIAL | App Store / Connections / Modules |
| Settings [platform] | `src/modules/registry.js:935 → src/modules/platform/Settings.jsx (/platform/settings)` | auth | WORKING | Settings / System / Misc |

### Plat-admin@claude/agent-ecosystem-architecture-nzexu1

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Apps [console] | `src/modules/registry.js:92 → src/modules/console/Apps.jsx (/apps)` | adminApi | WORKING | App Store / Connections / Modules |
| Agents [console] | `src/modules/registry.js:101 → src/modules/console/Agents.jsx (/agents)` | adminApi | WORKING | Fleet / Paperclip / Agents |
| Devices [console] | `src/modules/registry.js:176 → src/modules/console/Devices.jsx (/devices)` | ghost | WORKING | Box / Ghost / Phone |
| Executions [console] | `src/modules/registry.js:185 → src/modules/console/Executions.jsx (/executions)` | ghost | WORKING | Fleet / Paperclip / Agents |
| Approvals [console] | `src/modules/registry.js:194 → src/modules/console/Approvals.jsx (/approvals)` | adminApi | WORKING | Fleet / Paperclip / Agents |
| Business Data [console] | `src/modules/registry.js:203 → src/modules/console/DataHome.jsx (/data)` | settings | WORKING | Directory / Business profile & content |
| Deployments [console] | `src/modules/registry.js:212 → src/modules/console/Deployments.jsx (/deployments)` | adminApi,automations | WORKING | Automations |
| System [console] | `src/modules/registry.js:221 → src/modules/console/System.jsx (/system)` | adminApi,settings | WORKING | Settings / System / Misc |
| Business accounts [platform] | `src/modules/registry.js:996 → src/modules/platform/Businesses.jsx (/platform/businesses)` | businesses | WORKING | People / CRM / Accounts & auth |
| Admin & owner accounts [platform] | `src/modules/registry.js:1061 → src/modules/platform/Users.jsx (/platform/users)` | usersResource | WORKING | People / CRM / Accounts & auth |

### Play-user

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Page: AcceptInvite | `src/pages/AcceptInvite.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: AppStore | `src/pages/AppStore.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr ; Paperclip /api/store | WORKING | App Store / Connections / Modules |
| Page: BusinessPicker | `src/pages/BusinessPicker.jsx:1 (App.jsx:6)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Claim | `src/pages/Claim.jsx:1 (App.jsx:-)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Dashboard | `src/pages/Dashboard.jsx:1 (App.jsx:5)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | Analytics & overview |
| Page: Login | `src/pages/Login.jsx:1 (App.jsx:3)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: SignUp | `src/pages/SignUp.jsx:1 (App.jsx:4)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Section: Events | `src/sections/EventsSection.jsx (registry.jsx:5)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Events |
| Section: Faqs | `src/sections/FaqsSection.jsx (registry.jsx:8)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Generic | `src/sections/GenericSection.jsx (registry.jsx:24)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: HappyHour | `src/sections/HappyHourSection.jsx (registry.jsx:4)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Section: Hours | `src/sections/HoursSection.jsx (registry.jsx:1)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Menu | `src/sections/MenuSection.jsx (registry.jsx:3)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Section: Offerings | `src/sections/OfferingsSection.jsx (registry.jsx:10)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Bookings & availability |
| Section: Photos | `src/sections/PhotosSection.jsx (registry.jsx:2)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Policies | `src/sections/PoliciesSection.jsx (registry.jsx:9)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: PriceList | `src/sections/PriceListSection.jsx (registry.jsx:11)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Progress | `src/sections/ProgressSection.jsx (registry.jsx:12)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Reviews | `src/sections/ReviewsSection.jsx (registry.jsx:7)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Reviews |
| Section: Specials | `src/sections/SpecialsSection.jsx (registry.jsx:6)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Artist section: Artist Profile (artist_profiles) | `src/lib/artistModule.js:19` | gcr-api-clean /api/business/* table artist_profiles | WORKING | Artist / Song requests & tips |
| Artist section: Setlist (songs) | `src/lib/artistModule.js:20` | gcr-api-clean /api/business/* table songs | WORKING | Artist / Song requests & tips |
| Artist section: Prices (artist_price_tiers) | `src/lib/artistModule.js:21` | gcr-api-clean /api/business/* table artist_price_tiers | WORKING | Artist / Song requests & tips |
| Artist section: Payment Handles (tip_links) | `src/lib/artistModule.js:22` | gcr-api-clean /api/business/* table tip_links | WORKING | Artist / Song requests & tips |
| Artist section: Song Requests (song_requests) | `src/lib/artistModule.js:23` | gcr-api-clean /api/business/* table song_requests | WORKING | Artist / Song requests & tips |
| Artist section: Shoutouts (shoutouts) | `src/lib/artistModule.js:24` | gcr-api-clean /api/business/* table shoutouts | WORKING | Artist / Song requests & tips |
| Artist section: Goals (artist_goals) | `src/lib/artistModule.js:25` | gcr-api-clean /api/business/* table artist_goals | WORKING | Artist / Song requests & tips |
| Artist section: Goal Contributions (artist_goal_contributions) | `src/lib/artistModule.js:26` | gcr-api-clean /api/business/* table artist_goal_contributions | WORKING | Artist / Song requests & tips |
| Artist section: Crowdfunded Songs (song_cooperatives) | `src/lib/artistModule.js:27` | gcr-api-clean /api/business/* table song_cooperatives | WORKING | Artist / Song requests & tips |
| Artist section: Shows (artist_shows) | `src/lib/artistModule.js:28` | gcr-api-clean /api/business/* table artist_shows | WORKING | Artist / Song requests & tips |
| Artist section: Fan List (artist_follows) | `src/lib/artistModule.js:29` | gcr-api-clean /api/business/* table artist_follows | WORKING | Artist / Song requests & tips |
| Artist section: Booking Requests (artist_booking_requests) | `src/lib/artistModule.js:30` | gcr-api-clean /api/business/* table artist_booking_requests | WORKING | Artist / Song requests & tips |
| Artist section: QR Codes (artist_qr_codes) | `src/lib/artistModule.js:31` | gcr-api-clean /api/business/* table artist_qr_codes | WORKING | Menu / QR / Specials |
| Artist section: Payment Confirmations (payment_confirmations) | `src/lib/artistModule.js:32` | gcr-api-clean /api/business/* table payment_confirmations | WORKING | Payments & billing |
| Artist section: Also Known As (artist_aliases) | `src/lib/artistModule.js:33` | gcr-api-clean /api/business/* table artist_aliases | WORKING | Artist / Song requests & tips |

### Play-user@claude/agent-ecosystem-architecture-nzexu1

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Screen: Home | `src/app/nav.js:4 → src/screens/Home.jsx` | paperclip approvals,store,tasks; business bookings,events,messages,payments | WORKING | Analytics & overview |
| Screen: Business | `src/app/nav.js:5 → src/screens/Business.jsx` | business listings,profile (schema discovery) | WORKING | Analytics & overview |
| Screen: Apps | `src/app/nav.js:6 → src/screens/Apps.jsx` | /api/companies/* (paperclip) | WORKING | App Store / Connections / Modules |
| Screen: Agents | `src/app/nav.js:7 → src/screens/Agents.jsx` | paperclip agents,approvals,routines,store,tasks | WORKING | Fleet / Paperclip / Agents |
| Screen: Automations | `src/app/nav.js:8 → src/screens/Automations.jsx` | business automations; paperclip agents,store | WORKING | Automations |
| Screen: Calendar | `src/app/nav.js:9 → src/screens/Calendar.jsx` | business availability,bookings,events; paperclip routines,tasks | WORKING | Bookings & availability |
| Screen: Messages | `src/app/nav.js:10 → src/screens/Messages.jsx` | business messages; paperclip store | WORKING | Messaging / Marketing / Social |
| Screen: Computer | `src/app/nav.js:11 → src/screens/Computer.jsx` | /api/companies/* devices (paperclip) | WORKING | Box / Ghost / Phone |
| Screen: Activity | `src/app/nav.js:12 → src/screens/Activity.jsx` | paperclip activity,agents,receipts | WORKING | Ledger / Paper Trail / Audit |
| Screen: Settings | `src/app/nav.js:13 → src/screens/Settings.jsx` | paperclip auth,agents,devices,invites,store; business billing,notifications,privacy; /api/connections | WORKING | Settings / System / Misc |
| Screen: Onboarding | `src/screens/Onboarding.jsx` |  | WORKING | Onboarding / Setup |

### Universal-dashboard-

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| App catalog (Paperclip App Store feed) | `catalog.json:2` | read by saas-cybercheck Paperclip plugin | EMPTY | App Store / Connections / Modules |

### admin-dashboard-

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Page: BusinessPicker | `src/pages/BusinessPicker.jsx:1 (App.jsx:6)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Claim | `src/pages/Claim.jsx:1 (App.jsx:4)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Page: Dashboard | `src/pages/Dashboard.jsx:1 (App.jsx:5)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | Analytics & overview |
| Page: Login | `src/pages/Login.jsx:1 (App.jsx:3)` | VITE_GCR_API_BASE → gcr-api-clean /api/business,/api/business-auth,/api/auth,/api/gcr | WORKING | People / CRM / Accounts & auth |
| Section: Events | `src/sections/EventsSection.jsx (registry.jsx:5)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Events |
| Section: Faqs | `src/sections/FaqsSection.jsx (registry.jsx:8)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Generic | `src/sections/GenericSection.jsx (registry.jsx:24)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: HappyHour | `src/sections/HappyHourSection.jsx (registry.jsx:4)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Section: Hours | `src/sections/HoursSection.jsx (registry.jsx:1)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Menu | `src/sections/MenuSection.jsx (registry.jsx:3)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Section: Offerings | `src/sections/OfferingsSection.jsx (registry.jsx:10)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Bookings & availability |
| Section: Photos | `src/sections/PhotosSection.jsx (registry.jsx:2)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Policies | `src/sections/PoliciesSection.jsx (registry.jsx:9)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: PriceList | `src/sections/PriceListSection.jsx (registry.jsx:11)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Progress | `src/sections/ProgressSection.jsx (registry.jsx:12)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Directory / Business profile & content |
| Section: Reviews | `src/sections/ReviewsSection.jsx (registry.jsx:7)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Reviews |
| Section: Specials | `src/sections/SpecialsSection.jsx (registry.jsx:6)` | gcr-api-clean /api/business/* (schema-discovered tables) | WORKING | Menu / QR / Specials |
| Artist section: Artist Profile (artist_profiles) | `src/lib/artistModule.js:19` | gcr-api-clean /api/business/* table artist_profiles | WORKING | Artist / Song requests & tips |
| Artist section: Setlist (songs) | `src/lib/artistModule.js:20` | gcr-api-clean /api/business/* table songs | WORKING | Artist / Song requests & tips |
| Artist section: Prices (artist_price_tiers) | `src/lib/artistModule.js:21` | gcr-api-clean /api/business/* table artist_price_tiers | WORKING | Artist / Song requests & tips |
| Artist section: Payment Handles (tip_links) | `src/lib/artistModule.js:22` | gcr-api-clean /api/business/* table tip_links | WORKING | Artist / Song requests & tips |
| Artist section: Song Requests (song_requests) | `src/lib/artistModule.js:23` | gcr-api-clean /api/business/* table song_requests | WORKING | Artist / Song requests & tips |
| Artist section: Shoutouts (shoutouts) | `src/lib/artistModule.js:24` | gcr-api-clean /api/business/* table shoutouts | WORKING | Artist / Song requests & tips |
| Artist section: Goals (artist_goals) | `src/lib/artistModule.js:25` | gcr-api-clean /api/business/* table artist_goals | WORKING | Artist / Song requests & tips |
| Artist section: Goal Contributions (artist_goal_contributions) | `src/lib/artistModule.js:26` | gcr-api-clean /api/business/* table artist_goal_contributions | WORKING | Artist / Song requests & tips |
| Artist section: Crowdfunded Songs (song_cooperatives) | `src/lib/artistModule.js:27` | gcr-api-clean /api/business/* table song_cooperatives | WORKING | Artist / Song requests & tips |
| Artist section: Shows (artist_shows) | `src/lib/artistModule.js:28` | gcr-api-clean /api/business/* table artist_shows | WORKING | Artist / Song requests & tips |
| Artist section: Fan List (artist_follows) | `src/lib/artistModule.js:29` | gcr-api-clean /api/business/* table artist_follows | WORKING | Artist / Song requests & tips |
| Artist section: Booking Requests (artist_booking_requests) | `src/lib/artistModule.js:30` | gcr-api-clean /api/business/* table artist_booking_requests | WORKING | Artist / Song requests & tips |
| Artist section: QR Codes (artist_qr_codes) | `src/lib/artistModule.js:31` | gcr-api-clean /api/business/* table artist_qr_codes | WORKING | Menu / QR / Specials |
| Artist section: Payment Confirmations (payment_confirmations) | `src/lib/artistModule.js:32` | gcr-api-clean /api/business/* table payment_confirmations | WORKING | Payments & billing |
| Artist section: Also Known As (artist_aliases) | `src/lib/artistModule.js:33` | gcr-api-clean /api/business/* table artist_aliases | WORKING | Artist / Song requests & tips |

### cyber-admin

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Page: admin/admin-add-integration.html (Add New Integration - CyberCheck Admin) | `admin/admin-add-integration.html:1` | /api/admin/integrations | WORKING+mock-fallback | App Store / Connections / Modules |
| Page: admin/admin-content-manager.html (Content Manager - All Platforms) | `admin/admin-content-manager.html:1` | /api/content/platform,/api/content/platform/ | WORKING+mock-fallback | Directory / Business profile & content |
| Page: admin/admin-crm.html (CRM Admin - CyberCheck OS) | `admin/admin-crm.html:1` | /api/crm/fields,/api/crm/fields/,/api/crm/fields/all,/api/crm/mappings,/api/crm/mappings/,/api/crm/sections,/a | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Page: admin/admin-customer-phones.html (Customer Phone Assignments - Admin) | `admin/admin-customer-phones.html:1` | /api/admin/businesses,/api/admin/businesses/,/api/customer/calls | WORKING+mock-fallback | Messaging / Marketing / Social |
| Page: admin/admin-dashboard.html (Master Admin Dashboard - UniDash OS) | `admin/admin-dashboard.html:1` | /api/admin/costs,/api/admin/costs/per-lead,/api/admin/costs/summary,/api/admin/dashboard/activity,/api/admin/s | WORKING+mock-fallback | Analytics & overview |
| Page: admin/admin-gcr-discover.html (Discover & Import Businesses - GCR Admin) | `admin/admin-gcr-discover.html:1` |  | WORKING+mock-fallback | Directory / Business profile & content |
| Page: admin/admin-gcr-featured.html (Manage Featured Businesses - GCR Admin) | `admin/admin-gcr-featured.html:1` |  | WORKING+mock-fallback | Directory / Business profile & content |
| Page: admin/admin-gcr-management.html (GCR Management - CyberCheck Admin) | `admin/admin-gcr-management.html:1` | /api/gcr/upload-photo | WORKING+mock-fallback | Directory / Business profile & content |
| Page: admin/admin-hub.html (Admin Hub - CyberCheck) | `admin/admin-hub.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: admin/admin-integrations.html (Manage Integrations - CyberCheck Admin) | `admin/admin-integrations.html:1` | /api/admin/integrations,/api/admin/integrations/ | WORKING+mock-fallback | App Store / Connections / Modules |
| Page: admin/admin-login.html (Admin Access — CyberCheck) | `admin/admin-login.html:1` | sb:users | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Page: admin/admin-package-manager.html (Package Manager - CyberCheck) | `admin/admin-package-manager.html:1` | /api/features,/api/features/,/api/offers,/api/offers/,/api/packages,/api/packages/ | WORKING+mock-fallback | App Store / Connections / Modules |
| Page: admin/admin-panel.html (Admin Panel - THE GHOST OS) | `admin/admin-panel.html:1` | /api/admin/api-keys,/api/admin/test-connection/,/api/admin/verify | WORKING+mock-fallback | Settings / System / Misc |
| Page: admin/admin-pricing-control.html (Pricing & Packages Control - CyberCheck Admin) | `admin/admin-pricing-control.html:1` |  | WORKING+mock-fallback | Bookings & availability |
| Page: admin/admin-tags-manager.html (Tags Manager - GCR) | `admin/admin-tags-manager.html:1` | /api/tags,/api/tags/ | WORKING+mock-fallback | Website / Site builder / Publish |
| Page: admin/index.html () | `admin/index.html:1` |  | STATIC | Settings / System / Misc |
| Page: apps/ai-training/index.html (AI Training) | `apps/ai-training/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: apps/analytics/index.html (Analytics Dashboard) | `apps/analytics/index.html:1` |  | STATIC | Settings / System / Misc |
| Page: apps/biopage/index.html (Bio Page Editor) | `apps/biopage/index.html:1` |  | STATIC | Settings / System / Misc |
| Page: apps/biopage/public-simple.html (Loading...) | `apps/biopage/public-simple.html:1` |  | MOCK/STUB | Link hub / bio / cards |
| Page: apps/biopage/public.html (Loading...) | `apps/biopage/public.html:1` |  | MOCK/STUB | Link hub / bio / cards |
| Page: apps/booking/index.html (Booking Platform) | `apps/booking/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: apps/booking/public-booking.html (Book Now) | `apps/booking/public-booking.html:1` |  | MOCK/STUB | Link hub / bio / cards |
| Page: apps/loyalty/index.html (Loyalty Rewards) | `apps/loyalty/index.html:1` | /api/dashboard/loyalty/members,/api/dashboard/loyalty/stats | WORKING+mock-fallback | Settings / System / Misc |
| Page: apps/menu/index.html (Menu App) | `apps/menu/index.html:1` |  | STATIC | Settings / System / Misc |
| Page: apps/ordering/index.html (Online Ordering) | `apps/ordering/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: apps/referrals/index.html (Influencer Referrals) | `apps/referrals/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: apps/sms-automation/index.html (SMS Automation) | `apps/sms-automation/index.html:1` |  | STATIC | Settings / System / Misc |
| Page: apps/sms/index.html (SMS Marketing) | `apps/sms/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: apps/social/index.html (Social Media Manager) | `apps/social/index.html:1` |  | STATIC | Settings / System / Misc |
| Page: beachside-dashboard/index.html (Business Dashboard - CyberCheck) | `beachside-dashboard/index.html:1` | supabase | WORKING+mock-fallback | Settings / System / Misc |
| Page: beachside-dashboard/login.html (Login — Dashboard) | `beachside-dashboard/login.html:1` | supabase | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Page: beachside-dashboard/tabs/business-details/about-editor.html (About Us Editor) | `beachside-dashboard/tabs/business-details/about-editor.html:1` |  | MOCK/STUB | Directory / Business profile & content |
| Page: beachside-dashboard/tabs/business-details/gallery-editor.html (Photo Gallery Editor) | `beachside-dashboard/tabs/business-details/gallery-editor.html:1` |  | MOCK/STUB | Directory / Business profile & content |
| Page: beachside-dashboard/tabs/business-details/hours-editor.html (Business Hours Editor) | `beachside-dashboard/tabs/business-details/hours-editor.html:1` |  | STATIC | Directory / Business profile & content |
| Page: beachside-dashboard/tabs/business-details/index.html (Business Details) | `beachside-dashboard/tabs/business-details/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: beachside-dashboard/tabs/business-details/social-feeds.html (Social Feeds - Business Details) | `beachside-dashboard/tabs/business-details/social-feeds.html:1` |  | MOCK/STUB | Bookings & availability |
| Page: beachside-dashboard/tabs/business-details/team-editor.html (Team Members Editor) | `beachside-dashboard/tabs/business-details/team-editor.html:1` |  | MOCK/STUB | People / CRM / Accounts & auth |
| Page: beachside-dashboard/tabs/oauth.html (OAuth Connections) | `beachside-dashboard/tabs/oauth.html:1` | /api/oauth/ | WORKING | App Store / Connections / Modules |
| Page: beachside-dashboard/tabs/overview.html (Overview) | `beachside-dashboard/tabs/overview.html:1` |  | MOCK/STUB | Analytics & overview |
| Page: beachside-dashboard/tabs/settings.html (Settings) | `beachside-dashboard/tabs/settings.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: beachside-dashboard/tabs/workflows.html (Workflows) | `beachside-dashboard/tabs/workflows.html:1` |  | MOCK/STUB | Automations |
| Page: dashboard-booking/index.html (Boat Rental Dashboard) | `dashboard-booking/index.html:1` | supabase | WORKING+mock-fallback | Settings / System / Misc |
| Page: dashboard-circleboat/index.html (Beachside Circle Boats — Dashboard) | `dashboard-circleboat/index.html:1` | supabase | WORKING+mock-fallback | Settings / System / Misc |
| Page: dashboard-taxi/index.html (Taxi Dashboard — Gulf Coast Radar) | `dashboard-taxi/index.html:1` | /api/taxi | WORKING+mock-fallback | Settings / System / Misc |
| Page: dashboard/index.html (Business Dashboard - CyberCheck) | `dashboard/index.html:1` | supabase | WORKING+mock-fallback | Settings / System / Misc |
| Page: dashboard/login.html (Login — Dashboard) | `dashboard/login.html:1` |  | MOCK/STUB | People / CRM / Accounts & auth |
| Page: dashboard/tabs/business-details/about-editor.html (About Us Editor) | `dashboard/tabs/business-details/about-editor.html:1` |  | MOCK/STUB | Directory / Business profile & content |
| Page: dashboard/tabs/business-details/gallery-editor.html (Photo Gallery Editor) | `dashboard/tabs/business-details/gallery-editor.html:1` |  | MOCK/STUB | Directory / Business profile & content |
| Page: dashboard/tabs/business-details/hours-editor.html (Business Hours Editor) | `dashboard/tabs/business-details/hours-editor.html:1` |  | STATIC | Directory / Business profile & content |
| Page: dashboard/tabs/business-details/index.html (Business Details) | `dashboard/tabs/business-details/index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Page: dashboard/tabs/business-details/social-feeds.html (Social Feeds - Business Details) | `dashboard/tabs/business-details/social-feeds.html:1` |  | MOCK/STUB | Bookings & availability |
| Page: dashboard/tabs/business-details/team-editor.html (Team Members Editor) | `dashboard/tabs/business-details/team-editor.html:1` |  | MOCK/STUB | People / CRM / Accounts & auth |
| Page: dashboard/tabs/oauth.html (OAuth Connections) | `dashboard/tabs/oauth.html:1` | /api/oauth/ | WORKING | App Store / Connections / Modules |
| Page: dashboard/tabs/overview.html (Overview) | `dashboard/tabs/overview.html:1` |  | MOCK/STUB | Analytics & overview |
| Page: dashboard/tabs/settings.html (Settings) | `dashboard/tabs/settings.html:1` | /api/dashboard/domain | WORKING+mock-fallback | Settings / System / Misc |
| Page: dashboard/tabs/workflows.html (Workflows) | `dashboard/tabs/workflows.html:1` |  | MOCK/STUB | Automations |
| Page: taxi-business-dashboard.html (Taxi Business Dashboard) | `taxi-business-dashboard.html:1` | /api/taxi | WORKING+mock-fallback | Bookings & availability |
| Page: trip-concierge-dashboard.html (Your Gulf Coast Radar Trip - Personalized Concierge) | `trip-concierge-dashboard.html:1` |  | WORKING+mock-fallback | Trip Swipe / Consumer engagement |
| dashboard tab: overview | `dashboard/index.html:21` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| dashboard tab: profile | `dashboard/index.html:25` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard tab: media | `dashboard/index.html:29` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard tab: pages | `dashboard/index.html:33` | supabase (inline) / dashboard/js | WORKING | Link hub / bio / cards |
| dashboard tab: staff | `dashboard/index.html:37` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| dashboard tab: inventory | `dashboard/index.html:44` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: availability | `dashboard/index.html:48` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: addons | `dashboard/index.html:52` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: locations | `dashboard/index.html:56` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: bookings | `dashboard/index.html:60` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: waivers | `dashboard/index.html:65` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: waitlist | `dashboard/index.html:69` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: drivers | `dashboard/index.html:76` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: rides | `dashboard/index.html:80` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard tab: earnings | `dashboard/index.html:84` | supabase (inline) / dashboard/js | WORKING | Payments & billing |
| dashboard tab: history | `dashboard/index.html:88` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| dashboard tab: customers | `dashboard/index.html:95` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| dashboard tab: coupons | `dashboard/index.html:99` | supabase (inline) / dashboard/js | WORKING | Messaging / Marketing / Social |
| dashboard tab: messaging | `dashboard/index.html:106` | supabase (inline) / dashboard/js | WORKING | Messaging / Marketing / Social |
| dashboard tab: reviews | `dashboard/index.html:113` | supabase (inline) / dashboard/js | WORKING | Reviews |
| dashboard tab: analytics | `dashboard/index.html:120` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| dashboard tab: seo | `dashboard/index.html:124` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard tab: social | `dashboard/index.html:128` | supabase (inline) / dashboard/js | WORKING | Messaging / Marketing / Social |
| dashboard tab: billing | `dashboard/index.html:135` | supabase (inline) / dashboard/js | WORKING | Payments & billing |
| dashboard tab: theme | `dashboard/index.html:139` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard tab: connections | `dashboard/index.html:143` | supabase (inline) / dashboard/js | WORKING | App Store / Connections / Modules |
| dashboard tab: website-content | `dashboard/index.html:147` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard tab: site-editor | `dashboard/index.html:151` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard tab: domain | `dashboard/index.html:155` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard tab: publish | `dashboard/index.html:159` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| beachside-dashboard tab: overview | `beachside-dashboard/index.html:21` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| beachside-dashboard tab: profile | `beachside-dashboard/index.html:25` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| beachside-dashboard tab: media | `beachside-dashboard/index.html:29` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| beachside-dashboard tab: pages | `beachside-dashboard/index.html:33` | supabase (inline) / dashboard/js | WORKING | Link hub / bio / cards |
| beachside-dashboard tab: staff | `beachside-dashboard/index.html:37` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| beachside-dashboard tab: inventory | `beachside-dashboard/index.html:44` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: availability | `beachside-dashboard/index.html:48` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: addons | `beachside-dashboard/index.html:52` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: locations | `beachside-dashboard/index.html:56` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: bookings | `beachside-dashboard/index.html:60` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: waivers | `beachside-dashboard/index.html:65` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: waitlist | `beachside-dashboard/index.html:69` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: customers | `beachside-dashboard/index.html:76` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| beachside-dashboard tab: coupons | `beachside-dashboard/index.html:80` | supabase (inline) / dashboard/js | WORKING | Messaging / Marketing / Social |
| beachside-dashboard tab: messaging | `beachside-dashboard/index.html:87` | supabase (inline) / dashboard/js | WORKING | Messaging / Marketing / Social |
| beachside-dashboard tab: agents | `beachside-dashboard/index.html:91` | supabase (inline) / dashboard/js | WORKING | Fleet / Paperclip / Agents |
| beachside-dashboard tab: reviews | `beachside-dashboard/index.html:98` | supabase (inline) / dashboard/js | WORKING | Reviews |
| beachside-dashboard tab: analytics | `beachside-dashboard/index.html:105` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| beachside-dashboard tab: seo | `beachside-dashboard/index.html:109` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| beachside-dashboard tab: social | `beachside-dashboard/index.html:113` | supabase (inline) / dashboard/js | WORKING | Messaging / Marketing / Social |
| beachside-dashboard tab: billing | `beachside-dashboard/index.html:120` | supabase (inline) / dashboard/js | WORKING | Payments & billing |
| beachside-dashboard tab: theme | `beachside-dashboard/index.html:124` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| beachside-dashboard tab: connections | `beachside-dashboard/index.html:128` | supabase (inline) / dashboard/js | WORKING | App Store / Connections / Modules |
| beachside-dashboard tab: website-content | `beachside-dashboard/index.html:132` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| beachside-dashboard tab: site-editor | `beachside-dashboard/index.html:136` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| beachside-dashboard tab: domain | `beachside-dashboard/index.html:140` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| beachside-dashboard tab: gcr-listing | `beachside-dashboard/index.html:144` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| beachside-dashboard tab: transportation | `beachside-dashboard/index.html:148` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| beachside-dashboard tab: publish | `beachside-dashboard/index.html:152` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard-booking tab: overview | `dashboard-booking/index.html:20` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| dashboard-booking tab: bookings | `dashboard-booking/index.html:24` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: calendar | `dashboard-booking/index.html:29` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: manifest | `dashboard-booking/index.html:33` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: fleet | `dashboard-booking/index.html:39` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: addons | `dashboard-booking/index.html:43` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: pricing | `dashboard-booking/index.html:47` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: resources | `dashboard-booking/index.html:51` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: customers | `dashboard-booking/index.html:57` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| dashboard-booking tab: waivers | `dashboard-booking/index.html:61` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: profile | `dashboard-booking/index.html:67` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard-booking tab: locations | `dashboard-booking/index.html:71` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-booking tab: staff | `dashboard-booking/index.html:75` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| dashboard-booking tab: media | `dashboard-booking/index.html:79` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard-booking tab: reports | `dashboard-booking/index.html:83` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| dashboard-booking tab: connections | `dashboard-booking/index.html:89` | supabase (inline) / dashboard/js | WORKING | App Store / Connections / Modules |
| dashboard-booking tab: theme | `dashboard-booking/index.html:93` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard-booking tab: site-editor | `dashboard-booking/index.html:97` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard-booking tab: publish | `dashboard-booking/index.html:101` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard-circleboat tab: overview | `dashboard-circleboat/index.html:20` | supabase (inline) / dashboard/js | WORKING | Analytics & overview |
| dashboard-circleboat tab: bookings | `dashboard-circleboat/index.html:24` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-circleboat tab: calendar | `dashboard-circleboat/index.html:29` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-circleboat tab: fleet | `dashboard-circleboat/index.html:35` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-circleboat tab: pricing | `dashboard-circleboat/index.html:39` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-circleboat tab: dock | `dashboard-circleboat/index.html:43` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-circleboat tab: customers | `dashboard-circleboat/index.html:49` | supabase (inline) / dashboard/js | WORKING | People / CRM / Accounts & auth |
| dashboard-circleboat tab: waivers | `dashboard-circleboat/index.html:53` | supabase (inline) / dashboard/js | WORKING | Bookings & availability |
| dashboard-circleboat tab: profile | `dashboard-circleboat/index.html:59` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard-circleboat tab: media | `dashboard-circleboat/index.html:63` | supabase (inline) / dashboard/js | WORKING | Directory / Business profile & content |
| dashboard-circleboat tab: connections | `dashboard-circleboat/index.html:67` | supabase (inline) / dashboard/js | WORKING | App Store / Connections / Modules |
| dashboard-circleboat tab: theme | `dashboard-circleboat/index.html:71` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard-circleboat tab: site-editor | `dashboard-circleboat/index.html:75` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |
| dashboard-circleboat tab: publish | `dashboard-circleboat/index.html:79` | supabase (inline) / dashboard/js | WORKING | Website / Site builder / Publish |

### cybercheck-dashboard

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Tab: overview | `cybercheck-dashboard-platform/index.html:21` | CC_API_BASE (default localhost:3000) | STATIC | Analytics & overview |
| Tab: profile | `cybercheck-dashboard-platform/index.html:25 → js/profile.js` | CC.getProfile,CC.updateProfile | WORKING | Directory / Business profile & content |
| Tab: media | `cybercheck-dashboard-platform/index.html:29 → js/media.js` | CC.getGallery | WORKING+mock-fallback | Directory / Business profile & content |
| Tab: pages | `cybercheck-dashboard-platform/index.html:33 → js/pages.js` | CC.createPage,CC.deletePage,CC.getPages,CC.updatePage | WORKING | Link hub / bio / cards |
| Tab: staff | `cybercheck-dashboard-platform/index.html:37 → js/staff.js` | CC.createStaff,CC.deleteStaff,CC.getStaff,CC.updateStaff | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Tab: inventory | `cybercheck-dashboard-platform/index.html:44 → js/inventory.js` | CC.createFleetType,CC.deleteFleetType,CC.getFleetTypes,CC.updateFleetType | WORKING+mock-fallback | Bookings & availability |
| Tab: availability | `cybercheck-dashboard-platform/index.html:48 → js/availability.js` | CC_API_BASE (default localhost:3000) | MOCK/STUB | Bookings & availability |
| Tab: addons | `cybercheck-dashboard-platform/index.html:52 → js/addons.js` | CC.createAddon,CC.deleteAddon,CC.getAddons,CC.updateAddon | WORKING | Bookings & availability |
| Tab: locations | `cybercheck-dashboard-platform/index.html:56 → js/locations.js` | site_content | WORKING | Bookings & availability |
| Tab: bookings | `cybercheck-dashboard-platform/index.html:60 → js/bookings.js` | CC.getBookings,CC.updateBooking | WORKING+mock-fallback | Bookings & availability |
| Tab: waivers | `cybercheck-dashboard-platform/index.html:65 → js/waivers.js` | CC_API_BASE (default localhost:3000) | MOCK/STUB | Bookings & availability |
| Tab: waitlist | `cybercheck-dashboard-platform/index.html:69 → js/waitlist.js` | CC_API_BASE (default localhost:3000) | MOCK/STUB | Bookings & availability |
| Tab: customers | `cybercheck-dashboard-platform/index.html:76 → js/customers.js` | CC.createCustomer,CC.getCustomers | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Tab: coupons | `cybercheck-dashboard-platform/index.html:80 → js/coupons.js` | /api/dashboard/sms/campaign,/api/dashboard/sms/campaigns,CC.createCoupon,CC.deleteCoupon,CC.getCoupons,CC.upda | WORKING+mock-fallback | Messaging / Marketing / Social |
| Tab: messaging | `cybercheck-dashboard-platform/index.html:87 → js/messaging.js` | /api/dashboard/messaging-settings | WORKING+mock-fallback | Messaging / Marketing / Social |
| Tab: reviews | `cybercheck-dashboard-platform/index.html:94 → js/reviews.js` | CC.getReviews,CC.updateReview | WORKING+mock-fallback | Reviews |
| Tab: analytics | `cybercheck-dashboard-platform/index.html:101 → js/analytics.js` | CC.getAnalytics | WORKING | Analytics & overview |
| Tab: seo | `cybercheck-dashboard-platform/index.html:105 → js/seo.js` | CC.createSEOPage,CC.generateSitemap,CC.getSEO,CC.updateRobotsTxt,CC.updateSEOPage,CC.updateSitemapConfig | WORKING | Website / Site builder / Publish |
| Tab: social | `cybercheck-dashboard-platform/index.html:109 → js/social.js` | CC.createSocialPost,CC.deleteSocialPost,CC.disconnectSocialAccount,CC.getSocialMedia,CC.updateSocialPost | WORKING | Messaging / Marketing / Social |
| Tab: billing | `cybercheck-dashboard-platform/index.html:116 → js/billing.js` | CC_API_BASE (default localhost:3000) | MOCK/STUB | Payments & billing |
| Tab: theme | `cybercheck-dashboard-platform/index.html:120 → js/theme.js` | CC.getTheme,CC.updateTheme | WORKING | Website / Site builder / Publish |
| Tab: connections | `cybercheck-dashboard-platform/index.html:124` | CC_API_BASE (default localhost:3000) | STATIC | App Store / Connections / Modules |
| Tab: site-editor | `cybercheck-dashboard-platform/index.html:128 → js/site-editor.js` | CC_API_BASE (default localhost:3000) | MOCK/STUB | Website / Site builder / Publish |
| Tab: domain | `cybercheck-dashboard-platform/index.html:132 → js/domain.js` | /api/verify-dns,CC.getDomain,CC.updateDomain | WORKING+mock-fallback | Website / Site builder / Publish |
| Tab: publish | `cybercheck-dashboard-platform/index.html:136 → js/publish.js` | CC.publish | WORKING | Website / Site builder / Publish |

### cybercheck-login

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| app-dashboard tab: overview | `app-dashboard.html:23 → js/overview.js` | inline | local-only | Analytics & overview |
| app-dashboard tab: profile | `app-dashboard.html:27 → js/profile.js` | /api/site-data,CC.getProfile,CC.updateProfile | WORKING | Directory / Business profile & content |
| app-dashboard tab: media | `app-dashboard.html:31 → js/media.js` | CC.getGallery | WORKING+mock-fallback | Directory / Business profile & content |
| app-dashboard tab: pages | `app-dashboard.html:35 → js/pages.js` | CC.createPage,CC.deletePage,CC.getPages,CC.updatePage | WORKING | Link hub / bio / cards |
| app-dashboard tab: staff | `app-dashboard.html:39 → js/staff.js` | CC.createStaff,CC.deleteStaff,CC.getStaff,CC.updateStaff | WORKING+mock-fallback | People / CRM / Accounts & auth |
| app-dashboard tab: menu | `app-dashboard.html:46 → js/menu.js` | /api/dashboard/ai/vision-providers,/api/dashboard/menu/extract,CC.compressImage,CC.createMenuItem,CC.deleteMen | WORKING | Menu / QR / Specials |
| app-dashboard tab: qr-codes | `app-dashboard.html:50 → js/qr-codes.js` | inline | MOCK/STUB | Menu / QR / Specials |
| app-dashboard tab: specials | `app-dashboard.html:54 → js/specials.js` | /api/dashboard/events/extract,CC.compressImage,CC.createSpecial,CC.deleteSpecial,CC.getSpecials,CC.updateSpeci | WORKING | Menu / QR / Specials |
| app-dashboard tab: events | `app-dashboard.html:58 → js/events.js` | /api/dashboard/events/extract,CC.compressImage,CC.createEvent,CC.deleteEvent,CC.getEvents,CC.updateEvent | WORKING | Events |
| app-dashboard tab: portfolio | `app-dashboard.html:65 → js/portfolio.js` | /api/portfolio | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: services | `app-dashboard.html:69 → js/services.js` | /api/services | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: rooms | `app-dashboard.html:73 → js/rooms.js` | CC.addExternalCalendar,CC.createUnit,CC.deleteExternalCalendar,CC.deleteUnit,CC.getExternalCalendars,CC.getUni | WORKING | Bookings & availability |
| app-dashboard tab: inventory | `app-dashboard.html:78 → js/inventory.js` | CC.createFleetType,CC.deleteFleetType,CC.getFleetTypes,CC.updateFleetType | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: availability | `app-dashboard.html:82 → js/availability.js` | CC.getAvailability,CC.setAvailability | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: blackout-dates | `app-dashboard.html:86 → js/blackout-dates.js` | CC.addBlackoutDate,CC.deleteBlackoutDate,CC.getBlackoutDates | WORKING | Bookings & availability |
| app-dashboard tab: calendar-sync | `app-dashboard.html:90 → js/calendar-sync.js` | CC.addExternalCalendar,CC.deleteExternalCalendar,CC.getExternalCalendars,CC.getIcalFeedUrl,CC.regenerateIcalFe | WORKING | Bookings & availability |
| app-dashboard tab: addons | `app-dashboard.html:94 → js/addons.js` | CC.createAddon,CC.deleteAddon,CC.getAddons,CC.updateAddon | WORKING | Bookings & availability |
| app-dashboard tab: locations | `app-dashboard.html:98 → js/locations.js` | CC.createLocation,CC.deleteLocation,CC.getLocations,CC.updateLocation | WORKING | Bookings & availability |
| app-dashboard tab: bookings | `app-dashboard.html:102 → js/bookings.js` | /api/dashboard/declined-bookings,/api/public/resend-confirmation,/api/public/waivers/send-link,/api/stripe/ref | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: waivers | `app-dashboard.html:107 → js/waivers.js` | CC.deleteDocument,CC.getWaiverTemplate,CC.getWaivers,CC.updateWaiverTemplate,CC.uploadDocument | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: policies | `app-dashboard.html:111 → js/policies.js` | CC.deleteDocument,CC.getPolicies,CC.updatePolicies,CC.uploadDocument | WORKING+mock-fallback | Directory / Business profile & content |
| app-dashboard tab: transportation | `app-dashboard.html:115 → js/transportation.js` | CC.addTransportProvider,CC.deleteTransportProvider,CC.getTransportProviders,CC.getTransportRequests,CC.getTran | WORKING | Bookings & availability |
| app-dashboard tab: waitlist | `app-dashboard.html:119 → js/waitlist.js` | CC.deleteWaitlistEntry,CC.getWaitlist,CC.updateWaitlistEntry,CC.updateWaitlistSettings | WORKING | Bookings & availability |
| app-dashboard tab: customers | `app-dashboard.html:130 → js/customers.js` | /api/dashboard/contacts/scan-card,CC.createCustomer,CC.getCustomers,CC.getToken,CC.updateCustomer | WORKING+mock-fallback | People / CRM / Accounts & auth |
| app-dashboard tab: coupons | `app-dashboard.html:134 → js/coupons.js` | /api/dashboard/sms/campaign,/api/dashboard/sms/campaigns,CC.createCoupon,CC.deleteCoupon,CC.getCoupons,CC.upda | WORKING+mock-fallback | Messaging / Marketing / Social |
| app-dashboard tab: messaging | `app-dashboard.html:141 → js/messaging.js` | /api/whatsapp/send,CC.getMessaging,CC.updateMessaging | WORKING+mock-fallback | Messaging / Marketing / Social |
| app-dashboard tab: reviews | `app-dashboard.html:148 → js/reviews.js` | /api/dashboard/google-business/status,/api/dashboard/google-business/sync-reviews,CC.createReviewQuestion,CC.c | WORKING+mock-fallback | Reviews |
| app-dashboard tab: analytics | `app-dashboard.html:155 → js/analytics.js` | CC.getAnalytics | WORKING | Analytics & overview |
| app-dashboard tab: seo | `app-dashboard.html:159 → js/seo.js` | CC.createSEOPage,CC.generateSitemap,CC.getSEO,CC.getTrackingSettings,CC.updateRobotsTxt,CC.updateSEOPage,CC.up | WORKING | Website / Site builder / Publish |
| app-dashboard tab: social | `app-dashboard.html:163 → js/social.js` | CC.createSocialPost,CC.deleteSocialPost,CC.disconnectSocialAccount,CC.getSocialMedia,CC.updateSocialPost | WORKING | Messaging / Marketing / Social |
| app-dashboard tab: faq | `app-dashboard.html:167 → js/faq.js` | CC.createFAQ,CC.deleteFAQ,CC.getFAQs,CC.updateFAQ | WORKING | Directory / Business profile & content |
| app-dashboard tab: billing | `app-dashboard.html:181 → js/billing.js` | inline | MOCK/STUB | Payments & billing |
| app-dashboard tab: theme | `app-dashboard.html:185 → js/theme.js` | CC.getTheme,CC.updateTheme | WORKING | Website / Site builder / Publish |
| app-dashboard tab: connections | `app-dashboard.html:189` | inline | STATIC | App Store / Connections / Modules |
| app-dashboard tab: website-content | `app-dashboard.html:193 → js/website-content.js` | /api/dashboard/addons,/api/dashboard/addons/sync,/api/dashboard/fleet,/api/dashboard/fleet/,/api/dashboard/med | WORKING+mock-fallback | Directory / Business profile & content |
| app-dashboard tab: site-editor | `app-dashboard.html:197 → js/site-editor.js` | /api/site-data | WORKING+mock-fallback | Website / Site builder / Publish |
| app-dashboard tab: domain | `app-dashboard.html:201 → js/domain.js` | /api/verify-dns,CC.getDomain,CC.updateDomain | WORKING+mock-fallback | Website / Site builder / Publish |
| app-dashboard tab: publish | `app-dashboard.html:205 → js/publish.js` | CC.publish | WORKING | Website / Site builder / Publish |
| admin tab: overview | `admin.html:76 → js/overview.js` | inline | local-only | Analytics & overview |
| admin tab: menu-builder | `admin.html:83` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Menu / QR / Specials |
| admin tab: qr-menus | `admin.html:87` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Menu / QR / Specials |
| admin tab: qr-tracker | `admin.html:91` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Menu / QR / Specials |
| admin tab: reviews | `admin.html:95 → js/reviews.js` | /api/dashboard/google-business/status,/api/dashboard/google-business/sync-reviews,CC.createReviewQuestion,CC.c | WORKING+mock-fallback | Reviews |
| admin tab: referral-partners | `admin.html:99` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: daily-update-links | `admin.html:103` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Menu / QR / Specials |
| admin tab: menu-editors-hub | `admin.html:107` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Menu / QR / Specials |
| admin tab: gcr-businesses | `admin.html:114` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Directory / Business profile & content |
| admin tab: gcr-entity-editor | `admin.html:118` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Directory / Business profile & content |
| admin tab: gcr-site-editor | `admin.html:122` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Website / Site builder / Publish |
| admin tab: gcr-claims | `admin.html:126` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | People / CRM / Accounts & auth |
| admin tab: gcr-events | `admin.html:133` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Events |
| admin tab: gcr-artists | `admin.html:137` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Artist / Song requests & tips |
| admin tab: artist-profiles | `admin.html:141` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Artist / Song requests & tips |
| admin tab: gcr-specials | `admin.html:145` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Menu / QR / Specials |
| admin tab: gcr-ads | `admin.html:149` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: gcr-rails | `admin.html:153` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: ai-config | `admin.html:157` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | AI tools |
| admin tab: gcr-coupons | `admin.html:161` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: gcr-seo | `admin.html:165` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Website / Site builder / Publish |
| admin tab: bulk-upload | `admin.html:169` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: bulk-events | `admin.html:173` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Events |
| admin tab: ai-chat | `admin.html:180` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | AI tools |
| admin tab: ai-organize | `admin.html:184` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | AI tools |
| admin tab: rag-index | `admin.html:188` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | AI tools |
| admin tab: ai-settings | `admin.html:192` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | AI tools |
| admin tab: gcr-analytics | `admin.html:199` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Analytics & overview |
| admin tab: gcr-reviews | `admin.html:203` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Reviews |
| admin tab: gcr-customers | `admin.html:207` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | People / CRM / Accounts & auth |
| admin tab: gcr-messaging | `admin.html:211` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: gcr-social | `admin.html:215` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Messaging / Marketing / Social |
| admin tab: tripswipe-overview | `admin.html:222` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-businesses | `admin.html:226` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-tourists | `admin.html:230` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-analytics | `admin.html:234` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-ai | `admin.html:238` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-concierge-test | `admin.html:242` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: trip-swipe-questions | `admin.html:246` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-sponsored | `admin.html:250` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-tonight | `admin.html:254` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-points | `admin.html:258` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-sms-qr | `admin.html:262` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: platform-auth | `admin.html:266` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: trip-swipe-button | `admin.html:270` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: sms-settings | `admin.html:274` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: sms-blasts | `admin.html:278` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: business-leads | `admin.html:282` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: community-photos | `admin.html:286` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: app-manager | `admin.html:293` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | App Store / Connections / Modules |
| admin tab: biz-apps | `admin.html:297` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | App Store / Connections / Modules |
| admin tab: businesses | `admin.html:302` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Directory / Business profile & content |
| admin tab: leads | `admin.html:306 → js/leads.js` | inline | MOCK/STUB | Messaging / Marketing / Social |
| admin tab: bookings | `admin.html:310 → js/bookings.js` | /api/dashboard/declined-bookings,/api/public/resend-confirmation,/api/public/waivers/send-link,/api/stripe/ref | WORKING+mock-fallback | Bookings & availability |
| admin tab: sales-pages | `admin.html:314` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Website / Site builder / Publish |
| admin tab: ar-hunts | `admin.html:318` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Trip Swipe / Consumer engagement |
| admin tab: integrations | `admin.html:322` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | App Store / Connections / Modules |
| admin tab: users | `admin.html:326` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | People / CRM / Accounts & auth |
| admin tab: api-keys | `admin.html:330` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | App Store / Connections / Modules |
| admin tab: settings | `admin.html:334` | inline JS in admin.html → API_BASE gcr-api-clean | WORKING | Settings / System / Misc |
| admin-dashboard tab: menu | `admin-dashboard.html:1369 → js/menu.js` | /api/dashboard/ai/vision-providers,/api/dashboard/menu/extract,CC.compressImage,CC.createMenuItem,CC.deleteMen | WORKING | Menu / QR / Specials |
| admin-dashboard tab: drinks | `admin-dashboard.html:1370` | inline | STATIC | Menu / QR / Specials |
| admin-dashboard tab: happy-hour | `admin-dashboard.html:1371` | inline | STATIC | Menu / QR / Specials |
| admin-dashboard tab: specials | `admin-dashboard.html:1372 → js/specials.js` | /api/dashboard/events/extract,CC.compressImage,CC.createSpecial,CC.deleteSpecial,CC.getSpecials,CC.updateSpeci | WORKING | Menu / QR / Specials |
| admin-dashboard tab: events | `admin-dashboard.html:1373 → js/events.js` | /api/dashboard/events/extract,CC.compressImage,CC.createEvent,CC.deleteEvent,CC.getEvents,CC.updateEvent | WORKING | Events |
| admin-dashboard tab: bulk-upload | `admin-dashboard.html:1374` | inline | STATIC | Messaging / Marketing / Social |
| Standalone page: admin-pricing.html (Manage Pricing Packages - CyberCheck Admin) | `admin-pricing.html:1` |  | MOCK/STUB | Bookings & availability |
| Standalone page: ai-chat.html (AI Assistant - CyberCheck) | `ai-chat.html:1` | /api/dashboard/ai-chat | WORKING+mock-fallback | AI tools |
| Standalone page: app-store.html (App Store — CyberCheck) | `app-store.html:1` | /api/apps,/api/apps/install,/api/apps/uninstall/ | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: audit.html (Audit Log - CyberCheck) | `audit.html:1` |  | STATIC | Ledger / Paper Trail / Audit |
| Standalone page: automation-builder.html (Automations - CyberCheck) | `automation-builder.html:1` |  | STATIC | Automations |
| Standalone page: automation-setup.html (Create Automation - CyberCheck) | `automation-setup.html:1` |  | MOCK/STUB | Automations |
| Standalone page: automation-templates.html (Automation Templates - CyberCheck) | `automation-templates.html:1` |  | STATIC | Automations |
| Standalone page: automations.html (CyberCheck Automations — One Action. Everything Updates.) | `automations.html:1` |  | MOCK/STUB | Automations |
| Standalone page: beachside-circle-boats-dashboard.html (Business Dashboard - CyberCheck) | `beachside-circle-boats-dashboard.html:1` | /api/apps,/api/apps/install,/api/apps/uninstall/ | WORKING+mock-fallback | Analytics & overview |
| Standalone page: biz.html (Loading…) | `biz.html:1` | /api/platform/page/ | WORKING | Onboarding / Setup |
| Standalone page: book.html (Book — Loading…) | `book.html:1` | /api/platform/page/,/api/stripe/config,/api/stripe/create-payment-intent | WORKING+mock-fallback | Bookings & availability |
| Standalone page: booking.html (aWavegent Booking — Zero-Fee Booking for Rentals, Charters &) | `booking.html:1` |  | STATIC | Bookings & availability |
| Standalone page: bookpro-start.html (Get started — BookPro) | `bookpro-start.html:1` |  | MOCK/STUB | Bookings & availability |
| Standalone page: bookpro.html (BookPro — The Universal Booking Platform) | `bookpro.html:1` |  | STATIC | Bookings & availability |
| Standalone page: card-builder.html (Build Your Card - CyberCheck) | `card-builder.html:1` |  | MOCK/STUB | Link hub / bio / cards |
| Standalone page: card.html (Matt Johnson — Gulf Coast Radar / CyberCheck) | `card.html:1` | /api/gcr/lead-notify | WORKING+mock-fallback | Link hub / bio / cards |
| Standalone page: claim-business.html (Set Up Your Account) | `claim-business.html:1` |  | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Standalone page: connection-manager-dynamic.html (Connect Your Tools - CyberCheck) | `connection-manager-dynamic.html:1` |  | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: connection-manager.html (Connect Your Tools - CyberCheck) | `connection-manager.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: create-workflow-ai.html (Create Workflow - CyberCheck) | `create-workflow-ai.html:1` |  | WORKING+mock-fallback | Automations |
| Standalone page: customer-dashboard.html (My Business Cards - CyberCheck Dashboard) | `customer-dashboard.html:1` |  | MOCK/STUB | Analytics & overview |
| Standalone page: dashboard-charter.html (Gulf Adventure Charters - Dashboard) | `dashboard-charter.html:1` |  | STATIC | Bookings & availability |
| Standalone page: dashboard-restaurant.html (Joe's Pizza - Dashboard) | `dashboard-restaurant.html:1` |  | MOCK/STUB | Menu / QR / Specials |
| Standalone page: demo.html (CyberCheck Demo Access) | `demo.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: enter-stripe-key.html (Add Stripe Account) | `enter-stripe-key.html:1` |  | WORKING+mock-fallback | Payments & billing |
| Standalone page: gcr-entity-manager.html (GCR Entity Manager — CyberCheck Admin) | `gcr-entity-manager.html:1` | supabase | WORKING+mock-fallback | Directory / Business profile & content |
| Standalone page: index.html (CyberCheck - AI-Powered Business Dashboard with Voice Automa) | `index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: industries.html (Industries - Built for Restaurants, Charters & SMBs / CyberC) | `industries.html:1` |  | STATIC | Bookings & availability |
| Standalone page: installed-apps.html (Installed Apps - CyberCheck) | `installed-apps.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/alfio/alfio.html () | `integrations/alfio/alfio.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/artist-schedule/artist-schedule.html () | `integrations/artist-schedule/artist-schedule.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/booking/booking.html () | `integrations/booking/booking.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/castopod/castopod.html () | `integrations/castopod/castopod.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/easy-appointments/easy-appointments.html () | `integrations/easy-appointments/easy-appointments.html:1` | /api/v1/services | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/events/events.html () | `integrations/events/events.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/frappe/frappe.html () | `integrations/frappe/frappe.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/happy-hour/happy-hour.html () | `integrations/happy-hour/happy-hour.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/menu-no-images/menu-no-images.html () | `integrations/menu-no-images/menu-no-images.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/menu-with-images/menu-with-images.html () | `integrations/menu-with-images/menu-with-images.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/open-food-network/open-food-network.html () | `integrations/open-food-network/open-food-network.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/open-loyalty/open-loyalty.html () | `integrations/open-loyalty/open-loyalty.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/open-table-alt/open-table-alt.html () | `integrations/open-table-alt/open-table-alt.html:1` | supabase | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: integrations/rallly/rallly.html () | `integrations/rallly/rallly.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/shared/shared.html () | `integrations/shared/shared.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/specials/specials.html () | `integrations/specials/specials.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: login.html (Login - CyberCheck) | `login.html:1` | /api/auth/create-profile,https://gcr-api-clean.vercel.app/api/admin/login | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Standalone page: manage.html (Manage booking) | `manage.html:1` | /api/platform/manage/,/api/platform/page/ | WORKING | Settings / System / Misc |
| Standalone page: menu-editor-dark.html (Daily Update) | `menu-editor-dark.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-editor-popup.html (Menu Editor) | `menu-editor-popup.html:1` | /api/menu-editor/ | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-editor.html (Daily Update) | `menu-editor.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-setup.html (Menu Setup — ${esc(name)}) | `menu-setup.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-update.html (Menu Update) | `menu-update.html:1` | https://gcr-api-clean.vercel.app/api/gcr | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-updates.html (Daily Menu Update System — Gulf Coast Radar) | `menu-updates.html:1` |  | MOCK/STUB | Menu / QR / Specials |
| Standalone page: modular-dashboard.html (CyberCheck — Modular Dashboard) | `modular-dashboard.html:1` | /api/auth/login,/api/auth/signup,/api/platform,/api/square/connect-url,/api/square/disconnect,/api/square/save | WORKING+mock-fallback | Analytics & overview |
| Standalone page: navigation-demo.html (Navigation Demo - CyberCheck) | `navigation-demo.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: onboarding-links.html (CyberCheck — Pick Your Tools) | `onboarding-links.html:1` | sb:installed_modules,sb:profiles | WORKING | Link hub / bio / cards |
| Standalone page: onboarding.html (Get Started — CyberCheck) | `onboarding.html:1` | /api/apps,/api/apps/install,/api/site/content | WORKING+mock-fallback | Onboarding / Setup |
| Standalone page: page.html (Loading…) | `page.html:1` | https://gcr-api-clean.vercel.app/api/gcr | WORKING | Link hub / bio / cards |
| Standalone page: photo-repair.html (Photo Repair - CyberCheck Admin) | `photo-repair.html:1` | /api/admin/repair-photos,/api/admin/repair-photos/status | WORKING | Directory / Business profile & content |
| Standalone page: platform.html (All-in-One Platform - Replace Monday, Zapier & Custom Dashbo) | `platform.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: preview.html (Data Preview — Before Saving to DB) | `preview.html:1` | /api/admin/save-preview-data | WORKING+mock-fallback | Website / Site builder / Publish |
| Standalone page: profile-editor.html (Edit Public Profile - CyberCheck) | `profile-editor.html:1` | /api/profile/update | WORKING+mock-fallback | Directory / Business profile & content |
| Standalone page: public.html (Joe's Pizza - Links) | `public.html:1` |  | STATIC | Link hub / bio / cards |
| Standalone page: q.html (Gulf Coast Radar) | `q.html:1` | /api/qr/scan/ | WORKING | Link hub / bio / cards |
| Standalone page: restaurant-editor.html (Menu Update) | `restaurant-editor.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: reviews.html (CyberCheck Reviews — Real Purchases. Real Reviews. Real Trus) | `reviews.html:1` |  | MOCK/STUB | Reviews |
| Standalone page: sales.html (CyberCheck — The Complete Platform for Gulf Coast Businesses) | `sales.html:1` |  | STATIC | Website / Site builder / Publish |
| Standalone page: settings.html (Settings - CyberCheck) | `settings.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: signup.html (Sign Up - CyberCheck) | `signup.html:1` |  | MOCK/STUB | People / CRM / Accounts & auth |
| Standalone page: song-request.html (Request a Song / Get Sideways) | `song-request.html:1` |  | WORKING+mock-fallback | Artist / Song requests & tips |
| Standalone page: sql-setup.html (GCR SQL Setup - Copy & Run) | `sql-setup.html:1` | supabase | WORKING | Settings / System / Misc |
| Standalone page: tool-selection.html (Select Your Tools - CyberCheck) | `tool-selection.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: waiver.html (Sign waiver) | `waiver.html:1` | /api/platform/waiver-info/,/api/platform/waiver-sign/ | WORKING+mock-fallback | Bookings & availability |
| Standalone page: widget.html (Availability) | `widget.html:1` | /api/gcr/entity/ | WORKING | Website / Site builder / Publish |
| Standalone page: workflow-logs.html (Workflow Logs - CyberCheck) | `workflow-logs.html:1` |  | WORKING | Automations |

### cybercheck-orchestrator

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Module: availability (Check Availability) | `modules/availability/manifest.json:1` | kernel capabilities availability.* | WORKING | Bookings & availability |
| Module: business_profile | `modules/business_profile/index.js:1` | kernel | WORKING | Directory / Business profile & content |
| HTTP surface (no UI): Packages/marketplace | `src/http/server.js:37` | /api/packages | API-only | App Store / Connections / Modules |
| HTTP surface (no UI): Installs | `src/http/server.js:39` | /api/b/:slug/installs | API-only | App Store / Connections / Modules |
| HTTP surface (no UI): Approvals | `src/http/server.js:69` | /api/b/:slug/approvals | API-only | Fleet / Paperclip / Agents |
| HTTP surface (no UI): Receipts (ledger) | `src/http/server.js:85` | /api/b/:slug/receipts | API-only | Ledger / Paper Trail / Audit |
| HTTP surface (no UI): Device apps | `src/http/server.js:111` | /api/b/:slug/device/apps | API-only | Box / Ghost / Phone |
| HTTP surface (no UI): Device screen | `src/http/server.js:136` | /api/b/:slug/device/screen | API-only | Box / Ghost / Phone |
| HTTP surface (no UI): Automations | `src/http/server.js:156` | /api/b/:slug/automations | API-only | Automations |
| HTTP surface (no UI): Tokens | `src/http/server.js:179` | /api/b/:slug/tokens | API-only | Fleet / Paperclip / Agents |
| HTTP surface (no UI): Link page | `src/http/server.js:191` | /l/:slug | API-only | Link hub / bio / cards |
| HTTP surface (no UI): Embed section | `src/http/server.js:196` | /embed/:slug/:section | API-only | Website / Site builder / Publish |
| HTTP surface (no UI): Public availability search | `src/http/server.js:203` | /public/:slug/availability/search | API-only | Link hub / bio / cards |
| HTTP surface (no UI): Providers | `src/http/server.js:225` | /api/b/:slug/providers | API-only | App Store / Connections / Modules |
| HTTP surface (no UI): Routing | `src/http/server.js:241` | /api/b/:slug/routing | API-only | Fleet / Paperclip / Agents |
| HTTP surface (no UI): Harness | `src/http/server.js:245` | /api/b/:slug/harness | API-only | Fleet / Paperclip / Agents |
| HTTP surface (no UI): MCP | `src/http/server.js:167` | /mcp/:slug | API-only | Fleet / Paperclip / Agents |

### cybercheck-saas

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Onboarding step: What kind of business are you? | `public/onboarding.html:215` | API_BASE + path (onboarding.html:731) | WORKING | Onboarding / Setup |
| Onboarding step: Tell us about your business | `public/onboarding.html:261` | API_BASE + path (onboarding.html:731) | WORKING | Onboarding / Setup |
| Onboarding step: Add what you're renting or offering | `public/onboarding.html:319` | API_BASE + path (onboarding.html:731) | WORKING | Onboarding / Setup |
| Onboarding step: Connect your payment account | `public/onboarding.html:336` | API_BASE + path (onboarding.html:731) | WORKING | Onboarding / Setup |
| Onboarding step: Design your booking page | `public/onboarding.html:360` | API_BASE + path (onboarding.html:731) | WORKING | Onboarding / Setup |
| Onboarding step: You're ready to go live! | `public/onboarding.html:375` | API_BASE + path (onboarding.html:731) | WORKING | Onboarding / Setup |
| Page: public/login.html | `public/login.html:1` | API_BASE /auth/*, /public/booking | WORKING | People / CRM / Accounts & auth |
| Page: public/signup.html | `public/signup.html:1` | API_BASE /auth/*, /public/booking | WORKING | People / CRM / Accounts & auth |
| Page: public/forgot-password.html | `public/forgot-password.html:1` | API_BASE /auth/*, /public/booking | WORKING | People / CRM / Accounts & auth |
| Page: site-template/index.html | `site-template/index.html:1` | API_BASE /auth/*, /public/booking | WORKING | Settings / System / Misc |
| Page: embed.js | `embed.js:1` | API_BASE /auth/*, /public/booking | WORKING | Website / Site builder / Publish |

### gcr-admin

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| app-dashboard tab: overview | `app-dashboard.html:23 → js/overview.js` | inline | local-only | Analytics & overview |
| app-dashboard tab: profile | `app-dashboard.html:27 → js/profile.js` | /api/site-data,CC.getProfile,CC.updateProfile | WORKING | Directory / Business profile & content |
| app-dashboard tab: media | `app-dashboard.html:31 → js/media.js` | CC.getGallery | WORKING+mock-fallback | Directory / Business profile & content |
| app-dashboard tab: pages | `app-dashboard.html:35 → js/pages.js` | CC.createPage,CC.deletePage,CC.getPages,CC.updatePage | WORKING | Link hub / bio / cards |
| app-dashboard tab: staff | `app-dashboard.html:39 → js/staff.js` | CC.createStaff,CC.deleteStaff,CC.getStaff,CC.updateStaff | WORKING+mock-fallback | People / CRM / Accounts & auth |
| app-dashboard tab: menu | `app-dashboard.html:46 → js/menu.js` | /api/dashboard/ai/vision-providers,/api/dashboard/menu/extract,CC.compressImage,CC.createMenuItem,CC.deleteMen | WORKING | Menu / QR / Specials |
| app-dashboard tab: qr-codes | `app-dashboard.html:50 → js/qr-codes.js` | inline | MOCK/STUB | Menu / QR / Specials |
| app-dashboard tab: specials | `app-dashboard.html:54 → js/specials.js` | /api/dashboard/events/extract,CC.compressImage,CC.createSpecial,CC.deleteSpecial,CC.getSpecials,CC.updateSpeci | WORKING | Menu / QR / Specials |
| app-dashboard tab: events | `app-dashboard.html:58 → js/events.js` | /api/dashboard/events/extract,CC.compressImage,CC.createEvent,CC.deleteEvent,CC.getEvents,CC.updateEvent | WORKING | Events |
| app-dashboard tab: portfolio | `app-dashboard.html:65 → js/portfolio.js` | /api/portfolio | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: services | `app-dashboard.html:69 → js/services.js` | /api/services | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: rooms | `app-dashboard.html:73 → js/rooms.js` | /api/rooms | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: inventory | `app-dashboard.html:78 → js/inventory.js` | CC.createFleetType,CC.deleteFleetType,CC.getFleetTypes,CC.updateFleetType | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: availability | `app-dashboard.html:82 → js/availability.js` | CC.getAvailability,CC.setAvailability | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: blackout-dates | `app-dashboard.html:86 → js/blackout-dates.js` | CC.addBlackoutDate,CC.deleteBlackoutDate,CC.getBlackoutDates | WORKING | Bookings & availability |
| app-dashboard tab: addons | `app-dashboard.html:90 → js/addons.js` | CC.createAddon,CC.deleteAddon,CC.getAddons,CC.updateAddon | WORKING | Bookings & availability |
| app-dashboard tab: locations | `app-dashboard.html:94 → js/locations.js` | CC.createLocation,CC.deleteLocation,CC.getLocations,CC.updateLocation | WORKING | Bookings & availability |
| app-dashboard tab: bookings | `app-dashboard.html:98 → js/bookings.js` | /api/stripe/refund,CC.getBookings,CC.getToken,CC.updateBooking,https://gcr-api.vercel.app/api/dashboard/declin | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: waivers | `app-dashboard.html:103 → js/waivers.js` | CC.getSiteId,CC.getWaivers,documents | WORKING+mock-fallback | Bookings & availability |
| app-dashboard tab: waitlist | `app-dashboard.html:107 → js/waitlist.js` | CC.deleteWaitlistEntry,CC.getWaitlist,CC.updateWaitlistEntry,CC.updateWaitlistSettings | WORKING | Bookings & availability |
| app-dashboard tab: customers | `app-dashboard.html:114 → js/customers.js` | /api/dashboard/contacts/scan-card,CC.createCustomer,CC.getCustomers,CC.getToken,CC.updateCustomer | WORKING+mock-fallback | People / CRM / Accounts & auth |
| app-dashboard tab: coupons | `app-dashboard.html:118 → js/coupons.js` | /api/dashboard/sms/campaign,/api/dashboard/sms/campaigns,CC.createCoupon,CC.deleteCoupon,CC.getCoupons,CC.upda | WORKING+mock-fallback | Messaging / Marketing / Social |
| app-dashboard tab: messaging | `app-dashboard.html:125 → js/messaging.js` | /api/whatsapp/send,CC.getMessaging,CC.updateMessaging | WORKING+mock-fallback | Messaging / Marketing / Social |
| app-dashboard tab: reviews | `app-dashboard.html:132 → js/reviews.js` | /api/dashboard/google-business/status,/api/dashboard/google-business/sync-reviews,CC.createReviewQuestion,CC.c | WORKING+mock-fallback | Reviews |
| app-dashboard tab: analytics | `app-dashboard.html:139 → js/analytics.js` | CC.getAnalytics | WORKING | Analytics & overview |
| app-dashboard tab: seo | `app-dashboard.html:143 → js/seo.js` | CC.createSEOPage,CC.generateSitemap,CC.getSEO,CC.getTrackingSettings,CC.updateRobotsTxt,CC.updateSEOPage,CC.up | WORKING | Website / Site builder / Publish |
| app-dashboard tab: social | `app-dashboard.html:147 → js/social.js` | CC.createSocialPost,CC.deleteSocialPost,CC.disconnectSocialAccount,CC.getSocialMedia,CC.updateSocialPost | WORKING | Messaging / Marketing / Social |
| app-dashboard tab: faq | `app-dashboard.html:151 → js/faq.js` | CC.createFAQ,CC.deleteFAQ,CC.getFAQs,CC.updateFAQ | WORKING | Directory / Business profile & content |
| app-dashboard tab: billing | `app-dashboard.html:165 → js/billing.js` | inline | MOCK/STUB | Payments & billing |
| app-dashboard tab: theme | `app-dashboard.html:169 → js/theme.js` | CC.getTheme,CC.updateTheme | WORKING | Website / Site builder / Publish |
| app-dashboard tab: connections | `app-dashboard.html:173` | inline | STATIC | App Store / Connections / Modules |
| app-dashboard tab: website-content | `app-dashboard.html:177 → js/website-content.js` | /api/dashboard/addons,/api/dashboard/addons/sync,/api/dashboard/fleet,/api/dashboard/fleet/,/api/dashboard/pro | WORKING+mock-fallback | Directory / Business profile & content |
| app-dashboard tab: site-editor | `app-dashboard.html:181 → js/site-editor.js` | /api/site-data | WORKING+mock-fallback | Website / Site builder / Publish |
| app-dashboard tab: domain | `app-dashboard.html:185 → js/domain.js` | /api/verify-dns,CC.getDomain,CC.updateDomain | WORKING+mock-fallback | Website / Site builder / Publish |
| app-dashboard tab: publish | `app-dashboard.html:189 → js/publish.js` | CC.publish | WORKING | Website / Site builder / Publish |
| admin tab: overview | `admin.html:46 → js/overview.js` | inline | local-only | Analytics & overview |
| admin tab: menu-builder | `admin.html:53` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Menu / QR / Specials |
| admin tab: qr-menus | `admin.html:57` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Menu / QR / Specials |
| admin tab: qr-tracker | `admin.html:61` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Menu / QR / Specials |
| admin tab: reviews | `admin.html:65 → js/reviews.js` | /api/dashboard/google-business/status,/api/dashboard/google-business/sync-reviews,CC.createReviewQuestion,CC.c | WORKING+mock-fallback | Reviews |
| admin tab: referral-partners | `admin.html:69` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Messaging / Marketing / Social |
| admin tab: daily-update-links | `admin.html:73` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Menu / QR / Specials |
| admin tab: gcr-businesses | `admin.html:84` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Directory / Business profile & content |
| admin tab: gcr-entity-editor | `admin.html:88` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Directory / Business profile & content |
| admin tab: gcr-site-editor | `admin.html:92` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Website / Site builder / Publish |
| admin tab: gcr-claims | `admin.html:96` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | People / CRM / Accounts & auth |
| admin tab: gcr-events | `admin.html:103` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Events |
| admin tab: gcr-specials | `admin.html:107` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Menu / QR / Specials |
| admin tab: gcr-ads | `admin.html:111` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Messaging / Marketing / Social |
| admin tab: gcr-coupons | `admin.html:115` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Messaging / Marketing / Social |
| admin tab: gcr-seo | `admin.html:119` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Website / Site builder / Publish |
| admin tab: bulk-upload | `admin.html:123` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Messaging / Marketing / Social |
| admin tab: bulk-events | `admin.html:127` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Events |
| admin tab: ai-chat | `admin.html:134` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | AI tools |
| admin tab: ai-organize | `admin.html:138` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | AI tools |
| admin tab: rag-index | `admin.html:142` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | AI tools |
| admin tab: ai-settings | `admin.html:146` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | AI tools |
| admin tab: gcr-analytics | `admin.html:153` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Analytics & overview |
| admin tab: gcr-reviews | `admin.html:157` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Reviews |
| admin tab: gcr-customers | `admin.html:161` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | People / CRM / Accounts & auth |
| admin tab: gcr-messaging | `admin.html:165` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Messaging / Marketing / Social |
| admin tab: gcr-social | `admin.html:169` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Messaging / Marketing / Social |
| admin tab: tripswipe-overview | `admin.html:176` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-businesses | `admin.html:180` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-tourists | `admin.html:184` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-analytics | `admin.html:188` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-ai | `admin.html:192` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-concierge-test | `admin.html:196` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: trip-swipe-questions | `admin.html:200` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-sponsored | `admin.html:204` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: tripswipe-tonight | `admin.html:208` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: platform-auth | `admin.html:212` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: trip-swipe-button | `admin.html:216` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: sms-settings | `admin.html:220` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: sms-blasts | `admin.html:224` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: business-leads | `admin.html:228` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: community-photos | `admin.html:232` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: app-manager | `admin.html:239` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | App Store / Connections / Modules |
| admin tab: biz-apps | `admin.html:243` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | App Store / Connections / Modules |
| admin tab: businesses | `admin.html:248` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Directory / Business profile & content |
| admin tab: leads | `admin.html:252 → js/leads.js` | inline | MOCK/STUB | Messaging / Marketing / Social |
| admin tab: bookings | `admin.html:256 → js/bookings.js` | /api/stripe/refund,CC.getBookings,CC.getToken,CC.updateBooking,https://gcr-api.vercel.app/api/dashboard/declin | WORKING+mock-fallback | Bookings & availability |
| admin tab: sales-pages | `admin.html:260` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Website / Site builder / Publish |
| admin tab: ar-hunts | `admin.html:264` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Trip Swipe / Consumer engagement |
| admin tab: integrations | `admin.html:268` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | App Store / Connections / Modules |
| admin tab: users | `admin.html:272` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | People / CRM / Accounts & auth |
| admin tab: api-keys | `admin.html:276` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | App Store / Connections / Modules |
| admin tab: settings | `admin.html:280` | inline JS in admin.html → API_BASE gcr-api-clean-fresh | WORKING | Settings / System / Misc |
| admin-dashboard tab: menu | `admin-dashboard.html:1365 → js/menu.js` | /api/dashboard/ai/vision-providers,/api/dashboard/menu/extract,CC.compressImage,CC.createMenuItem,CC.deleteMen | WORKING | Menu / QR / Specials |
| admin-dashboard tab: drinks | `admin-dashboard.html:1366` | inline | STATIC | Menu / QR / Specials |
| admin-dashboard tab: happy-hour | `admin-dashboard.html:1367` | inline | STATIC | Menu / QR / Specials |
| admin-dashboard tab: specials | `admin-dashboard.html:1368 → js/specials.js` | /api/dashboard/events/extract,CC.compressImage,CC.createSpecial,CC.deleteSpecial,CC.getSpecials,CC.updateSpeci | WORKING | Menu / QR / Specials |
| admin-dashboard tab: events | `admin-dashboard.html:1369 → js/events.js` | /api/dashboard/events/extract,CC.compressImage,CC.createEvent,CC.deleteEvent,CC.getEvents,CC.updateEvent | WORKING | Events |
| admin-dashboard tab: bulk-upload | `admin-dashboard.html:1370` | inline | STATIC | Messaging / Marketing / Social |
| Standalone page: about.html (About Ghost - The Power Company of AI) | `about.html:1` |  | STATIC | Directory / Business profile & content |
| Standalone page: admin-pricing.html (Manage Pricing Packages - CyberCheck Admin) | `admin-pricing.html:1` |  | MOCK/STUB | Bookings & availability |
| Standalone page: ai-chat.html (AI Assistant - CyberCheck) | `ai-chat.html:1` | supabase | WORKING+mock-fallback | AI tools |
| Standalone page: analytics.html (Analytics - Ghost Marketplace) | `analytics.html:1` |  | STATIC | Analytics & overview |
| Standalone page: app-store.html (App Store — CyberCheck) | `app-store.html:1` | /api/apps,/api/apps/install,/api/apps/uninstall/ | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: audit.html (Audit Log - CyberCheck) | `audit.html:1` |  | STATIC | Ledger / Paper Trail / Audit |
| Standalone page: automation-builder.html (Automations - CyberCheck) | `automation-builder.html:1` |  | STATIC | Automations |
| Standalone page: automation-setup.html (Create Automation - CyberCheck) | `automation-setup.html:1` |  | MOCK/STUB | Automations |
| Standalone page: automation-templates.html (Automation Templates - CyberCheck) | `automation-templates.html:1` |  | STATIC | Automations |
| Standalone page: automations.html (CyberCheck Automations — One Action. Everything Updates.) | `automations.html:1` |  | MOCK/STUB | Automations |
| Standalone page: beachside-circle-boats-dashboard.html (Business Dashboard - CyberCheck) | `beachside-circle-boats-dashboard.html:1` | /api/apps,/api/apps/install,/api/apps/uninstall/ | WORKING+mock-fallback | Analytics & overview |
| Standalone page: billing.html (Billing & Tokens - Ghost Marketplace) | `billing.html:1` |  | STATIC | Payments & billing |
| Standalone page: booking.html (aWavegent Booking — Zero-Fee Booking for Rentals, Charters &) | `booking.html:1` |  | STATIC | Bookings & availability |
| Standalone page: card-builder.html (Build Your Card - CyberCheck) | `card-builder.html:1` |  | MOCK/STUB | Link hub / bio / cards |
| Standalone page: card.html (Matt Johnson — Gulf Coast Radar / CyberCheck) | `card.html:1` | /api/gcr/lead-notify | WORKING+mock-fallback | Link hub / bio / cards |
| Standalone page: changelog.html (Changelog - Ghost Marketplace) | `changelog.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: connection-manager-dynamic.html (Connect Your Tools - CyberCheck) | `connection-manager-dynamic.html:1` |  | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: connection-manager.html (Connect Your Tools - CyberCheck) | `connection-manager.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: contact.html (Contact Us - Ghost Marketplace) | `contact.html:1` |  | MOCK/STUB | Link hub / bio / cards |
| Standalone page: create-workflow-ai.html (Create Workflow - CyberCheck) | `create-workflow-ai.html:1` |  | WORKING+mock-fallback | Automations |
| Standalone page: customer-dashboard.html (My Business Cards - CyberCheck Dashboard) | `customer-dashboard.html:1` |  | MOCK/STUB | Analytics & overview |
| Standalone page: dashboard-charter.html (Gulf Adventure Charters - Dashboard) | `dashboard-charter.html:1` |  | STATIC | Bookings & availability |
| Standalone page: dashboard-restaurant.html (Joe's Pizza - Dashboard) | `dashboard-restaurant.html:1` |  | MOCK/STUB | Menu / QR / Specials |
| Standalone page: dashboard.html (Dashboard - Ghost Marketplace) | `dashboard.html:1` |  | MOCK/STUB | Analytics & overview |
| Standalone page: demo.html (CyberCheck Demo Access) | `demo.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: developer-dashboard.html (Developer Portal - Ghost Marketplace) | `developer-dashboard.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: developer-portal.html (Developer Portal - CyberCheck Marketplace) | `developer-portal.html:1` | /api/developers/register,/api/developers/stripe/connect | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: enter-stripe-key.html (Add Stripe Account) | `enter-stripe-key.html:1` |  | WORKING+mock-fallback | Payments & billing |
| Standalone page: help-center.html (Help Center - Ghost Marketplace) | `help-center.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: home.html (Ghost Marketplace - Build Your Perfect AI-Powered Workspace) | `home.html:1` | /api/public/gcr-stats | WORKING+mock-fallback | Analytics & overview |
| Standalone page: index.html (CyberCheck - AI-Powered Business Dashboard with Voice Automa) | `index.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: industries.html (Industries - Built for Restaurants, Charters & SMBs / CyberC) | `industries.html:1` |  | STATIC | Bookings & availability |
| Standalone page: installed-apps.html (Installed Apps - CyberCheck) | `installed-apps.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations.html (Integrations - Ghost Marketplace) | `integrations.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/alfio/alfio.html () | `integrations/alfio/alfio.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/artist-schedule/artist-schedule.html () | `integrations/artist-schedule/artist-schedule.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/booking/booking.html () | `integrations/booking/booking.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/castopod/castopod.html () | `integrations/castopod/castopod.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/easy-appointments/easy-appointments.html () | `integrations/easy-appointments/easy-appointments.html:1` | /api/v1/services | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/events/events.html () | `integrations/events/events.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/frappe/frappe.html () | `integrations/frappe/frappe.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/happy-hour/happy-hour.html () | `integrations/happy-hour/happy-hour.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/menu-no-images/menu-no-images.html () | `integrations/menu-no-images/menu-no-images.html:1` |  | STATIC | App Store / Connections / Modules |
| Standalone page: integrations/menu-with-images/menu-with-images.html () | `integrations/menu-with-images/menu-with-images.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/open-food-network/open-food-network.html () | `integrations/open-food-network/open-food-network.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/open-loyalty/open-loyalty.html () | `integrations/open-loyalty/open-loyalty.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/open-table-alt/open-table-alt.html () | `integrations/open-table-alt/open-table-alt.html:1` | supabase | WORKING+mock-fallback | App Store / Connections / Modules |
| Standalone page: integrations/rallly/rallly.html () | `integrations/rallly/rallly.html:1` | supabase | WORKING | App Store / Connections / Modules |
| Standalone page: integrations/shared/shared.html () | `integrations/shared/shared.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: integrations/specials/specials.html () | `integrations/specials/specials.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: login.html (Login - CyberCheck) | `login.html:1` | /api/auth/create-profile | WORKING+mock-fallback | People / CRM / Accounts & auth |
| Standalone page: menu-editor-dark.html (Daily Update) | `menu-editor-dark.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-editor.html (Daily Update) | `menu-editor.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-setup.html (Menu Setup — ${esc(name)}) | `menu-setup.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: menu-updates.html (Daily Menu Update System — Gulf Coast Radar) | `menu-updates.html:1` |  | MOCK/STUB | Menu / QR / Specials |
| Standalone page: navigation-demo.html (Navigation Demo - CyberCheck) | `navigation-demo.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: onboarding-links.html (CyberCheck — Pick Your Tools) | `onboarding-links.html:1` | sb:installed_modules,sb:profiles | WORKING | Link hub / bio / cards |
| Standalone page: onboarding.html (Get Started — CyberCheck) | `onboarding.html:1` | /api/apps,/api/apps/install,/api/site/content | WORKING+mock-fallback | Onboarding / Setup |
| Standalone page: page.html (Loading…) | `page.html:1` | https://gcr-api.vercel.app/api/gcr | WORKING | Link hub / bio / cards |
| Standalone page: platform.html (All-in-One Platform - Replace Monday, Zapier & Custom Dashbo) | `platform.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: pricing.html (Transparent Pricing - Ghost Marketplace) | `pricing.html:1` |  | STATIC | Bookings & availability |
| Standalone page: privacy.html (Privacy Policy - Ghost Marketplace) | `privacy.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: profile-editor.html (Edit Public Profile - CyberCheck) | `profile-editor.html:1` | /api/profile/update | WORKING+mock-fallback | Directory / Business profile & content |
| Standalone page: public.html (Joe's Pizza - Links) | `public.html:1` |  | STATIC | Link hub / bio / cards |
| Standalone page: qr-menu.html (Menu) | `qr-menu.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: restaurant-editor.html (Menu Update) | `restaurant-editor.html:1` |  | WORKING+mock-fallback | Menu / QR / Specials |
| Standalone page: reviews.html (CyberCheck Reviews — Real Purchases. Real Reviews. Real Trus) | `reviews.html:1` |  | MOCK/STUB | Reviews |
| Standalone page: sales.html (CyberCheck — The Complete Platform for Gulf Coast Businesses) | `sales.html:1` |  | STATIC | Website / Site builder / Publish |
| Standalone page: sandbox-deploy.html (Deployments - Ghost Marketplace) | `sandbox-deploy.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: sandbox-editor.html (Sandbox Editor - Ghost Marketplace) | `sandbox-editor.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: sandbox-projects.html (My Projects - Ghost Marketplace) | `sandbox-projects.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: settings.html (Settings - CyberCheck) | `settings.html:1` |  | MOCK/STUB | Settings / System / Misc |
| Standalone page: signup.html (Sign Up - CyberCheck) | `signup.html:1` |  | MOCK/STUB | People / CRM / Accounts & auth |
| Standalone page: sql-setup.html (GCR SQL Setup - Copy & Run) | `sql-setup.html:1` | supabase | WORKING | Settings / System / Misc |
| Standalone page: status.html (System Status - Ghost Marketplace) | `status.html:1` |  | MOCK/STUB | Analytics & overview |
| Standalone page: templates.html (Templates - Ghost Marketplace) | `templates.html:1` |  | STATIC | Website / Site builder / Publish |
| Standalone page: terms.html (Terms of Service - Ghost Marketplace) | `terms.html:1` |  | STATIC | Settings / System / Misc |
| Standalone page: tool-selection.html (Select Your Tools - CyberCheck) | `tool-selection.html:1` |  | MOCK/STUB | App Store / Connections / Modules |
| Standalone page: workflow-logs.html (Workflow Logs - CyberCheck) | `workflow-logs.html:1` |  | WORKING | Automations |

### gcr-unified

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Page: ArtistLive | `src/pages/ArtistLive.jsx:1` | gcr-api-clean | WORKING | Artist / Song requests & tips |
| Page: ArtistProfile | `src/pages/ArtistProfile.jsx:1` | gcr-api-clean | WORKING | Artist / Song requests & tips |
| Page: Dashboard | `src/pages/Dashboard.jsx:1` | gcr-api-clean | WORKING | Analytics & overview |
| Page: LinksPage | `src/pages/LinksPage.jsx:1` | gcr-api-clean | WORKING | Link hub / bio / cards |
| Page: LiveFeed | `src/pages/LiveFeed.jsx:1` | gcr-api-clean | WORKING | Link hub / bio / cards |
| Page: Setup | `src/pages/Setup.jsx:1` | gcr-api-clean | WORKING | Onboarding / Setup |

### ghost-platform (box page)

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Box page endpoint / | `box/server.js:165` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |
| Box page endpoint /api/status | `box/server.js:171` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |
| Box page endpoint /api/catalog | `box/server.js:173` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |
| Box page endpoint /api/maps | `box/server.js:177` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |
| Box page endpoint /api/capture | `box/server.js:183` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |
| Box page endpoint /api/maps/run | `box/server.js:187` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |
| Box page endpoint /api/mcp | `box/server.js:191` | localhost box server; config/ ; catalog.json (vault,sms,call,paperclip,notebook,mirror,app-maps) | WORKING | Box / Ghost / Phone |

### ghost-platform (operator console)

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Console tab: Work | `console/src/components/ghost/live.tsx:95` | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | WORKING | Box / Ghost / Phone |
| Console tab: Install | `console/src/components/ghost/live.tsx:176` | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | WORKING | Box / Ghost / Phone |
| Console tab: Addresses | `console/src/components/ghost/live.tsx:200` | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | WORKING | Box / Ghost / Phone |
| Console tab: Vault | `console/src/components/ghost/live.tsx:219` | bridge.ts → Paperclip, vault (Obsidian REST), phone sms/call, Open Notebook, box URLs (browser-stored addresses) | WORKING | Box / Ghost / Phone |

### nextgent-openjarvis

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Nav: Chat | `frontend/src/components/Sidebar/Sidebar.tsx:56` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Dashboard | `frontend/src/components/Sidebar/Sidebar.tsx:57` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Data Sources | `frontend/src/components/Sidebar/Sidebar.tsx:58` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Agents | `frontend/src/components/Sidebar/Sidebar.tsx:59` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Logs | `frontend/src/components/Sidebar/Sidebar.tsx:60` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Settings | `frontend/src/components/Sidebar/Sidebar.tsx:61` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |
| Nav: Get Started | `frontend/src/components/Sidebar/Sidebar.tsx:62` | OpenJarvis backend | WORKING | Fleet / Paperclip / Agents |

### nextgent-shell

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Shell tab: Businesses | `src/components/gent/app.tsx:68` | src/lib/gent/store.ts | WORKING | Directory / Business profile & content |
| Shell tab: Modules | `src/components/gent/app.tsx:69` | src/lib/gent/store.ts | WORKING | App Store / Connections / Modules |

### paperclip (fork, master)

| Name | File:line | Backend/API/env | Status | Group |
|---|---|---|---|---|
| Nav: Search | `ui/src/components/Sidebar.tsx:167 (/search)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Dashboard | `ui/src/components/Sidebar.tsx:168 (/dashboard)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Status | `ui/src/components/Sidebar.tsx:188 (/status)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Conference Room | `ui/src/components/Sidebar.tsx:191 (/board-chat)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Tasks | `ui/src/components/Sidebar.tsx:196 (/issues)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Projects | `ui/src/components/Sidebar.tsx:199 (/projects)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Routines | `ui/src/components/Sidebar.tsx:203 (/routines)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Artifacts | `ui/src/components/Sidebar.tsx:204 (/artifacts)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Cases | `ui/src/components/Sidebar.tsx:206 (/cases)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Pipelines | `ui/src/components/Sidebar.tsx:209 (/pipelines)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Goals | `ui/src/components/Sidebar.tsx:212 (/goals)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Workspaces | `ui/src/components/Sidebar.tsx:221 (/workspaces)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Agents | `ui/src/components/Sidebar.tsx:243 (/agents)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Skills | `ui/src/components/Sidebar.tsx:244 (/skills)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Connectors | `ui/src/components/Sidebar.tsx:245 (/apps)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Audit | `ui/src/components/Sidebar.tsx:246 (/activity)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Org | `ui/src/components/Sidebar.tsx:263 (/org)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Connectors | `ui/src/components/Sidebar.tsx:264 (/apps)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Timeline | `ui/src/components/Sidebar.tsx:265 (/timeline)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Costs | `ui/src/components/Sidebar.tsx:266 (/costs)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Activity | `ui/src/components/Sidebar.tsx:267 (/activity)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
| Nav: Settings | `ui/src/components/Sidebar.tsx:268 (/company/settings)` | Paperclip server /api/companies/* | WORKING | Fleet / Paperclip / Agents |
