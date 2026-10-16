# SOURCE PICK: where the real working logic lives, per module (for the from-scratch modular NEXT GENT)
Read-only. Repos and commit dates:
- **GCR** = gcr-api-clean main@e3495a1, 2026-09-29 (clone at /workspace/dashboards/gcr-api-clean).
- **GCR-ng** = gcr-api-clean branch codex/nextgent-integration-20261005@4375aee, 2026-10-06.
- **CCAD** = cybercheck-api-database main@d64cd86, 2026-07-27, package name "cybercheck-backend" (/workspace/repo-read/cybercheck-api-database). Branches unified-db-integration (+280 commits) and gcr-schema-migration (+275) are not lifted here.
- **CCB** = cybercheck-backend main@ba8ad9d, 2026-03-02 (/workspace/repo-read/cybercheck-backend): the front-end pair. Contains cybercheck-dashboard-platform/js (cc.js plus 33 modules), circle-boats-website, and an early cybercheck-backend-api (9 routes).
- **CCL** = cybercheck-login (static front end, same cc.js lineage).

**Lineage:** CCB-api (Mar) → CCAD (to Jul) → GCR (to Sep, refactored: admin.js 9,239 → 3,950 lines split into modules; added store, automations, composio, nodes, business-data, MCP, artists). Most CCAD route files exist in GCR with small diffs (site.js identical; analytics 13 diff lines; square 68; menu-edit 34). **GCR is the better source almost everywhere. CCAD wins only where GCR dropped features (reviews requests/POS, SMS inbox/reminders).** CCB is the best front-end reference for client screens (many keep state in localStorage).

| module | best source (file:line) | state | runner-up | notes for the rebuild |
|---|---|---|---|---|
| Auth (admin/owner) | GCR routes/auth.js:426 (login), business-auth.js:301 (phone OTP) | complete | CCAD auth.js (442 lines, older) | 4 user stores. Pick one identity; Paperclip better-auth for workspace users |
| Users / companies / claims | GCR admin.js `/users`, `/businesses`, `/link-user`; admin-signups.js; gcr.js `/claim` | complete | CCAD admin.js | business = `entity` + `entity_owners`; map to Paperclip company |
| Store / installs / plans / grants | GCR store.js:75-466 admin, :552-639 owner (:617 install); lib/storeManifest.js; sql/store.sql | complete (no seed items) | GCR-ng nextgent.js:344-682 (Paperclip install bridge) | absent in CCAD and CCB |
| Connections (connectors) | GCR composio.js (:430 connect); sql/composio_connections.sql | complete | — | |
| Automations | GCR automations.js:147-455 admin, :483 owner, :615/:625 cron/hook; lib/automationEngine.js | complete | CCAD modules/sms-automation/index.js (76 lines) | add a change-event trigger |
| Menus | GCR menu-editor.js (39 routes; :979 qr-menu); lib/menu-gcr.js:9-117 | complete | CCAD menu-edit.js, simple-menu-edit.js (same as GCR) | lift menu-editor + menu-gcr; drop menu-edit, simple-menu-edit, dashboard menu-categories |
| QR | GCR qr.js:96 `/r/:code` (26 routes) | complete | CCAD qr.js (715 lines, ~276 diff lines) | separate app |
| Daily update links | GCR update-link.js (1,376 lines) | complete | CCAD update-link.js | |
| Bookings / availability | GCR bookings.js:19; availability.js; rentals.js; services.js; admin-platform.js (58 routes); availability-engine.js; capabilities.js | complete but 3 data models | CCAD boat-rental, charter, photographer, rides (vertical, tables missing); CCB circle-boats-website/index.html (booking UI + holds) | pick bookable_resources + availability_slots; lift the engine |
| Song requests / artists / tips | GCR artists.js:27, artist-bookings.js, cooperatives.js, goals.js | complete (no payment ledger) | — | absent in CCAD and CCB |
| Events | GCR admin.js:654 `/gcr/events` + import; gcr.js `/events` | complete | CCAD dashboard.js `/events` | entity_events |
| Specials | GCR admin.js:710 `/gcr/specials` | complete | CCAD/GCR dashboard.js `/specials` (entity_specials) | drop legacy `specials` |
| Website builder | GCR dashboard.js:4911 website-content, :2090 pages, :2636 publish; site.js (identical in CCAD); verify-dns.js | partial (publish only flips a flag) | CCB js/site-editor.js (275), domain.js (697), publish.js, pages.js, theme.js | front end: lift CCB |
| Reviews | **CCAD reviews.js:77** (request, consent, inbound SMS, POS webhook, send-daily; 15 routes) + GCR google-business.js:351 | complete in CCAD; GCR reviews.js is CRUD only (5 routes) | CCB js/reviews.js (616, uses localStorage) | lift review-requests from CCAD |
| SMS / messaging | **CCAD sms.js:287** inbox/thread, :434 reminders, waiver/menu prompts; GCR sms.js:258 blast + QR codes | CCAD broader; GCR messaging.js unmounted (tables missing) | CCB js/messaging.js (localStorage) | merge: CCAD inbox/reminders + GCR blast/QR |
| Payments | GCR stripe.js:304 (Stripe Connect, payment intent; 887 lines); square.js | complete (per business) | CCAD stripe.js (812); CCAD branch feature/square-payment (stale) | no ledger table |
| Billing (platform) | GCR billing.js:25; sql/billing.sql | partial | CCB js/billing.js (localStorage UI) | merge with store plans |
| Waivers | GCR public.js:175 `/waiver*`, platform.js waiver-sign | complete | CCB js/waivers.js (localStorage) | 5 copies; one module |
| AI | GCR admin.js:2801 `/gcr/ask`, ai-organize, rag; ai-provider.js; lib/conciergeTools.js | complete | CCAD ai-provider.js (461 lines, larger) | compare ai-provider before lifting |
| Listings / directory | GCR gcr.js:978 entity/:slug (36 routes), business-data.js, business-profile.js, deep-crawl | complete | CCAD gcr.js (3,734; older) | entity schema is canonical |
| Analytics | GCR analytics.js, admin-analytics.js | complete | CCAD (same) | CCB circle-boats-website/tracking.js client |
| Social | GCR meta-webhook.js, admin.js social-posts | partial | CCAD modules/social-manager (79); CCB js/social.js | |
| Coupons / loyalty | GCR dashboard.js `/coupons`, `/loyalty`; platform.js rewards | partial | CCB js/coupons.js | |
| Customers / CRM | GCR dashboard.js `/customers`; admin.js `/gcr/customers` | partial | CCB js/customers.js (built from bookings) | |
| Ghost / devices | GCR nodes.js:72, admin-ghost.js | complete | — | |
| Agent access (MCP) | GCR mcp.js:139-228, mcp-public.js | complete | — | used by Paperclip plugin-cybercheck |
| Trip Swipe / tourist | GCR tourist.js (1,998), tourist-auth.js, tourist-groups.js | complete | CCAD tourist.js (1,374) | |
| Paperclip bridge | GCR-ng routes/nextgent.js | complete (branch only) | — | merge to main |
