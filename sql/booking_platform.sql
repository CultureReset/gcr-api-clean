-- ============================================================
-- BOOKING PLATFORM — the modular booking engine, slug-keyed.
-- ============================================================
--
-- Target: Supabase project "cyber check" (mkepugvdlktfsossumox). Nothing
-- here is destructive: create-if-not-exists, add-column-if-not-exists,
-- and seeds that do nothing on conflict. Safe to re-run.
--
-- ── The one rule this file exists to enforce ────────────────────────────
--
--   A VERTICAL IS A ROW, NOT A BRANCH.
--
-- There is no charter table, no parasail table, no jet-ski table. A fishing
-- charter and a parasail flight differ in four things — how the day is cut
-- into slots, who counts against capacity, what it costs per head, and what
-- has to be signed first — and all four are columns. `booking_templates`
-- holds the starting values for each vertical as DATA, so adding "horseback
-- rides" or "helicopter tours" is an INSERT, not a deploy.
--
-- The same rule already governs the rest of this API: bookings of every
-- type land in the ONE `bookings` table and every date-claim from every
-- source lands in `booking_calendar`. This file extends that spine rather
-- than forking it.
--
-- ── Why these tables and not the ones already here ──────────────────────
--
-- `offerings` (954 rows) is scraped directory data: `unit` is free text
-- that says "flat", "per trip", "per_person" and "private" for the same
-- idea, and `kind` says both "charter" and "Fishing Charter". It is a fine
-- catalogue and a hopeless price list. `booking_products` is the bookable,
-- sellable version, and it carries `offering_id` so a business that is
-- already in the directory sells the thing it is already listed as.
--
-- ── Money is never computed in a browser ────────────────────────────────
--
-- `booking_rates`, `booking_extras` and `promos` are the only inputs to a
-- price. The public checkout sends quantities; the server sends back the
-- amount. `booking_line_items` records how each total was reached, so a
-- disputed charge can be explained a year later.
--
-- ── Access ──────────────────────────────────────────────────────────────
--
-- RLS on, no policies, grants revoked: only gcr-api-clean's service key
-- reaches these tables, which is the same posture as the rest of the live
-- schema. The dashboard and the public page reach them through the API.
-- ============================================================


-- ============================================================
-- 1. TEMPLATES — the verticals, as rows
-- ============================================================
create table if not exists public.booking_templates (
  id              text primary key,
  name            text not null,
  category        text,
  icon            text,
  tagline         text,
  description     text,
  schedule_mode   text not null default 'fixed_times',
  defaults        jsonb not null default '{}'::jsonb,
  rate_template   jsonb not null default '[]'::jsonb,
  addon_template  jsonb not null default '[]'::jsonb,
  question_template jsonb not null default '[]'::jsonb,
  active          boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);


