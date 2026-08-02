-- ============================================================================
-- 07 — RENTALS: DURATION-BASED EQUIPMENT  (additive only)
-- ============================================================================
-- Requires: 00-spine.sql
-- Covers: boats, pontoons, jet skis, kayaks, paddleboards, bikes, golf carts,
--         beach chairs/umbrellas, scooters, dive gear.
--
-- THE SHAPE: a business owns a FLEET of physical things. A guest takes one
-- for a block of time (2 hours / half day / full day / week), then brings it
-- back. Distinct from lodging (nights, no return inspection of a moveable
-- asset) and from activities (shared seats on a fixed departure).
--
-- What makes rentals their own vertical: the asset comes BACK, and its
-- condition on return is a money event. Fuel, hours, damage, late fees.
-- ============================================================================


-- ── 1. ASSETS — the physical fleet ──────────────────────────────────────────
-- One row per real object. "Pontoon #3", "Yamaha VX #7", "Bike 22".
-- An `offerings` row is the rentable CLASS ("24ft Pontoon"); assets are the
-- units of it. A guest books the class; dispatch assigns an asset.
--
-- DISPLAYS: fleet list, dispatch board, maintenance schedule, admin asset
-- register, the "3 of 5 available" count on a listing.
CREATE TABLE IF NOT EXISTS rental_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  offering_id       uuid,                       -- the class this asset belongs to
  name              text NOT NULL,
  asset_code        text,                       -- "PON-03"
  asset_type        text,                       -- boat|jetski|kayak|bike|cart|chair|board

  -- identity / compliance
  make              text,
  model             text,
  year              integer,
  registration_no   text,                       -- AL boat registration
  hull_id           text,                       -- HIN / VIN / serial
  registration_expires date,
  insurance_policy  text,
  insurance_expires date,

  -- specs that drive booking rules
  capacity          integer,                    -- max persons
  max_weight_lbs    integer,
  horsepower        integer,
  length_ft         numeric,
  fuel_type         text,                       -- gas|electric|none
  fuel_capacity_gal numeric,
  requires_operator boolean NOT NULL DEFAULT false, -- captain must come along
  requires_boater_ed boolean NOT NULL DEFAULT false, -- AL: born after 1958

  -- usage
  hours_meter       numeric,
  odometer          numeric,
  home_location     text,                       -- slip, dock, rack, storefront

  status            text NOT NULL DEFAULT 'available',
    -- available|rented|maintenance|out_of_service|retired
  condition_notes   text,
  hero_image_url    text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, asset_code)
);
CREATE INDEX IF NOT EXISTS idx_rental_assets_entity ON rental_assets (entity_slug, is_active, status);
CREATE INDEX IF NOT EXISTS idx_rental_assets_off    ON rental_assets (offering_id);
CREATE INDEX IF NOT EXISTS idx_rental_assets_reg    ON rental_assets (registration_expires)
  WHERE is_active;


-- ── 2. RATE TIERS — price by duration ───────────────────────────────────────
-- The defining pricing model of this vertical: the same asset costs $X for
-- 2 hours, $Y for a half day, $Z for a full day, and the day rate is never
-- 4× the 2-hour rate. Seasonal because Gulf Coast summer is not January.
--
-- DISPLAYS: booking widget duration picker, price quote, rate card.
CREATE TABLE IF NOT EXISTS rental_rate_tiers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  offering_id    uuid,                          -- the class
  asset_id       uuid,                          -- or one specific asset
  tier_key       text NOT NULL,                 -- hour_2|half_day|full_day|week
  label          text NOT NULL,                 -- "Half Day (4 hrs)"
  duration_minutes integer NOT NULL,
  price          numeric NOT NULL,
  deposit_amount numeric,
  included_fuel_gal numeric,
  included_miles integer,
  season_start   date,
  season_end     date,
  days_of_week   integer[],
  sort_order     integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_tiers_off ON rental_rate_tiers (offering_id, active);


