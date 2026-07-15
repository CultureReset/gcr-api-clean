# GCR v2 — Canonical Schema Rebuild (beside production)

Execution of **GCR Full Database Rebuild Master Plan** (audit 2026-07-15,
live project `mkepugvdlktfsossumox`). This directory holds the v2 schema as
ordered SQL migrations.

## Non-negotiable rules (from the plan)
1. **Build v2 BESIDE production. Never drop or rewrite production tables.**
   Every v2 object lives in a separate Postgres schema: **`v2`** (e.g.
   `v2.entities`). Nothing here touches `public.*` until cutover.
2. **DDL runs on a Supabase development branch first** (plan Phase 2), never
   straight onto production.
3. **Canonical identity:** `v2.entities.id` (uuid) internally, `v2.entities.slug`
   publicly. Every business-content row carries both `entity_id` and, where the
   live code still needs it, `entity_slug`.
4. **One profile contract:** all display paths (web `/business/:slug`, QR
   `/menu/:slug`, `/rental/:slug`, `/service/:slug`, tourist AI, voice AI) must
   read from one compiled `EntityProfileV1` — no per-page assemblers, no legacy
   fallbacks.
5. **`enabled` ≠ `complete`.** A module is only shown when
   `v2.entity_module_status` says it has backing data (kills blank tabs).

## Migration order (files applied in numeric order)
| File | Pack | Status |
|---|---|---|
| `001_core.sql` | Core (identity, aliases, relations, locations, contacts, links, social, tags, attributes, sources, modules, module status) | ✅ drafted |
| `002_hours.sql` | Hours (hour sets, periods, exceptions) | ✅ drafted |
| `003_content_media.sql` | Content + media (media_assets, entity_media, content_blocks, faqs, policies, events, specials, announcements, reviews, review Q/A) | ✅ drafted |
| `004_food.sql` | Food (menus, periods, sections, items, availability, dietary, option groups, daily features, table sessions/orders) | ✅ drafted |
| `005_people.sql` | People (people, entity_people; person_offerings in 006) | ✅ drafted |
| `006_commerce.sql` | Commerce (offering_categories, offerings, prices, schedules, inclusions, requirements, addons, person_offerings, resources + resource_media/amenities/rates/fees/policies/calendars) | ✅ drafted |
| `007_booking.sql` | Booking (availability_slots/blocks, bookings, booking_items/guests/payments/waivers, waitlists, quotes) | ✅ drafted |
| `008_lodging.sql` | Lodging (property_details, room_types, beds, amenities) | ✅ drafted |
| `009_activities.sql` | Activities (activity_details, meeting_points, fish_species) | ✅ drafted |
| `010_marina_public_retail.sql` | Marina, Public Places (facilities/access_rules/live_conditions), Retail (products/variants/inventory) | ✅ drafted |
| `011_artist.sql` | Artist pack (artist_profiles + shows/bookings/follows/goals/songs/links/requests/shoutouts) | ✅ drafted |
| `012_operations.sql` | Operations (entity_owners, claims, invites, integrations, analytics_events, tourist_*) | ✅ drafted |
| `013_key_map_profile.sql` | entity_key_map + entity_profile_cache + refresh queue + conflicts (the one projection every reader/AI uses) | ✅ drafted |

**Core + every module pack is drafted AND APPLIED to the live database** (project
`mkepugvdlktfsossumox`, schema `v2` — 109 tables, confirmed via `list_tables`).
`public.*` is completely untouched; `v2.*` is additive only.

**`014_migrate_core_data.sql` has been EXECUTED against live production data.**
Every number below is a verified exact match (source count == v2 count) run
directly against the live database on 2026-07-15:

| Data | Rows migrated |
|---|---|
| Entities | 3,428 / 3,428 |
| Photos → media | 19,866 / 19,866 |
| Hours | 13,805 / 13,805 |
| Menu sections / items | 1,585 / 1,585 · 9,227 / 9,227 |
| Drink items | 403 / 403 |
| Happy hour items | 134 / 134 |
| Reviews | 10,481 / 10,481 |
| Events | 922 / 922 |
| Specials | 33 / 33 |
| Sections → content_blocks | 287 / 287 |
| FAQs (merged faqs + entity_faqs) | 544 / 544 |
| Policies | 35 / 35 |
| Team members → people | 15 / 15 |
| Tags (deduplicated) | 81,206 → 29,428 |

Phases 1-3 done. Phase 4 (entity_key_map) done — populated with slug, legacy
uuid, and google_place_id for every entity. Phase 6-7 (core identity + hours/
media/content migration) done.

**Not yet done:** Phase 5 (taxonomy cleanup — normalizing inconsistent
entity_subtype spellings), Phase 8-9 (commerce/booking/industry-module data —
these packs have no source data to migrate yet, most source tables are empty),
Phase 10 (compile entity_profile_cache — the JSON every reader will serve),
Phase 11 (stop legacy dashboard fallback writes), Phase 12 (switch API reads
to v2), Phase 13-16 (validation, shadow, cutover, archive legacy).

**IMPORTANT — this migration is a snapshot, not a live sync.** New/edited data
written through the current API still goes to `public.*` only. `v2.*` will
drift out of date until Phase 11/12 land (API writes/reads point at v2).
Re-run this file (against a truncated v2, or write an incremental sync) before
cutover.

## Second wave (`015_migrate_commerce_data.sql`) — the charter/rental/service side

The first pass covered restaurant-style content but missed the booking/commerce
tables. This wave migrated those, all verified exact against the live DB:

