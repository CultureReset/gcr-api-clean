-- ============================================================================
-- GCR v2 — 008_lodging.sql  (Lodging module pack)
-- Hotel/resort/condo-complex property details and room types.
-- Merges accommodation_details/property_details.
-- ============================================================================

create table if not exists v2.property_details (
  entity_id      uuid primary key references v2.entities(id) on delete cascade,
  property_type  text,                         -- hotel | resort | condo_complex | vacation_rental | motel
  total_units    integer,
  floors         integer,
  year_built     integer,
  check_in_time  time,
  check_out_time time,
  pet_friendly   boolean,
  pool           boolean,
  hot_tub        boolean,
  beach_access   boolean,
  parking        boolean,
  wifi           boolean,
  min_stay_nights integer,
  description    text,
  created_at     timestamptz not null default now()
);

create table if not exists v2.room_types (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  name        text not null,                  -- Studio | 1BR Gulf View | 3BR Penthouse
  description text,
  max_guests  integer,
  base_rate   numeric,
  media_id    uuid references v2.media_assets(id) on delete set null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_room_types_entity on v2.room_types (entity_id);

create table if not exists v2.room_type_beds (
  id           uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references v2.room_types(id) on delete cascade,
  bed_type     text not null,                 -- king | queen | full | twin | sofa | bunk
  quantity     integer not null default 1
);

create table if not exists v2.room_type_amenities (
  id           uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references v2.room_types(id) on delete cascade,
  amenity      text not null,
  category     text
);
