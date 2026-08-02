-- ============================================================================
-- 00 — THE UNIVERSAL SPINE  (additive only)
-- ============================================================================
-- Every vertical in this folder sits on these seven tables. routes/platform.js
-- (2,186 lines) already reads and writes all of them — but NONE of them has a
-- CREATE TABLE anywhere in this repo. Either they were created by hand in the
-- GCR Supabase and never captured as a migration, or platform.js is partly
-- dead code. server.js has precedent for the second case:
--
--   //mount('/api/whatsapp', ...); // UNMOUNTED: backing tables don't exist
--
-- ⚠️  READ THIS BEFORE APPLYING
-- Every statement is CREATE TABLE IF NOT EXISTS, so if these tables already
-- exist in the live DB this file is a NO-OP and will NOT reconcile a column
-- mismatch. That is deliberate — silently altering live booking tables is
-- worse than doing nothing. Run the audit query at the bottom of this file
-- FIRST and diff the result against these definitions.
--
-- Column shapes below were reverse-engineered from actual platform.js usage
-- (toBookingRow / toOfferingRow at platform.js:146-192, the booking_calendar
-- writers at platform.js:299 and email-parser.js:834-854 / 1414-1423), not
-- invented. Where platform.js and email-parser.js disagreed, the union of
-- both is used.
-- ============================================================================


-- ── 1. ENTITY_OWNERS — who may administer a business ────────────────────────
-- NOTE: user_id deliberately holds TWO conventions, per the comment at
-- platform.js:78 — platform signups store businesses.id, admin link-user
-- stores users.id. Both resolve. Do not "fix" this without fixing ownedSlug().
CREATE TABLE IF NOT EXISTS entity_owners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,
  entity_slug  text NOT NULL,
  role         text NOT NULL DEFAULT 'owner',   -- owner|manager|staff
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, entity_slug)
);
CREATE INDEX IF NOT EXISTS idx_entity_owners_slug ON entity_owners (entity_slug);


-- ── 2. ENTITY_MODULES — which apps a business switched on ───────────────────
-- settings holds the platform install snapshot {manifest, config, showOnPublic}.
-- Rows WITHOUT a manifest are pre-existing GCR module rows and platform.js
-- deliberately never touches them (platform.js:110-127).
CREATE TABLE IF NOT EXISTS entity_modules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  module_key   text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  settings     jsonb NOT NULL DEFAULT '{}',
  sort_order   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, module_key)
);
CREATE INDEX IF NOT EXISTS idx_entity_modules_slug ON entity_modules (entity_slug, enabled);


-- ── 3. OFFERINGS — the universal catalog ────────────────────────────────────
-- Trips, rooms, services, fleet, add-ons, gift cards, memberships, products.
-- `section` is the dataKey the dashboard app writes under; `kind` is the
-- semantic type; `unit` is what a price is per. The vertical tables in this
-- folder EXTEND an offerings row, they do not replace it.
CREATE TABLE IF NOT EXISTS offerings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  section      text,                    -- dataKey: 'trips' | 'rooms' | 'services' | 'fleet'
  kind         text NOT NULL DEFAULT 'offering',
  name         text NOT NULL,
  description  text,
  unit         text NOT NULL DEFAULT 'flat',
    -- person|hour|half_day|day|night|item|ticket|trip|session|cover|flat
  price_from   numeric,
  capacity     integer,
  duration_minutes integer,
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offerings_slug    ON offerings (entity_slug, active);
CREATE INDEX IF NOT EXISTS idx_offerings_section ON offerings (entity_slug, section, sort_order);


-- ── 4. OFFERING_PRICES — per-tier pricing ───────────────────────────────────
-- Named in the platform.js header but defined nowhere. Adult $95 / child $65 /
-- senior $85 on one trip; hour / half-day / day on one boat. Without this,
-- tiered pricing has to hide in offerings.details and cannot be reported on.
CREATE TABLE IF NOT EXISTS offering_prices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id  uuid NOT NULL,
  entity_slug  text NOT NULL,
  tier_key     text NOT NULL,           -- adult|child|senior|hour|half_day|day|week
  label        text NOT NULL,
  price        numeric NOT NULL,
  currency     text NOT NULL DEFAULT 'USD',
  min_qty      integer NOT NULL DEFAULT 0,
  max_qty      integer,
  min_age      integer,
  max_age      integer,
  counts_toward_capacity boolean NOT NULL DEFAULT true,
  season_start date,
  season_end   date,
  sort_order   integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (offering_id, tier_key, season_start)
);
CREATE INDEX IF NOT EXISTS idx_offering_prices_off ON offering_prices (offering_id, active);


