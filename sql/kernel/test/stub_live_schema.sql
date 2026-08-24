-- ============================================================================
-- The live tables the kernel migrations build on, and nothing else.
-- ============================================================================
--
-- This is NOT a migration and it never runs against a real database. It exists
-- so scripts/test-kernel-sql.sh can apply sql/kernel/*.sql to a throwaway
-- Postgres and find out whether they work, instead of finding out on
-- production the way sql/capability_tables.sql did. See HANDOFF.md.
--
-- Column definitions here are copied from the live schema of Supabase project
-- "cyber check" (mkepugvdlktfsossumox), verified 2026-08-24. Only the columns
-- and constraints the kernel actually depends on are reproduced — `entity` has
-- around 170 columns live and needs six of them here. If a migration starts
-- depending on a seventh, add it here and the test keeps its meaning.
-- ============================================================================

create extension if not exists pgcrypto;

create table entity (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text,
  parent_entity_slug text,
  is_parent          boolean,
  depth              smallint,
  ical_token         text unique
);

create table entity_owners (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  entity_id   uuid,
  entity_slug text,
  role        text,
  created_at  timestamptz default now()
);

create table module_catalog (
  module_key text primary key,
  name       text,
  tagline    text,
  category   text,
  icon       text,
  is_core    boolean,
  sort_order integer,
  active     boolean,
  created_at timestamptz default now()
);

create table permission_catalog (
  permission_key text primary key,
  description    text,
  category       text,
  is_sensitive   boolean,
  created_at     timestamptz default now()
);

-- The connections CATALOG. 1,070 rows live: every tool a business can connect.
create table platform_connections (
  tool_id        text primary key,
  name           text not null,
  logo           text,
  icon           text,
  cat            text,
  description    text,
  provider       text not null,
  sort_order     integer not null default 0,
  is_featured    boolean not null default false,
  is_active      boolean not null default true,
  composio_app   text,
  auth_config_id text,
  auth_scheme    text,
  categories     jsonb not null default '[]'::jsonb,
  industries     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);

-- The connections INSTALL table. 0 rows live.
create table entity_connections (
  id           uuid primary key default gen_random_uuid(),
  entity_slug  text not null,
  tool_id      text not null,
  status       text,
  account_ref  text,
  connected_at timestamptz,
  created_at   timestamptz default now(),
  unique (entity_slug, tool_id)
);

-- 37,847 rows live, written from a preset list rather than by anyone
-- installing anything. See the note in 007.
create table entity_modules (
  id          uuid primary key default gen_random_uuid(),
  entity_slug text not null,
  module_key  text not null,
  enabled     boolean,
  settings    jsonb,
  sort_order  integer,
  unique (entity_slug, module_key)
);

create table platform_admins (
  user_id    uuid primary key,
  note       text,
  created_at timestamptz default now()
);

-- ── Fixture data ────────────────────────────────────────────────────────────
-- Enough shape for the assertions to have something to bite on, including the
-- two cases that matter: an entity_modules row whose module_key is not in
-- module_catalog, and one whose `enabled` is false.
insert into entity (slug, name) values
  ('the-blue-crab', 'The Blue Crab'),
  ('dockside-bar',  'Dockside Bar');

insert into module_catalog (module_key, name) values
  ('menu', 'Menu'), ('hours', 'Hours'), ('rooms', 'Rooms');

insert into permission_catalog (permission_key, description) values
  ('menu.read', 'Read menu'), ('menu.write', 'Edit menu');

insert into platform_connections (tool_id, name, provider) values
  ('google_business', 'Google Business Profile', 'composio'),
  ('instagram',       'Instagram',               'composio');

insert into entity_modules (entity_slug, module_key, enabled, settings, sort_order) values
  ('the-blue-crab', 'menu',  true,  '{"layout":"grid"}'::jsonb, 10),
  ('the-blue-crab', 'hours', true,  null, 20),
  ('dockside-bar',  'menu',  false, null, 10),
  ('dockside-bar',  'orphaned_module_key', true, null, 30);
