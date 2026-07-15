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
| `002_hours.sql` | Hours (hour sets, periods, exceptions) | ⬜ todo |
| `003_content.sql` | Content + media (media_assets, entity_media, content_blocks, faqs, policies, events, specials, announcements, reviews) | ⬜ todo |
| `004_people.sql` | People (people, entity_people, person_offerings) | ⬜ todo |
| `005_commerce.sql` | Commerce (offerings, prices, schedules, inclusions, requirements, addons, resources + resource_*) | ⬜ todo |
| `006_booking.sql` | Booking (availability, bookings, booking_*, waivers, waitlists, quotes) | ⬜ todo |
| `007_food.sql` | Food (menus, periods, sections, items, options, dietary, daily features, tables) | ⬜ todo |
| `008_lodging.sql` | Lodging (property_details, room_types, beds, amenities) | ⬜ todo |
| `009_activities.sql` | Activities (activity_details, meeting_points, fish_species) | ⬜ todo |
| `010_marina_public_retail.sql` | Marina, Public Places, Retail packs | ⬜ todo |
| `011_artist.sql` | Artist pack (artist_profiles + shows/bookings/songs/etc.) | ⬜ todo |
| `012_ai.sql` | AI reader (raw_records, schema_registry, key_map, data_index, profile_cache, agents) | ⬜ todo |
| `013_operations.sql` | Operations (users, entity_owners, claims, integrations, analytics, tourist_*) | ⬜ todo |

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
