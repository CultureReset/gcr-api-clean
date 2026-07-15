# THE FOUNDATION — read this before touching anything

This is the complete map of how Gulf Coast Radar is structured. It was written
after too many rounds of rediscovering the platform in fragments and getting it
wrong. If you (human or AI) are about to change code or data, read this first.

## The one rule

**Everything is structured data tied to a business.** A business is one row in
`public.entity`, anchored by its `slug`. Every fact about that business — its
hours, menu, happy hour items, events, artists playing there, condo units,
offerings, prices, photos, policies, availability — is a typed row in a real
table, keyed by `entity_slug` (or a real FK). Display is a separate layer:
gulfcoastradar.com, a hub page, a white-label client, a widget, a text message,
an AI answer are all just different views over the same rows.

The same structure serves every kind of business. A restaurant, a fishing
charter, a cleaning service, a dolphin cruise differ in *which* tables have
rows — never in *how* the data works. Pricing units (per person / hour / day /
night / week / flat), age tiers (adult / kid / under-2-free), recurring
schedules (live music every Friday 7pm) are all **data values**, never
separate systems.

This is deliberately white-label-able: anything queryable can be re-displayed
by anyone, anywhere, in any layout. That property falls out of the structure —
it is the product.

## The anchor

`public.entity` — ~2,372 active businesses (~2,900 total rows). Identity,
contact, links (booking/reservation/order/menu URLs), social, summary fields.
`parent_entity_slug` makes any business a child of another: a marina's tenant
restaurants and charter boats, a condo complex's units, Flora-Bama's venues.
A business with children renders as a hub/directory page automatically
(`is_hub` is computed from a live child count — it is not a stored flag).

## The spine — 124 tables keyed by entity_slug

Verified from information_schema (2026-07-15). Grouped by domain:

**Identity & facility:** entity_hours, entity_secondary_hours, hours_exceptions,
entity_photos, entity_gallery, entity_tags (81k rows — amenity flags, features,
good-for), entity_amenities, amenities, entity_attributes, entity_about_bullets,
entity_perfect_for, entity_policies, entity_sections + entity_section_items
(generic section store), entity_sides, hub_details, marina_details,
property_details, spot_details, spot_rules, activity_details, access_info,
facilities, meeting_points, service_area_zones, seasonal_info, brands.

**Food & drink:** menu_sections → menu_items, menu_periods, drink_sections →
drink_items, happy_hour_sections → happy_hour_items, daily_features,
entity_daily_features.

**Events & music:** entity_events (venue + event_name + event_date OR
day_of_week/recurring + start/end time + cover_charge + `artist_id` FK →
artists). artists (roster: name, genre, hometown, bio, socials, spotify).
artist_profiles, artist_shows, artist_booking_requests, artist_follows,
artist_goals, music_links, songs, song_requests, social_posts,
entity_social_posts, shoutouts.

**Commerce & booking:** offerings → offering_prices (units and age bands are
DATA: unit column + age_min/age_max), price_items, pricing_items, products,
product_categories, service_menu, service_packages, service_addons,
service_categories, room_types, charter_trips, activity_options,
activity_schedules, class_schedule, fees, property_fees, promos, bookings,
entity_bookings, booking_calendar, bookable_resources (1,008 condo units/
boats, per-unit specs + ical_export_token), waivers, quote_requests,
payment_confirmations, transportation_providers, requirements, whats_included,
what_to_bring, fish_species, order_links, stay_links, shop_links, tip_links,
table_orders, table_sessions, item_reviews, loyalty_programs, loyalty_members,
review_invites.

**Availability & calendar (ONE calendar per business):**
business_availability is THE calendar — per date (+ optional time slot,
+ optional resource_id for a specific unit): capacity, booked, remaining,
status. Fed by BOTH sync paths: entity_external_calendars (iCal feed configs,
polled hourly by cron → /api/email-parser/ical-import/run) and email parsing
(booking confirmation emails BCC'd to gcr-[slug]@parse..., parsed by
routes/email-parser.js EXTRACTORS). Also: email_parser_log (every parsed
booking), gcr_deals (auto last-minute deals from availability thresholds),
availability, entity_availability (legacy).

**Reviews & Q&A:** entity_reviews (2,245 businesses), faqs, entity_faqs,
entity_blog_posts, entity_team_members.

**Visitor/engagement & capture:** tourist_click_events (every Book Now click:
who/when/target_url + converted/converted_at/email_log_id) → booking_opt_ins
(name/phone/email + sms_consent captured BEFORE the third-party handoff,
click_id FK) → email_parser_log.opt_in_id/click_id (the confirmed booking).
This is the capture-before-handoff chain. Plus tourist_saves, tourist_seen,
tourist_photos, tourist_points, tourist_swipe_events, tourist_itineraries,
tourist_group_saves, tripswipe_*, qr_codes, qr_scans, page_rail_items,
announcements.

