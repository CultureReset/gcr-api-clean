# Handoff — read this before running anything

Written after I applied a schema migration to the **wrong Supabase project**.
This document records what happened, what is verified, what is not, and what is
left to do.

The rule I broke and that should hold from here: **do not guess.** Anything
below that I did not personally verify is marked `NOT VERIFIED`. Nothing in
this file should be acted on without checking the marked items first.

---

## 1. The mistake

I applied seven SQL files to Supabase project **`gulf coast radar`
(`adpnhipmdefutkzzltbs`)**. That is not the database this platform runs on.

I picked it by matching its schema — it has `entity`, `entity_sections`,
`menu_items`, `entity_photos` — and concluded it must be the GCR database. That
was an inference, not a check. I should have confirmed the target before
writing to a production database and I did not.

The real database is **`cyber check` (`mkepugvdlktfsossumox`)**.

### How the real one is identifiable

| Signal | `cyber check` (real) | `gulf coast radar` (wrong) |
|---|---|---|
| Tables with an `entity_slug` column | **309** | 20 |
| `entity` rows | **4,067** | 2,301 |
| `menu_items` rows | **11,147** | 7,551 |
| The five ingestion tables | **all present** | absent |

Everything keys off the slug. That is the tell, and it is unambiguous.

### Damage

**None to data.** The wrong project has been fully reverted and verified:

- 0 of the ~36 tables I created remain
- 0 of the columns I added to `entity`, `availability`, `menu_sections` remain
- `amenities`, `activities`, `packages` restored under their original names
- Row counts back to their originals: entity 2,301 · menu_items 7,551 ·
  menu_sections 1,637 · entity_photos 7,118 · platform_settings 1
- Table count back to 182

**I never wrote to the real database.** Every query I ran against
`mkepugvdlktfsossumox` was read-only — `select` against `information_schema`
and `count(*)`. No insert, no alter, no create.

### What else the mistake produced

Three findings I reported as facts were artifacts of reading the wrong
database. They are **false**:

1. ~~"The five ingestion tables don't exist."~~ They all exist on the real
   database.
2. ~~"`availability` is missing five columns the engine needs."~~ It already
   has `entity_slug, resource_id, date, start_time, end_time, status,
   spots_total, spots_remaining, offering_id`.
3. ~~"`routes/gcr.js:320` is already broken."~~ It queries
   `amenities` for `id,name,category,icon,is_shared` by `entity_slug`, and the
   real `amenities` table is exactly that. **That code is correct.**

`entity.daily_capacity` and `entity.capacity_per_slot` also already exist on
the real database.

---

## 2. Every SQL file in `sql/` is now banner-marked DO NOT RUN

All eight carry a header pointing here. Verdicts below are based on comparing
each file against shapes I read from the real database.

| File | Verdict against the REAL database |
|---|---|
| `00_legacy_rename.sql` | **DANGEROUS.** Real `activities` has `activity_name` and real `packages` has `whats_included`, so both guards fire and both tables get renamed away. Both are empty so no data is lost, but any code selecting them breaks. |
| `capability_tables.sql` | **DANGEROUS.** `create table if not exists` silently skips the real `vessels` (37 rows), `amenities` (37), `entity_amenities` (756), `activities`, `packages` — leaving their existing shapes while the new routes expect mine. Produces a broken hybrid. |
| `capability_seed.sql` | **WILL ERROR.** Inserts `amenities (key, label, category, sort_order)`; the real `amenities` has no `key` and no `label`. |
| `menu_normalization.sql` | **PARTIAL.** `service_periods`, `service_period_days`, `menu_item_prices` are genuinely new and fine. The `dietary_tags` insert **will error** — real `dietary_tags` is `id, name, icon, sort_order, created_at`, with no `key`/`label`/`kind`. |
| `booking_ingestion.sql` | No-op. Both columns already exist. |
| `booking_ingestion_tables.sql` | Premise is wrong (all five tables exist). Column-level comparison `NOT VERIFIED` — see §4. |
| `admin_dashboard_gaps.sql` | `NOT VERIFIED`. |
| `composio_connections.sql` | `NOT VERIFIED`. |

**Recommendation: treat `sql/` as scrap.** It was authored against the wrong
schema. Rewriting it against the real one is cheaper and safer than auditing it.

---

## 3. What the real database already has

Read-only, verified by me on the real project.

### Tables that already exist WITH DATA — do not recreate, do not reshape

| Table | Rows | Actual columns |
|---|---|---|
| `bookable_resources` | **1,055** | 35 cols incl. `entity_slug, slug, resource_type, bedrooms, bathrooms, capacity, sqft, nightly_price, cleaning_fee, service_fee, site_id` |
| `offerings` | 954 | not inspected |
| `entity_amenities` | **756** | `id, entity_slug, amenity, category, sort_order, created_at` — `amenity` is **text**, not a catalog FK |
| `vessels` | **37** | `id, entity_slug, slug, name, vessel_category, length_ft, passenger_max, year, make_model, engine_description, description, source_resource_id, is_active, created_at` |
| `amenities` | **37** | `id, entity_slug, name, category, icon, is_shared` — per-entity, **not** a catalog |
| `fish_species` | **36** | `id, entity_slug, species, season, sort_order, peak_months, size_range, bag_limit, size_limit, regulation_notes, fishing_method, depth_range, best_bait, is_regulated` |
| `dietary_tags` | **7** | `id, name, icon, sort_order, created_at` |
| `room_types` | 2 | not inspected |
| `menu_sections` | 1,940 | has **no** `service_period_id` |
| `menu_items` | 11,147 | not inspected |
| `entity` | 4,067 | has `daily_capacity` and `capacity_per_slot` |