-- ── 5. BOOKINGS — the ONE universal booking record ──────────────────────────
-- Every booking-type app writes here; the unit is DATA, never a separate
-- table. Each vertical adds ONE extension row keyed on booking_id carrying
-- only what that vertical needs (lodging_stays, activity_tickets,
-- rental_contracts, appointments, dining_reservations, transport_trips).
--
-- `details` is the app's raw record, round-tripped by fromBookingRow().
CREATE TABLE IF NOT EXISTS bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  offering_id   uuid,
  customer_name text,
  phone         text,
  email         text,
  customer_id   uuid,                   -- → customer_identities.id (canonical-gaps)
  date          date,
  end_date      date,
  start_time    time,
  end_time      time,
  party_size    integer,
  adults        integer,
  children      integer,
  qty           integer,
  total_price   numeric,
  deposit_paid  numeric,
  currency      text NOT NULL DEFAULT 'USD',
  status        text NOT NULL DEFAULT 'pending',
    -- pending|confirmed|checked_in|completed|cancelled|no_show
  source        text NOT NULL DEFAULT 'dashboard',
    -- dashboard|direct|standalone|ical|email:<platform>|manual|<channel>
  vertical      text,                   -- lodging|activity|rental|appointment|dining|transport
  external_ref  text,
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_slug    ON bookings (entity_slug, status);
CREATE INDEX IF NOT EXISTS idx_bookings_date    ON bookings (entity_slug, date);
CREATE INDEX IF NOT EXISTS idx_bookings_phone   ON bookings (phone);
CREATE INDEX IF NOT EXISTS idx_bookings_offering ON bookings (offering_id);


-- ── 6. BOOKING_CALENDAR — every date-claim from every source ────────────────
-- THE table availability is computed from. Direct bookings, manual blocks,
-- Airbnb/VRBO iCal, FareHarbor, and parsed confirmation emails all land here,
-- so a date taken anywhere blocks the direct checkout everywhere.
--
-- offering_id is the RESOURCE discriminator and is deliberately polymorphic:
-- it holds an offerings.id, or a vertical resource id (lodging_units.id,
-- rental_assets.id). email-parser.js calls the same value resource_id. There
-- is no FK on purpose — do not add one without unifying those two names first.
--
-- Dedup key is (entity_slug, source, external_uid): a re-forwarded
-- confirmation email never double-claims a date (email-parser.js:848-854).
CREATE TABLE IF NOT EXISTS booking_calendar (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  booking_id   uuid,
  offering_id  uuid,                    -- resource: offering | unit | asset
  date         date NOT NULL,
  end_date     date,
  start_time   time,
  end_time     time,
  kind         text NOT NULL DEFAULT 'booking',  -- booking|block
  source       text NOT NULL DEFAULT 'direct',
  status       text NOT NULL DEFAULT 'active',   -- active|cancelled
  title        text,
  party        integer,
  external_uid text,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bcal_lookup   ON booking_calendar (entity_slug, date, status);
CREATE INDEX IF NOT EXISTS idx_bcal_resource ON booking_calendar (offering_id, date);
CREATE INDEX IF NOT EXISTS idx_bcal_booking  ON booking_calendar (booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bcal_dedup
  ON booking_calendar (entity_slug, source, external_uid)
  WHERE external_uid IS NOT NULL;


-- ── 7. PROMOS — discount codes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  code         text,
  type         text NOT NULL DEFAULT 'percent',  -- percent|amount
  amount       numeric NOT NULL DEFAULT 0,
  applies_to   text,                    -- NULL = everything, else an offerings.section
  min_spend    numeric,
  max_uses     integer,
  uses_count   integer NOT NULL DEFAULT 0,
  starts       date,
  ends         date,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promos_slug ON promos (entity_slug, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promos_code ON promos (entity_slug, code) WHERE code IS NOT NULL;


-- ── 8. RESOURCES — the generic bookable thing ───────────────────────────────
-- For verticals that need a countable physical resource but do not warrant a
-- dedicated table (a chair, an umbrella, a bay, a locker). Verticals with real
-- depth get their own: lodging_units, rental_assets, dining_tables.
CREATE TABLE IF NOT EXISTS resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text NOT NULL,
  offering_id  uuid,
  name         text NOT NULL,
  resource_type text,
  capacity     integer NOT NULL DEFAULT 1,
  quantity     integer NOT NULL DEFAULT 1,
  active       boolean NOT NULL DEFAULT true,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resources_slug ON resources (entity_slug, active);


-- ============================================================================
-- AUDIT QUERY — run this against the LIVE GCR Supabase before applying.
-- If a table below already exists, compare its columns to the definitions
-- above and reconcile by hand. This file will not do it for you.
-- ============================================================================
--
-- SELECT table_name,
--        string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS columns
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name IN ('bookings','offerings','offering_prices','booking_calendar',
--                      'promos','entity_modules','entity_owners','resources')
-- GROUP BY table_name
-- ORDER BY table_name;
--
-- Expected outcomes:
--   0 rows      → platform.js is dead code. Apply this file as-is.
--   8 rows      → the spine exists. Diff columns, apply nothing, capture the
--                 live shape back into this file so it stops being a mystery.
--   partial     → the interesting case. Apply only the missing tables, and
--                 check which platform.js routes are silently failing today.
