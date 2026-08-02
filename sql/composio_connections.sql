-- Composio connections.
--
-- Two catalog tables an admin curates, and one table recording which business
-- has connected which tool. Nothing here touches existing business data.
--
-- Deliberately compatible with the owner-dashboard package's
-- owner_dashboard.sql: the same three table names and the same core columns,
-- so running either one first is fine. This file adds the columns the Composio
-- handshake needs (composio_app, integration_id, auth_scheme) with ALTERs that
-- are safe to re-run.
--
--   psql "$DATABASE_URL" -f sql/composio_connections.sql

/* ── categories ──────────────────────────────────────────────────────── */

create table if not exists public.platform_connection_categories (
  cat_id      text primary key,
  name        text not null,
  sort_order  int  not null default 0
);

/* ── the tool catalog ────────────────────────────────────────────────── */

create table if not exists public.platform_connections (
  tool_id      text primary key,
  name         text not null,
  logo         text,
  icon         text,
  cat          text references public.platform_connection_categories (cat_id),
  description  text,
  provider     text not null default 'composio',
  sort_order   int  not null default 0,
  is_featured  boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Composio linkage. Separate ALTERs so this runs cleanly whether the table was
-- created here or by the owner-dashboard package.
alter table public.platform_connections
  add column if not exists composio_app text;
alter table public.platform_connections
  add column if not exists integration_id text;
alter table public.platform_connections
  add column if not exists auth_scheme text;

comment on column public.platform_connections.composio_app is
  'Composio app key, e.g. googlecalendar. Informational.';
comment on column public.platform_connections.integration_id is
  'Composio integration id. Required before a business can connect this tool.';

/* ── who has connected what ──────────────────────────────────────────── */

create table if not exists public.entity_connections (
  id            uuid primary key default gen_random_uuid(),
  entity_slug   text not null,
  tool_id       text not null,
  status        text not null default 'pending',
  account_ref   text,
  connected_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (entity_slug, tool_id)
);

create index if not exists entity_connections_slug_idx
  on public.entity_connections (entity_slug);
create index if not exists entity_connections_status_idx
  on public.entity_connections (status);

/* ── row level security ──────────────────────────────────────────────── */
-- The catalog is a storefront and reads publicly. Connections are account
-- plumbing: no policies, so only the API's service key reaches them.

alter table public.platform_connections            enable row level security;
alter table public.platform_connection_categories  enable row level security;
alter table public.entity_connections              enable row level security;

drop policy if exists platform_connections_read on public.platform_connections;
create policy platform_connections_read on public.platform_connections
  for select using (is_active);

drop policy if exists platform_connection_categories_read on public.platform_connection_categories;
create policy platform_connection_categories_read on public.platform_connection_categories
  for select using (true);

/* ── seed categories ─────────────────────────────────────────────────── */

insert into public.platform_connection_categories (cat_id, name, sort_order) values
  ('booking',   'Booking & reservations', 1),
  ('payments',  'Payments & POS',         2),
  ('marketing', 'Marketing & social',     3),
  ('crm',       'CRM & contacts',         4),
  ('email',     'Email & calendar',       5),
  ('reviews',   'Reviews & listings',     6),
  ('ops',       'Operations',             7)
on conflict (cat_id) do nothing;
