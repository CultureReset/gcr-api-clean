-- ============================================================================
-- GCR v2 — 001_core.sql  (Core module pack)
-- ----------------------------------------------------------------------------
-- Builds the canonical Core tables BESIDE production in schema `v2`.
-- Safe: creates only new objects in a new schema. Does NOT touch public.*.
-- Apply on a Supabase development branch first (plan Phase 2).
--
-- Canonical identity: v2.entities.id (uuid) internal, v2.entities.slug public.
-- Every satellite carries entity_id (true FK). entity_slug is denormalized on
-- rows the live code still reads by slug, kept in sync by trigger below.
-- ============================================================================

create schema if not exists v2;
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- entities — one canonical business/venue/property/artist/operator.
-- Deliberately LEAN. The live public.entity has 178 columns; modular data
-- (contacts, links, social, hours, media, address) moves to its own tables.
-- ----------------------------------------------------------------------------
create table if not exists v2.entities (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  name             text not null,
  entity_type      text,                       -- restaurant, condo, charter, artist, ...
  entity_subtype   text,                       -- fk-ish to subtype_taxonomy.subtype_key
  status           text not null default 'active',   -- active | hidden | archived
  featured         boolean not null default false,
  icon             text,
  subtitle         text,
  description      text,
  primary_media_id uuid,                        -- fk added in 003_content.sql (media_assets)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_v2_entities_type    on v2.entities (entity_type, entity_subtype);
create index if not exists idx_v2_entities_status  on v2.entities (status);

-- Helper: keep updated_at fresh
create or replace function v2.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_v2_entities_touch on v2.entities;
create trigger trg_v2_entities_touch before update on v2.entities
  for each row execute function v2.touch_updated_at();

-- ----------------------------------------------------------------------------
-- entity_aliases — old names, DBAs, misspellings, alternate slugs.
-- Required for AI entity resolution + safe duplicate merges.
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_aliases (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  alias_type text not null,                    -- old_name | dba | misspelling | alt_slug | google_name
  value      text not null,
  created_at timestamptz not null default now(),
  unique (entity_id, alias_type, value)
);
create index if not exists idx_v2_aliases_value on v2.entity_aliases (lower(value));

-- ----------------------------------------------------------------------------
-- entity_relations — parent/child/located_at/managed_by/operated_by/departs_from.
-- (public.entity_relations is empty; hubs, marinas, complexes, managers need it.)
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_relations (
  id               uuid primary key default gen_random_uuid(),
  parent_entity_id uuid not null references v2.entities(id) on delete cascade,
  child_entity_id  uuid not null references v2.entities(id) on delete cascade,
  relation_type    text not null,             -- parent|child|located_at|managed_by|operated_by|departs_from|sister
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  unique (parent_entity_id, child_entity_id, relation_type),
  check (parent_entity_id <> child_entity_id)
);
create index if not exists idx_v2_relations_child on v2.entity_relations (child_entity_id);

-- ----------------------------------------------------------------------------
-- entity_locations — physical/mailing/departure/meeting/office (>=1 per entity).
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_locations (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references v2.entities(id) on delete cascade,
  location_type  text not null default 'physical',  -- physical|mailing|departure|meeting|office
  label          text,
  address_line_1 text,
  address_line_2 text,
  city           text,
  state          text,
  zip            text,
  latitude       numeric,
  longitude      numeric,
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists idx_v2_locations_entity on v2.entity_locations (entity_id);

-- ----------------------------------------------------------------------------
-- entity_service_areas — cities/ZIPs/polygons/travel-fee zones for mobile biz.
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_service_areas (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  area_type  text not null,                   -- city | zip | polygon | radius
  value      text not null,
  travel_fee numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_service_areas_entity on v2.entity_service_areas (entity_id);

-- ----------------------------------------------------------------------------
-- entity_contacts — public phone/email/department contacts (off the master row).
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_contacts (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  contact_type text not null,                 -- phone | email | department
  label        text,
  value        text not null,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_contacts_entity on v2.entity_contacts (entity_id);

-- ----------------------------------------------------------------------------
-- entity_links — website/menu/order/reservation/booking/tickets/store/directions.
-- Replaces the URL columns on entity + order_links/stay_links/shop_links.
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_links (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  link_type  text not null,                   -- website|menu|order|reservation|booking|tickets|store|gift_card|directions
  url        text not null,
  label      text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_links_entity on v2.entity_links (entity_id);

-- ----------------------------------------------------------------------------
-- entity_social_profiles — public social URLs/usernames (OAuth tokens elsewhere).
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_social_profiles (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  platform   text not null,                   -- instagram|facebook|tiktok|twitter|youtube
  url        text,
  username   text,
  created_at timestamptz not null default now(),
  unique (entity_id, platform)
);

-- ----------------------------------------------------------------------------
-- entity_tags — searchable categories/amenities/features/audience.
-- (public.entity_tags is bloated; dedupe on migrate.)
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_tags (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  tag_name     text not null,
  tag_category text,
  created_at   timestamptz not null default now(),
  unique (entity_id, tag_name, tag_category)
);
create index if not exists idx_v2_tags_name on v2.entity_tags (lower(tag_name));

-- ----------------------------------------------------------------------------
-- entity_attributes — typed long-tail facts not worth a dedicated table.
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_attributes (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  key          text not null,
  label        text,
  value_text   text,
  value_number numeric,
  value_bool   boolean,
  unit         text,
  visibility   text not null default 'public', -- public | private | internal
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_attributes_entity on v2.entity_attributes (entity_id, key);

-- ----------------------------------------------------------------------------
-- entity_sources — field-level provenance/confidence/verification.
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_sources (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  field_path  text not null,                  -- e.g. 'description', 'contacts[phone].value'
  source_name text,
  source_url  text,
  confidence  numeric,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_sources_entity on v2.entity_sources (entity_id);

-- ----------------------------------------------------------------------------
-- module_catalog — available modules + which tables back them + type defaults.
-- ----------------------------------------------------------------------------
create table if not exists v2.module_catalog (
  module_key      text primary key,
  name            text not null,
  description     text,
  required_tables text[] not null default '{}',
  default_for     text[] not null default '{}', -- business types that auto-enable it
  created_at      timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- entity_modules — which modules an entity has enabled (+ settings).
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_modules (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  module_key text not null references v2.module_catalog(module_key),
  enabled    boolean not null default true,
  settings   jsonb not null default '{}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (entity_id, module_key)
);

-- ----------------------------------------------------------------------------
-- entity_module_status — completeness/row counts/validation (prevents blank tabs).
-- The display layer shows a module only when is_complete = true.
-- ----------------------------------------------------------------------------
create table if not exists v2.entity_module_status (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references v2.entities(id) on delete cascade,
  module_key        text not null references v2.module_catalog(module_key),
  is_complete       boolean not null default false,
  row_count         integer not null default 0,
  validation_errors jsonb not null default '[]',
  last_validated_at timestamptz,
  created_at        timestamptz not null default now(),
  unique (entity_id, module_key)
);

-- ============================================================================
-- End 001_core.sql
-- ============================================================================
