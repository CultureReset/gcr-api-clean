-- ============================================================================
-- LODGING 05 — THE THREE SURFACES  (additive only)
-- ============================================================================
-- Requires: 01, 02, 03, 04
-- Review file: DO NOT APPLY without explicit approval.
--
-- One schema, three places it shows up:
--
--   1. STANDALONE PLATFORM — its own domain, its own search/listing/checkout.
--      Reads live units across every entity that opted in. This is the
--      Airbnb-shaped public product.
--
--   2. CLIENT DASHBOARD MODULE — an OPTION a client turns on, exactly like
--      every other app in the marketplace. A restaurant client never sees it;
--      a condo client installs it and gets Units / Calendar / Pricing /
--      Reservations / Owners / Cleaning tabs. Install state lives in
--      `entity_modules` (platform.js convention: settings holds
--      {manifest, config, showOnPublic}).
--
--   3. YOUR ADMIN — cross-client visibility over everything above. The views
--      at the bottom of this file are what admin.html reads; they are the
--      only place in the lodging schema that deliberately ignores entity_slug
--      scoping, because that IS the admin's job.
-- ============================================================================


-- ── 1. PER-ENTITY LODGING SETTINGS ──────────────────────────────────────────
-- What this client's lodging operation looks like. Created when the module is
-- installed; drives both their dashboard and their slice of the standalone.
--
-- DISPLAYS: client dashboard Settings tab, standalone branding, admin config.
CREATE TABLE IF NOT EXISTS lodging_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug           text NOT NULL UNIQUE,

  -- operating model
  operator_type         text NOT NULL DEFAULT 'manager',  -- manager|owner_operator|hotel
  default_commission_percent numeric,
  default_cancellation_policy_id uuid,
  default_currency      text NOT NULL DEFAULT 'USD',
  timezone              text NOT NULL DEFAULT 'America/Chicago',

  -- booking behaviour
  instant_book          boolean NOT NULL DEFAULT true,
  request_to_book       boolean NOT NULL DEFAULT false,
  deposit_percent       numeric NOT NULL DEFAULT 100,     -- 100 = pay in full at booking
  balance_due_days_before integer,                        -- NULL when paid in full
  hold_minutes          integer NOT NULL DEFAULT 20,      -- checkout soft-lock TTL
  min_advance_hours     integer NOT NULL DEFAULT 0,
  max_advance_days      integer NOT NULL DEFAULT 540,

  -- surfacing
  show_on_standalone    boolean NOT NULL DEFAULT true,    -- appear in the aggregator
  show_on_gcr           boolean NOT NULL DEFAULT true,    -- appear on Gulf Coast Radar
  standalone_domain     text,                             -- their own white-label domain
  brand_color           text,
  logo_url              text,

  -- ops toggles
  auto_create_cleaning_tasks boolean NOT NULL DEFAULT true,
  auto_issue_access_codes    boolean NOT NULL DEFAULT false,
  send_arrival_instructions  boolean NOT NULL DEFAULT true,
  owner_portal_enabled       boolean NOT NULL DEFAULT true,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);


-- ── 2. MODULE REGISTRY SEED ─────────────────────────────────────────────────
-- Adds the lodging apps to the marketplace so a client can switch them on.
-- Matches the existing module_manifest shape seeded in routes/modules.js.
-- 'lodging-core' is the parent; the rest are the tabs it unlocks.
--
-- NOTE: module_manifest is the CATALOG. Per-business install state belongs in
-- `entity_modules` (entity_slug-keyed, what platform.js reads). See the
-- README in this folder for the reconciliation plan between entity_modules
-- and the older site_id-keyed user_modules table.
INSERT INTO module_manifest (id, name, description, category, icon, is_core, price_monthly, js_path, sort_order) VALUES
  ('lodging-core',      'Vacation Rentals',   'Condo, house, and hotel rental management',            'lodging', '🏠', false, 0, 'lodging-core.js',      200),
  ('lodging-units',     'Units & Listings',   'Photos, amenities, bed config, house rules',           'lodging', '🛏️', false, 0, 'lodging-units.js',     201),
  ('lodging-calendar',  'Rental Calendar',    'Multi-unit availability grid with drag-to-block',      'lodging', '📆', false, 0, 'lodging-calendar.js',  202),
  ('lodging-pricing',   'Rates & Pricing',    'Nightly rates, seasons, min-stay, fees, taxes',        'lodging', '💲', false, 0, 'lodging-pricing.js',   203),
  ('lodging-stays',     'Reservations',       'Bookings, modifications, cancellations, refunds',      'lodging', '🗝️', false, 0, 'lodging-stays.js',     204),
  ('lodging-owners',    'Owner Portal',       'Owner statements, payouts, and unit performance',      'lodging', '🧾', false, 0, 'lodging-owners.js',    205),
  ('lodging-cleaning',  'Turnover & Cleaning','Auto-generated turnovers, checklists, vendor dispatch','lodging', '🧹', false, 0, 'lodging-cleaning.js',  206),
  ('lodging-maintenance','Maintenance',       'Tickets, work orders, inspections, approvals',         'lodging', '🔧', false, 0, 'lodging-maintenance.js',207),
  ('lodging-access',    'Access & Arrival',   'Door codes, parking, arrival instructions',            'lodging', '🔐', false, 0, 'lodging-access.js',    208),
  ('lodging-channels',  'Channel Sync',       'Two-way iCal with Airbnb, VRBO, and Booking.com',      'lodging', '🔄', false, 0, 'lodging-channels.js',  209),
  ('lodging-standalone','Standalone Booking Site','Your own direct-booking site on your own domain',  'lodging', '🌐', false, 0, 'lodging-standalone.js',210)
