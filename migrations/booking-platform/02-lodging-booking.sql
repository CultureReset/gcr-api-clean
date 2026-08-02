-- ============================================================================
-- LODGING 02 — STAYS, QUOTES, CANCELLATION  (additive only)
-- ============================================================================
-- Requires: 01-lodging-core.sql
-- Review file: DO NOT APPLY without explicit approval.
--
-- THE RULE THIS FILE OBEYS:
-- platform.js already declares "ONE universal booking: every booking-type app
-- writes the same `bookings` table; the unit is DATA, never a separate table."
-- This file does NOT create a second bookings table. A lodging reservation is
-- a normal `bookings` row (unit = 'night') PLUS one `lodging_stays` row that
-- carries the things only a multi-night stay has: a date RANGE instead of a
-- date+slot, a guest split, and an assigned physical unit.
--
-- Date claims still go in `booking_calendar` — one row per night — so the
-- existing availability engine, the iCal importer and the email parser all
-- keep working with no changes.
-- ============================================================================

-- Needed for the double-booking exclusion constraint below (uuid = uuid inside
-- a GiST index). Safe to run repeatedly.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ── 1. CANCELLATION POLICIES — a rule set, not a paragraph ──────────────────
-- Evaluated at cancel time against nights-before-arrival, so the refund is
-- computed rather than argued about. tiers is ordered most-generous first:
--   [{"days_before":60,"refund_percent":100},
--    {"days_before":30,"refund_percent":50},
--    {"days_before":0,"refund_percent":0}]
--
-- DISPLAYS: listing "Cancellation" block, checkout agreement, the cancel
-- screen's "you will be refunded $X" line, admin dispute review.
CREATE TABLE IF NOT EXISTS lodging_cancellation_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug           text NOT NULL,
  name                  text NOT NULL,              -- "Flexible", "Moderate", "Peak Season"
  description           text,
  tiers                 jsonb NOT NULL DEFAULT '[]',
  fees_refundable       boolean NOT NULL DEFAULT false,
  cleaning_fee_refundable boolean NOT NULL DEFAULT true,
  taxes_refundable      boolean NOT NULL DEFAULT true,
  grace_period_hours    integer NOT NULL DEFAULT 0, -- free cancel window after booking
  is_default            boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cancel_policies_entity ON lodging_cancellation_policies (entity_slug, is_active);


