# Handoff — read this before running anything

Two things live in this file: the record of a schema migration applied to the
**wrong Supabase project**, and the list of what is still open because of it.

The rule that should hold from here: **do not guess.** Anything below that has
not been confirmed against the live database is marked `NOT VERIFIED`.

> **Dated.** Sections 1–3 record reads taken on **2026-08-03**, and nothing in
> them has been re-checked against the live database since — several sessions
> have tried and been stopped by an approval prompt for the Supabase tools.
> Where this file and `CLAUDE.md` disagree, **`CLAUDE.md` wins**: it is newer
> and it is the file the project maintains. One such disagreement is called out
> in §2 and §3.

---

## 1. The mistake

Seven SQL files were applied to Supabase project **`gulf coast radar`
(`adpnhipmdefutkzzltbs`)**. That is not the database this platform runs on.

It was picked by matching its schema — it has `entity`, `entity_sections`,
`menu_items`, `entity_photos` — and concluding it must be the GCR database.
That was an inference, not a check. The target should have been confirmed
before writing to a production database.

The real database is **`cyber check` (`mkepugvdlktfsossumox`)**.

### How the real one is identifiable

`CLAUDE.md` carries the current, maintained version of this table — use it
rather than this one. As read on 2026-08-03:

| Signal | `cyber check` (real) | `gulf coast radar` (wrong) |
|---|---|---|
| Tables with an `entity_slug` column | **309** | 20 |
| `entity` rows | **4,067** | 2,301 |
| `menu_items` rows | **11,147** | 7,551 |
| The five ingestion tables | **all present** | absent |

Everything keys off the slug. That is the tell, and it is unambiguous.

### Damage

**None to data.** The wrong project was fully reverted and verified: 0 of the
~36 created tables remain, 0 of the added columns remain, `amenities` /
`activities` / `packages` restored under their original names, row counts back
to their originals, table count back to 182.

**The real database was never written to.** Every query against
`mkepugvdlktfsossumox` in that session was read-only.

### What else the mistake produced

Three findings reported as facts were artifacts of reading the wrong database.
They are **false**:

1. ~~"The five ingestion tables don't exist."~~ They all exist on the real
   database.
2. ~~"`availability` is missing five columns the engine needs."~~ It already
   has `entity_slug, resource_id, date, start_time, end_time, status,
   spots_total, spots_remaining, offering_id`.
3. ~~"`routes/gcr.js:320` is already broken."~~ It queries `amenities` for
   `id,name,category,icon,is_shared` by `entity_slug`, and the real `amenities`
   table is exactly that. **That code is correct.**

`entity.daily_capacity` and `entity.capacity_per_slot` also already exist.

---

## 2. The SQL files

Twelve files now, not eight. They fall into two groups.

### Eight banner-marked DO NOT RUN — written against the wrong schema

| File | Verdict against the REAL database |
|---|---|
| `00_legacy_rename.sql` | **DANGEROUS.** Real `activities` has `activity_name` and real `packages` has `whats_included`, so both guards fire and both tables get renamed away. Both are empty so no data is lost, but any code selecting them breaks. |
| `capability_tables.sql` | **DANGEROUS.** `create table if not exists` silently skips the real `vessels` (37 rows), `amenities` (37), `entity_amenities` (756), `activities`, `packages` — leaving their existing shapes while the new routes expect different ones. Produces a broken hybrid. |
| `capability_seed.sql` | **WILL ERROR.** Inserts `amenities (key, label, category, sort_order)`; the real `amenities` has no `key` and no `label`. |
| `menu_normalization.sql` | **PARTIAL.** `service_periods`, `service_period_days`, `menu_item_prices` are genuinely new and fine. The `dietary_tags` insert **will error** — real `dietary_tags` is `id, name, icon, sort_order, created_at`. |
| `booking_ingestion.sql` | No-op. Both columns already exist. |
| `booking_ingestion_tables.sql` | Premise is wrong (all five tables exist). Column-level comparison `NOT VERIFIED`. |
| `admin_dashboard_gaps.sql` | `NOT VERIFIED`. |
| `composio_connections.sql` | **Its banner is now wrong — see below.** |

**`composio_connections.sql` — the banner overstates the case.** It creates
`platform_connection_categories`, `platform_connections` and
`entity_connections`. §3 below lists `platform_connections` as absent from the
real database, but `CLAUDE.md` — written one commit *later* — records it as
present with **~1,070 rows**, and uses its existence as *the* telltale for
identifying the right project. `routes/composio.js` reads it in live code, and
the App Store and Connections screens resolve against it in the endpoint audit.

So the tables this file creates exist and hold data. Its banner's claim that it
was "never validated against the real one" no longer describes reality. The
file itself is `create table if not exists` throughout, so it is a no-op
against the current database rather than a hazard. **Confirm with a live row
count before relying on this paragraph** — it reconciles two documents, which
is exactly the kind of inference §1 is a monument to.

### Four written against the real schema — not banner-marked, and correct

`business_claims_entity_slug.sql` · `business_mcp_tokens.sql` ·
`business_signups.sql` · `entity_listed_on_gcr.sql`

These back shipped features (claims, MCP tokens, phone sign-up, GCR listing).
Whether each has been **applied** to the live database is `NOT VERIFIED`; if
one has not, the feature behind it fails at runtime rather than at deploy.

**The `sql/` directory is still not a migration system.** There is no record of
what has been applied. That is the root cause of every ambiguity above.

---

## 3. What the real database had on 2026-08-03

Read-only, verified on the real project on that date. Not re-checked since.

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

### Absent from the real database, as read on that date

