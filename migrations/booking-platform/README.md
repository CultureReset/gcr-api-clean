# Booking platform — schema

One modular booking platform covering every vertical, built on the existing
GCR spine. **88 tables + 5 views across 12 additive migrations.** Nothing here
is applied — same convention as `migrations/2026-07-19-canonical-gaps.sql`.

```
00-spine.sql              universal: bookings, offerings, calendar     8 tables
01-lodging-core.sql       condo/hotel supply + pricing                11 tables
02-lodging-booking.sql    stays, quotes, cancellation                  7 tables
03-lodging-money.sql      ledger, payouts, owner statements           10 tables
04-lodging-ops.sql        cleaning, maintenance, access                8 tables
05-lodging-surfaces.sql   settings, module seed, admin views    1 table + 5 views
06-activities.sql         charters, tours, classes                     6 tables
07-rentals.sql            boats, jet skis, equipment fleet             6 tables
08-appointments.sql       photographers, salons, spas, staff           9 tables
09-dining.sql             tables, covers, waitlist                     7 tables
10-transportation.sql     shuttles, dispatch, drivers                  6 tables
90-legacy-backfill.sql    migration functions (moves NO data on apply)
```

Apply in order — later files reference earlier ones. `00-spine.sql` is
mandatory; every vertical file after it is independent, so you can apply only
the verticals you need.

---

## The one idea

**Every vertical is the same three things**: a catalog row, a booking row, and
a date claim. They differ only in the *unit* and the extension fields.

| Vertical | Unit | Catalog | Booking extension | Distinct problem |
|---|---|---|---|---|
| Lodging | `night` | `lodging_units` | `lodging_stays` | date *ranges*, owner money |
| Activities | `person` | `offerings` + `activity_departures` | `activity_tickets` | shared seats on a fixed departure |
| Rentals | `hour`/`day` | `rental_assets` | `rental_contracts` | the asset comes **back** |
| Appointments | `session` | `offerings` + `staff_members` | `appointments` | capacity is a *person* |
| Dining | `cover` | `dining_tables` | `dining_reservations` | tables turn every 90 min |
| Transport | `trip` | `transport_vehicles` | `transport_trips` | capacity moves through space |

All six write the same `bookings` row and claim dates in the same
`booking_calendar`. That is what makes it one platform instead of six.

---

## How it attaches to what exists

| Existing thing | How it is used |
|---|---|
| `entity` | A business is an entity row. No new business table. |
| `entity_owners` | Unchanged — how a client's login reaches their data. |
| `entity_modules` | Where installs live. Every vertical is an **option**. |
| `bookings` | The one universal record. Verticals extend, never replace. |
| `booking_calendar` | The only place date claims live. |
| `booking_line_items` | Reused for fees/taxes (defined in `canonical-gaps.sql`). |
| `entity_external_calendars` | Its `resource_id` now points at `lodging_units.id` / `rental_assets.id`, so the existing iCal importer blocks a specific unit with no code change. |
| `schedule_rules` | Generates `activity_departures` (canonical-gaps). |
| `waivers` | `activity_manifest.waiver_id` points here. |
| `routes/stripe.js` | Still moves money. The ledger is the *book* of what moved. |
| `routes/rides.js` | Its dispatch/rotation logic finally has a real schema. |
| `routes/email-parser.js` | Its OpenTable/Resy/Toast extractors now have `dining_reservations` to land in instead of only `business_availability`. |

**Availability is computed, never stored:**

```
bookable(resource, date) =
      the vertical's own rule (rate_calendar / departure seats / shift / turn time)
  AND no active booking_calendar claim for (entity_slug, offering_id, date)
```

---

## The three surfaces

Every table is `entity_slug`-scoped. The same rows render in three places.

**1. Standalone platform** — own domain, public search/listing/checkout.
Reads `standalone_lodging_listings`; only `live` rows from clients with
`show_on_standalone`.

**2. Client dashboard** — installed via `entity_modules`. `05-*.sql` seeds 11
lodging modules into `module_manifest`. A restaurant client never sees them; a
condo client gets Units / Calendar / Pricing / Reservations / Owners /
Cleaning / Maintenance / Access / Channels tabs.

**3. Your admin** — the four `admin_lodging_*` views are the only thing that
deliberately ignores `entity_slug` scoping. **Do not expose them on any
client-facing route.**

Plus a mobile **ops** surface (cleaners, maintenance, drivers) scoped by
`vendor_id` / `assigned_to` / `driver_id`.

---

## Decisions worth knowing about

**Verticals extend `bookings`, they don't replace it.** `platform.js` says one
universal booking table and the unit is data. Each vertical adds exactly one
extension row keyed on `booking_id`.

