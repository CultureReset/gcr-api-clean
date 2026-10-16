# NEXT GENT — DATA MODEL (Phase 1, data layer first)
Status: DRAFT. Nothing has been run against a live database. The SQL lives in `/workspace/build/gcr-api-clean/migrations/nextgent/` on the local branch `nextgent/phase1-data`.

## 0. Rules
- There is **one business key**: `business_id uuid` = `public.entity.id`. `slug` is kept for URLs only.
- Every canonical table lives in the new Postgres schema **`ng`**, so the live `public.*` tables are not touched. The old routes keep working until each module is cut over.
- Money is stored in integer cents, times in timestamptz, and recurrence as an RFC 5545 RRULE.
- Every write emits an event into `ng.events_outbox`. Readers (website, QR, listing, links, Google, Square, Paperclip) react to events. No module reads another module's tables.
- Outside IDs (Google location, Square catalog object, FareHarbor item, Stripe price) go in `ng.external_ref (business_id, provider, local_table, local_id, remote_id)`.

## 1. Data kinds → current tables (duplicates marked ⚠)
Sources: **G** = gcr-api-clean (the one API), **C** = cybercheck-api-database (lifting reviews and SMS from it), **L** = CCB/CCL legacy site_id tables.

| Kind | Current tables | Duplicates / notes |
|---|---|---|
| Business / profile | G `entity` (slug), `entity_owners`, `site_content`; L `businesses` (site_id); C `businesses` | ⚠ 3 business records; entity is the winner |
| Accounts / users | G `users`, `admin_users`, `tourist_profiles`, `entity_owners` / business-auth | ⚠ 4 user stores → `ng.account` + `ng.business_member` |
| Hours | G `entity_hours`; L `business_hours`; happy hour inside `specials` | ⚠ 2 tables, plus happy hour mixed into specials |
| Menu | G `menu_sections` + `menu_items` (entity_slug); G `menu_categories` + `menu_subcategories` (dashboard.js:579); L `menu_items` (site_id, public.js:2968) | ⚠ 3 menu models; prices stored as text |
| Specials | G `specials`, `entity_specials` | ⚠ 2 |
| Events | G `events`, `entity_events` | ⚠ 2 |
| Photos / media | G `entity_photos`, storage paths inside site_content JSON, rehost-photos | ⚠ scattered |
| Shop / products / orders | G merch store tables (products, orders), Stripe | ok, per entity_slug |
| Bookings | G `entity_bookings`; `bookable_resources` + `booking_events`; `bookings` + `booking_calendar` | ⚠ 3 booking models |
| Waivers | G waiver tables (bookings module) | ok |
| Reviews | G `reviews`, `entity_reviews`; C reviews + review requests (SMS) | ⚠ 3; C version is the best |
| SMS / contacts | C sms tables, contacts; G leads / forms | ⚠ split |
| Artists / songs / live | G songs, sets, votes, song requests (myset.vip) | ok |
| Listings | G listings (gcr.js:978) | ok |
| FAQ | G `faqs`, `entity_faqs` | ⚠ 2 |
| Website pages | G `site_content`, `site_pages` | ⚠ 2 |
| QR | G qr codes / scans (qr.js) | ok |
| Apps / modules | G `site_apps`, `module_manifest`, `user_modules`, `installed_modules`, `entity_modules` | ⚠ 5 → `ng.module` + `ng.module_install` |

## 2. Canonical `ng` tables (one set, keyed by business_id)
| File | Tables |
|---|---|
| 0001 | business, account, business_member, business_profile, external_ref |
| 0002 | hours, hours_exception, media, contact_action, faq, team_member, policy |
| 0003 | menu, menu_section, menu_item, menu_item_price, menu_option_group, menu_option, special, event |
| 0004 | listing, listing_media, product, product_variant, customer, order, order_item, custom_request, payment |
| 0005 | offering, offering_price, resource, addon, location, availability_rule, availability_exception, booking, booking_line, external_calendar, waiver_template, waiver_signature, waitlist_entry |
| 0006 | review, review_request, song, live_session, vote, song_request, form, form_submission, qr_code, qr_scan |
| 0007 | theme, site, site_page, site_block, site_revision |
| 0008 | events_outbox, event_delivery (+ pg_notify `ng_events`) |
| 0009 | module, module_install (a projection of Paperclip installs) |
| 0010 | ng.emit() + ng.menu_item_update(): an atomic write + emit example |
| 0901 | backfill: entity → business, entity_hours → hours, menu_sections/items → menu* |