-- ============================================================
-- 2. PRODUCTS — the bookable thing
-- ============================================================
-- schedule_mode decides how a calendar is cut up, and it is the only
-- structural difference between the verticals:
--   fixed_times    departures at set clock times  (charter, parasail, cruise)
--   duration_slots rolling slots of N minutes     (jet ski, kayak, lesson)
--   date_range     check-in to check-out          (multi-day rental, lodging)
--   open_date      a whole day, no time           (day pass, admission)
--   request        no calendar, an enquiry        (custom trips, groups)
--
-- capacity_mode decides what fills up:
--   seats      passengers share one departure     (a 6-pack charter)
--   units      countable things                   (12 jet skis)
--   exclusive  one booking takes the whole slot   (a private boat)
create table if not exists public.booking_products (
  id                  uuid primary key default gen_random_uuid(),
  entity_slug         text not null,
  template_id         text,
  offering_id         uuid,
  name                text not null,
  description         text,
  image_url           text,
  schedule_mode       text not null default 'fixed_times',
  capacity_mode       text not null default 'seats',
  duration_minutes    integer,
  capacity            integer not null default 1,
  min_party           integer not null default 1,
  max_party           integer,
  lead_time_minutes   integer not null default 0,
  booking_window_days integer not null default 365,
  buffer_minutes      integer not null default 0,
  deposit_mode        text not null default 'full',
  deposit_value       numeric(10,2) not null default 0,
  tax_percent         numeric(6,3) not null default 0,
  currency            text not null default 'usd',
  cancellation_policy jsonb not null default '{}'::jsonb,
  requires_waiver     boolean not null default false,
  waiver_text         text,
  questions           jsonb not null default '[]'::jsonb,
  settings            jsonb not null default '{}'::jsonb,
  active              boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists booking_products_slug_idx on public.booking_products (entity_slug, active);
create index if not exists booking_products_offering_idx on public.booking_products (offering_id);


-- ============================================================
-- 3. RATES — what a seat costs, and who may sit in it
-- ============================================================
-- One row per price tier. "Adult $135 / Child $95" is two rows; "Private
-- charter, up to 6, $900" is one row with pricing_mode 'per_group'.
-- occupies_capacity is how an infant-in-lap rides free without taking a
-- seat, and how a parasail observer pays less but still weighs on the boat.
create table if not exists public.booking_rates (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null,
  product_id        uuid not null,
  label             text not null,
  description       text,
  pricing_mode      text not null default 'per_person',
  amount            numeric(10,2) not null default 0,
  min_qty           integer not null default 0,
  max_qty           integer,
  age_min           integer,
  age_max           integer,
  weight_min_lb     integer,
  weight_max_lb     integer,
  occupies_capacity boolean not null default true,
  capacity_weight   numeric(6,2) not null default 1,
  season_start      date,
  season_end        date,
  days_of_week      integer[],
  active            boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists booking_rates_product_idx on public.booking_rates (product_id, active);
create index if not exists booking_rates_slug_idx on public.booking_rates (entity_slug);


-- ============================================================
-- 4. SCHEDULES — when it runs
-- ============================================================
-- kind 'weekly'   recurring days + departure times (or a window to slice)
-- kind 'date'     a one-off extra departure
-- kind 'blackout' closed: a dry-dock week, a holiday, a hurricane
--
-- A product with no schedule row is bookable on any date in its window,
-- which is the right default for a date_range rental.
create table if not exists public.booking_schedules (
  id                    uuid primary key default gen_random_uuid(),
  entity_slug           text not null,
  product_id            uuid,
  kind                  text not null default 'weekly',
  label                 text,
  days_of_week          integer[],
  times                 text[],
  window_start          time,
  window_end            time,
  slot_interval_minutes integer,
  specific_date         date,
  valid_from            date,
  valid_to              date,
  capacity_override     integer,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists booking_schedules_product_idx on public.booking_schedules (product_id, active);
create index if not exists booking_schedules_slug_idx on public.booking_schedules (entity_slug);


-- ============================================================
-- 5. ADD-ONS — the upsell
-- ============================================================
-- product_id null means the add-on is offered on every product, which is
-- how "fish cleaning" or "GoPro rental" is configured once.
create table if not exists public.booking_extras (
  id           uuid primary key default gen_random_uuid(),
  entity_slug  text not null,
  product_id   uuid,
  name         text not null,
  description  text,
  price        numeric(10,2) not null default 0,
  pricing_mode text not null default 'per_booking',
  max_qty      integer not null default 1,
  required     boolean not null default false,
  active       boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists booking_extras_slug_idx on public.booking_extras (entity_slug, active);


-- ============================================================
-- 6. RESOURCES — the boat, the jet ski, the guide
-- ============================================================
-- A resource can only be in one place at a time. Two products that share a
-- boat (a morning charter and an afternoon dolphin cruise) block each other
-- through this table without either knowing the other exists.
create table if not exists public.booking_resources (
  id            uuid primary key default gen_random_uuid(),
  entity_slug   text not null,
  name          text not null,
  resource_type text,
  capacity      integer,
  description   text,
  image_url     text,
  details       jsonb not null default '{}'::jsonb,
  active        boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists booking_resources_slug_idx on public.booking_resources (entity_slug, active);

create table if not exists public.booking_product_resources (
  id          uuid primary key default gen_random_uuid(),
  entity_slug text not null,
  product_id  uuid not null,
  resource_id uuid not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists booking_product_resources_pair_idx
  on public.booking_product_resources (product_id, resource_id);


-- ============================================================
-- 7. LINE ITEMS — how the total was reached
-- ============================================================
create table if not exists public.booking_line_items (
  id          uuid primary key default gen_random_uuid(),
  entity_slug text not null,
  booking_id  uuid not null,
  kind        text not null default 'rate',
  ref_id      uuid,
  label       text not null,
  unit_amount numeric(10,2) not null default 0,
  quantity    numeric(10,2) not null default 1,
  amount      numeric(10,2) not null default 0,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists booking_line_items_booking_idx on public.booking_line_items (booking_id);


-- ============================================================
-- 8. PAYMENTS — every Stripe object that ever touched a booking
-- ============================================================
create table if not exists public.booking_payments (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null,
  booking_id        uuid,
  kind              text not null default 'payment',
  provider          text not null default 'stripe',
  provider_object_id text,
  stripe_account_id text,
  amount            numeric(10,2) not null default 0,
  application_fee   numeric(10,2) not null default 0,
  currency          text not null default 'usd',
  status            text not null default 'pending',
  failure_reason    text,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists booking_payments_booking_idx on public.booking_payments (booking_id);
create index if not exists booking_payments_slug_idx on public.booking_payments (entity_slug, created_at);
create unique index if not exists booking_payments_object_idx
  on public.booking_payments (provider, provider_object_id, kind)
  where provider_object_id is not null;


-- ============================================================
-- 9. PAYMENT ACCOUNTS — Stripe Connect, keyed by slug
-- ============================================================
-- The legacy `connections` table is keyed by a site_id uuid and also stores
-- business secret keys encrypted at rest. This one holds no secret at all:
-- a Connect account id is not a credential, and the platform key signs for
-- it. Nothing here can be stolen and used.
create table if not exists public.payment_accounts (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null,
  provider          text not null default 'stripe',
  account_id        text,
  account_type      text not null default 'express',
  country           text not null default 'US',
  default_currency  text not null default 'usd',
  charges_enabled   boolean not null default false,
  payouts_enabled   boolean not null default false,
  details_submitted boolean not null default false,
  requirements      jsonb not null default '{}'::jsonb,
  livemode          boolean not null default false,
  business_profile  jsonb not null default '{}'::jsonb,
  last_synced_at    timestamptz,
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists payment_accounts_slug_provider_idx
  on public.payment_accounts (entity_slug, provider);
create index if not exists payment_accounts_account_idx on public.payment_accounts (account_id);


-- ============================================================
-- 10. FEE RULES — the platform's cut, as configuration
-- ============================================================
-- Most specific wins: entity → template → global. A business negotiated
-- down to 0% is a row, not a code path, and PLATFORM_FEE_PERCENT stays the
-- fallback for a deployment with no rules at all.
create table if not exists public.platform_fee_rules (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null default 'global',
  entity_slug text,
  template_id text,
  percent     numeric(6,3) not null default 0,
  fixed_cents integer not null default 0,
  min_cents   integer not null default 0,
  max_cents   integer,
  note        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists platform_fee_rules_lookup_idx on public.platform_fee_rules (scope, entity_slug, active);


-- ============================================================
-- 11. WEBHOOK EVENTS — idempotency
-- ============================================================
-- Stripe retries. A retry that charges twice, or cancels a booking that was
-- already rebooked, is worse than a dropped event — so every event id is
-- written here first and a second delivery of the same id does nothing.
create table if not exists public.booking_webhook_events (
  id           text primary key,
  type         text,
  account_id   text,
  livemode     boolean,
  payload      jsonb,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);


-- ============================================================
-- 12. bookings — the existing universal table, extended
-- ============================================================
-- Every booking still lands in `bookings`. These columns carry the money
-- and the Stripe references the engine needs; nothing existing is altered.
alter table public.bookings add column if not exists product_id uuid;
alter table public.bookings add column if not exists template_id text;
alter table public.bookings add column if not exists currency text default 'usd';
alter table public.bookings add column if not exists subtotal numeric(10,2);
alter table public.bookings add column if not exists discount_total numeric(10,2) default 0;
alter table public.bookings add column if not exists tax_total numeric(10,2) default 0;
alter table public.bookings add column if not exists total_amount numeric(10,2);
alter table public.bookings add column if not exists amount_paid numeric(10,2) default 0;
alter table public.bookings add column if not exists balance_due numeric(10,2);
alter table public.bookings add column if not exists deposit_due numeric(10,2);
alter table public.bookings add column if not exists refunded_amount numeric(10,2) default 0;
alter table public.bookings add column if not exists application_fee numeric(10,2) default 0;
alter table public.bookings add column if not exists stripe_account_id text;
alter table public.bookings add column if not exists checkout_session_id text;
alter table public.bookings add column if not exists promo_code text;
alter table public.bookings add column if not exists end_time time;
alter table public.bookings add column if not exists hold_expires_at timestamptz;
alter table public.bookings add column if not exists waiver_signed_at timestamptz;
alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.bookings add column if not exists cancel_reason text;
alter table public.bookings add column if not exists answers jsonb default '{}'::jsonb;
alter table public.bookings add column if not exists customer_notes text;
alter table public.bookings add column if not exists updated_at timestamptz default now();

-- booking_calendar is the one place every date-claim lands, from this
-- engine and from every external sync. It needs to say which product and
-- which boat a claim belongs to, or availability cannot tell a morning
-- charter's seats from an afternoon cruise's.
alter table public.booking_calendar add column if not exists product_id uuid;
alter table public.booking_calendar add column if not exists resource_id uuid;
create index if not exists booking_calendar_product_idx on public.booking_calendar (product_id, date);
create index if not exists booking_calendar_slug_date_idx on public.booking_calendar (entity_slug, date);

create index if not exists bookings_slug_date_idx on public.bookings (entity_slug, date);
create index if not exists bookings_product_idx on public.bookings (product_id, date);
create index if not exists bookings_session_idx on public.bookings (checkout_session_id);
create index if not exists bookings_hold_idx on public.bookings (hold_expires_at) where hold_expires_at is not null;


-- ============================================================
-- 13. LOCK THE DOORS
-- ============================================================
-- Same posture as the rest of the live schema: the anon and authenticated
-- roles get nothing, RLS is on with no policy, and the API's service key
-- (which bypasses RLS) is the only way in.
alter table public.booking_templates        enable row level security;
alter table public.booking_products         enable row level security;
alter table public.booking_rates            enable row level security;
alter table public.booking_schedules        enable row level security;
alter table public.booking_extras           enable row level security;
alter table public.booking_resources        enable row level security;
alter table public.booking_product_resources enable row level security;
alter table public.booking_line_items       enable row level security;
alter table public.booking_payments         enable row level security;
alter table public.payment_accounts         enable row level security;
alter table public.platform_fee_rules       enable row level security;
alter table public.booking_webhook_events   enable row level security;

revoke all on public.booking_templates         from anon, authenticated;
revoke all on public.booking_products          from anon, authenticated;
revoke all on public.booking_rates             from anon, authenticated;
revoke all on public.booking_schedules         from anon, authenticated;
revoke all on public.booking_extras            from anon, authenticated;
revoke all on public.booking_resources         from anon, authenticated;
revoke all on public.booking_product_resources from anon, authenticated;
revoke all on public.booking_line_items        from anon, authenticated;
revoke all on public.booking_payments          from anon, authenticated;
revoke all on public.payment_accounts          from anon, authenticated;
revoke all on public.platform_fee_rules        from anon, authenticated;
revoke all on public.booking_webhook_events    from anon, authenticated;


-- ============================================================
-- 14. SEED — the verticals
-- ============================================================
-- These are starting points a business edits, not rules it obeys. Every
-- value below is a column on booking_products / booking_rates that the
-- owner can change the moment the product is created. Adding a vertical is
-- another row here and nothing else.
insert into public.booking_templates
  (id, name, category, icon, tagline, schedule_mode, defaults, rate_template, addon_template, question_template, sort_order)
values

-- ── Water: charters and flights ────────────────────────────────────────
('fishing_charter', 'Fishing Charter', 'water', '🎣',
 'Half-day and full-day trips with set departure times.',
 'fixed_times',
 '{"capacity_mode":"seats","capacity":6,"duration_minutes":240,"min_party":1,"max_party":6,"lead_time_minutes":720,"deposit_mode":"percent","deposit_value":25,"requires_waiver":true,"buffer_minutes":60,
   "cancellation_policy":{"free_until_hours":48,"partial_until_hours":24,"partial_percent":50},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"times":["06:00","13:00"]}}'::jsonb,
 '[{"label":"Adult","pricing_mode":"per_person","amount":150,"occupies_capacity":true,"sort_order":0},
   {"label":"Child (under 12)","pricing_mode":"per_person","amount":100,"age_max":11,"occupies_capacity":true,"sort_order":1},
   {"label":"Private charter (whole boat)","pricing_mode":"per_group","amount":900,"occupies_capacity":true,"capacity_weight":6,"active":false,"sort_order":2}]'::jsonb,
 '[{"name":"Fish cleaning","price":25,"pricing_mode":"per_booking"},
   {"name":"Rod rental","price":15,"pricing_mode":"per_person"},
   {"name":"Fishing license (3-day)","price":20,"pricing_mode":"per_person"}]'::jsonb,
 '[{"key":"experience","label":"Fished before?","type":"select","options":["First time","Some experience","Experienced"]},
   {"key":"target","label":"Anything you are hoping to catch?","type":"text"}]'::jsonb,
 10),

('parasailing', 'Parasailing', 'water', '🪂',
 'Timed flights, priced per flyer, weight limits enforced at booking.',
 'fixed_times',
 '{"capacity_mode":"seats","capacity":12,"duration_minutes":90,"min_party":1,"max_party":12,"lead_time_minutes":180,"deposit_mode":"full","deposit_value":0,"requires_waiver":true,"buffer_minutes":30,
   "cancellation_policy":{"free_until_hours":24,"weather_refund":true},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"times":["08:00","10:00","12:00","14:00","16:00","18:00"]}}'::jsonb,
 '[{"label":"Single flyer","pricing_mode":"per_person","amount":85,"weight_min_lb":50,"weight_max_lb":275,"occupies_capacity":true,"sort_order":0},
   {"label":"Tandem (2 flyers)","pricing_mode":"per_person","amount":75,"min_qty":2,"weight_max_lb":425,"occupies_capacity":true,"sort_order":1},
   {"label":"Observer (rides along, does not fly)","pricing_mode":"per_person","amount":35,"occupies_capacity":true,"capacity_weight":1,"sort_order":2}]'::jsonb,
 '[{"name":"Photo package","price":40,"pricing_mode":"per_booking"},
   {"name":"GoPro rental","price":25,"pricing_mode":"per_booking"}]'::jsonb,
 '[{"key":"weights","label":"Flyer weights (lbs) — required by the Coast Guard","type":"text","required":true}]'::jsonb,
 20),

('jetski_rental', 'Jet Ski / Waverunner Rental', 'water', '🌊',
 'Rolling rental slots, priced by the hour, counted by machine.',
 'duration_slots',
 '{"capacity_mode":"units","capacity":8,"duration_minutes":60,"min_party":1,"lead_time_minutes":60,"deposit_mode":"percent","deposit_value":50,"requires_waiver":true,"buffer_minutes":15,
   "cancellation_policy":{"free_until_hours":24},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"window_start":"09:00","window_end":"18:00","slot_interval_minutes":60}}'::jsonb,
 '[{"label":"1 hour","pricing_mode":"per_unit","amount":95,"occupies_capacity":true,"sort_order":0},
   {"label":"2 hours","pricing_mode":"per_unit","amount":175,"occupies_capacity":true,"sort_order":1},
   {"label":"Half day (4 hours)","pricing_mode":"per_unit","amount":300,"occupies_capacity":true,"sort_order":2}]'::jsonb,
 '[{"name":"Fuel surcharge","price":30,"pricing_mode":"per_unit"},
   {"name":"Extra rider vest","price":10,"pricing_mode":"per_unit"}]'::jsonb,
 '[{"key":"drivers_license","label":"Driver over 18 in the party?","type":"select","options":["Yes","No"],"required":true}]'::jsonb,
 30),

