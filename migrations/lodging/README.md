# Lodging vertical — schema

Condo / vacation-rental / hotel booking, built on the existing GCR spine.
Five additive migrations. **Nothing here is applied yet** — same convention as
`migrations/2026-07-19-canonical-gaps.sql`, which is also sitting unapplied.

```
01-lodging-core.sql       supply + pricing        11 tables
02-lodging-booking.sql    stays + quotes           7 tables
03-lodging-money.sql      ledger + payouts        10 tables
04-lodging-ops.sql        cleaning + maintenance   8 tables
05-lodging-surfaces.sql   settings, modules, views 1 table + 5 views
```

Apply in order — later files reference earlier ones.

---

## How it attaches to what already exists

This does **not** introduce a parallel platform. It extends the model
`routes/platform.js` already declares in its header.

| Existing thing | How lodging uses it |
|---|---|
| `entity` | A lodging business is an entity row. No new business table. |
| `entity_owners` | Unchanged — how a client's login reaches their data. |
| `entity_modules` | Where the install lives. Lodging is an **option**, not a default. |
| `bookings` | Still the one universal booking record. `lodging_stays` extends it. |
| `booking_calendar` | Still the only place date claims live. One row per night. |
| `booking_line_items` | Reused for fees/taxes (defined in `canonical-gaps.sql`). |
| `entity_external_calendars` | Already has `resource_id` — now points at `lodging_units.id`, so the existing iCal importer blocks a **specific unit** with no code change. |
| `customer_identities` | `lodging_stays.customer_id` links here (also canonical-gaps). |
| `routes/stripe.js` | Still moves the money. The ledger is the book of what moved. |

**Availability is computed, never stored:**

```
bookable(unit, date) =
      rate_calendar.is_available
  AND no booking_calendar claim for (entity_slug, resource_id=unit_id, date)
  AND stay satisfies rate_calendar.min_stay / closed_to_arrival / closed_to_departure
```

---

## The three surfaces

Every table is `entity_slug`-scoped. The same rows render in three places.

### 1. Standalone platform (public, own domain)
Reads `standalone_lodging_listings` — only `status='live'` units belonging to
clients with `lodging_settings.show_on_standalone = true`.

| Screen | Tables |
|---|---|
| Search + map | `standalone_lodging_listings`, `rate_calendar`, `booking_calendar` |
| Listing detail | `lodging_units`, `_photos`, `_bed_configs`, `_unit_amenities`, `_policies` |
| Checkout | `lodging_quotes`, `lodging_holds`, `lodging_fees`, `tax_rates` |
| Confirmation / Trips | `lodging_stays`, `lodging_payment_schedules`, `lodging_access_codes` |

### 2. Client dashboard (the option they switch on)
Installed via `entity_modules`; catalog rows seeded into `module_manifest` by
`05-*.sql`. A restaurant client never sees any of it.

| Tab | Module key | Tables |
|---|---|---|
| Units | `lodging-units` | `lodging_units`, `_photos`, `_bed_configs`, `_unit_amenities`, `_properties` |
| Calendar | `lodging-calendar` | `rate_calendar`, `booking_calendar`, `lodging_stays`, `_owner_holds` |
| Pricing | `lodging-pricing` | `rate_calendar`, `lodging_rate_rules`, `lodging_fees`, `tax_*` |
| Reservations | `lodging-stays` | `lodging_stays`, `_stay_guests`, `_stay_events`, `_payments` |
| Owners | `lodging-owners` | `lodging_owners`, `_owner_agreements`, `_owner_statements`, `_payouts`, `_expenses` |
| Cleaning | `lodging-cleaning` | `lodging_cleaning_tasks`, `lodging_vendors` |
| Maintenance | `lodging-maintenance` | `_maintenance_tickets`, `_work_orders`, `_inspections` |
| Access | `lodging-access` | `lodging_access_codes`, `_arrival_instructions` |
| Channels | `lodging-channels` | `entity_external_calendars` (existing) |
| Settings | `lodging-core` | `lodging_settings`, `lodging_cancellation_policies`, `lodging_permits` |

### 3. Your admin (cross-client)
The four `admin_lodging_*` views are the only thing in this schema that
deliberately ignores `entity_slug` scoping — that is the admin's whole job.
**Do not expose them on any client-facing route.**

| Panel | Reads |
|---|---|
| Portfolio | `admin_lodging_portfolio` |
| Today (all clients) | `admin_lodging_today` |
| Money held / owed | `admin_lodging_liabilities` |
| Turnovers at risk | `admin_lodging_turnover_risk` |

