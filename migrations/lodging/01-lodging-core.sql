-- ============================================================================
-- LODGING 01 — SUPPLY + PRICING  (additive only)
-- ============================================================================
-- The condo / vacation-rental / hotel vertical, built on the existing GCR
-- spine. Everything keys off entity_slug, same as the rest of the platform.
-- Nothing existing is renamed, altered destructively, or migrated.
-- Review file: DO NOT APPLY without explicit approval.
--
-- HOW THIS ATTACHES TO WHAT ALREADY EXISTS:
--   - A lodging business IS an `entity` row (entity.slug). No new business table.
--   - Owner attaches through `entity_owners`, same as every other vertical.
--   - The client turns the vertical on via `entity_modules` (see 05-*.sql) —
--     it is an option in their dashboard, not something forced on.
--   - `lodging_units.id` is what `entity_external_calendars.resource_id` and
--     `business_availability.resource_id` already point at, so the existing
--     iCal importer blocks a SPECIFIC unit with no changes to that code.
--   - Date claims still live in `booking_calendar` — the ONE table the
--     platform engine computes availability from. Nothing here duplicates it.
--
-- AVAILABILITY IS COMPUTED, NOT STORED:
--   a unit is bookable on a date when
--     rate_calendar.is_available = true
--     AND no booking_calendar claim exists for (entity_slug, resource_id, date)
--     AND the stay satisfies rate_calendar.min_stay / closed_to_arrival
-- ============================================================================


-- ── 1. PROPERTIES — the building or complex ─────────────────────────────────
-- One property, many units. "Phoenix West II" is a property; "#1503" is a unit.
-- Optional: a single-unit owner never has to create one (units.property_id NULL).
--
-- DISPLAYS: standalone search result grouping, building amenity list, map pin
-- clustering, the admin property tree.
CREATE TABLE IF NOT EXISTS lodging_properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  name           text NOT NULL,
  slug           text,
  description    text,
  address_line1  text,
  address_line2  text,
  city           text,
  state          text,
  postal_code    text,
  country        text NOT NULL DEFAULT 'US',
  latitude       numeric,
  longitude      numeric,
  building_amenities text[],              -- pool, elevator, beach access, gate
  floors         integer,
  year_built     integer,
  hero_image_url text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, slug)
);
CREATE INDEX IF NOT EXISTS idx_lodging_props_entity ON lodging_properties (entity_slug, is_active);
CREATE INDEX IF NOT EXISTS idx_lodging_props_geo    ON lodging_properties (latitude, longitude);


-- ── 2. UNITS — the bookable thing ───────────────────────────────────────────
-- THE central table of the vertical. Two inventory models, one table:
--   is_specific_unit = true  → guest books THIS unit (Airbnb / condo model).
--                              inventory_count is always 1.
--   is_specific_unit = false → guest books a TYPE ("2BR Gulf Front"), the
--                              company assigns a physical unit at check-in
--                              (hotel model). inventory_count = how many exist.
-- Getting this wrong later is expensive, so it is explicit from row one.
--
-- DISPLAYS: standalone listing cards + detail page, host Listings tab, admin
-- unit tree, the calendar grid's row headers.
CREATE TABLE IF NOT EXISTS lodging_units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug      text NOT NULL,
  property_id      uuid,                          -- NULL = standalone home/cabin
  offering_id      uuid,                          -- optional link to `offerings`
  name             text NOT NULL,                 -- "Unit 1503" | "2BR Gulf Front"
  slug             text,
  unit_number      text,
  unit_type        text,                          -- condo|house|cabin|room|suite|rv|boat
  is_specific_unit boolean NOT NULL DEFAULT true,
  inventory_count  integer NOT NULL DEFAULT 1,    -- >1 only when is_specific_unit=false

  -- capacity / layout
  max_guests       integer NOT NULL DEFAULT 2,
  max_adults       integer,
  max_children     integer,
  bedrooms         numeric,                       -- numeric: 0.5 = studio alcove
  bathrooms        numeric,
  square_feet      integer,
  floor            integer,

  -- content
  summary          text,
  description      text,
  the_space        text,
  guest_access     text,
  neighborhood     text,
  getting_around   text,
  hero_image_url   text,

  -- listing state
  status           text NOT NULL DEFAULT 'draft', -- draft|pending_review|live|paused|archived
  listed_at        timestamptz,
  base_rate        numeric,                       -- fallback when rate_calendar has no row
  currency         text NOT NULL DEFAULT 'USD',

  -- external identity (so an imported Airbnb/VRBO unit can be matched back)
  external_refs    jsonb NOT NULL DEFAULT '{}',   -- {"airbnb":"12345","vrbo":"98765"}

  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, slug)
);
CREATE INDEX IF NOT EXISTS idx_lodging_units_entity   ON lodging_units (entity_slug, is_active);
CREATE INDEX IF NOT EXISTS idx_lodging_units_property ON lodging_units (property_id);
CREATE INDEX IF NOT EXISTS idx_lodging_units_status   ON lodging_units (status) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_lodging_units_guests   ON lodging_units (max_guests, bedrooms);


