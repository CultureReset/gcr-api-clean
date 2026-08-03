-- ============================================================
-- CAPABILITY TABLES — named after the thing, not the industry
-- ============================================================
--
-- A table is named after WHAT IT IS. A vessel is a vessel whether a fishing
-- charter, a dolphin cruise or a pontoon rental owns it. There is no
-- `charter_boats` and no `cruise_vessels`, because that would mean a marina
-- running charters AND renting pontoons could not use the same table for its
-- own fleet.
--
-- ── The rule ────────────────────────────────────────────────────────────
--
--   ANY slug can use ANY of these tables. The industry gates nothing.
--
-- `entity.entity_type` / `entity_subtype` already say what a business is.
-- Repeating that in a table name locks a business into one industry and buys
-- nothing. A restaurant with a private dining room uses `spaces`. A condo
-- complex that also rents bikes uses `gear`. A charter that also runs sunset
-- cruises uses one `vessels` row and two `trips` rows.
--
-- ── No JSON ─────────────────────────────────────────────────────────────
--
-- Every column here is a real, typed, indexable column. No jsonb, no
-- key/value pairs, no comma-separated lists. Lists are join tables.
--
-- ── On reads at scale ───────────────────────────────────────────────────
--
-- Every table is indexed on `entity_slug` and only holds rows for businesses
-- that actually have that thing. Reading one business is a handful of index
-- lookups against small tables; listing 100k businesses touches none of them,
-- because the directory list reads `entity` alone. Nothing here is scanned to
-- render a list.
--
--   psql "$DATABASE_URL" -f sql/capability_tables.sql
--
-- Re-runnable. Creates nothing that already exists, drops nothing.

/* ══════════════════════════════════════════════════════════════════════
   HOW THE BUSINESS OPERATES — one optional row per slug
   ══════════════════════════════════════════════════════════════════════ */
--
-- Replaces what was `charter_operators`, `cruise_operators`,
-- `rental_operators`, `watersport_operators`, `session_providers` and
-- `stay_properties` — six tables that were the same idea six times. Every
-- column is optional; a business fills in the ones that apply to it and
-- ignores the rest. Nulls cost a bit over nothing in Postgres.

