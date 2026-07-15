-- ============================================================================
-- GCR v2 — 006_commerce.sql  (Commerce module pack)
-- Offerings (services/tours/charters/rentals/packages) + prices/schedules/
-- inclusions/requirements/addons, and bookable resources (rooms/units/boats/
-- vehicles/equipment) with their media/amenities/rates/fees/policies/calendars.
-- ============================================================================

create table if not exists v2.offering_categories (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  name       text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- offerings — a purchasable/reservable/quoteable product.
create table if not exists v2.offerings (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  category_id  uuid references v2.offering_categories(id) on delete set null,
  offering_type text not null default 'service', -- service | tour | charter | rental | package | class | ticket
  name         text not null,
  description  text,
  duration_text text,
  duration_minutes integer,
  capacity_min integer,
  capacity_max integer,
  media_id     uuid references v2.media_assets(id) on delete set null,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_offerings_entity on v2.offerings (entity_id, offering_type);

-- person_offerings — which person can perform which offering (was staff_services).
create table if not exists v2.person_offerings (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references v2.people(id) on delete cascade,
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (person_id, offering_id)
);

-- offering_prices — adult/child/group/duration/seasonal/tier prices.
create table if not exists v2.offering_prices (
  id          uuid primary key default gen_random_uuid(),
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  label       text,                           -- Adult | Child | Group | Senior | Peak | Off-Peak
  price       numeric not null,
  price_unit  text,                           -- per_person | per_hour | per_day | flat
  min_qty     integer,
  season      text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists v2.offering_schedules (
  id          uuid primary key default gen_random_uuid(),
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  days_of_week text,
  start_time  time,
  end_time    time,
  season_start date,
  season_end   date,
  created_at  timestamptz not null default now()
);

create table if not exists v2.offering_inclusions (
  id          uuid primary key default gen_random_uuid(),
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  label       text not null,
  is_included boolean not null default true,  -- false = explicitly NOT included
  sort_order  integer not null default 0
);

create table if not exists v2.offering_requirements (
  id          uuid primary key default gen_random_uuid(),
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  req_type    text not null,                  -- age | weight | waiver | arrival | bring | health
  label       text not null,
  value       text,
  sort_order  integer not null default 0
);

create table if not exists v2.offering_addons (
  id          uuid primary key default gen_random_uuid(),
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  name        text not null,
  price       numeric,
  is_required boolean not null default false
);

-- resources — rooms/units/boats/vehicles/equipment/chairs/tables/capacity.
create table if not exists v2.resources (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  resource_type text not null,                -- room | unit | boat | vehicle | equipment | table | seat
  name         text not null,
  description  text,
  capacity     integer,
  bedrooms     integer,
  bathrooms    numeric,
  sleeps       integer,
  unit_number  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_resources_entity on v2.resources (entity_id, resource_type);

create table if not exists v2.offering_resources (
  id          uuid primary key default gen_random_uuid(),
  offering_id uuid not null references v2.offerings(id) on delete cascade,
  resource_id uuid not null references v2.resources(id) on delete cascade,
  unique (offering_id, resource_id)
);

create table if not exists v2.resource_media (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  media_id    uuid not null references v2.media_assets(id) on delete cascade,
  sort_order  integer not null default 0,
  unique (resource_id, media_id)
);

create table if not exists v2.resource_amenities (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  amenity     text not null,
  category    text
);

create table if not exists v2.resource_rates (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  rate_type   text not null,                  -- nightly | hourly | daily | per_person | seasonal
  price       numeric not null,
  season      text,
  min_nights  integer
);

create table if not exists v2.resource_fees (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  fee_type    text not null,                  -- cleaning | service | resort | fuel | mandatory
  label       text,
  amount      numeric,
  is_mandatory boolean not null default true
);

create table if not exists v2.resource_policies (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  policy_type text not null,
  body        text
);

create table if not exists v2.resource_calendar_sources (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  source_type text not null,                  -- ical | email_parser | provider
  url         text,
  settings    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
