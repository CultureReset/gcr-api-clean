-- ============================================================================
-- GCR v2 — 002_hours.sql  (Hours module pack)
-- Named hour sets (business, kitchen, bar, spa, fuel dock, service dept),
-- day-of-week periods (supports split shifts), and date-specific exceptions.
-- Beside production in schema `v2`. Non-destructive.
-- ============================================================================

-- entity_hour_sets — a named schedule. Replaces primary/secondary hour split.
create table if not exists v2.entity_hour_sets (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  set_key    text not null,                   -- business | kitchen | bar | spa | fuel_dock | service | pool ...
  label      text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (entity_id, set_key)
);
create index if not exists idx_v2_hour_sets_entity on v2.entity_hour_sets (entity_id);

-- entity_hour_periods — opening periods per set. Multiple rows/day = split shift.
create table if not exists v2.entity_hour_periods (
  id          uuid primary key default gen_random_uuid(),
  hour_set_id uuid not null references v2.entity_hour_sets(id) on delete cascade,
  day_of_week integer not null,               -- 0=Sun .. 6=Sat
  opens_at    time,
  closes_at   time,
  is_closed   boolean not null default false,
  created_at  timestamptz not null default now(),
  check (day_of_week between 0 and 6)
);
create index if not exists idx_v2_hour_periods_set on v2.entity_hour_periods (hour_set_id, day_of_week);

-- entity_hour_exceptions — holiday/temporary/seasonal/date overrides.
create table if not exists v2.entity_hour_exceptions (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  hour_set_id  uuid references v2.entity_hour_sets(id) on delete cascade,
  exception_date date not null,
  opens_at     time,
  closes_at    time,
  is_closed    boolean not null default false,
  reason       text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_hour_exceptions_entity on v2.entity_hour_exceptions (entity_id, exception_date);