-- ── 3. CONTRACTS — the rental extension of a `bookings` row ─────────────────
-- Covers the whole life of one rental: reserved → out → back → settled.
-- assigned_asset_id may be NULL at booking time and filled at dispatch.
--
-- DISPLAYS: dispatch board, active-rentals screen, return checklist, the
-- overdue alert, the settlement/refund screen.
CREATE TABLE IF NOT EXISTS rental_contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid,                       -- → bookings.id
  entity_slug       text NOT NULL,
  offering_id       uuid,
  assigned_asset_id uuid,
  rate_tier_id      uuid,

  scheduled_start   timestamptz NOT NULL,
  scheduled_end     timestamptz NOT NULL,
  actual_start      timestamptz,
  actual_end        timestamptz,

  renter_name       text,
  renter_phone      text,
  renter_dl_number  text,                       -- store masked; see README note
  renter_dl_state   text,
  renter_dob        date,
  boater_ed_number  text,
  operator_staff_id uuid,                       -- captain, when required

  party_size        integer,
  deposit_amount    numeric,
  deposit_status    text NOT NULL DEFAULT 'none', -- none|held|released|claimed
  deposit_ref       text,

  agreement_signed_at timestamptz,
  agreement_url     text,

  status            text NOT NULL DEFAULT 'reserved',
    -- reserved|checked_out|active|overdue|returned|settled|cancelled|no_show
  late_minutes      integer,
  late_fee          numeric,
  fuel_charge       numeric,
  damage_charge     numeric,
  other_charges     numeric,
  settled_at        timestamptz,

  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contracts_booking ON rental_contracts (booking_id);
CREATE INDEX IF NOT EXISTS idx_contracts_asset   ON rental_contracts (assigned_asset_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_contracts_active  ON rental_contracts (entity_slug, status)
  WHERE status IN ('reserved', 'checked_out', 'active', 'overdue');


-- ── 4. CONDITION REPORTS — out and back ─────────────────────────────────────
-- The photo set at checkout is the ONLY thing that makes a damage charge
-- defensible. Two rows per contract: one 'out', one 'in'. Fuel and hours
-- deltas compute the fuel charge automatically.
--
-- DISPLAYS: dock tablet checkout/return flow, damage dispute evidence,
-- fuel charge math, asset condition history.
CREATE TABLE IF NOT EXISTS rental_condition_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  contract_id    uuid NOT NULL,
  asset_id       uuid NOT NULL,
  direction      text NOT NULL,                 -- out|in
  fuel_level     numeric,                       -- 0..1 or gallons, per business
  hours_meter    numeric,
  odometer       numeric,
  checklist      jsonb NOT NULL DEFAULT '[]',
  photo_urls     text[],
  damage_noted   text,
  staff_name     text,
  guest_signature_url text,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_condition_asset ON rental_condition_reports (asset_id, recorded_at DESC);


-- ── 5. ASSET MAINTENANCE ────────────────────────────────────────────────────
-- Engine-hours-based service, not calendar-based. An asset in service must
-- come out of the bookable pool, which is why status lives on rental_assets
-- and this table drives it.
--
-- DISPLAYS: maintenance due list, fleet availability, downtime cost report.
CREATE TABLE IF NOT EXISTS rental_maintenance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  asset_id       uuid NOT NULL,
  maintenance_type text NOT NULL,               -- service|repair|inspection|winterize|cleaning
  triggered_by   text,                          -- hours|calendar|damage_report|inspection
  due_at_hours   numeric,
  due_on         date,
  performed_on   date,
  hours_at_service numeric,
  vendor_name    text,
  description    text,
  cost           numeric,
  invoice_url    text,
  takes_out_of_service boolean NOT NULL DEFAULT true,
  out_of_service_from  date,
  out_of_service_to    date,
  status         text NOT NULL DEFAULT 'scheduled', -- scheduled|in_progress|complete|deferred
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_maint_asset ON rental_maintenance (asset_id, status);
CREATE INDEX IF NOT EXISTS idx_rental_maint_due   ON rental_maintenance (due_on) WHERE status = 'scheduled';


-- ── 6. ASSET BLOCKS — non-booking unavailability ────────────────────────────
-- Owner use, dry dock, seasonal haul-out, a hold for a big group quote.
-- Mirrors into booking_calendar as kind='block' so availability stays
-- computed from the one table.
CREATE TABLE IF NOT EXISTS rental_asset_blocks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  asset_id       uuid NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  block_type     text NOT NULL DEFAULT 'maintenance', -- maintenance|owner|weather|hold|seasonal
  reason         text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_blocks ON rental_asset_blocks (asset_id, starts_at, ends_at);
