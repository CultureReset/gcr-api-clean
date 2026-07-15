-- ============================================================================
-- GCR v2 — 005_people.sql  (People module pack)
-- Canonical staff/artist-member/instructor/captain/stylist rows and their
-- roles at a business. Replaces entity_team_members/business_staff/staff.
-- (person_offerings lives in 006_commerce.sql, after offerings exist.)
-- ============================================================================

create table if not exists v2.people (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null,
  bio        text,
  media_id   uuid references v2.media_assets(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists v2.entity_people (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  person_id  uuid not null references v2.people(id) on delete cascade,
  role       text,                            -- owner | captain | chef | stylist | instructor | staff ...
  title      text,
  bio        text,
  visibility text not null default 'public',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (entity_id, person_id, role)
);
create index if not exists idx_v2_entity_people_entity on v2.entity_people (entity_id);