('boat_rental', 'Boat / Pontoon Rental', 'water', '⛵',
 'Half-day, full-day and multi-day rentals of a named vessel.',
 'duration_slots',
 '{"capacity_mode":"exclusive","capacity":1,"duration_minutes":240,"min_party":1,"max_party":12,"lead_time_minutes":720,"deposit_mode":"percent","deposit_value":30,"requires_waiver":true,"buffer_minutes":60,
   "cancellation_policy":{"free_until_hours":72,"partial_until_hours":48,"partial_percent":50},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"times":["08:00","13:00"]}}'::jsonb,
 '[{"label":"Half day (4 hours)","pricing_mode":"per_group","amount":450,"sort_order":0},
   {"label":"Full day (8 hours)","pricing_mode":"per_group","amount":750,"sort_order":1}]'::jsonb,
 '[{"name":"Captain","price":200,"pricing_mode":"per_booking"},
   {"name":"Tube / towables","price":50,"pricing_mode":"per_booking"},
   {"name":"Cooler with ice","price":25,"pricing_mode":"per_booking"}]'::jsonb,
 '[{"key":"boating_experience","label":"Have you operated a boat this size before?","type":"select","options":["Yes","No"],"required":true}]'::jsonb,
 40),

('dolphin_cruise', 'Dolphin / Sunset Cruise', 'water', '🐬',
 'Scheduled sailings priced per head, kids at a lower rate.',
 'fixed_times',
 '{"capacity_mode":"seats","capacity":40,"duration_minutes":120,"min_party":1,"lead_time_minutes":120,"deposit_mode":"full","deposit_value":0,"requires_waiver":false,"buffer_minutes":30,
   "cancellation_policy":{"free_until_hours":24,"weather_refund":true},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"times":["10:00","14:00","18:00"]}}'::jsonb,
 '[{"label":"Adult","pricing_mode":"per_person","amount":35,"occupies_capacity":true,"sort_order":0},
   {"label":"Child (3-12)","pricing_mode":"per_person","amount":20,"age_min":3,"age_max":12,"occupies_capacity":true,"sort_order":1},
   {"label":"Infant (under 3)","pricing_mode":"per_person","amount":0,"age_max":2,"occupies_capacity":false,"capacity_weight":0,"sort_order":2}]'::jsonb,
 '[{"name":"Drink package","price":15,"pricing_mode":"per_person"}]'::jsonb,
 '[]'::jsonb,
 50),

