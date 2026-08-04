-- Self-serve business sign-up: the record, and the approval gate.
--
-- A business creating its own account is the one path where a stranger can put
-- a row into `entity`, which is the table the whole public directory renders
-- from. Nothing they create is visible until someone approves it, and this
-- table is where that decision lives.
--
-- Deliberately NOT columns on `entity`. That table has 4,067 rows of real
-- listings and is read by every surface; sign-up bookkeeping does not belong
-- in it. The link is entity_slug, and approval flips entity.is_active.
--
-- Nothing here is shared with tourist sign-up. Tourist accounts and business
-- accounts are separate systems.
--
-- ADDITIVE. Creates one table and its indexes. Touches no existing table.
--
--   psql "$DATABASE_URL" -f sql/business_signups.sql
--
-- To undo:  drop table public.business_signups;

create table if not exists public.business_signups (
  id                uuid primary key default gen_random_uuid(),

  -- Who signed up. user_id is the SUPABASE AUTH id, the same id
  -- entity_owners.user_id carries — not users.id.
  user_id           uuid,
  phone             text not null,
  phone_verified_at timestamptz,
  email             text,

  -- What they created.
  entity_slug       text,
  entity_id         uuid,
  submitted_name    text not null,
  website           text,

  -- Review. 'pending' until a human decides; approving is what makes the
  -- listing public.
  status            text not null default 'pending',
  reviewed_by       text,
  reviewed_at       timestamptz,
  notes             text,

  -- Listings that look like the same business, captured at sign-up time.
  -- This is the counterfeit check: if someone signs up as "Flora-Bama" and a
  -- Flora-Bama already exists, the reviewer sees that side by side instead of
  -- having to notice it. Shape: [{slug, name, score}].
  possible_duplicates jsonb not null default '[]'::jsonb,

  -- How much of the account is real: did the phone verify, did they connect
  -- Google Business, did the website resolve. Filled in as they do it.
  verification      jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now()
);

comment on table public.business_signups is
  'Self-serve business sign-ups awaiting review. Approval flips entity.is_active.';
comment on column public.business_signups.possible_duplicates is
  'Existing listings matching the submitted name, captured at sign-up. The counterfeit check.';
comment on column public.business_signups.verification is
  'Signals gathered about the business: phone_verified, google_business, website_resolved.';

-- The queue a reviewer opens.
create index if not exists business_signups_status_created_idx
  on public.business_signups (status, created_at desc);

create index if not exists business_signups_entity_slug_idx
  on public.business_signups (entity_slug) where entity_slug is not null;

-- One pending sign-up per phone. Stops the same number spraying listings.
create unique index if not exists business_signups_phone_pending_idx
  on public.business_signups (phone) where status = 'pending';

-- Service-key only. This holds phone numbers and review decisions; the anon
-- key must never see it.
alter table public.business_signups enable row level security;
