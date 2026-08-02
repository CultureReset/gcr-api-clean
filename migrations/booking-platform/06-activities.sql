-- ============================================================================
-- 06 — ACTIVITIES: SCHEDULED-CAPACITY BOOKING  (additive only)
-- ============================================================================
-- Requires: 00-spine.sql
-- Covers: fishing charters, dolphin cruises, sunset sails, parasailing,
--         guided tours, dive trips, classes, ticketed experiences.
--
-- THE SHAPE: a business offers a TRIP that runs at a set time with N seats.
-- Guests buy seats on a specific departure. This is the opposite of lodging —
-- there, one guest takes the whole unit for a date range; here, many guests
-- share one time slot.
--
-- An `offerings` row is the trip TYPE ("6-Hour Deep Sea"). An
-- activity_departures row is one actual sailing ("Aug 3, 7:00 AM, 6 seats").
-- schedule_rules (canonical-gaps.sql) generates departures; it is the brush,
-- departures are the source of truth — exactly the rate_rules/rate_calendar
-- relationship in lodging.
-- ============================================================================


-- ── 1. DEPARTURES — one actual scheduled occurrence ─────────────────────────
-- seats_sold is maintained by the booking write path AND recomputable from
-- activity_tickets, so a bad count is repairable instead of permanent.
-- private_charter flips a shared trip into a whole-boat buyout.
--
-- DISPLAYS: booking widget time picker, "3 seats left" badge, captain's day
-- sheet, the last-minute deal generator, availability search results.
CREATE TABLE IF NOT EXISTS activity_departures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  offering_id       uuid NOT NULL,              -- the trip type
  resource_id       uuid,                       -- the boat/van it runs on
  schedule_rule_id  uuid,                       -- what generated it, if generated

  depart_date       date NOT NULL,
  depart_time       time NOT NULL,
  return_time       time,
  duration_minutes  integer,

  capacity          integer NOT NULL,
  seats_sold        integer NOT NULL DEFAULT 0,
  seats_held        integer NOT NULL DEFAULT 0, -- in-checkout soft locks
  min_to_run        integer NOT NULL DEFAULT 1, -- cancel below this
  private_charter   boolean NOT NULL DEFAULT false,

  price_override    numeric,                    -- NULL = use offering_prices
  status            text NOT NULL DEFAULT 'scheduled',
    -- scheduled|running|sold_out|departed|cancelled|weather_hold
  cancel_reason     text,

  captain_name      text,
  crew              text[],
  meeting_point     text,
  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offering_id, depart_date, depart_time, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_departures_date   ON activity_departures (entity_slug, depart_date, status);
CREATE INDEX IF NOT EXISTS idx_departures_off    ON activity_departures (offering_id, depart_date);
CREATE INDEX IF NOT EXISTS idx_departures_open   ON activity_departures (depart_date)
  WHERE status IN ('scheduled', 'running');


-- ── 2. TICKETS — the activity extension of a `bookings` row ─────────────────
-- One row per booking. Tier counts live here; the per-tier money is itemized
-- into booking_line_items (canonical-gaps.sql).
--
-- DISPLAYS: booking detail, check-in scan, captain's manifest, refund math.
CREATE TABLE IF NOT EXISTS activity_tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid,                          -- → bookings.id
  entity_slug    text NOT NULL,
  departure_id   uuid NOT NULL,
  offering_id    uuid,

  seats          integer NOT NULL DEFAULT 1,    -- total seats consumed
  tier_counts    jsonb NOT NULL DEFAULT '{}',   -- {"adult":2,"child":1}

  checked_in_at  timestamptz,
  checked_in_by  text,
  no_show        boolean NOT NULL DEFAULT false,

  confirmation_code text,
  qr_token       text,
  special_requests  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_departure ON activity_tickets (departure_id);
CREATE INDEX IF NOT EXISTS idx_tickets_booking   ON activity_tickets (booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_code
  ON activity_tickets (confirmation_code) WHERE confirmation_code IS NOT NULL;


-- ── 3. MANIFEST — named passengers per departure ────────────────────────────
-- Not optional for anything on the water: USCG-inspected vessels must carry a
-- passenger count and list. Also what the captain reads at the dock, and what
-- a waiver attaches to.
--
-- DISPLAYS: captain's manifest print/mobile, check-in list, waiver status,
-- emergency contact lookup.
CREATE TABLE IF NOT EXISTS activity_manifest (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  departure_id   uuid NOT NULL,
  ticket_id      uuid,
  booking_id     uuid,

  full_name      text NOT NULL,
  age            integer,
  age_group      text,                          -- adult|child|infant
  weight_lbs     integer,                       -- parasail/dive weight limits
  emergency_contact_name  text,
  emergency_contact_phone text,

  waiver_id      uuid,                          -- → waivers.id (existing table)
  waiver_signed_at timestamptz,
  checked_in     boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manifest_departure ON activity_manifest (departure_id);
CREATE INDEX IF NOT EXISTS idx_manifest_ticket    ON activity_manifest (ticket_id);


-- ── 4. ADD-ONS — upsells attached to a trip ─────────────────────────────────
-- Rod rental, fishing license, photo package, lunch, wetsuit. The catalog is
-- here; a purchase becomes a booking_line_items row.
--
-- DISPLAYS: checkout upsell step, captain's prep list, revenue-per-trip.
CREATE TABLE IF NOT EXISTS activity_addons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  offering_id    uuid,                          -- NULL = offered on every trip
  name           text NOT NULL,
  description    text,
  price          numeric NOT NULL,
  charge_basis   text NOT NULL DEFAULT 'per_person', -- per_person|per_booking|per_unit
  max_qty        integer,
  inventory_per_departure integer,              -- only 6 rods exist
  is_required    boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addons_entity ON activity_addons (entity_slug, active);


-- ── 5. WEATHER HOLDS / CANCELLATIONS ────────────────────────────────────────
-- Weather is the defining operational fact of Gulf Coast water activities and
-- drives a specific workflow: hold → decide → notify everyone → refund or
-- rebook. Tracked separately from a normal cancellation because it is a
-- DEPARTURE-level event affecting many bookings at once.
--
-- DISPLAYS: the "cancel this departure" flow, guest notification batch,
-- refund/rebook queue, the reliability stat on a listing.
CREATE TABLE IF NOT EXISTS activity_weather_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  departure_id   uuid NOT NULL,
  decision       text NOT NULL DEFAULT 'hold',  -- hold|cancelled|proceeded|rescheduled
  reason         text,
  decided_by     text,
  decided_at     timestamptz,
  guests_notified integer,
  notified_at    timestamptz,
  rebooked_to_departure_id uuid,
  refund_policy_applied text,                   -- full_refund|credit|reschedule_only
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weather_departure ON activity_weather_events (departure_id);


-- ── 6. GEAR / LICENSE TRACKING ──────────────────────────────────────────────
-- Alabama requires a fishing licence for charter passengers unless the vessel
-- carries a trip licence. Tracking who holds what avoids a dockside problem.
--
-- DISPLAYS: pre-trip checklist, captain's manifest column, addon prompt.
CREATE TABLE IF NOT EXISTS activity_licenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  manifest_id    uuid,
  license_type   text NOT NULL,                 -- fishing|dive_cert|boater_ed
  license_number text,
  issued_state   text,
  expires_on     date,
  verified       boolean NOT NULL DEFAULT false,
  purchased_onboard boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_licenses_manifest ON activity_licenses (manifest_id);