## 3. Old → new mapping
| Old | New | Notes |
|---|---|---|
| entity | business (+ business_profile) | id kept the same |
| businesses (L, site_id) / C businesses | business via external_ref(provider='legacy_site') | needs a site_id→entity map (Q3) |
| users, admin_users, tourist_profiles, entity_owners | account (+ legacy_ref), business_member(role) | platform_role for admins |
| entity_hours, business_hours | hours(kind='regular') | happy hour → hours(kind='happy_hour') |
| menu_sections / menu_items | menu(kind) → menu_section → menu_item | text price → price_cents; multiple prices → menu_item_price |
| menu_categories / menu_subcategories | menu_section (parent = category) | merge by name |
| L menu_items (site_id) | menu_item | only when the entity has no G menu |
| specials, entity_specials | special (rrule) | dedupe on (business, title, rrule) |
| events, entity_events | event (rrule, venue/performer ids) | |
| faqs, entity_faqs | faq | |
| entity_photos, site_content images | media | site_content JSON is parsed |
| products / orders (merch) | product, product_variant, order, order_item, payment | |
| entity_bookings; bookable_resources + booking_events; bookings + booking_calendar | offering, resource, availability_rule, booking, booking_line | 3 → 1 |
| waivers | waiver_template, waiver_signature | |
| reviews, entity_reviews, C reviews / requests | review, review_request | lift from C |
| songs / sets / votes / requests | song, live_session, vote, song_request | |
| listings | listing, listing_media | |
| site_content, site_pages | site, site_page, site_block | |
| qr tables | qr_code, qr_scan | |
| site_apps, module_manifest, user_modules, installed_modules, entity_modules | module, module_install | |

## 4. Who reads each table (consumers, through events or a public route)
| Canonical data | Website (public.js / site) | QR menu (menu-editor.js:979, qr.js) | Listings (gcr.js:978) | Links page (links.js) | Concierge / MCP (conciergeTools.js:393, /api/mcp) | Google Business (google-business.js) | Square (square.js) | FareHarbor | Stripe | Paperclip / Jarvis |
|---|---|---|---|---|---|---|---|---|---|---|
| business / profile | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (name, phone, site) | | | | ✓ |
| hours | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (regular + special hours) | | | | ✓ |
| menu* | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (food menu) | ✓ (catalog) | | | ✓ |
| special | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (posts / offers) | | | | ✓ |
| event | ✓ | | ✓ | ✓ | ✓ | ✓ (event posts) | | | | ✓ |
| media | ✓ | ✓ | ✓ | ✓ | | ✓ (photos) | ✓ (item images) | | | |
| product / order | ✓ (shop) | | | ✓ | ✓ | | ✓ | | ✓ | ✓ |
| offering / booking / waiver | ✓ (book) | | ✓ | ✓ | ✓ | ✓ (booking link) | | ✓ | ✓ (deposits) | ✓ |
| review | ✓ | | ✓ | | ✓ | ✓ (replies) | | | | ✓ |
| song / live_session | ✓ (myset.vip) | ✓ | | ✓ | ✓ | | | | | |
| listing | ✓ | | ✓ | | ✓ | | | | | |
| faq / policy / contact_action | ✓ | ✓ | ✓ | ✓ (A9ENT CTAs) | ✓ | | | | | |
| qr_code / qr_scan | | ✓ | | | | | | | | ✓ (stats) |
| events_outbox | | | | | | sync worker | sync worker | | | ✓ (POST /api/nextgent/events) |

## 5. Events
- The type is `<module>.<thing>.<verb>`, e.g. `menus.item.updated`.
- The payload has `{before, after, changed}`. The actor has `{kind, id, paperclipTaskId}`, so "Jarvis, update my menu" ties back to the Paperclip task.
- Delivery: `lib/events/worker.js` fans out to `event_delivery` per consumer and retries with backoff, up to 8 attempts.
- Paperclip is reached with a signed POST using the contract §3 v2 scheme: HMAC-SHA256 over `ts\nnonce\nMETHOD\npath\nquery\nsha256(body)`, with headers x-nextgent-timestamp / -nonce / -signature.
