# HUB MAP: "update my menu" → Jarvis → Paperclip → every place the menu appears
Read-only. Sources: cybercheck-login@8b3d6df (CCL), gcr-api-clean main@e3495a1 (API) plus branch `codex/nextgent-integration-20261005`@4375aee (API-ng), paperclip-ng@051bc6a `codex/nextgent-integration-20261005` (PC).

## 1. CCL admin dashboard: admin.html (22,977 lines, one file)
Navigation is `showPage('…')` at admin.html:76-334; page divs are at the line shown. Backend is API `API_BASE` (gcr-api-clean), plus a few direct Supabase calls.
| group | screen (page line) | backend calls seen |
|---|---|---|
| Home | overview 367; biz-dashboard 5965 | /api/admin/gcr/claims, entities |
| Menu & QR | menu-builder 3734; qr-menus 3440; qr-tracker 2968; reviews 3341; referral-partners 438; daily-update-links 2902; menu-editors-hub 5372 | /api/admin/gcr/menu-items, menu-sections, daily-features; /api/dashboard/menu/extract, generate-design, qr-theme; /api/qr, /api/qr/r, partners, locations, batch; /api/update/generate, send-sms, today; /api/menu-editor; /api/reviews/* |
| GCR directory | gcr-businesses 518; gcr-entity-editor 600 (tabs :644-658: info, hours, photos, tags, features, content, sections, pages, wavegent, rawdata, pricing, schedule, faqs, team, blog); gcr-site-editor 1508; gcr-claims 565 | /api/admin/gcr/entities/* (101 calls), sections (40), business-data, upload-image, entity-pages, page-assignments, site-config, category-cards, reindex |
| Content | gcr-events 1844; gcr-artists 1643; artist-profiles 1727; gcr-specials 2052; gcr-ads 2161; gcr-rails 2176; ai-config 5952; gcr-coupons 4022; gcr-seo 4033; bulk-upload 2372; bulk-events 2637 | /api/admin/gcr/events, specials, ads, page-rails, coupons, import-* (menu, drinks, happyhour, events, specials, csv, master); /api/dashboard/events, specials; /api/artists, cooperatives |
| AI | ai-chat 5287; ai-organize 5519; rag-index 5765; ai-settings 5824 | /api/admin/gcr/grok-chat, ai-organize, ai-chat-organizer, ai-scrape-url, ai-scrape-approve, rag-status, ai-provider; /api/dashboard/ai-chat |
| Engagement | gcr-analytics 2768; gcr-reviews 2793; gcr-customers 2816; gcr-messaging 3999; gcr-social 2839 | /api/admin/gcr/reviews, customers, messaging, platform-analytics |
| Trip Swipe | tripswipe-overview 4391, businesses 4454, tourists 4580, analytics 4624, ai 4685, concierge-test 3456, questions 3663, sponsored 4735, tonight 5140, points 5097, sms-qr 5120; platform-auth 4793; trip-swipe-button 4840; sms-settings 4913; sms-blasts 5022; business-leads 5215; community-photos 5234 | /api/admin/tripswipe/*, tourists, setup-questions, sms-blast(s), sms-config, auth-config, community-photos; /api/tourist/* ; /api/sms/qr-codes |
| App Store | app-manager 394; biz-apps 413 | /api/admin/apps, site-apps |
| Platform | businesses 427; leads 2683; bookings 2746; sales-pages 2879; ar-hunts 4049; integrations 4287; users 4185; api-keys 4193; settings 5258 | /api/admin/businesses, link-user, invite-business, sales-leads, bookings, users, save-api-key, set-connection; /api/ar-hunts |
Rebuilt equivalent: ADM modules/registry.js (same list, one-to-one). Other CCL admin files: admin-dashboard.html (4,527 lines), admin-pricing.html, audit.html, photo-repair.html, gcr-entity-manager.html, sql-setup.html.

## 2. Circle Boats client dashboard: beachside-circle-boats-dashboard.html (1,841 lines)
Sidebar `navigateTo()` :200-211 has 12 items: profile, inventory, addons, media, bookings, connections, messaging, reviews, customers, coupons, waivers, publish. The page divs are listed below.
**Wiring reality:** the page loads js/cc.js (:1501), but none of the page modules (js/dashboard.js, site-editor.js, etc.) are loaded. Inline JS calls only `CC.dashboard.getOnboarding` (:1551), `getBookings` / `getCustomers` (:1673-1674) and `/api/apps`, `/api/apps/install`, `/api/apps/uninstall` (:1709, 1771, 1790; **unmounted** in API). Every other screen is an HTML shell. The column "would edit via cc.js" shows the client method that exists but is not called.
| screen (div line) | edits | would edit via cc.js (line) → API route → table |
|---|---|---|
| overview 189 | stats, onboarding | getOnboarding :479 → /api/dashboard/onboarding |
| profile 226 | name, contact, hours, social | updateProfile :187, updateHours :191 → /api/dashboard/profile, hours |
| media 344 | photos | gallery :200-203 → /api/dashboard/gallery → entity_gallery / entity_photos |
| pages 360 | site pages | :377-380 → /api/dashboard/pages (dashboard.js:2090) → site_pages |
| staff 369 | team | /api/dashboard/team → entity_team_members |
| qr-codes 379 | QR codes + theme | :369-370 → /api/dashboard/qr-theme (dashboard.js:2042) → businesses, connections |
| inventory 403; availability 412; blackout-dates 433 | boats/units, slots | fleet :260-269, units :433 → /api/dashboard/fleet, fleet-items, units, availability → fleet_types, bookable_resources |
| addons 499 | rental add-ons | :284-287 → /api/dashboard/addons → rental_addons |
| locations 540; theme 549 | docks, site theme | :383-384 → /api/dashboard/theme |
| app-store 574 | install apps | /api/apps* (**dead**) |
| connections 586 | Stripe/Square | /api/dashboard/connections, stripe-status |
| bookings 612; messaging 629; reviews 696; customers 725; coupons 737; waivers 757; waitlist 780; billing 799 | operations | /api/dashboard/bookings, customers, reviews, coupons, waivers, billing |
| **site-editor 823** (CMS sidebar + live preview) | website sections | getWebsiteContent / update :483-486 → /api/dashboard/website-content(/:section) (dashboard.js:4911) → **site_content** |
| domain 848 | subdomain, custom domain, DNS, SSL | :393-394 → /api/dashboard/domain; /api/verify-dns |
| publish 872 | publish/unpublish, revisions | publish :510 → /api/dashboard/publish (dashboard.js:2636) → businesses |
| website-content 893 | section-by-section copy | same as site-editor → site_content |
| analytics 922; seo 980; faq 1056; social 1067 | SEO, FAQ, social posts | :387-390 seo; :206-213 faqs → /api/dashboard/seo, faqs |
| modals 1088-1460 | page, menu-item (:1350), menu-extract (:1369), special (:1400), event (:1430), QR edit (:1460) | menu :230-245, specials :254-257, events :248-251 |
Public site for the client: CCL book.html, biz.html, page.html → /api/platform/page; /api/public/site-data (public.js:2540 → businesses + site_content).

## 3. "Update my menu" fan-out: every place menu data appears
| place | table(s) read | screen / surface | file:line |
|---|---|---|---|
| GCR listing (directory detail) | menu_sections (by entity_slug), menu_items (by section_id), drink_*, happy_hour_*, entity_specials | gcr site, Trip Swipe cards | API gcr.js:292, :379, :457 (entity/:slug :978) |
| QR menu (public) | menu_sections, menu_items, drink_*, happy_hour_*, entity_daily_features, entity_specials | QR scan → menu page | API menu-editor.js:979 `/:slug/qr-menu`; qr.js:96 `/r/:code` redirect; CCL q.html |
| Link hub / bio menu | same 8 tables | link page, card | API links.js:8 |
| Business website (new path) | menu_sections + menu_items via lib/menu-gcr.js:9 | CCL site via /api/public/menu | API public.js:2925 (entity first) |
| Business website (**legacy path**) | **menu_items by site_id + specials + site_content** (businesses-keyed) | Circle Boats-style sites | API public.js:2968-2973 |
| Website CMS copy | **site_content** (free text, can contain menu copy) | site-editor / website-content | API dashboard.js:4911 |
| Client dashboard menu editor | menu_items through menu-gcr; **menu_categories / menu_subcategories (separate tables)** | CCL modal-menu-item :1350; js/cc.js:230-245 | API dashboard.js:520, :579 |
| Admin menu builder | menu_sections, menu_items, drink_*, hh_* | CCL admin.html menu-builder :3734; ADM menu/MenuBuilder.jsx | API admin.js `/gcr/menu-*` |
| Pin-auth staff menu editor | menu tables via `/:slug/data` | CCL menu-editor.html, menu-editor-popup.html | API menu-editor.js:196 |
| Simple / text menu edit | menu tables | SMS / quick edit | API menu-edit.js (:188), simple-menu-edit.js (:189) |
| Daily update links (SMS) | daily_rotation_*, entity_daily_features, menu items | texted link | API update-link.js:315 |
| Specials (listing + site) | **entity_specials** (GCR) vs **specials** (site_id) | admin gcr-specials 2052; client modal-special 1400 | API dashboard.js:2008 (entity_specials); public.js:605 (specials) |
| Owner dashboard (new) | schema tables menu_sections, menu_items… | USR sections/MenuSection.jsx | API business-data.js (/api/business/:table) |
| AI concierge answers | menu_items | Trip Swipe / chat | API lib/conciergeTools.js:393 |
| Agent MCP | any business table | Jarvis/agents | API mcp.js:177 read_section, :211 update_row; mcp-public.js:140 |
| Paperclip app manifests | screens bound to business sections | Next Gent app | API-ng routes/nextgent.js:316 manifestFrom |
| Boxes menu app | own Next.js app + upload | BX apps/menu | separate backend (not in API) |
**Conflicts that stop a single write from landing everywhere:**
1. Two menu keys: entity_slug/section_id (GCR) vs site_id (legacy businesses), public.js:2968.
2. menu_categories vs menu_sections, dashboard.js:579.
3. specials vs entity_specials.
4. site_content free text.
5. The Boxes app has its own store.
6. Publish snapshot (dashboard.js:2636) sets businesses state only; there is no regeneration or cache bust.

## 4. How Paperclip would carry "update my menu" today
| step | piece | status | evidence |
|---|---|---|---|
| Matt → Jarvis | Jarvis = CEO agent per workspace | EXISTS (design + onboarding) | PC NEXT_GENT.md:13-16; nextgent/README.md:124-127 |
| Jarvis → task | paperclip MCP: paperclipCreateIssue, UpdateIssue, ListAgents, SuggestTasks, ApiRequest, approvals… | EXISTS | PC packages/mcp-server/src/tools.ts |
| Task → agent writes menu | plugin-cybercheck tools business_list_sections / read_section / create_row / update_row / delete_row → API `POST /api/mcp` | EXISTS | PC packages/plugins/plugin-cybercheck/src/constants.ts, worker.ts:117-128, gcr.ts:78 → API mcp.js:195-228 |
| Plugin auth per company/agent | businessToken + agentTokens[agentId] set automatically | EXISTS | PC services/nextgent-business-plugin.ts:28,70; routes/nextgent.ts:144 business-token, :187 install token |
| Scoped permissions | install token permissions `resource:action` | EXISTS (API-ng branch only) | API-ng lib/businessTables.js:469,491 |
| Store "app" item → projected into API | app/layout manifests pushed to API on install, patched on update, removed on uninstall | EXISTS on both sides, **branch only** | PC services/nextgent-store.ts:38,352,402,424; client nextgent-gcr-client.ts:197-212; API-ng routes/nextgent.js:344,612,637,682 (server.js:302). **Not in API main@e3495a1** |
| Routines (scheduled / triggered) | company routines, created by store content.sync | EXISTS | PC routes/routines.ts:149; store-content.ts:490,501 |
| Approval before publish | Paperclip approvals | EXISTS (generic) | mcp tools paperclipCreateApproval |
| Fan-out: one write → listing, QR, links, site | works only for readers on GCR menu_sections/menu_items | PARTIAL | listing, QR, links, concierge and new site all read the same tables (§3) |
| Legacy site, menu_categories, specials, site_content | not covered by a GCR write | MISSING | public.js:2968, dashboard.js:579, :2008, :4911 |
| "Menu changed" event → other apps (re-publish site, regenerate QR PDF, push to Google Business / Yelp / Square) | no change event or outbox after a business-table write | MISSING | no emitter in mcp.js / business-data.js; automations has a cron/hook only (automations.js:615,625) |
| A "menu" skill/agent knowing which sections are the menu | none; the agent must discover through list_sections | MISSING | — |
| App registry telling Paperclip which apps show the menu | app manifests have bindings, but nothing maps section → consuming apps | MISSING | API-ng nextgent.js:316 (manifest only) |
| Website builder as an app | website lives in site_content / site_pages, not as a store app | MISSING | dashboard.js:2090, :4911 |
| Boxes menu app on GCR tables | own backend | MISSING | BX apps/menu |
| Merge API-ng branch into main / deploy; set GCR_API_URL + NEXTGENT_SERVICE_SECRET | — | MISSING | PAPERCLIP-TENANCY.md gaps |

**What it takes:**
1. Merge API `codex/nextgent-integration` into main.
2. Pick one menu model (menu_sections/menu_items on entity_slug) and migrate the site_id, menu_categories and `specials` copies onto it.
3. Add a business-table change event (outbox) in API, which Paperclip routines and store apps subscribe to.
4. Register website, QR, listing and Google Business as store `app`/`connector` items whose manifests declare the sections they read, so Paperclip knows the fan-out.
5. Give Jarvis a "business editor" skill that uses plugin-cybercheck plus an approval before publish.