### Tables that exist but are EMPTY

`availability` (0) · `business_availability` (0) · `email_parser_log` (0) ·
`booking_calendar` (0) · `entity_external_calendars` (0) · `gcr_deals` (0) ·
`activities` (0, shape `id, entity_id, activity_name, …`) ·
`packages` (0, shape `id, site_id, …, whats_included`) ·
`menu_item_dietary` (0, shape `id, menu_item_id, flag, catalog_item_id`)

`business_availability` columns (verified): `id, entity_slug,
availability_date, time_slot, end_time, total_capacity, booked_count,
remaining_spots, status, booking_type, source_platform, last_minute_deal,
last_minute_price, original_price, last_updated, last_email_log_id,
created_at, visible_on_profile, resource_id, external_uid`.

### Genuinely absent from the real database

`entity_operations` · `trips` · `gear` · `spaces` · `space_event_types` ·
`units` · `unit_beds` · `unit_amenities` · `vessel_amenities` ·
`space_amenities` · `species` · `entity_species` · `entity_activities` ·
`service_periods` · `service_period_days` · `menu_item_prices` ·
`community_photos` · `category_cards` · `business_leads` ·
`platform_connections` · `platform_connection_categories` ·
`entity_connections` · `menu_sections.service_period_id`

---

## 4. NOT VERIFIED — do not act on these without checking

- **`GCR_SUPABASE_URL`.** I never read the deployed value. Vercel's API did not
  return env vars to me, and the tools that would have settled it needed an
  approval this session could not give. The target was confirmed verbally, not
  by me. **Check the env var in the `gcr-api-clean` Vercel project.**
- **Column shapes of `email_parser_log`, `booking_calendar`,
  `entity_external_calendars`, `gcr_deals`** on the real database. I confirmed
  they exist and are empty. I did **not** read their columns.
- **`admin_dashboard_gaps.sql` and `composio_connections.sql`** against the
  real schema.
- **Whether any of the 81 dashboard sections work against the real database.**
  Nothing has ever been run against it. Every "verified" claim I made in this
  session was against a stub API, a fake query builder, or the wrong database.
- **The other ~530 tables** in the real project. I looked at about 40.
- **`routes/gcr.js`, `routes/platform.js`, `routes/deals.js`** and the rest of
  the pre-existing routes against the real schema.

---

## 5. What still needs doing

### 5.1 The capability model has to be rebuilt around the real schema

`routes/capabilities.js`, the capability half of `routes/admin-platform.js`,
and the dashboard's **Listing Data** and **Find a Match** sections all assume
the tables I invented. On the real database they will fail — the tables are not
there, or are there in a different shape.

The correct approach is **map to what exists, add only what does not**:

| Capability | Should point at | Action |
|---|---|---|
| units | **`bookable_resources`** (1,055 rows) | map — do not create `units` |
| vessels | **`vessels`** (37 rows) | map to real columns (`vessel_category`, `passenger_max`, `make_model`); add new columns like `has_ac`, `has_head` **additively** |
| species | **`fish_species`** (36 rows, per-entity) | map — do not build a catalog + join |
| amenities | **`entity_amenities`** (756 rows, text) | map to the text model |
| operations, trips, gear, spaces, unit_beds, service periods | absent | genuinely new — safe to create |

This is a real redesign, not a rename. It needs doing before any of it is run.

### 5.2 Security — still open, and now more urgent

`routes/email-parser.js` has **no auth on any route**.
`GET /api/email-parser/log` returns `raw_text` (up to 5,000 characters of email
body), `customer_name`, `from_email` and `confirmation_no` to anyone who asks.
`/setup/:slug` and `/availability/:slug` are also open.

Fix is one word — `adminRequired` — on those three routes, leaving `/inbound`
open so the parser keeps receiving mail. Not applied because it touches the
live inbound pipeline and needs your go-ahead.

### 5.3 Other open items

- **Capacity is unset.** On the wrong database it was 0 of 2,301. `NOT VERIFIED`
  on the real one. A business with no `daily_capacity` can never report an
  opening.
- **SMS / Messaging** has no route anywhere. `routes/messaging.js` is commented
  out in `server.js`.
- **Menu prices / dietary** — no routes or UI. Note `menu_item_dietary` already
  exists on the real DB with `flag` and `catalog_item_id`, which is a different
  design from the one I wrote.
- **Owner dashboards** — separate repo, not in this session's GitHub scope.
- **Deploy + smoke test** — never run. `npm run smoke -- --base <url> --email … --password …`

---

## 6. Repository state

Both branches are `claude/cybercheck-modular-react-dashboard-7on41c`, committed
and pushed.

- **`gcr-api-clean`** — routes, the availability engine, the embed widget and
  the capability layer. All `sql/` files banner-marked DO NOT RUN.
- **`Admin-dashboard-main`** — 81 sections, React 19 + Vite 8. Builds clean,
  lints clean, all 81 routes render against a **stubbed** API. Never tested
  against the real one.

No code in either repo has been validated against the real database.