-- ── 3. UNIT PHOTOS ──────────────────────────────────────────────────────────
-- Ordered and room-tagged. Room tagging is what lets the detail page group
-- photos by space instead of showing one undifferentiated pile.
--
-- DISPLAYS: listing gallery, card hero, host photo manager (drag to reorder).
CREATE TABLE IF NOT EXISTS lodging_unit_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL,
  entity_slug text NOT NULL,
  url         text NOT NULL,
  caption     text,
  room_tag    text,                        -- living|kitchen|bedroom_1|bath_1|balcony|view|pool
  sort_order  integer NOT NULL DEFAULT 0,
  is_hero     boolean NOT NULL DEFAULT false,
  width       integer,
  height      integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lodging_photos_unit ON lodging_unit_photos (unit_id, sort_order);


-- ── 4. BED CONFIGURATION ────────────────────────────────────────────────────
-- Per-room beds. This is what makes "sleeps 8" honest, and it is the single
-- most common pre-booking question a guest asks.
--
-- DISPLAYS: "Where you'll sleep" strip on the listing page, sleeps-N badge,
-- the search filter on bedrooms/beds.
CREATE TABLE IF NOT EXISTS lodging_bed_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL,
  entity_slug text NOT NULL,
  room_name   text NOT NULL,               -- "Master", "Bunk room", "Living room"
  room_type   text NOT NULL DEFAULT 'bedroom', -- bedroom|living|loft|other
  bed_type    text NOT NULL,               -- king|queen|full|twin|bunk|sofa|air
  bed_count   integer NOT NULL DEFAULT 1,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lodging_beds_unit ON lodging_bed_configs (unit_id, sort_order);


-- ── 5. AMENITIES — controlled vocabulary, not free text ─────────────────────
-- Free-text amenities cannot be filtered on, which kills the search page.
-- The catalog is platform-wide; the join is per unit.
--
-- DISPLAYS: search filter chips, listing amenity grid, comparison view.
CREATE TABLE IF NOT EXISTS lodging_amenities (
  key         text PRIMARY KEY,            -- 'wifi', 'pool_private', 'gulf_front'
  label       text NOT NULL,
  category    text,                        -- essentials|kitchen|outdoor|location|accessibility|safety
  icon        text,
  is_filter   boolean NOT NULL DEFAULT false,   -- surfaces as a search chip
  sort_order  integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lodging_unit_amenities (
  unit_id      uuid NOT NULL,
  amenity_key  text NOT NULL,
  entity_slug  text NOT NULL,
  notes        text,                       -- "2 kayaks included"
  PRIMARY KEY (unit_id, amenity_key)
);
CREATE INDEX IF NOT EXISTS idx_lodging_unit_amen_key ON lodging_unit_amenities (amenity_key);


-- ── 6. POLICIES — the stay rules ────────────────────────────────────────────
-- One row per unit (or per entity when unit_id IS NULL — the company default
-- that units inherit unless they override).
--
-- DISPLAYS: "Things to know" block on the listing, checkout confirmation,
-- the rental agreement generator, guest arrival email.
CREATE TABLE IF NOT EXISTS lodging_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug           text NOT NULL,
  unit_id               uuid,                        -- NULL = entity-wide default
  check_in_time         time NOT NULL DEFAULT '16:00',
  check_out_time        time NOT NULL DEFAULT '10:00',
  check_in_window_end   time,
  self_check_in         boolean NOT NULL DEFAULT false,
  min_guest_age         integer,
  pets_allowed          boolean NOT NULL DEFAULT false,
  pets_max              integer,
  smoking_allowed       boolean NOT NULL DEFAULT false,
  events_allowed        boolean NOT NULL DEFAULT false,
  quiet_hours_start     time,
  quiet_hours_end       time,
  house_rules           text,
  cancellation_policy_id uuid,                       -- → lodging_cancellation_policies (02)
  rental_agreement_text text,
  requires_signed_agreement boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_lodging_policies_entity ON lodging_policies (entity_slug);


-- ── 7. RATE CALENDAR — one row per unit per date ────────────────────────────
-- THE most important table in the vertical. Nightly price and stay rules vary
-- by date (season, weekend, holiday, event weekend), so they cannot live as
-- columns on the unit. Search, availability, min-stay enforcement, revenue
-- reporting and the host calendar grid ALL read off this table.
--
-- closed_to_arrival / closed_to_departure implement Saturday-to-Saturday
-- changeover, which is still standard for Gulf Coast beach weeks.
--
-- DISPLAYS: host calendar grid (the screen owners live in), search result
-- price, checkout breakdown, "prices are low for these dates" badge.
CREATE TABLE IF NOT EXISTS rate_calendar (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug           text NOT NULL,
  unit_id               uuid NOT NULL,
  date                  date NOT NULL,
  nightly_rate          numeric,
  currency              text NOT NULL DEFAULT 'USD',
  is_available          boolean NOT NULL DEFAULT true,   -- host opened this date at all
  min_stay              integer NOT NULL DEFAULT 1,
  max_stay              integer,
  closed_to_arrival     boolean NOT NULL DEFAULT false,  -- may not START here
  closed_to_departure   boolean NOT NULL DEFAULT false,  -- may not END here
  source                text NOT NULL DEFAULT 'manual',  -- manual|rule|import|dynamic_pricing
  note                  text,                            -- "Hangout Fest weekend"
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id, date)
);
CREATE INDEX IF NOT EXISTS idx_rate_cal_lookup ON rate_calendar (unit_id, date);
CREATE INDEX IF NOT EXISTS idx_rate_cal_search ON rate_calendar (entity_slug, date, is_available);