**Double-booking is prevented by the database.** `lodging_stays` has a GiST
exclusion constraint on `(unit_id, stay_range)`. Range is `[check_in,
check_out)` — half-open, because a checkout and the next arrival are the same
calendar date and must not collide. Application-level checks lose the race
under concurrency.

**`booking_calendar` has a dedup index** on `(entity_slug, source,
external_uid)`. A re-forwarded confirmation email cannot double-claim a date —
which is the exact failure mode `email-parser.js` guards against in code and
can now rely on in the schema.

**`rate_calendar` is one row per unit per date.** Season/weekend/event pricing
cannot be columns on the unit.

**Money is double-entry.** Debit/credit pairs sharing a `group_id`;
corrections are reversing pairs, never edits. Note `ledger_accounts` uses a
COALESCE-based unique index — a plain `UNIQUE` with nullable columns silently
allows duplicates because `NULL <> NULL`.

**Tax is a table, not a number.** A Gulf Shores stay carries Alabama state,
Baldwin County, and city lodging tax. Rates are effective-dated.

**Transportation keeps its own model on purpose.** It is the one vertical that
is genuinely not offering + calendar, because the vehicle must physically be
at the origin.

---

## ⚠️ Before applying

1. **Verify the spine.** `platform.js` reads `bookings`, `offerings`,
   `booking_calendar`, `promos`, `entity_modules`, `entity_owners` — none had
   a `CREATE TABLE` in this repo. `00-spine.sql` defines them from actual
   `platform.js` usage, but every statement is `IF NOT EXISTS`, so **it will
   not reconcile a column mismatch on tables that already exist.** Run the
   audit query at the bottom of `00-spine.sql` against the live GCR Supabase
   first. Three outcomes: 0 rows → apply as-is; 8 rows → diff and capture the
   live shape back into the file; partial → apply the gaps and find out which
   `platform.js` routes are silently failing today.

2. **Apply `canonical-gaps.sql` first, or accept the gaps.**
   `booking_line_items`, `customer_identities`, `schedule_rules` and
   `schedule_exceptions` are referenced here and defined there.

3. **`90-legacy-backfill.sql` moves no data on apply.** It defines functions.
   Data moves only when you call one, one table at a time. Only
   `entity_bookings` has a real mapping — the other six legacy tables have no
   `CREATE TABLE` anywhere, so their templates need the §1 audit filled in
   before use.

4. **Secrets in columns.** `lodging_access_codes.code_value`,
   `lodging_arrival_instructions.wifi_password`,
   `rental_contracts.renter_dl_number`, `transport_drivers.license_number`.
   Restrict column access or move them behind service-role-only views before
   any client dashboard touches them. `lodging_owners.tax_id_last4` is last-4
   only, deliberately — do not widen it.

5. **Two module registries still disagree.** `modules.js` uses
   `module_manifest` + `user_modules` keyed on `site_id`; `platform.js` uses
   `entity_modules` keyed on `entity_slug`. This folder seeds the shared
   *catalog* and installs to `entity_modules`. Retiring `user_modules` is a
   separate cleanup.

---

## Validation

Applied against a scratch PostgreSQL 16 instance. All 12 files apply clean in
order and re-run idempotently three times with no seed duplication. Behaviour
verified:

- overlapping stays on one unit → rejected by `lodging_stays_no_overlap`
- back-to-back stays (checkout = next arrival) → accepted
- cancelled stay → dates free, rebooking succeeds
- `backfill_entity_bookings()` → migrates, re-runs to 0, tags every row
- `backfill_bookings_to_calendar()` → one claim per booking, idempotent
- `rollback_backfill()` → removes exactly the tagged rows, leaves legacy
  tables untouched, refuses any non-`legacy:*` tag
- `booking_calendar` dedup index → rejects a duplicate `(source, external_uid)`
- all 5 views resolve

---

## Not built here

Schema only — no routes. Still to build: the quote engine, the rate-calendar
generator, the departure generator, the turnover generator, and the
availability resolver per vertical.

Also deliberately deferred: guest↔host messaging (`routes/messaging.js`
exists), double-blind reviews with rating breakdown (`entity_reviews` is
single-sided), wishlists, ID verification, dispute workflow, dynamic pricing
(`rate_calendar.source` reserves `'dynamic_pricing'`), 1099 generation.

## Minimum set to run one real client

**Lodging:** `lodging_units` · `rate_calendar` · `lodging_fees` · `tax_*` ·
`lodging_quotes` · `lodging_stays` · `lodging_payment_schedules` ·
`lodging_payments` · `lodging_owners` · `lodging_owner_agreements` ·
`lodging_owner_statements` · `lodging_cleaning_tasks` · `lodging_settings`

**Activities:** `offerings` · `offering_prices` · `activity_departures` ·
`activity_tickets` · `activity_manifest`

**Rentals:** `rental_assets` · `rental_rate_tiers` · `rental_contracts` ·
`rental_condition_reports`

Everything else is depth.
