-- ============================================================================
-- 09 — DINING: TABLE RESERVATIONS + WAITLIST  (additive only)
-- ============================================================================
-- Requires: 00-spine.sql
-- Covers: restaurants, bars, breweries, private dining, chef's table.
--
-- THE SHAPE: capacity is measured in COVERS and constrained by TABLES, and a
-- table turns several times a night. Nothing else in the platform models a
-- resource that recycles every 90 minutes.
--
-- This is also where the email parser already produces data: OpenTable, Resy
-- and Toast extractors exist in routes/email-parser.js and currently write
-- only to business_availability. Once these tables exist, those confirmations
-- have somewhere real to land.
-- ============================================================================


-- ── 1. AREAS — where a guest can sit ────────────────────────────────────────
-- Patio, main dining, bar, upstairs. Guests request them, weather closes them,
-- and they carry different capacities.
CREATE TABLE IF NOT EXISTS dining_areas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  name           text NOT NULL,
  area_type      text,                          -- indoor|patio|bar|private|rooftop
  total_covers   integer,
  is_weather_dependent boolean NOT NULL DEFAULT false,
  is_bookable    boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dining_areas ON dining_areas (entity_slug, is_active);


-- ── 2. TABLES — the physical inventory ──────────────────────────────────────
-- combinable_with lets two 2-tops become a 4-top, which is how a real host
-- stand actually works and what naive reservation systems get wrong.
CREATE TABLE IF NOT EXISTS dining_tables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  area_id        uuid,
  table_number   text NOT NULL,
  seats_min      integer NOT NULL DEFAULT 1,
  seats_max      integer NOT NULL,
  table_shape    text,                          -- round|square|booth|bar|high_top
  combinable_with text[],                       -- other table_numbers
  is_accessible  boolean NOT NULL DEFAULT false,
  is_bookable    boolean NOT NULL DEFAULT true,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, table_number)
);
CREATE INDEX IF NOT EXISTS idx_dining_tables ON dining_tables (entity_slug, is_active);


-- ── 3. SERVICE PERIODS — when covers are sold ───────────────────────────────
-- Lunch 11–14, dinner 17–22, brunch Sat/Sun. turn_time_minutes is what makes
-- slot math possible: a 2-top at 18:00 with a 90-minute turn frees at 19:30.
CREATE TABLE IF NOT EXISTS dining_service_periods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  name              text NOT NULL,             -- "Dinner"
  days_of_week      integer[],
  start_time        time NOT NULL,
  end_time          time NOT NULL,
  last_seating_time time,
  slot_interval_minutes integer NOT NULL DEFAULT 15,
  turn_time_minutes integer NOT NULL DEFAULT 90,
  max_covers_per_slot integer,                  -- kitchen pacing
  max_party_size    integer,
  season_start      date,
  season_end        date,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_periods ON dining_service_periods (entity_slug, is_active);


-- ── 4. RESERVATIONS — the extension of a `bookings` row ─────────────────────
-- seated_at / left_at are what the email parser's OpenTable/Resy/Toast
-- extractors already try to capture (seated_time, left_time in ParsedBooking).
--
-- DISPLAYS: host stand, floor map, arrival list, turn-time analytics, the
-- "tables available tonight" answer on the public page.
CREATE TABLE IF NOT EXISTS dining_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid,                          -- → bookings.id
  entity_slug     text NOT NULL,
  area_id         uuid,
  table_id        uuid,
  service_period_id uuid,

  reservation_date date NOT NULL,
  reservation_time time NOT NULL,
  covers          integer NOT NULL DEFAULT 2,
  expected_turn_minutes integer,

  status          text NOT NULL DEFAULT 'booked',
    -- booked|confirmed|arrived|seated|finished|cancelled|no_show|walked_in
  seated_at       timestamptz,
  left_at         timestamptz,
  actual_turn_minutes integer,

  occasion        text,                          -- birthday|anniversary|business
  seating_preference text,                       -- booth|patio|quiet|high_top
  dietary_notes   text,
  guest_notes     text,
  vip             boolean NOT NULL DEFAULT false,

  source          text NOT NULL DEFAULT 'direct',
    -- direct|opentable|resy|yelp|toast|phone|walk_in|email
  external_ref    text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dining_res_date  ON dining_reservations (entity_slug, reservation_date, reservation_time);
CREATE INDEX IF NOT EXISTS idx_dining_res_table ON dining_reservations (table_id, reservation_date);
CREATE INDEX IF NOT EXISTS idx_dining_res_book  ON dining_reservations (booking_id);
CREATE INDEX IF NOT EXISTS idx_dining_res_live  ON dining_reservations (entity_slug, reservation_date)
  WHERE status IN ('booked', 'confirmed', 'arrived', 'seated');


-- ── 5. WAITLIST — walk-ins and overflow ─────────────────────────────────────
-- The other half of a host stand, and the natural place to hook SMS ("your
-- table is ready") since routes/sms.js and Brevo are already wired.
CREATE TABLE IF NOT EXISTS dining_waitlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  guest_name      text NOT NULL,
  phone           text,
  covers          integer NOT NULL DEFAULT 2,
  quoted_wait_minutes integer,
  seating_preference text,

  status          text NOT NULL DEFAULT 'waiting',
    -- waiting|notified|seated|left|expired
  added_at        timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz,
  seated_at       timestamptz,
  removed_at      timestamptz,
  actual_wait_minutes integer,
  table_id        uuid,
  reservation_id  uuid,                          -- if converted
  notes           text
);
CREATE INDEX IF NOT EXISTS idx_waitlist_live ON dining_waitlist (entity_slug, added_at)
  WHERE status IN ('waiting', 'notified');


-- ── 6. CLOSURES — days and shifts that do not exist ─────────────────────────
-- Holidays, private buyouts, hurricane days. Distinct from a booked-out night.
CREATE TABLE IF NOT EXISTS dining_closures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  closure_date   date NOT NULL,
  area_id        uuid,                           -- NULL = whole restaurant
  service_period_id uuid,                        -- NULL = all periods
  all_day        boolean NOT NULL DEFAULT true,
  start_time     time,
  end_time       time,
  reason         text,                           -- holiday|private_event|weather|maintenance
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dining_closures ON dining_closures (entity_slug, closure_date);


-- ── 7. LARGE PARTY / PRIVATE EVENT INQUIRIES ────────────────────────────────
-- Parties over the reservation cap are a quote-and-contract flow, not a
-- booking flow. Kept separate so they never consume normal inventory.
CREATE TABLE IF NOT EXISTS dining_event_inquiries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  contact_name   text NOT NULL,
  phone          text,
  email          text,
  event_date     date,
  event_time     time,
  covers         integer,
  event_type     text,                           -- rehearsal|corporate|birthday|buyout
  area_id        uuid,
  budget_per_person numeric,
  minimum_spend  numeric,
  status         text NOT NULL DEFAULT 'new',
    -- new|quoted|contract_sent|confirmed|lost|completed
  quote_url      text,
  contract_url   text,
  deposit_amount numeric,
  deposit_paid_at timestamptz,
  booking_id     uuid,                           -- once it converts
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dining_inquiries ON dining_event_inquiries (entity_slug, status, event_date);