('snorkel_dive', 'Snorkel / Scuba Trip', 'water', '🤿',
 'Guided trips with gear hire and certification checks.',
 'fixed_times',
 '{"capacity_mode":"seats","capacity":20,"duration_minutes":180,"min_party":1,"lead_time_minutes":720,"deposit_mode":"percent","deposit_value":25,"requires_waiver":true,"buffer_minutes":45,
   "cancellation_policy":{"free_until_hours":48,"weather_refund":true},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"times":["08:00","13:00"]}}'::jsonb,
 '[{"label":"Snorkeler","pricing_mode":"per_person","amount":70,"occupies_capacity":true,"sort_order":0},
   {"label":"Certified diver (2 tanks)","pricing_mode":"per_person","amount":140,"occupies_capacity":true,"sort_order":1}]'::jsonb,
 '[{"name":"Full gear rental","price":35,"pricing_mode":"per_person"},
   {"name":"Underwater camera","price":25,"pricing_mode":"per_person"}]'::jsonb,
 '[{"key":"certification","label":"Certification agency and level","type":"text"},
   {"key":"last_dive","label":"When did you last dive?","type":"text"}]'::jsonb,
 60),

('kayak_paddle', 'Kayak / Paddleboard Rental', 'water', '🛶',
 'Hourly hire counted by board, with guided options.',
 'duration_slots',
 '{"capacity_mode":"units","capacity":20,"duration_minutes":60,"min_party":1,"lead_time_minutes":30,"deposit_mode":"full","deposit_value":0,"requires_waiver":true,"buffer_minutes":0,
   "cancellation_policy":{"free_until_hours":12},
   "schedule":{"kind":"weekly","days_of_week":[0,1,2,3,4,5,6],"window_start":"08:00","window_end":"19:00","slot_interval_minutes":60}}'::jsonb,
 '[{"label":"Single kayak / board (1 hr)","pricing_mode":"per_unit","amount":25,"sort_order":0},
   {"label":"Tandem kayak (1 hr)","pricing_mode":"per_unit","amount":40,"sort_order":1},
   {"label":"Guided tour (per person)","pricing_mode":"per_person","amount":55,"active":false,"sort_order":2}]'::jsonb,
 '[{"name":"Dry bag","price":5,"pricing_mode":"per_unit"}]'::jsonb,
 '[]'::jsonb,
 70),