### 4. Ops (mobile, cleaners + maintenance)
`lodging_cleaning_tasks` · `lodging_work_orders` · `lodging_inspections` ·
`lodging_access_codes`. Scoped by `vendor_id` / `assigned_to`, not by owner.

---

## Five decisions worth knowing about

**Stays extend `bookings`, they don't replace it.** `platform.js` says one
universal booking table and the unit is data. A reservation is a `bookings`
row (unit = `night`) plus one `lodging_stays` row carrying the date *range*,
guest split, and assigned unit. Nothing else in the platform has to learn
about lodging.

**Double-booking is prevented by the database, not by application code.**
`lodging_stays` has a GiST exclusion constraint on `(unit_id, stay_range)`.
Application-level "is it free?" checks lose the race under concurrency, and a
double-booked holiday week loses a client permanently. Range is `[check_in,
check_out)` — half-open, because a checkout and the next arrival are the same
calendar date and must not collide. Pooled unit-types
(`is_specific_unit = false`) are still capacity-checked in code against
`inventory_count`; the constraint only covers specific units.

**`rate_calendar` is one row per unit per date.** Nightly price and stay rules
vary by season, weekend and event, so they cannot be columns on the unit.
`lodging_rate_rules` is the brush that paints ranges; `rate_calendar` stays
the source of truth.

**Money is double-entry.** Every movement is a debit/credit pair sharing a
`group_id`; `SUM(debit) = SUM(credit)` per group, always. Corrections are new
reversing pairs, never edits. Once you hold a guest's money that belongs to an
owner, minus commission, minus tax owed to three authorities, single-column
balances stop reconciling and nothing tells you where the drift came from.

**Tax is a table, not a number.** A Gulf Shores stay carries Alabama state,
Baldwin County, and city lodging tax — three authorities, three filings.
Rates are effective-dated so a reprint of last March stays correct.
Under-collecting is a legal exposure, not a bug.

---

## Before applying

1. **Verify the spine exists.** `platform.js` reads `bookings`, `offerings`,
   `booking_calendar`, `promos`, `entity_modules`, `entity_owners` — none of
   which have a `CREATE TABLE` anywhere in this repo. Either they were created
   by hand in Supabase and never captured as migrations, or `platform.js` is
   partly dead code. `server.js` already has precedent for the second case
   (`whatsapp` is unmounted with "backing tables don't exist in the live DB").
   **Confirm against the live GCR Supabase first** — `02-*.sql` references
   `bookings.id` and `05-*.sql` inserts into `module_manifest`.

2. **Apply `canonical-gaps.sql` first, or accept the gaps.** `booking_line_items`
   and `customer_identities` are referenced here and defined there.

3. **Two module registries still disagree.** `modules.js` uses
   `module_manifest` + `user_modules` keyed on `site_id`; `platform.js` uses
   `entity_modules` keyed on `entity_slug`. `05-*.sql` seeds the *catalog*
   (`module_manifest`, which is shared) and installs go to `entity_modules`.
   Retiring `user_modules` is a separate cleanup, not blocked by this.

4. **`lodging_access_codes.code_value` and `lodging_arrival_instructions.wifi_password`
   are secrets.** Restrict column access, or move them behind a
   service-role-only view before this goes anywhere near a client dashboard.

5. **`lodging_owners.tax_id_last4` is last-4 only, deliberately.** Do not
   widen it. Full SSN/EIN belongs with whoever files the 1099s, not here.

---

## Not in these files

Deliberately deferred — none of it blocks a first client:

- Guest-to-host **messaging** (`routes/messaging.js` already exists)
- **Double-blind reviews** with a rating breakdown — `entity_reviews` exists
  but is single-sided and unstructured
- Wishlists / saved searches (`saved_searches` is in canonical-gaps)
- ID verification, fraud flags, dispute workflow
- Dynamic pricing (`rate_calendar.source` already reserves `'dynamic_pricing'`)
- 1099 generation

## Minimum set to run one real client

`lodging_units` · `rate_calendar` · `lodging_fees` · `tax_*` ·
`lodging_quotes` · `lodging_stays` · `lodging_payment_schedules` ·
`lodging_payments` · `lodging_owners` · `lodging_owner_agreements` ·
`lodging_owner_statements` · `lodging_cleaning_tasks` · `lodging_settings`

That is a condo rental company's operating system. Everything else is depth.
