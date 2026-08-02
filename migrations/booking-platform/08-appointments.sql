-- ============================================================================
-- 08 — APPOINTMENTS: STAFF-BASED SERVICE BOOKING  (additive only)
-- ============================================================================
-- Requires: 00-spine.sql
-- Covers: photographers, salons, barbers, spas, massage, tattoo, med-spa,
--         detailing, guides, consultants — anything booked with a PERSON.
--
-- THE SHAPE: availability is a function of WHO, not what. Two stylists means
-- two parallel calendars; one calls in sick and half the day's capacity
-- disappears. Neither lodging (unit-date) nor activities (fixed departure)
-- models that, which is why this is its own vertical.
--
-- An `offerings` row is the service ("60-min Deep Tissue"). staff_services
-- says who can perform it, how long THEY take, and what THEY charge.
-- ============================================================================


-- ── 1. STAFF — the bookable person ──────────────────────────────────────────
-- DISPLAYS: "choose your stylist" picker, calendar column headers, staff
-- performance report, commission/payout math.
CREATE TABLE IF NOT EXISTS staff_members (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  user_id        text,                          -- if they log in
  display_name   text NOT NULL,
  title          text,                          -- "Senior Stylist"
  bio            text,
  photo_url      text,
  email          text,
  phone          text,
  color          text,                          -- calendar column colour
  accepts_bookings boolean NOT NULL DEFAULT true,
  booking_buffer_before integer NOT NULL DEFAULT 0,  -- minutes
  booking_buffer_after  integer NOT NULL DEFAULT 0,
  max_daily_bookings integer,
  commission_percent numeric,
  license_number text,
  license_expires date,
  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_entity ON staff_members (entity_slug, is_active);


-- ── 2. STAFF SCHEDULES — recurring working hours ────────────────────────────
-- The baseline of what CAN be booked. Availability = schedule − time off −
-- existing appointments − buffers.
CREATE TABLE IF NOT EXISTS staff_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  staff_id       uuid NOT NULL,
  day_of_week    integer NOT NULL,              -- 0=Sun..6=Sat
  start_time     time NOT NULL,
  end_time       time NOT NULL,
  break_start    time,
  break_end      time,
  location_id    uuid,                          -- multi-location businesses
  effective_from date,
  effective_to   date,
  is_active      boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_staff_sched ON staff_schedules (staff_id, day_of_week, is_active);


-- ── 3. TIME OFF — the exception that eats capacity ──────────────────────────
CREATE TABLE IF NOT EXISTS staff_time_off (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  staff_id       uuid NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  reason         text,                          -- vacation|sick|training|personal
  all_day        boolean NOT NULL DEFAULT false,
  approved       boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_time_off_staff ON staff_time_off (staff_id, starts_at, ends_at);


-- ── 4. STAFF ↔ SERVICE — who does what, and how long THEY take ──────────────
-- A junior stylist takes 60 minutes for a cut a senior does in 40, and charges
-- less. Modeling duration and price per (staff, service) is what makes the
-- slot math correct instead of approximately correct.
CREATE TABLE IF NOT EXISTS staff_services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  staff_id          uuid NOT NULL,
  offering_id       uuid NOT NULL,               -- the service
  duration_override integer,                     -- minutes
  price_override    numeric,
  is_primary        boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  UNIQUE (staff_id, offering_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_services_off ON staff_services (offering_id, active);


-- ── 5. ROOMS / STATIONS — the second constraint ─────────────────────────────
-- A massage needs a therapist AND a room. A detail needs a tech AND a bay.
-- Double-booking the person is the obvious failure; double-booking the room
-- is the one that surprises people.
CREATE TABLE IF NOT EXISTS appointment_rooms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  name           text NOT NULL,
  room_type      text,                          -- treatment|chair|bay|studio
  capacity       integer NOT NULL DEFAULT 1,
  location_id    uuid,
  equipment      text[],
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appt_rooms ON appointment_rooms (entity_slug, is_active);

-- Which services need which kind of room.
CREATE TABLE IF NOT EXISTS offering_room_requirements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  offering_id    uuid NOT NULL,
  room_type      text,
  room_id        uuid,                          -- or a specific room
  required       boolean NOT NULL DEFAULT true
);


-- ── 6. APPOINTMENTS — the extension of a `bookings` row ─────────────────────
-- DISPLAYS: staff day view, week calendar, client history, reminder sender,
-- no-show tracking, commission report.
CREATE TABLE IF NOT EXISTS appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid,                          -- → bookings.id
  entity_slug     text NOT NULL,
  staff_id        uuid,
  room_id         uuid,
  offering_id     uuid,

  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  buffer_before   integer NOT NULL DEFAULT 0,
  buffer_after    integer NOT NULL DEFAULT 0,

  status          text NOT NULL DEFAULT 'booked',
    -- booked|confirmed|arrived|in_progress|complete|cancelled|no_show|rescheduled
  arrived_at      timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,

  is_recurring    boolean NOT NULL DEFAULT false,
  recurrence_rule text,                          -- RRULE for standing appointments
  parent_appointment_id uuid,

  rescheduled_from_id uuid,
  cancellation_fee    numeric,
  client_notes    text,
  staff_notes     text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appts_staff   ON appointments (staff_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appts_room    ON appointments (room_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appts_booking ON appointments (booking_id);
CREATE INDEX IF NOT EXISTS idx_appts_day     ON appointments (entity_slug, starts_at)
  WHERE status NOT IN ('cancelled', 'no_show');


-- ── 7. INTAKE FORMS — what must be collected before the chair ───────────────
-- Photo release for a photographer, allergy/health history for a spa, consent
-- for a tattoo. Definition here, submission below.
CREATE TABLE IF NOT EXISTS appointment_forms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  offering_id    uuid,                          -- NULL = every service
  name           text NOT NULL,
  form_type      text NOT NULL DEFAULT 'intake', -- intake|consent|release|health
  fields         jsonb NOT NULL DEFAULT '[]',
  required_before text NOT NULL DEFAULT 'appointment', -- booking|appointment
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appointment_form_submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  form_id        uuid NOT NULL,
  appointment_id uuid,
  booking_id     uuid,
  responses      jsonb NOT NULL DEFAULT '{}',
  signature_url  text,
  submitted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_subs_appt ON appointment_form_submissions (appointment_id);