-- ── Land: tours, lessons, services, tickets ────────────────────────────
('guided_tour', 'Guided Tour', 'land', '🚐',
 'Walking, bus or buggy tours on set departures.',
 'fixed_times',
 '{"capacity_mode":"seats","capacity":16,"duration_minutes":120,"min_party":1,"lead_time_minutes":240,"deposit_mode":"full","deposit_value":0,"requires_waiver":false,"buffer_minutes":30,
   "cancellation_policy":{"free_until_hours":24},
   "schedule":{"kind":"weekly","days_of_week":[1,2,3,4,5,6],"times":["09:00","13:00","17:00"]}}'::jsonb,
 '[{"label":"Adult","pricing_mode":"per_person","amount":45,"occupies_capacity":true,"sort_order":0},
   {"label":"Child","pricing_mode":"per_person","amount":25,"age_max":12,"occupies_capacity":true,"sort_order":1},
   {"label":"Senior","pricing_mode":"per_person","amount":38,"age_min":65,"occupies_capacity":true,"sort_order":2}]'::jsonb,
 '[]'::jsonb,
 '[{"key":"mobility","label":"Any mobility needs we should plan for?","type":"text"}]'::jsonb,
 80),

('lesson_class', 'Lesson / Class', 'land', '🏄',
 'Instructor-led sessions with a small head count.',
 'duration_slots',
 '{"capacity_mode":"seats","capacity":6,"duration_minutes":90,"min_party":1,"lead_time_minutes":720,"deposit_mode":"percent","deposit_value":50,"requires_waiver":true,"buffer_minutes":15,
   "cancellation_policy":{"free_until_hours":24},
   "schedule":{"kind":"weekly","days_of_week":[1,2,3,4,5,6],"window_start":"09:00","window_end":"17:00","slot_interval_minutes":90}}'::jsonb,
 '[{"label":"Group lesson","pricing_mode":"per_person","amount":75,"occupies_capacity":true,"sort_order":0},
   {"label":"Private lesson","pricing_mode":"per_group","amount":180,"capacity_weight":6,"sort_order":1}]'::jsonb,
 '[{"name":"Equipment hire","price":20,"pricing_mode":"per_person"}]'::jsonb,
 '[{"key":"skill_level","label":"Skill level","type":"select","options":["Never tried","Beginner","Intermediate","Advanced"]}]'::jsonb,
 90),

