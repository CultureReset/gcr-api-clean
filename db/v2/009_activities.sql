-- ============================================================================
-- GCR v2 — 009_activities.sql  (Activities module pack)
-- Tour/activity/charter operational facts, meeting points, fish species.
-- ============================================================================

create table if not exists v2.activity_details (
  entity_id       uuid primary key references v2.entities(id) on delete cascade,
  activity_type   text,                        -- fishing_charter | dolphin_cruise | boat_tour | jet_ski | eco_tour
  duration_text   text,
  min_age         integer,
  max_capacity    integer,
  what_to_expect  text,
  cancellation_policy text,
  created_at      timestamptz not null default now()
);

create table if not exists v2.meeting_points (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  offering_id uuid references v2.offerings(id) on delete cascade,
  label       text,
  instructions text,
  address     text,
  latitude    numeric,
  longitude   numeric,
  created_at  timestamptz not null default now()
);

create table if not exists v2.fish_species (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid references v2.entities(id) on delete cascade,
  offering_id uuid references v2.offerings(id) on delete cascade,
  name        text not null,
  season      text,
  method      text,
  regulation  text
);