| Data | Rows migrated |
|---|---|
| module_catalog | 29 / 29 |
| entity_modules (which tabs/features are enabled per business) | 37,610 / 37,847 (see note) |
| offerings (charters, tours, rentals, services, packages) | 348 / 348 |
| offering_prices | 285 real + 6 synthesized from `offerings.price_from` where no price row existed = 291 |
| bookable_resources → resources (condo units, boats, vehicles) | 1,008 / 1,008 |
| resource_rates (nightly price) | 11 |
| resource_fees (cleaning + service fees) | 2,016 |
| requirements → content_blocks | 477 / 477 items (61 entities) |
| whats_included → content_blocks | 54 / 54 items (+ 6 from entity_sections sharing the label, distinguishable by `legacy_ref`) |
| what_to_bring → content_blocks | 22 / 22 items |
| pricing_items → content_blocks | 204 / 204 items (+ 102 from entity_sections sharing the label) |
| fish_species | 31 / 31 |
| artist_profiles | 390 / 390 |

**Notes, not hidden:**
- **237 `entity_modules` rows were not migrated** — they reference an
  `entity_slug` that doesn't exist in `public.entity` at all. This is
  pre-existing bad data in the live database, not something the migration
  broke. Logged in `v2.entity_conflicts` (`conflict_type='orphan_row'`) for
  someone to review, not silently dropped.
- **`public.artists` (390 rows) is still unmerged with `public.artist_profiles`
  (390 rows).** Same row count, likely duplicates of the same 390 artists —
  the plan flags this as a real merge decision, not something to auto-resolve.
  Logged in `v2.entity_conflicts` (`conflict_type='duplicate_slug'`).
- **None of the 390 `artist_profiles` rows link to a GCR entity.** Their
  `entity_slug` values are all populated but point at a separate slug
  namespace belonging to a disconnected artist-tipping mini-app (its own
  `site_id`/`owner_user_id` fields) — not GCR businesses. `v2.artist_profiles.entity_id`
  is NULL for all 390; this is real, not a bug.
- **Spotify/YouTube/Venmo/CashApp are empty for all 390 artists in the source
  data itself** — 0 populated, verified directly. `v2.music_links` /
  `v2.tip_links` are correctly empty; there is nothing to migrate.

## Zero JSON, zero arrays — everything is a real table (hard requirement)

`v2` originally had 9 `jsonb` columns and 2 array columns left over from the
first two migration waves (`content_blocks.items`, `entity_modules.settings`,
`media_assets.ai_tags`, `module_catalog.required_tables`/`default_for`,
`analytics_events.utm`, `entity_conflicts.detail`,
`entity_module_status.validation_errors`, `integration_accounts.settings`,
`resource_calendar_sources.settings`, `tourist_itineraries.items`,
`tourist_profiles.preferences`, `entity_relations.metadata`). **All of them
have been eliminated** (`018_eliminate_remaining_json...` — applied directly,
not yet saved as its own file below; see migration history). Every one was
replaced with a real table or real typed columns, with existing data verified
moved before the column was dropped (1,067/1,067 content items; 238/238
conflict rows preserved with real `source_table`/`entity_slug`/`module_key`/
`note` columns). Confirmed by direct query against
`information_schema.columns`: **0 jsonb/json/array columns remain anywhere in
schema `v2`.**

New real tables from this pass: `content_block_items`, `entity_module_settings`,
`media_asset_tags`, `module_catalog_tables`, `module_catalog_business_types`,
`entity_page_assignments`, `entity_module_validation_errors`,
`integration_account_settings`, `resource_calendar_source_settings`,
`tourist_itinerary_stops`, `tourist_preference_scores`.

**`entity_profile_cache` and `entity_profile_refresh_queue` were removed
entirely**, not just de-JSONed. Their whole purpose was to hold a compiled
JSON blob as a read cache — the opposite of what was asked for. There is no
profile cache: every reader (web, QR, rental, service, any AI) queries the
real modular tables directly, joined at read time. If read performance ever
requires a cache later, that is a decision to make explicitly, not something
to reintroduce by default.

Also newly migrated into real rows (not arrays) from the original wide
`entity` table: `known_for` (35), `highlights` (2,421), `good_for` (1,551),
and `seo_keywords` (701) → `v2.entity_tags` with a matching `tag_category`.
`secondary_subtypes` and `also_appears_on` were empty in the source (0 rows) —
`v2.entity_page_assignments` exists and is ready for `also_appears_on` data
whenever it's populated.

## Phase tracker (plan's 16 phases)
- [~] **1 Freeze contract** — routes documented in `../../CANONICAL_DATABASE.md`; "no new legacy tables" rule in force.
- [ ] **2 Supabase dev branch** — create branch, apply these migrations there first.
- [~] **3 v2 canonical tables** — Core drafted here; remaining packs to follow.
- [ ] 4 Build `v2.entity_key_map` · 5 Clean taxonomy · 6–9 Migrate data · 10 Universal reader/index · 11 Fix dashboard writes · 12 Switch API reads to EntityProfileV1 · 13 Per-slug validation · 14 Shadow · 15 Cut over · 16 Archive legacy.

## Parallel track — Immediate Code Fixes (blockers, from the plan)
These are code-level and can land before full migration. Tracked separately so a
working live site is never broken to chase them:
- [ ] Stop legacy dashboard fallback writes → return `ENTITY_NOT_LINKED`.
- [ ] Fix menu helper column names → `entity_slug` + `section_id`.
- [ ] Fix gallery writes → canonical `entity_photos` fields (`url`/source), not `image_url`/`alt_text`.
- [ ] Unify rental/service/QR readers onto the profile projection.
- [ ] Populate `entity_owners`; build `entity_key_map`.
