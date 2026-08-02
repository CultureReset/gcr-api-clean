-- ============================================================================
-- 10 — TRANSPORTATION: POINT-TO-POINT + DISPATCH  (additive only)
-- ============================================================================
-- Requires: 00-spine.sql
-- Covers: shuttles, airport transfers, taxis, limos, golf-cart transport,
--         beach shuttles, brewery tours.
--
-- THE SHAPE: this is the one vertical that is genuinely NOT
-- offering + calendar. A trip has an origin, a destination, and a vehicle
-- that must physically be at the origin when the guest is. Capacity moves
-- through space. Everything else in this folder books a resource that stays
-- put, which is why transportation keeps its own dispatch model instead of
-- being forced onto the shared one.
--
-- routes/rides.js already implements SMS lead dispatch with driver rotation
-- and bidding against transportation_* tables. This file gives that flow a
-- real schema and connects it to `bookings`.
-- ============================================================================


-- ── 1. VEHICLES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transport_vehicles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  name           text NOT NULL,                 -- "Van 2"
  vehicle_type   text,                          -- sedan|suv|van|shuttle|limo|cart|bus
  make           text,
  model          text,
  year           integer,
  plate          text,
  vin            text,
  passenger_capacity integer NOT NULL DEFAULT 4,
  luggage_capacity   integer,
  wheelchair_accessible boolean NOT NULL DEFAULT false,
  has_car_seats  boolean NOT NULL DEFAULT false,
  insurance_expires date,
  inspection_expires date,
  registration_expires date,
  status         text NOT NULL DEFAULT 'available', -- available|on_trip|maintenance|out_of_service
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transport_vehicles ON transport_vehicles (entity_slug, is_active, status);


-- ── 2. DRIVERS ──────────────────────────────────────────────────────────────
-- is_on_duty + last_assigned_at are what the existing rotation logic in
-- routes/rides.js needs to spread work fairly instead of always hitting the
-- first driver in the list.
CREATE TABLE IF NOT EXISTS transport_drivers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  user_id        text,
  full_name      text NOT NULL,
  phone          text NOT NULL,
  email          text,
  license_number text,
  license_class  text,
  license_expires date,
  tcp_or_pucp_no text,                          -- commercial passenger authority
  default_vehicle_id uuid,
  is_on_duty     boolean NOT NULL DEFAULT false,
  accepts_dispatch boolean NOT NULL DEFAULT true,
  last_assigned_at timestamptz,                 -- drives the rotation
  rating         numeric,
  commission_percent numeric,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transport_drivers ON transport_drivers (entity_slug, is_active, is_on_duty);


-- ── 3. ZONES + FARES — how a price gets quoted ──────────────────────────────
-- Three pricing models coexist in this business and all three are needed:
-- flat zone-to-zone (airport runs), per-mile (metered), and hourly (charter).
CREATE TABLE IF NOT EXISTS transport_zones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  name           text NOT NULL,                 -- "Pensacola Airport", "Orange Beach"
  zone_type      text,                          -- airport|city|resort|point
  center_lat     numeric,
  center_lng     numeric,
  radius_miles   numeric,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transport_fares (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  from_zone_id   uuid,
  to_zone_id     uuid,
  vehicle_type   text,
  fare_type      text NOT NULL DEFAULT 'flat',  -- flat|per_mile|hourly
  base_fare      numeric NOT NULL DEFAULT 0,
  per_mile       numeric,
  per_hour       numeric,
  minimum_fare   numeric,
  per_passenger_over integer,                   -- surcharge threshold
  per_passenger_fee  numeric,
  after_hours_start  time,
  after_hours_end    time,
  after_hours_surcharge numeric,
  gratuity_percent numeric,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transport_fares ON transport_fares (entity_slug, from_zone_id, to_zone_id);


-- ── 4. TRIPS — the extension of a `bookings` row ────────────────────────────
-- DISPLAYS: dispatch board, driver mobile, guest tracking link, the
-- "where is my ride" answer, per-trip revenue.
CREATE TABLE IF NOT EXISTS transport_trips (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid,                        -- → bookings.id
  entity_slug       text NOT NULL,

  pickup_at         timestamptz NOT NULL,
  pickup_address    text NOT NULL,
  pickup_lat        numeric,
  pickup_lng        numeric,
  pickup_zone_id    uuid,
  pickup_notes      text,                        -- "baggage claim door 3"

  dropoff_address   text,
  dropoff_lat       numeric,
  dropoff_lng       numeric,
  dropoff_zone_id   uuid,

  is_round_trip     boolean NOT NULL DEFAULT false,
  return_pickup_at  timestamptz,

  passengers        integer NOT NULL DEFAULT 1,
  luggage_count     integer,
  car_seats_needed  integer,
  wheelchair_needed boolean NOT NULL DEFAULT false,

  flight_number     text,                        -- airport runs: track delays
  flight_arrival_at timestamptz,

  vehicle_id        uuid,
  driver_id         uuid,
  assigned_at       timestamptz,

  status            text NOT NULL DEFAULT 'requested',
    -- requested|quoted|assigned|en_route|arrived|on_board|completed|cancelled|no_show
  en_route_at       timestamptz,
  arrived_at        timestamptz,
  picked_up_at      timestamptz,
  completed_at      timestamptz,

  quoted_fare       numeric,
  final_fare        numeric,
  gratuity          numeric,
  distance_miles    numeric,
  duration_minutes  integer,
  driver_payout     numeric,

  tracking_token    text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_pickup  ON transport_trips (entity_slug, pickup_at);
CREATE INDEX IF NOT EXISTS idx_trips_driver  ON transport_trips (driver_id, pickup_at);
CREATE INDEX IF NOT EXISTS idx_trips_booking ON transport_trips (booking_id);
CREATE INDEX IF NOT EXISTS idx_trips_live    ON transport_trips (entity_slug, status)
  WHERE status IN ('requested', 'quoted', 'assigned', 'en_route', 'arrived', 'on_board');
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_tracking
  ON transport_trips (tracking_token) WHERE tracking_token IS NOT NULL;


-- ── 5. DISPATCH OFFERS — the SMS bidding loop ───────────────────────────────
-- routes/rides.js blasts a lead to drivers and takes the first acceptance.
-- One row per driver per trip makes the rotation auditable and stops the same
-- driver being offered everything.
--
-- DISPLAYS: dispatch board, driver response log, fairness/rotation report.
CREATE TABLE IF NOT EXISTS transport_dispatch_offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  trip_id        uuid NOT NULL,
  driver_id      uuid NOT NULL,
  offer_round    integer NOT NULL DEFAULT 1,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  channel        text NOT NULL DEFAULT 'sms',   -- sms|push|app
  expires_at     timestamptz,
  response       text,                          -- accepted|declined|expired|no_response
  responded_at   timestamptz,
  bid_amount     numeric,                       -- when drivers bid
  won            boolean NOT NULL DEFAULT false,
  UNIQUE (trip_id, driver_id, offer_round)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_trip   ON transport_dispatch_offers (trip_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_driver ON transport_dispatch_offers (driver_id, sent_at DESC);


-- ── 6. DRIVER SHIFTS ────────────────────────────────────────────────────────
-- Who is actually working, so dispatch does not page someone at 3am.
CREATE TABLE IF NOT EXISTS transport_driver_shifts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  driver_id      uuid NOT NULL,
  vehicle_id     uuid,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'scheduled', -- scheduled|active|complete|missed
  clocked_in_at  timestamptz,
  clocked_out_at timestamptz,
  trips_completed integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_driver_shifts ON transport_driver_shifts (driver_id, starts_at);