('appointment', 'Appointment / Service', 'service', '🗓️',
 'One customer at a time, back-to-back slots.',
 'duration_slots',
 '{"capacity_mode":"exclusive","capacity":1,"duration_minutes":60,"min_party":1,"max_party":1,"lead_time_minutes":120,"deposit_mode":"none","deposit_value":0,"requires_waiver":false,"buffer_minutes":15,
   "cancellation_policy":{"free_until_hours":24},
   "schedule":{"kind":"weekly","days_of_week":[1,2,3,4,5],"window_start":"09:00","window_end":"17:00","slot_interval_minutes":60}}'::jsonb,
 '[{"label":"Standard session","pricing_mode":"per_group","amount":120,"sort_order":0}]'::jsonb,
 '[]'::jsonb,
 '[]'::jsonb,
 100),

('equipment_rental', 'Equipment Rental', 'service', '🏖️',
 'Chairs, bikes, umbrellas and golf carts, by the day.',
 'date_range',
 '{"capacity_mode":"units","capacity":50,"min_party":1,"lead_time_minutes":0,"deposit_mode":"full","deposit_value":0,"requires_waiver":false,"buffer_minutes":0,
   "cancellation_policy":{"free_until_hours":24}}'::jsonb,
 '[{"label":"Per day","pricing_mode":"per_day","amount":35,"sort_order":0},
   {"label":"Weekly rate","pricing_mode":"per_unit","amount":175,"sort_order":1}]'::jsonb,
 '[{"name":"Delivery and setup","price":25,"pricing_mode":"per_booking"}]'::jsonb,
 '[{"key":"delivery_address","label":"Delivery address (if delivering)","type":"text"}]'::jsonb,
 110),