create table if not exists public.entity_operations (
  entity_slug           text primary key,

  -- Where you meet them. A marina, a dock, a launch point, a pick-up counter,
  -- a lobby — the same field whatever the business calls it.
  departs_from          text,
  dock_number           text,
  meeting_instructions  text,

  -- Who runs it.
  crew_count            integer,
  captains              integer,
  guides                integer,
  licensed              boolean,
  license_number        text,
  insured               boolean,
  years_operating       integer,

  -- What a customer has to be or bring.
  min_age               integer,
  max_age               integer,
  min_weight_lb         integer,
  max_weight_lb         integer,
  license_required      boolean,
  id_required           boolean,

  -- What is included without paying extra.
  gear_included         boolean,
  instruction_included  boolean,
  fuel_included         boolean,
  bait_included         boolean,
  ice_included          boolean,
  cleaning_included     boolean,
  photos_included       boolean,
  linens_included       boolean,
  food_included         boolean,

  -- Rules.
  pets_allowed          boolean,
  smoking_allowed       boolean,
  alcohol_allowed       boolean,
  byob_allowed          boolean,
  events_allowed        boolean,

  -- Getting there and back.
  delivery_available    boolean,
  delivery_fee          numeric(10,2),
  travels_to_customer   boolean,
  travel_radius_mi      integer,
  travel_fee            numeric(10,2),
  captain_available     boolean,
  captain_rate          numeric(10,2),

  -- Money and terms.
  deposit_percent       numeric(5,2),
  deposit_amount        numeric(10,2),
  security_deposit      numeric(10,2),
  cancellation_policy   text,
  weather_policy        text,
  tax_rate              numeric(5,2),

  -- Timing.
  check_in_time         time,
  check_out_time        time,
  turnaround_days       integer,

  -- Access and the building, for a business that IS a building.
  beachfront            boolean,
  distance_to_beach_ft  integer,
  floors                integer,
  year_built            integer,
  renovated_year        integer,
  total_units           integer,
  front_desk_24h        boolean,
  housekeeping_daily    boolean,
  security_onsite       boolean,
  gated                 boolean,
  elevator              boolean,
  wheelchair_accessible boolean,
  parking_type          text,
  parking_spaces        integer,
  parking_notes         text,
  management_company    text,

  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- The columns a guest actually filters on, indexed.
create index if not exists entity_operations_beachfront_idx
  on public.entity_operations (beachfront) where beachfront is true;
create index if not exists entity_operations_pets_idx
  on public.entity_operations (pets_allowed) where pets_allowed is true;
create index if not exists entity_operations_min_age_idx
  on public.entity_operations (min_age);

/* ══════════════════════════════════════════════════════════════════════
   VESSELS — anything that floats and carries people
   ══════════════════════════════════════════════════════════════════════ */
--
-- A fishing charter's 65ft Viking, a rental company's 22ft double-deck
-- tritoon, a dolphin cruise's 56-footer. Same facts, same table.
-- `vessel_type` says which, and it is data rather than a table name — the
-- business already knows what it is.

create table if not exists public.vessels (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null,

  name              text,
  vessel_type       text,          -- sportfish | center_console | pontoon | deck_boat
                                   -- catamaran | sailboat | yacht | jet_ski | kayak | paddleboard
  make              text,
  model             text,
  year              integer,

  length_ft         numeric(5,1),
  beam_ft           numeric(5,1),
  max_passengers    integer,       -- what the coastguard cert says
  max_anglers       integer,       -- fewer than passengers on a fishing trip
  engines           integer,
  engine_hp         integer,
  cruising_speed_kn numeric(5,1),
  fuel_capacity_gal integer,
  max_range_mi      integer,

  -- The first three questions anyone asks about a vessel.
  has_head          boolean,
  has_ac            boolean,
  has_cabin         boolean,
  has_shade         boolean,
  has_galley        boolean,
  has_livewell      boolean,
  has_fishfinder    boolean,
  has_radar         boolean,
  has_outriggers    boolean,
  has_fighting_chair boolean,
  has_stereo        boolean,
  has_ladder        boolean,
  wheelchair_accessible boolean,

  -- Rented directly rather than only used for trips.
  hourly_rate       numeric(10,2),
  half_day_rate     numeric(10,2),
  full_day_rate     numeric(10,2),
  weekly_rate       numeric(10,2),

  quantity          integer default 1,   -- five identical pontoons is one row
  is_active         boolean default true,
  sort_order        integer default 0,
  notes             text,

  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists vessels_entity_idx on public.vessels (entity_slug);
create index if not exists vessels_search_idx on public.vessels (length_ft, max_passengers);
create index if not exists vessels_type_idx on public.vessels (vessel_type);

/* ══════════════════════════════════════════════════════════════════════
   UNITS — anything with bedrooms
   ══════════════════════════════════════════════════════════════════════ */
--
-- A condo unit, a hotel room, a cabin, a whole house. `entity_slug` is the
-- unit's own slug when it is its own listing, and the building's slug when it
-- is not — either way, one row per bookable unit.

create table if not exists public.units (
  id                 uuid primary key default gen_random_uuid(),
  entity_slug        text not null,

  name               text,
  unit_number        text,
  unit_type          text,          -- condo | suite | studio | villa | room | cabin | house
  floor              integer,

  -- The four every search starts with.
  bedrooms           integer,
  bathrooms          numeric(3,1),  -- 2.5 is a real answer
  sleeps             integer,
  square_feet        integer,

  half_baths         integer,
  view               text,          -- gulf_front | gulf_view | side_gulf | bay | lagoon | pool | parking | none
  balcony            boolean,
  balcony_count      integer,
  ground_floor       boolean,
  elevator_access    boolean,
  wheelchair_accessible boolean,

  min_nights         integer,
  max_nights         integer,
  max_guests         integer,
  pet_friendly       boolean,
  pet_fee            numeric(10,2),
  max_pets           integer,

  nightly_rate       numeric(10,2),
  weekly_rate        numeric(10,2),
  monthly_rate       numeric(10,2),
  cleaning_fee       numeric(10,2),

  description        text,
  house_rules        text,

  quantity           integer default 1,   -- "we have six of this room type"
  is_active          boolean default true,
  sort_order         integer default 0,

  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create index if not exists units_entity_idx on public.units (entity_slug);
create index if not exists units_search_idx on public.units (bedrooms, bathrooms, sleeps);
create index if not exists units_view_idx on public.units (view);
create index if not exists units_rate_idx on public.units (nightly_rate);

-- "Bedroom 1: one king." Someone working out where to put four kids is asking
-- about exactly this.
create table if not exists public.unit_beds (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references public.units(id) on delete cascade,
  room_name   text,
  room_type   text,          -- bedroom | living | loft | den | bunk_room
  bed_type    text not null, -- king | queen | full | twin | bunk | sofa_bed | murphy
  quantity    integer default 1,
  sort_order  integer default 0
);

create index if not exists unit_beds_unit_idx on public.unit_beds (unit_id);

/* ══════════════════════════════════════════════════════════════════════
   TRIPS — anything with a departure time and a duration
   ══════════════════════════════════════════════════════════════════════ */
--
-- An 8-hour offshore charter, a sunset dolphin cruise, a parasail flight, a
-- kayak tour. `vessel_id` is optional, because a walking tour has no boat.

create table if not exists public.trips (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null,
  vessel_id           uuid references public.vessels(id) on delete set null,

  name              text,
  trip_type         text,          -- inshore | nearshore | offshore | deep_sea | bottom | trolling
                                   -- dolphin | sunset | sightseeing | dinner | party | eco
                                   -- parasail | snorkel | dive | kayak | walking
  duration_hours    numeric(4,1),
  min_guests        integer,
  max_guests        integer,
  departure_time    time,
  return_time       time,

  price             numeric(10,2),
  price_unit        text default 'trip',   -- trip | person
  child_price       numeric(10,2),
  extra_person_fee  numeric(10,2),

  is_private        boolean,
  narrated          boolean,
  guarantee         text,          -- "dolphin sighting or ride again free"

  is_active         boolean default true,
  sort_order        integer default 0,
  notes             text
);

create index if not exists trips_entity_idx on public.trips (entity_slug);
create index if not exists trips_search_idx on public.trips (duration_hours, max_guests);
create index if not exists trips_type_idx on public.trips (trip_type);

/* ══════════════════════════════════════════════════════════════════════
   GEAR — anything you rent that is not a boat or a unit
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.gear (
  id              uuid primary key default gen_random_uuid(),
  entity_slug     text not null,

  name            text,
  gear_type       text,            -- golf_cart | bike | scooter | beach_chair | umbrella
                                   -- kayak | paddleboard | snorkel_set | fishing_rod | cooler | wagon
  make            text,
  model           text,
  year            integer,
  capacity        integer,
  quantity        integer default 1,

  hourly_rate     numeric(10,2),
  daily_rate      numeric(10,2),
  weekly_rate     numeric(10,2),
  delivery_included boolean,

  is_active       boolean default true,
  sort_order      integer default 0,
  notes           text
);

create index if not exists gear_entity_idx on public.gear (entity_slug);
create index if not exists gear_type_idx on public.gear (gear_type);

/* ══════════════════════════════════════════════════════════════════════
   PACKAGES — a priced thing with a duration but no departure
   ══════════════════════════════════════════════════════════════════════ */
--
-- A photo session, a spa treatment, a surf lesson, a guided walk.

create table if not exists public.packages (
  id              uuid primary key default gen_random_uuid(),
  entity_slug     text not null,

  name            text,
  package_type    text,            -- family | engagement | wedding | maternity | newborn | senior
                                   -- headshot | event | real_estate | massage | facial | lesson
  length_minutes  integer,
  max_people      integer,
  deliverables    integer,         -- edited images, prints, whatever is counted
  turnaround_days integer,
  outfit_changes  integer,
  locations_count integer,

  price           numeric(10,2),
  deposit         numeric(10,2),

  is_active       boolean default true,
  sort_order      integer default 0,
  notes           text
);

create index if not exists packages_entity_idx on public.packages (entity_slug);
create index if not exists packages_search_idx on public.packages (package_type, max_people);

/* ══════════════════════════════════════════════════════════════════════
   SPACES — anything with a capacity you book by the hour or the day
   ══════════════════════════════════════════════════════════════════════ */
--
-- A ballroom, a beach deck, a restaurant's private dining room, a conference
-- room in a hotel. A restaurant is not a "venue", and it can still have one.

create table if not exists public.spaces (
  id                 uuid primary key default gen_random_uuid(),
  entity_slug        text not null,

  name               text,
  space_type         text,         -- ballroom | deck | lawn | beach | private_dining
                                   -- conference | whole_venue | patio
  standing_capacity  integer,
  seated_capacity    integer,
  square_feet        integer,
  outdoor            boolean,
  beachfront         boolean,

  catering_inhouse   boolean,
  outside_catering   boolean,
  bar_service        boolean,
  av_equipment       boolean,
  tables_chairs      boolean,
  dance_floor        boolean,

  hourly_rate        numeric(10,2),
  day_rate           numeric(10,2),
  minimum_spend      numeric(10,2),

  is_active          boolean default true,
  sort_order         integer default 0,
  notes              text
);

create index if not exists spaces_entity_idx on public.spaces (entity_slug);
create index if not exists spaces_capacity_idx on public.spaces (seated_capacity);

create table if not exists public.space_event_types (
  space_id    uuid not null references public.spaces(id) on delete cascade,
  event_type  text not null,       -- wedding | reception | corporate | birthday | conference | concert
  primary key (space_id, event_type)
);

/* ══════════════════════════════════════════════════════════════════════
   CATALOGS — amenities, species, activities. Joined, never free text.
   ══════════════════════════════════════════════════════════════════════ */
--
-- One amenity catalog for everything. Wifi is wifi whether it is in a condo,
-- on a boat or in a ballroom. `category` is a plain grouping column for the
-- UI — it does not need a table of its own and it does not scope anything.

create table if not exists public.amenities (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  label       text not null,
  category    text,                -- bathroom | bedroom | kitchen | outdoor | vessel | …
  sort_order  integer default 0,
  is_active   boolean default true
);

create index if not exists amenities_category_idx on public.amenities (category);

-- One join per thing that can have amenities. Any slug can use any of them.
create table if not exists public.entity_amenities (
  entity_slug text not null,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  primary key (entity_slug, amenity_id)
);

create table if not exists public.unit_amenities (
  unit_id     uuid not null references public.units(id) on delete cascade,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  primary key (unit_id, amenity_id)
);

create table if not exists public.vessel_amenities (
  vessel_id     uuid not null references public.vessels(id) on delete cascade,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  primary key (vessel_id, amenity_id)
);

create table if not exists public.space_amenities (
  space_id    uuid not null references public.spaces(id) on delete cascade,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  primary key (space_id, amenity_id)
);

create index if not exists entity_amenities_amenity_idx on public.entity_amenities (amenity_id);
create index if not exists unit_amenities_amenity_idx on public.unit_amenities (amenity_id);
create index if not exists boat_amenities_amenity_idx on public.vessel_amenities (amenity_id);

-- What they fish for. A catalog and a join, so "who targets red snapper" is an
-- index lookup rather than a LIKE over a comma-separated string.
create table if not exists public.species (
  id           uuid primary key default gen_random_uuid(),
  key          text unique not null,
  label        text not null,
  category     text,               -- inshore | offshore | reef | pelagic
  season_start integer,            -- month, 1-12
  season_end   integer,
  sort_order   integer default 0
);

create table if not exists public.entity_species (
  entity_slug text not null,
  species_id  uuid not null references public.species(id) on delete cascade,
  primary key (entity_slug, species_id)
);

create index if not exists entity_species_species_idx on public.entity_species (species_id);

-- What they offer doing. Same pattern.
create table if not exists public.activities (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  label       text not null,
  category    text,
  sort_order  integer default 0
);

create table if not exists public.entity_activities (
  entity_slug      text not null,
  activity_id      uuid not null references public.activities(id) on delete cascade,
  price            numeric(10,2),
  duration_minutes integer,
  primary key (entity_slug, activity_id)
);

create index if not exists entity_activities_activity_idx on public.entity_activities (activity_id);
