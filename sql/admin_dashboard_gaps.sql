-- ############################################################
-- ##  DO NOT RUN. See HANDOFF.md in the repository root.    ##
-- ##                                                        ##
-- ##  This file was written against the WRONG database and  ##
-- ##  has never been validated against the real one         ##
-- ##  (Supabase project "cyber check" / mkepugvdlktfsossumox).##
-- ############################################################

-- Tables the admin dashboard needs that don't exist yet.
--
-- Small on purpose. Most of the gap was covered by tables that already exist:
--   platform_settings   already a key/value jsonb store — site config, SMS
--                       config and auth config are three keys in it, not three
--                       new tables
--   business_leads      already written by routes/public.js from the public
--                       sign-up form; only the admin read side was missing
--
-- So this file adds two tables and makes sure platform_settings is present.
--
--   psql "$DATABASE_URL" -f sql/admin_dashboard_gaps.sql

/* ── key/value settings ──────────────────────────────────────────────── */
-- Defined in TOURIST_SCHEMA_EXTENSIONS.sql; repeated here so this file can be
-- run on a database that never had that one applied.

create table if not exists public.platform_settings (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  value       jsonb,
  updated_at  timestamptz default now()
);

/* ── guest photos ────────────────────────────────────────────────────── */
-- Visitor-submitted photos, held until someone approves them.

create table if not exists public.community_photos (
  id            uuid primary key default gen_random_uuid(),
  entity_slug   text,
  url           text not null,
  image_path    text,
  caption       text,
  submitted_by  text,
  submitter_ref text,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists community_photos_status_idx
  on public.community_photos (status);
create index if not exists community_photos_slug_idx
  on public.community_photos (entity_slug);

alter table public.community_photos enable row level security;

-- Approved photos are public; everything else is admin-only through the API's
-- service key, so a pending photo can never be read by a visitor.
drop policy if exists community_photos_read_approved on public.community_photos;
create policy community_photos_read_approved on public.community_photos
  for select using (status = 'approved');

/* ── category cards ──────────────────────────────────────────────────── */
-- The tiles linking to each category page on the public site.

create table if not exists public.category_cards (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  subtitle    text,
  page        text,
  category    text,
  image_url   text,
  link_url    text,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists category_cards_page_idx
  on public.category_cards (page);

alter table public.category_cards enable row level security;

drop policy if exists category_cards_read on public.category_cards;
create policy category_cards_read on public.category_cards
  for select using (is_active);

/* ── business leads ──────────────────────────────────────────────────── */
-- routes/public.js inserts into this from the public form and swallows the
-- error if the table is absent, so it may never have been created. This makes
-- sure it exists with the columns that route writes.

create table if not exists public.business_leads (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null,
  category      text,
  contact_name  text,
  phone         text,
  email         text,
  website       text,
  notes         text,
  plan          text default 'Listed',
  status        text not null default 'new',
  submitted_at  timestamptz not null default now()
);

create index if not exists business_leads_status_idx
  on public.business_leads (status);

alter table public.business_leads enable row level security;
-- No policies: leads are private, only the API's service key reads them.