**Ops:** entity_owners, business_staff, business_invites, entity_modules,
entity_module_grants, users, deep_crawl_jobs, action_audit_log,
entity_edit_log, ai_facts.

## Key real FKs beyond the slug

- `entity.parent_entity_slug` → entity (parent/child; 330 children live)
- `entity_events.artist_id` → artists (609 events FK'd, 317 artists scheduled,
  0 loose name-only rows — the artist⇄venue⇄day⇄time graph is real)
- `menu_items.section_id` → menu_sections; same pattern for drink_ and
  happy_hour_ sections
- `offering_prices.offering_id` → offerings
- `booking_opt_ins.click_id` → tourist_click_events;
  `email_parser_log.opt_in_id/click_id`; `tourist_click_events.email_log_id`
- `business_availability.resource_id` → bookable_resources (per-unit calendar)

## Display layer (gcr-unified SPA) — page → endpoint

- `/business/:slug` → BusinessDetail → GET /api/gcr/entity/:slug (+ reviews
  stats, team, blog, faqs, email-parser availability; POST /api/tourist/
  track-click on outbound CTAs). If the entity has children → HubTemplate
  (hub hero, stats, categorized child directory via GET
  /api/gcr/entities/:parentSlug/children).
- `/events` → Events → GET /api/gcr/events — every event with embedded artist
  object + entity_slug; each card links to /business/:slug. Artists and
  venues cross-link in both directions.
- `/artists`, `/artist/:slug`(+ /live) → GET /api/artists[/:slug], queue/
  song-request endpoints.
- `/restaurants /coffee /happy-hours /things-to-do /public-spots /shopping
  /nightlife /wellness /marinas` → CategoryPage → GET /api/gcr/entities
  (client-filtered by subtype) — happy-hours uses GET /api/gcr/happy-hours,
  which returns hh_sections + items per business (the expandable items
  dropdown on the card).
- `/reserve/:slug` → Reserve → availability read + POST /api/gcr/opt-in
  (capture) + POST /api/email-parser/manual (direct booking entry).
- `/staying`, `/rental/:slug`, `/book-rental/:slug` → /api/rentals/* backed by
  bookable_resources. `/services`, `/service/:slug` → /api/services/*.
- `/search` → POST /api/gcr/search — searches STRUCTURED tables (menu items,
  drink items, hh items, tags, amenities, faqs, offerings, sections), not
  just names.
- `/deals` → /api/deals (gcr_deals). `/swipe/*` → TripSwipe deck. `/profile`,
  `/groups`, `/saves`, itinerary builder → tourist + platform endpoints.
- Static `public/book.html` + `biz.html` → /api/platform/page/:slug (the
  slug-keyed universal engine in routes/platform.js).

## Known parallel systems — do NOT "clean up" without explicit owner approval

- **v2 schema**: a complete parallel rebuild (~120 tables) exists in schema
  `v2`, fully migrated from public, served ONLY by the additive
  /api/gcr/v2-preview route. `public` is what's live. Do not point live
  routes at v2 or delete either without the owner's explicit go-ahead.
- **Two booking engines**: routes/platform.js (booking_calendar as source of
  truth — currently 0 rows, used only by book.html/biz.html) and the
  email-parser/business_availability path (what the live SPA uses). Both
  real; unification is an owner decision.
- **Dead search**: GET /api/availability/search queries availability_slots /
  integration_items / integration_accounts — tables that DO NOT EXIST. Good
  logic, no backing tables. Known.
- **Lookalike entity rows** (e.g. flora-bama vs flora-bama-lounge, sanroc
  "- Marina"/"- Shopping"): NOT duplicates to delete. Each slug has its own
  attached rows (different menus, photos, events). Both stay. See rules.

## Standing rules (owner-set, non-negotiable)

1. **NEVER delete or merge rows.** Data hangs off every slug; deleting "a
   duplicate" destroys attachments the other row doesn't have. It happened
   once (597 rows) and must never happen again. At most: report what's
   attached to each row and wait for an explicit per-row decision.
2. **Everything added gets added as structured rows** tied to the right
   business. No JSON blobs, no arrays, no free text where a typed row belongs.
3. **Trace the actual keys before concluding anything.** Table names lie;
   foreign keys don't. (artist_shows is empty; the real artist schedule lives
   in entity_events.artist_id. Check flow, then speak.)
4. An example given by the owner is an instance of the rule — not a task to
   go audit in isolation.

## State in one line (as of 2026-07-15)

Structure: correct and universal. Universal layers (hours/photos/tags/reviews)
~90% populated; content layers (menus/offerings/HH/FAQs/specials) populated
for tens-to-hundreds of businesses, not all 2,372; events+artists graph real
and live (922 events, 816 recurring, 390 artists); transactional layer built
and verified but unfed (0 availability rows, 0 calendar feeds connected, 131
booking URLs). The work is filling the pipes, not re-architecting them.