-- ── 8. RATE RULES — how the calendar gets filled ────────────────────────────
-- Nobody hand-enters 365 rows per unit. A rule paints a date range, and a
-- generator writes rate_calendar rows from the highest-priority match.
-- rate_calendar stays the source of truth; rules are just the brush.
--
-- DISPLAYS: host Pricing tab (season editor), "apply to range" bulk actions.
CREATE TABLE IF NOT EXISTS lodging_rate_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug      text NOT NULL,
  unit_id          uuid,                        -- NULL = all units for this entity
  name             text NOT NULL,               -- "Peak Summer", "Weekends", "Off Season"
  rule_type        text NOT NULL DEFAULT 'season', -- season|day_of_week|los_discount|early_bird|last_minute|orphan_gap
  priority         integer NOT NULL DEFAULT 0,  -- higher wins on overlap
  season_start     date,
  season_end       date,
  days_of_week     integer[],                   -- 0=Sun..6=Sat; NULL = all
  nightly_rate     numeric,
  adjust_type      text,                        -- fixed|percent  (NULL = set nightly_rate directly)
  adjust_value     numeric,
  min_stay         integer,
  min_nights_for_discount integer,              -- los_discount: 7+ nights
  days_before_arrival     integer,              -- early_bird / last_minute threshold
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_rules_entity ON lodging_rate_rules (entity_slug, is_active, priority DESC);


-- ── 9. FEES — everything that is not room rate ──────────────────────────────
-- Cleaning, pet, extra-guest, resort, damage waiver. Charge basis matters:
-- a cleaning fee is per stay, a pet fee may be per night, an extra-guest fee
-- is per guest per night. Modeled once here, itemized onto every quote.
--
-- DISPLAYS: checkout price breakdown, host Pricing tab, owner statement,
-- the "nightly with fees" vs "stay total" toggle on search.
CREATE TABLE IF NOT EXISTS lodging_fees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  unit_id           uuid,                       -- NULL = applies to all units
  name              text NOT NULL,              -- "Cleaning fee", "Pet fee"
  fee_code          text NOT NULL,              -- cleaning|pet|extra_guest|resort|damage_waiver|admin
  amount            numeric NOT NULL,
  charge_basis      text NOT NULL DEFAULT 'per_stay', -- per_stay|per_night|per_guest|per_guest_per_night|percent_of_rent
  is_taxable        boolean NOT NULL DEFAULT true,
  is_refundable     boolean NOT NULL DEFAULT false,
  applies_when      jsonb NOT NULL DEFAULT '{}',-- {"guests_over":6} | {"pets":true}
  is_optional       boolean NOT NULL DEFAULT false, -- guest may decline at checkout
  sort_order        integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lodging_fees_entity ON lodging_fees (entity_slug, is_active);