ON CONFLICT (id) DO NOTHING;


-- ── 3. ADMIN VIEWS — cross-client, deliberately unscoped ────────────────────
-- Everything else in the lodging schema is entity_slug-scoped. These are not:
-- they are what YOUR admin dashboard reads to see every client at once.
-- Read-only by construction. Do not expose them on any client-facing route.

-- Portfolio overview: one row per client running lodging.
CREATE OR REPLACE VIEW admin_lodging_portfolio AS
SELECT
  s.entity_slug,
  e.name                                    AS business_name,
  s.operator_type,
  s.show_on_standalone,
  COUNT(DISTINCT u.id)                      AS units_total,
  COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'live') AS units_live,
  COUNT(DISTINCT o.id)                      AS owners_total,
  COUNT(DISTINCT st.id) FILTER (
    WHERE st.status IN ('confirmed','checked_in')
      AND st.check_out >= CURRENT_DATE
  )                                         AS upcoming_stays,
  MAX(st.created_at)                        AS last_booking_at
FROM lodging_settings s
LEFT JOIN entity          e  ON e.slug        = s.entity_slug
LEFT JOIN lodging_units   u  ON u.entity_slug = s.entity_slug AND u.is_active
LEFT JOIN lodging_owners  o  ON o.entity_slug = s.entity_slug AND o.is_active
LEFT JOIN lodging_stays   st ON st.entity_slug = s.entity_slug
GROUP BY s.entity_slug, e.name, s.operator_type, s.show_on_standalone;

-- Today across every client: who arrives, who leaves, what needs cleaning.
CREATE OR REPLACE VIEW admin_lodging_today AS
SELECT
  st.entity_slug,
  e.name            AS business_name,
  u.name            AS unit_name,
  st.id             AS stay_id,
  st.guest_name,
  st.check_in,
  st.check_out,
  st.status,
  CASE
    WHEN st.check_in  = CURRENT_DATE THEN 'arrival'
    WHEN st.check_out = CURRENT_DATE THEN 'departure'
    ELSE 'in_house'
  END               AS today_role
FROM lodging_stays st
JOIN lodging_units  u ON u.id   = st.unit_id
LEFT JOIN entity    e ON e.slug = st.entity_slug
WHERE st.status IN ('confirmed', 'checked_in')
  AND CURRENT_DATE BETWEEN st.check_in AND st.check_out;

-- Money owed but not yet handed over — tax you are holding, owners you owe.
CREATE OR REPLACE VIEW admin_lodging_liabilities AS
SELECT
  l.entity_slug,
  a.code                    AS account_code,
  a.name                    AS account_name,
  SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END) AS balance
FROM ledger_entries l
JOIN ledger_accounts a ON a.id = l.account_id
WHERE a.account_type = 'liability'
GROUP BY l.entity_slug, a.code, a.name;

-- Turnovers at risk: unassigned or unfinished cleans inside 48 hours.
CREATE OR REPLACE VIEW admin_lodging_turnover_risk AS
SELECT
  c.entity_slug,
  e.name          AS business_name,
  u.name          AS unit_name,
  c.scheduled_date,
  c.window_start,
  c.window_end,
  c.is_same_day_turn,
  c.status,
  c.vendor_id
FROM lodging_cleaning_tasks c
JOIN lodging_units u ON u.id   = c.unit_id
LEFT JOIN entity   e ON e.slug = c.entity_slug
WHERE c.status IN ('scheduled', 'assigned', 'in_progress')
  AND c.scheduled_date <= CURRENT_DATE + 2;


-- ── 4. STANDALONE SEARCH VIEW ───────────────────────────────────────────────
-- What the public aggregator queries. Only live units, only clients who opted
-- into the standalone surface. Price and availability still resolve per-date
-- against rate_calendar and booking_calendar at query time — this view is the
-- catalog half only, deliberately cheap to scan.
CREATE OR REPLACE VIEW standalone_lodging_listings AS
SELECT
  u.id                AS unit_id,
  u.entity_slug,
  u.slug              AS unit_slug,
  u.name              AS unit_name,
  u.unit_type,
  u.max_guests,
  u.bedrooms,
  u.bathrooms,
  u.summary,
  u.hero_image_url,
  u.base_rate,
  u.currency,
  p.name              AS property_name,
  p.city,
  p.state,
  p.latitude,
  p.longitude,
  e.name              AS operator_name,
  ARRAY(
    SELECT ua.amenity_key
    FROM lodging_unit_amenities ua
    WHERE ua.unit_id = u.id
  )                   AS amenity_keys
FROM lodging_units u
JOIN lodging_settings s ON s.entity_slug = u.entity_slug
LEFT JOIN lodging_properties p ON p.id   = u.property_id
LEFT JOIN entity e ON e.slug = u.entity_slug
WHERE u.is_active
  AND u.status = 'live'
  AND s.show_on_standalone;
