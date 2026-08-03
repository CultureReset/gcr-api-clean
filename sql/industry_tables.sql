-- ============================================================
-- INDUSTRY TABLES — real columns, one table per real thing
-- ============================================================
--
-- What each kind of business would store if you rebuilt its platform from
-- scratch. A condo unit gets a `stay_units` row with a `bedrooms` integer, not
-- a key/value pair and not a JSON blob. Every field below is a real, typed,
-- indexable column, and every list is a real join table.
--
-- The shape follows the real platforms — Airbnb and VRBO for stays, FareHarbor
-- and Peek Pro for charters and cruises — so a business that already has a
-- listing can transcribe it rather than invent answers.
--
-- ── How this maps onto `entity` ────────────────────────────────────────
--
-- `entity` stays the single directory record: name, slug, phone, hours, hero
-- image, the things every business has. These tables hang off it by slug and
-- hold only what is specific to an industry.
--
-- A condo complex is one `entity` and each unit is its own `entity` with
-- `parent_entity_slug` pointing at the building. That separation already
-- exists, and it is the right one: the building has a pool and a lazy river,
-- the unit has two bedrooms. So `stay_properties` keys off the building's slug
-- and `stay_units` off each unit's own slug.
--
--   psql "$DATABASE_URL" -f sql/industry_tables.sql
--
-- Re-runnable. Creates nothing that already exists, drops nothing.

/* ══════════════════════════════════════════════════════════════════════
   AMENITIES — one catalog, grouped into sections, joined where used
   ══════════════════════════════════════════════════════════════════════ */
--
-- Airbnb groups amenities into sections — Bathroom, Kitchen and dining,
-- Outdoor, Parking and facilities — and a guest filters within them. Same
-- here: `amenity_sections` is the grouping, `amenities` is the catalog, and
-- each thing that can HAVE amenities gets its own join table. One catalog
-- rather than one list per industry, because "wifi" is the same amenity
-- whether it is in a condo or on a boat.

create table if not exists public.amenity_sections (
  key          text primary key,
  label        text not null,
  sort_order   integer default 0
);

create table if not exists public.amenities (
  id           uuid primary key default gen_random_uuid(),
  key          text unique not null,
  label        text not null,
  section_key  text references public.amenity_sections(key) on delete set null,
  icon         text,
  sort_order   integer default 0,
  is_active    boolean default true
);

create index if not exists amenities_section_idx on public.amenities (section_key);

/* ══════════════════════════════════════════════════════════════════════
   STAYS — condos, vacation rentals, hotels, resorts
   ══════════════════════════════════════════════════════════════════════ */

