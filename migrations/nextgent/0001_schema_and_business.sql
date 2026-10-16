-- DRAFT. NOT RUN. NEXT GENT canonical data layer, part 1: schema, business, accounts.
create schema if not exists ng;
create extension if not exists pgcrypto;

-- One row per business. Points at the existing directory entity (public.entity.id).
create table if not exists ng.business (
  id            uuid primary key,                 -- = public.entity.id
  slug          text not null unique,
  name          text not null,
  kind          text,                             -- restaurant, charter, artist, realtor, venue, rental, tour, …
  timezone      text not null default 'America/Chicago',
  currency      text not null default 'USD',
  paperclip_company_id text unique,               -- link to Paperclip company
  preset        text,                             -- business-type preset applied
  status        text not null default 'active',   -- active, hidden, archived
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ONE account store (replaces users, admin_users, tourist_profiles logins; entity_owners → business_member).
create table if not exists ng.account (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,
  phone         text unique,
  display_name  text,
  platform_role text not null default 'user',     -- user, platform_admin, consumer
  auth_provider text,                             -- otp, password, paperclip
  legacy_ref    jsonb not null default '{}',      -- {"users":id,"admin_users":id,"tourist_profiles":id}
  created_at    timestamptz not null default now()
);

create table if not exists ng.business_member (
  business_id   uuid not null references ng.business(id) on delete cascade,
  account_id    uuid not null references ng.account(id) on delete cascade,
  role          text not null default 'owner',    -- owner, admin, staff, member
  created_at    timestamptz not null default now(),
  primary key (business_id, account_id)
);

-- Profile singletons (about, contact, address, socials, brand). One row per business.
create table if not exists ng.business_profile (
  business_id   uuid primary key references ng.business(id) on delete cascade,
  tagline       text,
  description   text,
  phone         text,
  email         text,
  website_url   text,
  address       jsonb,                            -- {line1,city,region,postal,country,lat,lng}
  socials       jsonb not null default '{}',      -- {instagram:"…",facebook:"…",tiktok:"…"}
  logo_media_id uuid,
  cover_media_id uuid,
  attributes    jsonb not null default '{}',      -- amenities, features, tags (typed later per kind)
  updated_at    timestamptz not null default now()
);

-- Mapping of our rows to outside systems (Google Business, Square, Yelp, FareHarbor, Stripe…).
create table if not exists ng.external_ref (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  provider      text not null,                    -- google_business, square, yelp, fareharbor, stripe
  local_table   text not null,                    -- ng.menu_item, ng.hours, …
  local_id      uuid,
  external_id   text not null,
  last_synced_at timestamptz,
  sync_state    text,                             -- ok, pending, error
  unique (provider, local_table, local_id)
);