('day_pass', 'Ticket / Day Pass', 'attraction', '🎟️',
 'Admission for a date, no time slot.',
 'open_date',
 '{"capacity_mode":"seats","capacity":200,"min_party":1,"lead_time_minutes":0,"deposit_mode":"full","deposit_value":0,"requires_waiver":false,
   "cancellation_policy":{"free_until_hours":24}}'::jsonb,
 '[{"label":"General admission","pricing_mode":"per_person","amount":25,"occupies_capacity":true,"sort_order":0},
   {"label":"Child","pricing_mode":"per_person","amount":15,"age_max":12,"occupies_capacity":true,"sort_order":1}]'::jsonb,
 '[]'::jsonb,
 '[]'::jsonb,
 120),

('custom_request', 'Custom / Group Enquiry', 'service', '✉️',
 'No calendar — collect the request and quote it by hand.',
 'request',
 '{"capacity_mode":"seats","capacity":999,"min_party":1,"lead_time_minutes":0,"deposit_mode":"none","deposit_value":0,"requires_waiver":false}'::jsonb,
 '[]'::jsonb,
 '[]'::jsonb,
 '[{"key":"group_size","label":"How many people?","type":"text","required":true},
   {"key":"preferred_dates","label":"Preferred dates","type":"text"},
   {"key":"details","label":"Tell us what you have in mind","type":"textarea"}]'::jsonb,
 130)