-- ── 2. QUOTES — the immutable price snapshot ────────────────────────────────
-- Priced BEFORE booking and never recomputed after. Rates, fees and tax rates
-- all change; without a frozen snapshot you cannot answer "why was I charged
-- this?" six months later, and you cannot defend a chargeback.
-- A quote may exist with no booking (abandoned checkout) — that is useful
-- conversion data, so rows are kept.
--
-- DISPLAYS: checkout breakdown, confirmation email, guest receipt, admin
-- dispute evidence, abandoned-checkout reporting.
CREATE TABLE IF NOT EXISTS lodging_quotes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  unit_id           uuid NOT NULL,
  check_in          date NOT NULL,
  check_out         date NOT NULL,
  nights            integer NOT NULL,
  adults            integer NOT NULL DEFAULT 1,
  children          integer NOT NULL DEFAULT 0,
  infants           integer NOT NULL DEFAULT 0,
  pets              integer NOT NULL DEFAULT 0,

  -- money, all in currency
  currency          text NOT NULL DEFAULT 'USD',
  rent_subtotal     numeric NOT NULL DEFAULT 0,   -- sum of nightly rates
  fees_subtotal     numeric NOT NULL DEFAULT 0,
  discount_total    numeric NOT NULL DEFAULT 0,
  taxable_base      numeric NOT NULL DEFAULT 0,
  tax_total         numeric NOT NULL DEFAULT 0,
  grand_total       numeric NOT NULL DEFAULT 0,
  deposit_due_now   numeric,
  balance_due_on    date,

  -- the receipt, frozen
  nightly_breakdown jsonb NOT NULL DEFAULT '[]',  -- [{"date":"2026-08-01","rate":289}]
  fee_breakdown     jsonb NOT NULL DEFAULT '[]',  -- [{"code":"cleaning","name":..,"amount":175}]
  tax_breakdown     jsonb NOT NULL DEFAULT '[]',  -- [{"jurisdiction":"AL State","rate":4,"amount":..}]
  promo_code        text,

  policy_snapshot   jsonb NOT NULL DEFAULT '{}',  -- cancellation tiers as they were
  expires_at        timestamptz,
  status            text NOT NULL DEFAULT 'open', -- open|converted|expired|abandoned
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotes_unit_dates ON lodging_quotes (unit_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_quotes_entity     ON lodging_quotes (entity_slug, status, created_at DESC);


-- ── 3. STAYS — the lodging extension of a `bookings` row ────────────────────
-- booking_id points at the universal bookings row (guest name, contact,
-- payment status, source all live there). This table carries only what a
-- multi-night stay needs on top.
--
-- stay_range is a generated daterange used by the exclusion constraint below.
-- It is [check_in, check_out) — half open — because a checkout day and the
-- next arrival day are the SAME calendar date and must not collide.
--
-- DISPLAYS: host calendar bars, reservation detail, guest Trips tab, arrival
-- board, cleaning task generator, owner statement lines.
CREATE TABLE IF NOT EXISTS lodging_stays (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid,                          -- → bookings.id (universal record)
  quote_id          uuid,                          -- → lodging_quotes.id (frozen price)
  entity_slug       text NOT NULL,
  unit_id           uuid NOT NULL,                 -- booked unit or unit-type
  assigned_unit_id  uuid,                          -- physical unit, hotel model only

  check_in          date NOT NULL,
  check_out         date NOT NULL,
  nights            integer NOT NULL,
  stay_range        daterange GENERATED ALWAYS AS (daterange(check_in, check_out, '[)')) STORED,

  adults            integer NOT NULL DEFAULT 1,
  children          integer NOT NULL DEFAULT 0,
  infants           integer NOT NULL DEFAULT 0,
  pets              integer NOT NULL DEFAULT 0,

  arrival_time      time,
  departure_time    time,

  status            text NOT NULL DEFAULT 'confirmed',
    -- inquiry|pending|confirmed|checked_in|checked_out|cancelled|no_show
  source            text NOT NULL DEFAULT 'direct',
    -- direct|standalone|dashboard|airbnb|vrbo|booking_com|ical|email|manual|owner_hold
  external_ref      text,                          -- channel confirmation number

  guest_name        text,
  guest_email       text,
  guest_phone       text,
  customer_id       uuid,                          -- → customer_identities.id

  agreement_signed_at timestamptz,
  agreement_url     text,
  guest_notes       text,
  internal_notes    text,

  cancelled_at      timestamptz,
  cancelled_by      text,                          -- guest|host|admin|channel
  cancellation_reason text,
  refund_amount     numeric,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stays_unit_dates ON lodging_stays (unit_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_stays_entity     ON lodging_stays (entity_slug, status);
CREATE INDEX IF NOT EXISTS idx_stays_booking    ON lodging_stays (booking_id);
CREATE INDEX IF NOT EXISTS idx_stays_arrivals   ON lodging_stays (entity_slug, check_in)  WHERE status IN ('confirmed','checked_in');
CREATE INDEX IF NOT EXISTS idx_stays_departures ON lodging_stays (entity_slug, check_out) WHERE status IN ('confirmed','checked_in');

-- ── DOUBLE-BOOKING PREVENTION, ENFORCED BY THE DATABASE ─────────────────────
-- Application-level "is it free?" checks lose the race under concurrency, and
-- a double-booked holiday week is the one bug that loses a client permanently.
-- This makes overlapping live stays on the same specific unit IMPOSSIBLE.
-- Cancelled/no-show rows are excluded so a unit frees up on cancel.
--
-- NOTE: only applies to specific units. Pooled unit-types (is_specific_unit
-- = false) are capacity-checked in application code against inventory_count.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lodging_stays_no_overlap'
  ) THEN
    ALTER TABLE lodging_stays
      ADD CONSTRAINT lodging_stays_no_overlap
      EXCLUDE USING gist (
        unit_id WITH =,
        stay_range WITH &&
      )
      WHERE (status NOT IN ('cancelled', 'no_show', 'inquiry'));
  END IF;
END $$;


-- ── 4. STAY GUESTS ──────────────────────────────────────────────────────────
-- Named occupants. Beach condo buildings and gated complexes routinely require
-- an access list before arrival, and parking passes are issued per person.
--
-- DISPLAYS: pre-arrival form, building access list export, parking passes.
CREATE TABLE IF NOT EXISTS lodging_stay_guests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_id     uuid NOT NULL,
  entity_slug text NOT NULL,
  full_name   text NOT NULL,
  age_group   text,                        -- adult|child|infant
  age         integer,
  is_primary  boolean NOT NULL DEFAULT false,
  vehicle_plate text,
  vehicle_desc  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stay_guests_stay ON lodging_stay_guests (stay_id);


-- ── 5. STAY STATUS HISTORY — append only ────────────────────────────────────
-- Every state change, who made it, and what changed. This is what you reach
-- for during a dispute, and what makes a wrong availability count repairable
-- instead of permanent.
--
-- DISPLAYS: reservation timeline, admin audit view, dispute evidence.
CREATE TABLE IF NOT EXISTS lodging_stay_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_id     uuid NOT NULL,
  entity_slug text NOT NULL,
  event_type  text NOT NULL,               -- created|confirmed|modified|cancelled|checked_in|checked_out|refunded|message
  from_status text,
  to_status   text,
  actor_type  text,                        -- guest|host|admin|system|channel
  actor_id    text,
  detail      jsonb NOT NULL DEFAULT '{}', -- {"old_check_out":"..","new_check_out":".."}
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stay_events_stay ON lodging_stay_events (stay_id, created_at);


-- ── 6. HOLDS — soft locks during checkout ───────────────────────────────────
-- Between "guest picked dates" and "payment cleared" the dates must be held,
-- or two people pay for the same week. Short TTL, swept by cron.
--
-- DISPLAYS: nothing user-facing; it is what stops the checkout race.
CREATE TABLE IF NOT EXISTS lodging_holds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,
  unit_id     uuid NOT NULL,
  quote_id    uuid,
  check_in    date NOT NULL,
  check_out   date NOT NULL,
  session_ref text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_holds_unit    ON lodging_holds (unit_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_holds_expiry  ON lodging_holds (expires_at);


-- ── 7. OWNER HOLDS — the unit's owner blocks their own week ─────────────────
-- A condo owner using their own unit is not a booking (no money, no guest,
-- no cleaning revenue) but it MUST block the calendar and show on the
-- statement. Kept separate from stays so it never pollutes revenue reporting.
--
-- DISPLAYS: host calendar (distinct colour), owner portal "my stays",
-- owner statement (zero revenue, cleaning cost may still apply).
CREATE TABLE IF NOT EXISTS lodging_owner_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  unit_id      uuid NOT NULL,
  owner_id     uuid,                       -- → lodging_owners (03)
  check_in     date NOT NULL,
  check_out    date NOT NULL,
  hold_type    text NOT NULL DEFAULT 'owner_stay', -- owner_stay|maintenance|seasonal_close
  charge_cleaning boolean NOT NULL DEFAULT true,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owner_holds_unit ON lodging_owner_holds (unit_id, check_in, check_out);