-- The building. One row per complex/hotel entity.
create table if not exists public.stay_properties (
  id                     uuid primary key default gen_random_uuid(),
  entity_slug            text unique not null,

  property_type          text,            -- condo_complex | hotel | resort | house | duplex
  total_units            integer,
  floors                 integer,
  year_built             integer,
  renovated_year         integer,

  beachfront             boolean default false,
  distance_to_beach_ft   integer,
  distance_to_airport_mi numeric(6,1),

  front_desk_24h         boolean default false,
  housekeeping_daily     boolean default false,
  security_onsite        boolean default false,
  gated                  boolean default false,

  check_in_time          time,
  check_out_time         time,
  parking_type           text,            -- covered | surface | garage | street | none
  parking_spaces_per_unit numeric(3,1),
  parking_notes          text,

  hoa_name               text,
  management_company     text,

  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

create table if not exists public.stay_property_amenities (
  property_id  uuid not null references public.stay_properties(id) on delete cascade,
  amenity_id   uuid not null references public.amenities(id) on delete cascade,
  notes        text,
  primary key (property_id, amenity_id)
);

-- The unit. One row per bookable unit — this is what a guest searches.
create table if not exists public.stay_units (
  id                 uuid primary key default gen_random_uuid(),
  entity_slug        text unique not null,
  property_id        uuid references public.stay_properties(id) on delete set null,

  unit_number        text,
  floor              integer,
  unit_type          text,                -- condo | suite | studio | villa | room

  -- The four every search starts with.
  bedrooms           integer,
  bathrooms          numeric(3,1),        -- 2.5 is a real answer
  sleeps             integer,
  square_feet        integer,

  half_baths         integer,
  view               text,                -- gulf_front | gulf_view | side_gulf | bay | pool | parking | none
  balcony            boolean default false,
  balcony_count      integer,
  ground_floor       boolean default false,
  elevator_access    boolean default false,
  wheelchair_accessible boolean default false,

  pet_friendly       boolean default false,
  pet_fee            numeric(10,2),
  max_pets           integer,
  smoking_allowed    boolean default false,
  events_allowed     boolean default false,

  min_nights         integer,
  max_nights         integer,
  max_guests         integer,
  min_age_to_book    integer,
  check_in_time      time,
  check_out_time     time,
  cancellation_policy text,               -- flexible | moderate | strict | non_refundable

  nightly_rate       numeric(10,2),
  weekly_rate        numeric(10,2),
  monthly_rate       numeric(10,2),
  cleaning_fee       numeric(10,2),
  pet_deposit        numeric(10,2),
  security_deposit   numeric(10,2),
  tax_rate           numeric(5,2),

  description        text,
  house_rules        text,

  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- The four columns every stay search filters on, in one index.
create index if not exists stay_units_search_idx
  on public.stay_units (bedrooms, bathrooms, sleeps);
create index if not exists stay_units_property_idx on public.stay_units (property_id);
create index if not exists stay_units_view_idx on public.stay_units (view);
create index if not exists stay_units_rate_idx on public.stay_units (nightly_rate);

create table if not exists public.stay_unit_amenities (
  unit_id     uuid not null references public.stay_units(id) on delete cascade,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  notes       text,
  primary key (unit_id, amenity_id)
);

-- "Bedroom 1: one king. Living room: one sofa bed." A real table, because a
-- guest searching for somewhere to put four kids is asking about this.
create table if not exists public.stay_unit_beds (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references public.stay_units(id) on delete cascade,
  room_name   text,                       -- Bedroom 1 | Living room | Bunk room
  room_type   text,                       -- bedroom | living | loft | den
  bed_type    text not null,              -- king | queen | full | twin | bunk | sofa_bed | murphy
  quantity    integer default 1,
  sort_order  integer default 0
);

create index if not exists stay_unit_beds_unit_idx on public.stay_unit_beds (unit_id);

/* ══════════════════════════════════════════════════════════════════════
   FISHING CHARTERS
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.charter_operators (
  id                    uuid primary key default gen_random_uuid(),
  entity_slug           text unique not null,

  marina                text,
  dock_number           text,
  captains              integer,
  deckhands             integer,
  uscg_licensed         boolean default false,
  insured               boolean default false,
  years_operating       integer,

  license_included      boolean default false,
  gear_included         boolean default false,
  bait_included         boolean default false,
  ice_included          boolean default false,
  cleaning_included     boolean default false,
  cooler_provided       boolean default false,
  byob_allowed          boolean default false,

  deposit_percent       numeric(5,2),
  cancellation_policy   text,
  weather_policy        text,

  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- The boat. "A 45ft boat with AC and a head" is a question about this row.
create table if not exists public.charter_boats (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text,                 -- set when the boat is its own listing
  operator_id       uuid not null references public.charter_operators(id) on delete cascade,

  boat_name         text,
  make              text,
  model             text,
  year              integer,
  length_ft         numeric(5,1),
  beam_ft           numeric(5,1),
  max_anglers       integer,
  crew_size         integer,
  engines           integer,
  engine_hp         integer,
  cruising_speed_kn numeric(5,1),
  fuel_capacity_gal integer,
  max_range_mi      integer,

  has_head          boolean default false,   -- the first thing anyone asks
  has_ac            boolean default false,   -- the second
  has_cabin         boolean default false,
  has_shade         boolean default false,
  has_galley        boolean default false,
  has_livewell      boolean default false,
  has_fishfinder    boolean default false,
  has_radar         boolean default false,
  has_outriggers    boolean default false,
  has_fighting_chair boolean default false,
  wheelchair_accessible boolean default false,

  is_active         boolean default true,
  sort_order        integer default 0,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists charter_boats_operator_idx on public.charter_boats (operator_id);
create index if not exists charter_boats_search_idx on public.charter_boats (length_ft, max_anglers);

create table if not exists public.charter_boat_amenities (
  boat_id     uuid not null references public.charter_boats(id) on delete cascade,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  primary key (boat_id, amenity_id)
);

-- A trip is what a guest actually books: "8 hour offshore, up to 6, $1,800".
create table if not exists public.charter_trips (
  id                uuid primary key default gen_random_uuid(),
  operator_id       uuid not null references public.charter_operators(id) on delete cascade,
  boat_id           uuid references public.charter_boats(id) on delete set null,

  name              text,
  trip_type         text,                 -- inshore | nearshore | offshore | deep_sea | bottom | trolling | shark | night
  duration_hours    numeric(4,1),
  max_anglers       integer,
  min_anglers       integer,
  departure_time    time,
  return_time       time,

  price             numeric(10,2),
  price_unit        text default 'trip',  -- trip | person
  extra_person_fee  numeric(10,2),

  is_private        boolean default true,
  is_active         boolean default true,
  sort_order        integer default 0,
  notes             text
);

create index if not exists charter_trips_operator_idx on public.charter_trips (operator_id);
create index if not exists charter_trips_search_idx on public.charter_trips (duration_hours, max_anglers);

-- Species is a catalog, not free text, so "who targets red snapper" is a join
-- rather than a LIKE over a comma-separated string.
create table if not exists public.fish_species (
  id           uuid primary key default gen_random_uuid(),
  key          text unique not null,
  label        text not null,
  category     text,                      -- inshore | offshore | reef | pelagic
  season_start integer,                   -- month, 1-12
  season_end   integer,
  sort_order   integer default 0
);

create table if not exists public.charter_species (
  operator_id  uuid not null references public.charter_operators(id) on delete cascade,
  species_id   uuid not null references public.fish_species(id) on delete cascade,
  primary key (operator_id, species_id)
);

/* ══════════════════════════════════════════════════════════════════════
   CRUISES & TOURS
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.cruise_operators (
  id                 uuid primary key default gen_random_uuid(),
  entity_slug        text unique not null,
  departure_point    text,
  dock_number        text,
  min_age            integer,
  alcohol_allowed    boolean default false,
  byob_allowed       boolean default false,
  pets_allowed       boolean default false,
  food_available     boolean default false,
  adult_price        numeric(10,2),
  child_price        numeric(10,2),
  senior_price       numeric(10,2),
  infant_free_under  integer,
  cancellation_policy text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table if not exists public.cruise_vessels (
  id                    uuid primary key default gen_random_uuid(),
  entity_slug           text,
  operator_id           uuid not null references public.cruise_operators(id) on delete cascade,
  vessel_name           text,
  vessel_type           text,             -- catamaran | pontoon | sailboat | yacht | speedboat
  length_ft             numeric(5,1),
  passenger_capacity    integer,
  decks                 integer,
  has_restroom          boolean default false,
  has_bar               boolean default false,
  covered_seating       boolean default false,
  has_sound_system      boolean default false,
  wheelchair_accessible boolean default false,
  is_active             boolean default true
);

create index if not exists cruise_vessels_operator_idx on public.cruise_vessels (operator_id);
create index if not exists cruise_vessels_capacity_idx on public.cruise_vessels (passenger_capacity);

create table if not exists public.cruise_trips (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.cruise_operators(id) on delete cascade,
  vessel_id          uuid references public.cruise_vessels(id) on delete set null,
  name               text,
  cruise_type        text,                -- dolphin | sunset | sightseeing | dinner | party | private | fireworks
  duration_hours     numeric(4,1),
  departure_time     time,
  narrated           boolean default false,
  dolphin_guarantee  boolean default false,
  adult_price        numeric(10,2),
  child_price        numeric(10,2),
  max_passengers     integer,
  is_active          boolean default true,
  sort_order         integer default 0
);

create index if not exists cruise_trips_operator_idx on public.cruise_trips (operator_id);

/* ══════════════════════════════════════════════════════════════════════
   BOAT & GEAR RENTALS
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.rental_operators (
  id                  uuid primary key default gen_random_uuid(),
  entity_slug         text unique not null,
  pickup_location     text,
  license_required    boolean default false,
  min_age_to_rent     integer,
  captain_available   boolean default false,
  captain_rate        numeric(10,2),
  delivery_available  boolean default false,
  delivery_fee        numeric(10,2),
  fuel_included       boolean default false,
  security_deposit    numeric(10,2),
  cancellation_policy text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table if not exists public.rental_items (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text,
  operator_id       uuid not null references public.rental_operators(id) on delete cascade,
  rental_type       text not null,        -- pontoon | deck_boat | center_console | jet_ski | kayak | paddleboard | golf_cart | bike
  name              text,
  make              text,
  model             text,
  year              integer,
  length_ft         numeric(5,1),
  capacity          integer,
  horsepower        integer,
  has_bimini        boolean default false,
  has_stereo        boolean default false,
  has_cooler        boolean default false,
  has_restroom      boolean default false,
  has_ladder        boolean default false,
  hourly_rate       numeric(10,2),
  half_day_rate     numeric(10,2),
  full_day_rate     numeric(10,2),
  weekly_rate       numeric(10,2),
  quantity          integer default 1,    -- five identical pontoons is one row, quantity 5
  is_active         boolean default true
);

create index if not exists rental_items_operator_idx on public.rental_items (operator_id);
create index if not exists rental_items_search_idx on public.rental_items (rental_type, capacity);

/* ══════════════════════════════════════════════════════════════════════
   PARASAILING & WATERSPORTS
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.watersport_operators (
  id                   uuid primary key default gen_random_uuid(),
  entity_slug          text unique not null,
  launch_location      text,
  max_flight_height_ft integer,
  riders_per_flight    integer,
  min_weight_lb        integer,
  max_weight_lb        integer,
  min_age              integer,
  instruction_included boolean default false,
  gear_included        boolean default false,
  photos_included      boolean default false,
  photos_price         numeric(10,2),
  observers_allowed    boolean default false,
  observer_price       numeric(10,2),
  price_per_person     numeric(10,2),
  cancellation_policy  text,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create table if not exists public.watersport_activities (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  label       text not null,
  sort_order  integer default 0
);

create table if not exists public.watersport_operator_activities (
  operator_id       uuid not null references public.watersport_operators(id) on delete cascade,
  activity_id       uuid not null references public.watersport_activities(id) on delete cascade,
  price             numeric(10,2),
  duration_minutes  integer,
  primary key (operator_id, activity_id)
);

/* ══════════════════════════════════════════════════════════════════════
   PHOTOGRAPHERS & SESSIONS
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.session_providers (
  id                  uuid primary key default gen_random_uuid(),
  entity_slug         text unique not null,
  travels_to_you      boolean default false,
  travel_radius_mi    integer,
  travel_fee          numeric(10,2),
  studio_available    boolean default false,
  prints_available    boolean default false,
  digital_included    boolean default false,
  raw_available       boolean default false,
  second_shooter      boolean default false,
  drone_licensed      boolean default false,
  deposit             numeric(10,2),
  cancellation_policy text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table if not exists public.session_packages (
  id               uuid primary key default gen_random_uuid(),
  provider_id      uuid not null references public.session_providers(id) on delete cascade,
  name             text,
  session_type     text,                  -- family | engagement | wedding | maternity | newborn | senior | headshot | event
  length_minutes   integer,
  edited_images    integer,
  turnaround_days  integer,
  max_people       integer,
  outfit_changes   integer,
  locations_count  integer,
  price            numeric(10,2),
  is_active        boolean default true,
  sort_order       integer default 0
);

create index if not exists session_packages_provider_idx on public.session_packages (provider_id);
create index if not exists session_packages_search_idx on public.session_packages (session_type, max_people);

create table if not exists public.session_locations (
  provider_id   uuid not null references public.session_providers(id) on delete cascade,
  location_type text not null,            -- beach | studio | venue | home | travel
  primary key (provider_id, location_type)
);

/* ══════════════════════════════════════════════════════════════════════
   VENUES & EVENTS
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.venue_spaces (
  id                 uuid primary key default gen_random_uuid(),
  entity_slug        text,
  venue_entity_slug  text not null,
  name               text,
  space_type         text,                -- ballroom | deck | lawn | beach | private_room
  standing_capacity  integer,
  seated_capacity    integer,
  square_feet        integer,
  outdoor            boolean default false,
  beachfront         boolean default false,
  catering_inhouse   boolean default false,
  outside_catering   boolean default false,
  bar_service        boolean default false,
  av_equipment       boolean default false,
  tables_chairs      boolean default false,
  dance_floor        boolean default false,
  parking_spaces     integer,
  hourly_rate        numeric(10,2),
  day_rate           numeric(10,2),
  minimum_spend      numeric(10,2),
  is_active          boolean default true
);

create index if not exists venue_spaces_entity_idx on public.venue_spaces (venue_entity_slug);
create index if not exists venue_spaces_capacity_idx on public.venue_spaces (seated_capacity);

create table if not exists public.venue_space_event_types (
  space_id    uuid not null references public.venue_spaces(id) on delete cascade,
  event_type  text not null,              -- wedding | reception | corporate | birthday | conference | concert
  primary key (space_id, event_type)
);

create table if not exists public.venue_space_amenities (
  space_id    uuid not null references public.venue_spaces(id) on delete cascade,
  amenity_id  uuid not null references public.amenities(id) on delete cascade,
  primary key (space_id, amenity_id)
);