-- ── 10. TAX JURISDICTIONS + RATES ───────────────────────────────────────────
-- NOT optional and NOT a single number. A Gulf Shores stay carries Alabama
-- state lodging tax plus Baldwin County plus city — three authorities, three
-- filings, three different bases. Under-collecting is a legal exposure, not
-- a bug, so tax is a first-class table with an effective-dated rate history.
--
-- DISPLAYS: checkout breakdown, owner statement, admin tax-remittance report.
CREATE TABLE IF NOT EXISTS tax_jurisdictions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,             -- "Alabama State Lodging Tax"
  level          text NOT NULL,             -- state|county|city|district
  country        text NOT NULL DEFAULT 'US',
  state          text,
  county         text,
  city           text,
  remit_to       text,                      -- authority name
  filing_frequency text,                    -- monthly|quarterly|annual
  account_number text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL,
  rate_percent    numeric NOT NULL,
  applies_to      text NOT NULL DEFAULT 'rent_and_fees', -- rent_only|rent_and_fees|fees_only
  exempt_after_nights integer,              -- long-stay exemption (often 30/90)
  effective_from  date NOT NULL,
  effective_to    date,                     -- NULL = current
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_rates_jur ON tax_rates (jurisdiction_id, effective_from DESC);

-- Which jurisdictions a given unit (or whole entity) collects for.
CREATE TABLE IF NOT EXISTS lodging_unit_taxes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  unit_id         uuid,                     -- NULL = all units for this entity
  jurisdiction_id uuid NOT NULL,
  collected_by    text NOT NULL DEFAULT 'platform', -- platform|owner|channel
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_unit_taxes_entity ON lodging_unit_taxes (entity_slug);


-- ── 11. PERMITS / LICENSES ──────────────────────────────────────────────────
-- Short-term rental registration is required in most Gulf Coast municipalities
-- and the number often must appear on the listing. Expiry tracking here is
-- what keeps a client from being delisted mid-season.
--
-- DISPLAYS: listing footer (permit #), host compliance panel, admin expiry alerts.
CREATE TABLE IF NOT EXISTS lodging_permits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  unit_id       uuid,
  permit_type   text NOT NULL,              -- str_license|business_license|lodging_tax_account
  issuing_body  text,
  permit_number text,
  issued_on     date,
  expires_on    date,
  document_url  text,
  status        text NOT NULL DEFAULT 'active', -- active|expired|pending|revoked
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lodging_permits_expiry ON lodging_permits (expires_on) WHERE status = 'active';


-- ── SEED: amenity vocabulary ────────────────────────────────────────────────
INSERT INTO lodging_amenities (key, label, category, icon, is_filter, sort_order) VALUES
  ('wifi',            'WiFi',                  'essentials',    '📶', true,  10),
  ('air_conditioning','Air conditioning',      'essentials',    '❄️', true,  11),
  ('heating',         'Heating',               'essentials',    '🔥', false, 12),
  ('washer',          'Washer',                'essentials',    '🧺', true,  13),
  ('dryer',           'Dryer',                 'essentials',    '🌀', false, 14),
  ('tv',              'TV',                    'essentials',    '📺', false, 15),
  ('kitchen_full',    'Full kitchen',          'kitchen',       '🍳', true,  20),
  ('dishwasher',      'Dishwasher',            'kitchen',       '🍽️', false, 21),
  ('coffee_maker',    'Coffee maker',          'kitchen',       '☕', false, 22),
  ('grill',           'Grill',                 'outdoor',       '🔥', false, 30),
  ('balcony',         'Balcony',               'outdoor',       '🌅', true,  31),
  ('pool_shared',     'Shared pool',           'outdoor',       '🏊', true,  32),
  ('pool_private',    'Private pool',          'outdoor',       '🏊', true,  33),
  ('hot_tub',         'Hot tub',               'outdoor',       '♨️', true,  34),
  ('gulf_front',      'Gulf front',            'location',      '🌊', true,  40),
  ('gulf_view',       'Gulf view',             'location',      '🌅', true,  41),
  ('beach_access',    'Direct beach access',   'location',      '🏖️', true,  42),
  ('boat_slip',       'Boat slip',             'location',      '⛵', true,  43),
  ('parking_free',    'Free parking',          'location',      '🅿️', true,  44),
  ('elevator',        'Elevator',              'accessibility', '🛗', true,  50),
  ('step_free',       'Step-free access',      'accessibility', '♿', true,  51),
  ('pets_ok',         'Pet friendly',          'essentials',    '🐕', true,  52),
  ('smoke_detector',  'Smoke detector',        'safety',        '🚨', false, 60),
  ('first_aid',       'First aid kit',         'safety',        '🩹', false, 61)
ON CONFLICT (key) DO NOTHING;
