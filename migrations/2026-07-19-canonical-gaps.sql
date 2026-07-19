-- ============================================================================
-- CANONICAL MODEL — THE SIX MISSING STRUCTURES (additive only)
-- ============================================================================
-- Everything here keys off entity_slug, same as the rest of the GCR spine.
-- Nothing existing is renamed, altered destructively, or migrated. Empty
-- tables are fine — the point is that data has somewhere to land.
-- Review file: DO NOT APPLY without explicit approval.
-- ============================================================================


-- ── 1. AVAILABILITY PROJECTION ──────────────────────────────────────────────
-- The single computed "who's open when" answer. Derived, never hand-edited:
-- a refresher recomputes rows from schedule_rules (what CAN run) minus
-- booking_calendar claims (what's TAKEN) plus business_availability capacity
-- (what the email parser learned). One row per business/resource/date/slot.
--
-- DISPLAYS: date-search results, listing-card "spots left" badge, profile
-- availability strip, AI concierge answers, the embeddable widget.
CREATE TABLE IF NOT EXISTS availability_projection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  resource_id     uuid,                    -- specific unit/boat/chair; NULL = whole business
  date            date NOT NULL,
  time_slot       time,                    -- NULL = whole-day answer
  end_time        time,
  status          text NOT NULL DEFAULT 'unknown',  -- available | limited | full | blocked | unknown
  spots_total     integer,
  spots_remaining integer,
  source          text,                    -- which feed computed it: email | ical | direct | manual | schedule
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, resource_id, date, time_slot)
);
CREATE INDEX IF NOT EXISTS idx_avail_proj_date   ON availability_projection (date, status);
CREATE INDEX IF NOT EXISTS idx_avail_proj_entity ON availability_projection (entity_slug, date);


-- ── 2. SCHEDULE RULES — what a business OFFERS to run ───────────────────────
-- "The 7 AM trip runs daily May–September, 6 seats." The system today only
-- stores what's taken; this stores what's offered, so the projection can
-- compute open capacity even before any booking exists.
--
-- DISPLAYS: bookable time choices on checkout pages, "departures" on
-- profiles, the projection's baseline.
CREATE TABLE IF NOT EXISTS schedule_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug      text NOT NULL,
  resource_id      uuid,                   -- NULL = whole business
  offering_id      uuid,                   -- NULL = applies to any offering
  name             text,                   -- "7 AM Trip", "Evening seating"
  days_of_week     integer[],              -- 0=Sun..6=Sat; NULL = every day
  start_time       time,
  end_time         time,
  season_start     date,                   -- NULL = year-round
  season_end       date,
  capacity         integer,                -- seats/units per occurrence
  min_notice_hours integer,                -- booking cutoff
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedule_rules_entity ON schedule_rules (entity_slug, active);

-- One-off deviations from a rule: closed for weather, extra holiday run,
-- reduced capacity on a specific date.
CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,
  rule_id     uuid,                        -- NULL = business-wide exception
  date        date NOT NULL,
  closed      boolean NOT NULL DEFAULT true,
  start_time  time,                        -- when not closed: altered window
  end_time    time,
  capacity    integer,                     -- altered capacity
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedule_exc_entity ON schedule_exceptions (entity_slug, date);


-- ── 3. BOOKING LINE ITEMS — what exactly was in a transaction ───────────────
-- One row per thing inside a booking: 2 adult tickets, 1 kid ticket, add-on
-- shrimp, cleaning fee. meta carries tier keys and modifier selections.
-- Also the landing spot for table-order receipts in the review loop.
--
-- DISPLAYS: booking detail views, receipts, per-item review targeting,
-- revenue reporting by item.
CREATE TABLE IF NOT EXISTS booking_line_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL,
  entity_slug text NOT NULL,
  item_type   text NOT NULL DEFAULT 'ticket',  -- ticket | addon | menu_item | fee | service
  name        text NOT NULL,
  quantity    integer NOT NULL DEFAULT 1,
  unit_price  numeric,
  total       numeric,
  meta        jsonb NOT NULL DEFAULT '{}',     -- {"tier":"adult"} | {"modifiers":[...]}
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_items_booking ON booking_line_items (booking_id);
CREATE INDEX IF NOT EXISTS idx_line_items_entity  ON booking_line_items (entity_slug);