`entity_operations` · `trips` · `gear` · `spaces` · `space_event_types` ·
`units` · `unit_beds` · `unit_amenities` · `vessel_amenities` ·
`space_amenities` · `species` · `entity_species` · `entity_activities` ·
`service_periods` · `service_period_days` · `menu_item_prices` ·
`community_photos` · `category_cards` · `business_leads` ·
`platform_connection_categories` · `entity_connections` ·
`menu_sections.service_period_id`

> `platform_connections` was on this list and has been removed from it. See §2
> — `CLAUDE.md` records it as present with ~1,070 rows. The two entries either
> side of it, `platform_connection_categories` and `entity_connections`, come
> from the same SQL file and are therefore also suspect; they have not been
> re-read.

---

## 4. NOT VERIFIED — do not act on these without checking

- **Everything in §3.** Those reads are from 2026-08-03.
- **`GCR_SUPABASE_URL`** as deployed. Never read off Vercel. Confirmed
  verbally, not by inspection. `scripts/verify-db-connection.mjs` answers this
  — run it against the deployment.
- **Column shapes of `email_parser_log`, `booking_calendar`,
  `entity_external_calendars`, `gcr_deals`.** Confirmed to exist and be empty;
  columns never read.
- **Whether the four clean SQL files in §2 have been applied.**
- **`platform_connections` and its two sibling tables** — the §2 reconciliation.
- **Whether any dashboard section works against the real database.** Nothing
  has ever been run against it. Every "verified" claim in the originating
  session was against a stub API, a fake query builder, or the wrong database.
- **The other ~530 tables.** About 40 were looked at.
- **`routes/gcr.js`, `routes/platform.js`, `routes/deals.js`** and the rest of
  the pre-existing routes against the real schema.

Repeated attempts to settle these have been blocked by an approval prompt on
the Supabase MCP tools. **Granting that once would close most of this section**
and is the highest-leverage thing available.

---

## 5. What still needs doing

### 5.1 The capability model still has to be rebuilt around the real schema

**Still open. Nothing about this has changed.**

`routes/capabilities.js` describes `units`, `species` + `entity_species`,
`entity_activities`, `unit_beds`, `space_event_types`, `vessel_amenities`,
`service_periods` and `packages`. Per §3 those are absent. It describes
`vessels` with `vessel_type` / `max_passengers` / `make` / `model`; the real
37-row table has `vessel_category` / `passenger_max` / `make_model`. It treats
`amenities` as a catalog with an `amenity_id` join; real `entity_amenities`
stores `amenity` as plain text.

The dashboard's **Listing Data** (`src/modules/booking/AttributesPanel.jsx`)
and **Find a Match** (`src/modules/booking/Match.jsx`) are driven by it.

**The guard cannot catch this.** `scripts/check-capability-columns.mjs`
validates `capabilities.js` against `sql/*.sql` — the same DO-NOT-RUN files
written against the wrong database. Both sides share one wrong assumption, so
`npm run verify` passes green. The check that exists to catch exactly this
drift is structurally incapable of it. **Point it at the live schema** — that
is a precondition for trusting the rest of this repo's gate, and it needs the
database access §4 describes.

The correct approach remains **map to what exists, add only what does not**:

| Capability | Should point at | Action |
|---|---|---|
| units | **`bookable_resources`** (1,055 rows) | map — do not create `units` |
| vessels | **`vessels`** (37 rows) | map to real columns; add new ones **additively** |
| species | **`fish_species`** (36 rows, per-entity) | map — no catalog + join |
| amenities | **`entity_amenities`** (756 rows, text) | map to the text model |
| operations, trips, gear, spaces, unit_beds, service periods | absent | genuinely new — safe to create |

This is a redesign, not a rename.

### 5.2 Security — CLOSED

`routes/email-parser.js` had no auth on any route. Fixed; see the header of
that file for which routes are open and why. In short: `/inbound`, `/manual`
and `/availability/:slug` are public because a mail provider, a booking visitor
and the public website respectively have no token to present. Everything else
carries `adminRequired`.

The two open write paths are narrowed rather than guarded — a public booking
may only ever land as `pending`, must name a real listing, and is rate limited
in `server.js`. `/availability/:slug` no longer returns the guest list and now
honours `visible_on_profile` like every other public reader.

Note for anyone revisiting: the obvious fix — `ownerRequired` on `/manual`,
`adminRequired` on `/availability/:slug` — **breaks production.** The public
site posts reservations to the first and renders the second.

### 5.3 Other open items

- **Capacity is unset.** `NOT VERIFIED` on the real database. A business with
  no `daily_capacity` can never report an opening.
- **SMS / Messaging** has no route anywhere. `routes/messaging.js` is unmounted
  in `server.js`. It is the one dashboard section depending on a route that
  exists nowhere; `endpoints.sms.config`, the two `leads.businessLead*` and the
  two `photos.community*` are the declared-missing set behind it.
- **Menu prices / dietary** — no routes or UI. `menu_item_dietary` already
  exists with `flag` and `catalog_item_id`, a different design from
  `menu_normalization.sql`'s.
- **Deploy + smoke test** — never run.
  `npm run smoke -- --base <url> --email … --password …`

---

## 6. Repository state

Work is on `claude/admin-dashboard-repo-review-47q2vc` in both repos.

- **`gcr-api-clean`** — `npm run verify` passes (74 checks). Eight `sql/` files
  banner-marked DO NOT RUN; four written against the real schema.
- **`Admin-dashboard-main`** — 88 sections, React 19 + Vite 8.
  `npm run verify` passes clean: lint, endpoint audit (316 endpoints resolve,
  0 unexpected missing, 11 declared missing), section map, build.

The endpoint gap the original handoff described — 58 endpoints returning 404
pending a deploy — is **closed**. What remains is the 11 declared-missing above.

**No code in either repo has been validated against the real database.** That
sentence has been true since this file was created and is the single most
important thing in it.
