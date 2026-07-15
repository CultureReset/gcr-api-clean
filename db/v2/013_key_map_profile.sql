-- ============================================================================
-- GCR v2 — 013_key_map_profile.sql  (Identity resolution + one profile contract)
-- The two things that make "the same business displays the same everywhere" true
-- and make any reader (web, QR, rental, service, tourist AI, voice AI) trivial:
--   1. entity_key_map  — resolve ANY historical key to the canonical entity_id.
--   2. entity_profile_cache — one compiled EntityProfileV1 JSON per business,
--      assembled from every v2 table, that every route serves.
-- No AI runtime is built here: the AI just reads these tables + the profile.
-- ============================================================================

-- entity_key_map — resolves slug / entity_id / site_id / business_id /
-- Google place id / old slugs to the one canonical entity. Plan Phase 4.
create table if not exists v2.entity_key_map (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  key_type     text not null,                 -- slug | legacy_slug | site_id | business_id | google_place_id | entity_uuid_v1
  key_value    text not null,
  created_at   timestamptz not null default now(),
  unique (key_type, key_value)
);
create index if not exists idx_v2_key_map_entity on v2.entity_key_map (entity_id);

-- entity_profile_cache — the single compiled, validated profile every reader uses.
-- profile jsonb is the EntityProfileV1 assembled from all v2 tables for the entity.
create table if not exists v2.entity_profile_cache (
  entity_id    uuid primary key references v2.entities(id) on delete cascade,
  slug         text not null,
  profile      jsonb not null,                -- the full EntityProfileV1 document
  profile_version text not null default 'v1',
  compiled_at  timestamptz not null default now(),
  is_valid     boolean not null default true
);
create index if not exists idx_v2_profile_cache_slug on v2.entity_profile_cache (slug);

-- entity_profile_refresh_queue — recompile after any canonical table changes.
create table if not exists v2.entity_profile_refresh_queue (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  reason     text,
  queued_at  timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_v2_refresh_queue_pending on v2.entity_profile_refresh_queue (processed_at) where processed_at is null;

-- entity_conflicts — conflicting facts / duplicate slugs surfaced for resolution
-- (validation surfaces problems instead of hiding them — plan's AI test rule).
create table if not exists v2.entity_conflicts (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid references v2.entities(id) on delete cascade,
  conflict_type text not null,                -- duplicate_slug | conflicting_fact | orphan_row | unresolved_key
  detail       jsonb not null default '{}',
  status       text not null default 'open',  -- open | resolved | ignored
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_conflicts_status on v2.entity_conflicts (status);