-- ── 4. ONE CUSTOMER IDENTITY — phone-keyed, platform-wide ───────────────────
-- The single person behind loyalty_members, tourist_profiles, customers, and
-- bookings. NON-DESTRUCTIVE: the existing fragment tables stay exactly where
-- they are; customer_links ties each fragment row to the one identity, so
-- unification is additive and reversible.
--
-- DISPLAYS: the business's customer list ("this person, 4 visits, 95 points,
-- booked twice"), co-op loyalty balances, review identity, the concierge.
CREATE TABLE IF NOT EXISTS customer_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text UNIQUE,                 -- THE key; normalized E.164
  email       text,
  name        text,
  consent_sms boolean NOT NULL DEFAULT false,
  consent_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_identities_email ON customer_identities (email);

CREATE TABLE IF NOT EXISTS customer_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  system      text NOT NULL,               -- tourist_profiles | loyalty_members | customers | bookings | table_sessions
  external_id text NOT NULL,               -- that system's row id
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system, external_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_links_customer ON customer_links (customer_id);


-- ── 5. MODIFIER RULES — the guided-flow brain ───────────────────────────────
-- menu_item_options already exists WITH real data (286 rows: "Add shrimp
-- +$2.95"). What's missing is the rules layer: required or optional, pick
-- exactly how many. Groups are definable once per business and reusable
-- across items ("Pick 2 sides" defined once, not retyped on 40 dishes).
--
-- DISPLAYS: the QR menu tap-through ("How would you like it?" → required,
-- pick 1), the menu editor's modifier UI, the dashboard menu app, and the
-- modifiers:[] slot the public menu payload already emits.
CREATE TABLE IF NOT EXISTS menu_item_option_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  menu_item_id uuid,                       -- NULL = reusable business-level group
  label        text NOT NULL,              -- "Pick your sides", "How would you like it?"
  required     boolean NOT NULL DEFAULT false,
  min_picks    integer NOT NULL DEFAULT 0,
  max_picks    integer,                    -- NULL = no limit
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_option_groups_entity ON menu_item_option_groups (entity_slug);
CREATE INDEX IF NOT EXISTS idx_option_groups_item   ON menu_item_option_groups (menu_item_id);

-- Attach existing options to groups. Rows without group_id keep working
-- exactly as today (group_label text stays untouched as their display label).
ALTER TABLE menu_item_options ADD COLUMN IF NOT EXISTS group_id uuid;
CREATE INDEX IF NOT EXISTS idx_menu_item_options_group ON menu_item_options (group_id);


-- ── 6. SMALL GAPS ───────────────────────────────────────────────────────────
-- Special hours keyed the GCR way (the existing hours_exceptions table is
-- keyed to the legacy site_id world and stays untouched).
-- DISPLAYS: "Closed July 4th" on profiles, hours logic everywhere.
CREATE TABLE IF NOT EXISTS entity_hours_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,
  date        date NOT NULL,
  is_closed   boolean NOT NULL DEFAULT true,
  opens_at    time,
  closes_at   time,
  note        text,
  UNIQUE (entity_slug, date)
);

-- Parent→child amenity inheritance: the marina's amenities show on each
-- boat, the complex's pool shows on each unit, marked so children render
-- them read-only.
ALTER TABLE entity_amenities ADD COLUMN IF NOT EXISTS is_inherited boolean NOT NULL DEFAULT false;


-- ── 7. SAVED AVAILABILITY SEARCHES ──────────────────────────────────────────
-- "All the photographers available these days" saved and re-runnable.
-- The frontend ships a device-local version today; this table makes saves
-- follow the tourist across devices once approved.
-- DISPLAYS: saved-search chips on the Search page; re-run alerts later.
CREATE TABLE IF NOT EXISTS saved_searches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tourist_id  uuid,                        -- tourist_profiles/users linkage
  phone       text,                        -- alt key for one-text users
  label       text NOT NULL,
  search_type text NOT NULL,               -- charter | photographer | rental | activity | stay | all
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  query       text,
  coverage    text NOT NULL DEFAULT 'any', -- any | all (stays)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_tourist ON saved_searches (tourist_id);
