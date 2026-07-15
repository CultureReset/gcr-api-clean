-- ============================================================================
-- GCR v2 — 012_operations.sql  (Operations pack — entity-linked ops tables)
-- Ownership, claims, invites, private integrations, unified analytics, and the
-- tourist-side tables. (Shared infra like users/qr_codes/sms_log already exist
-- in production and are consolidated in place, not re-created here.)
-- ============================================================================

-- entity_owners — owner/user→entity roles. Plan flags this as CRITICAL:
-- only one user is currently linked, so claimed dashboards can't resolve.
create table if not exists v2.entity_owners (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  user_id    uuid not null,
  role       text not null default 'owner',   -- owner | manager | staff
  created_at timestamptz not null default now(),
  unique (entity_id, user_id)
);
create index if not exists idx_v2_entity_owners_user on v2.entity_owners (user_id);

create table if not exists v2.business_claims (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid references v2.entities(id) on delete cascade,
  claimant_name text,
  claimant_email text,
  claimant_phone text,
  status     text not null default 'pending', -- pending | approved | rejected
  created_at timestamptz not null default now()
);

create table if not exists v2.business_invites (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  invited_contact text not null,
  role       text not null default 'manager',
  token      text unique,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- integration_accounts — private provider/OAuth connections + secrets (NOT public).
create table if not exists v2.integration_accounts (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  provider    text not null,                  -- google_business | square | stripe | meta | fareharbor
  settings    jsonb not null default '{}',
  secret_ref  text,                           -- reference to a secret store, never the raw secret
  status      text not null default 'connected',
  created_at  timestamptz not null default now()
);

-- analytics_events — unified GCR/profile/click/swipe analytics.
create table if not exists v2.analytics_events (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid references v2.entities(id) on delete set null,
  event_type text not null,                   -- page_view | profile_view | click | swipe | qr_scan
  session_id text,
  page_path  text,
  source     text,
  utm        jsonb not null default '{}',
  device_type text,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_analytics_entity on v2.analytics_events (entity_id, event_type, created_at desc);

-- ---- Tourist side ----------------------------------------------------------
create table if not exists v2.tourist_profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  display_name text,
  preferences jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table if not exists v2.tourist_saves (
  id         uuid primary key default gen_random_uuid(),
  tourist_id uuid not null references v2.tourist_profiles(id) on delete cascade,
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (tourist_id, entity_id)
);

create table if not exists v2.tourist_itineraries (
  id         uuid primary key default gen_random_uuid(),
  tourist_id uuid not null references v2.tourist_profiles(id) on delete cascade,
  title      text,
  start_date date,
  end_date   date,
  items      jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists v2.tourist_memories (
  id         uuid primary key default gen_random_uuid(),
  tourist_id uuid not null references v2.tourist_profiles(id) on delete cascade,
  memory     text not null,
  created_at timestamptz not null default now()
);

create table if not exists v2.tourist_conversations (
  id         uuid primary key default gen_random_uuid(),
  tourist_id uuid references v2.tourist_profiles(id) on delete cascade,
  channel    text,                            -- chat | voice | sms
  created_at timestamptz not null default now()
);

create table if not exists v2.tourist_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references v2.tourist_conversations(id) on delete cascade,
  role            text not null,              -- user | assistant | tool
  content         text,
  created_at      timestamptz not null default now()
);