on conflict (id) do nothing;


-- The platform's default cut, only if nothing is configured yet. A row of
-- 0% is still a row — the deployment decides, not the code.
insert into public.platform_fee_rules (scope, percent, fixed_cents, note)
select 'global', 0, 0, 'Default: no platform fee until one is configured.'
where not exists (select 1 from public.platform_fee_rules where scope = 'global');


-- ============================================================
-- 15. LODGING AND CHANNELS  (applied as a later migration)
-- ============================================================
-- Stay rules live on booking_products rather than in a lodging-only
-- table: a multi-day jet ski hire is a stay too, and a second table
-- would have made lodging a special case of itself.
alter table public.booking_products add column if not exists min_nights integer not null default 1;
alter table public.booking_products add column if not exists max_nights integer;
alter table public.booking_products add column if not exists turnover_days integer not null default 0;
alter table public.booking_products add column if not exists arrival_days integer[];
alter table public.booking_products add column if not exists departure_days integer[];
alter table public.booking_products add column if not exists base_occupancy integer;
alter table public.booking_products add column if not exists extra_guest_fee numeric(10,2) not null default 0;

-- Per-date pricing and stay rules. A PMS lives or dies on this table: one
-- price for a product is useless when the 4th of July is worth triple a
-- Tuesday in November.
create table if not exists public.booking_rate_calendar (
  id                  uuid primary key default gen_random_uuid(),
  entity_slug         text not null,
  product_id          uuid not null,
  date                date not null,
  price               numeric(10,2),
  min_nights          integer,
  closed              boolean not null default false,
  closed_to_arrival   boolean not null default false,
  closed_to_departure boolean not null default false,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists booking_rate_calendar_day_idx on public.booking_rate_calendar (product_id, date);
create index if not exists booking_rate_calendar_slug_idx on public.booking_rate_calendar (entity_slug, date);

-- Channels. An iCal feed in either direction: 'import' pulls Airbnb, Vrbo
-- or Booking.com reservations in so a night sold there closes here;
-- 'export' hands them a URL so a night sold here closes there.
create table if not exists public.booking_channels (
  id              uuid primary key default gen_random_uuid(),
  entity_slug     text not null,
  product_id      uuid,
  resource_id     uuid,
  name            text not null,
  kind            text not null default 'ical',
  direction       text not null default 'import',
  url             text,
  export_token    text,
  active          boolean not null default true,
  last_synced_at  timestamptz,
  last_status     text,
  last_error      text,
  events_imported integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists booking_channels_slug_idx on public.booking_channels (entity_slug, active);
create index if not exists booking_channels_product_idx on public.booking_channels (product_id);
create unique index if not exists booking_channels_export_token_idx
  on public.booking_channels (export_token) where export_token is not null;

alter table public.booking_rate_calendar enable row level security;
alter table public.booking_channels      enable row level security;
revoke all on public.booking_rate_calendar from anon, authenticated;
revoke all on public.booking_channels      from anon, authenticated;
