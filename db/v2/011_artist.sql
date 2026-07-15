-- ============================================================================
-- GCR v2 — 011_artist.sql  (Artist / live-music module pack)
-- Canonical artist profile linked to an entity, plus shows, bookings, follows,
-- goals, songs, links and request/shoutout workflows.
-- Merges artists + artist_profiles (both currently 390 rows).
-- ============================================================================

create table if not exists v2.artist_profiles (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid references v2.entities(id) on delete cascade,
  stage_name  text not null,
  genre       text,
  bio         text,
  media_id    uuid references v2.media_assets(id) on delete set null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_artist_profiles_entity on v2.artist_profiles (entity_id);

-- entity_events.artist_id can now reference an artist profile.
alter table v2.entity_events
  add constraint fk_v2_events_artist
  foreign key (artist_id) references v2.artist_profiles(id) on delete set null;

create table if not exists v2.artist_shows (
  id          uuid primary key default gen_random_uuid(),
  artist_id   uuid not null references v2.artist_profiles(id) on delete cascade,
  venue_entity_id uuid references v2.entities(id) on delete set null,
  show_date   date,
  start_time  time,
  created_at  timestamptz not null default now()
);

create table if not exists v2.artist_bookings (
  id          uuid primary key default gen_random_uuid(),
  artist_id   uuid not null references v2.artist_profiles(id) on delete cascade,
  venue_entity_id uuid references v2.entities(id) on delete set null,
  status      text not null default 'requested',
  requested_date date,
  created_at  timestamptz not null default now()
);

create table if not exists v2.artist_follows (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references v2.artist_profiles(id) on delete cascade,
  phone      text,
  consented  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists v2.artist_goals (
  id          uuid primary key default gen_random_uuid(),
  artist_id   uuid not null references v2.artist_profiles(id) on delete cascade,
  title       text not null,
  target_amount numeric,
  raised_amount numeric not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists v2.artist_goal_contributions (
  id         uuid primary key default gen_random_uuid(),
  goal_id    uuid not null references v2.artist_goals(id) on delete cascade,
  amount     numeric not null,
  contributor text,
  created_at timestamptz not null default now()
);

create table if not exists v2.songs (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references v2.artist_profiles(id) on delete cascade,
  title      text not null,
  requestable boolean not null default true
);

create table if not exists v2.music_links (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references v2.artist_profiles(id) on delete cascade,
  platform   text not null,                   -- spotify | apple | youtube | soundcloud
  url        text not null
);

create table if not exists v2.tip_links (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references v2.artist_profiles(id) on delete cascade,
  platform   text not null,                   -- venmo | cashapp | paypal
  handle     text not null
);

create table if not exists v2.song_requests (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references v2.artist_profiles(id) on delete cascade,
  song_id    uuid references v2.songs(id) on delete set null,
  song_text  text,
  tip_amount numeric,
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists v2.shoutouts (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references v2.artist_profiles(id) on delete cascade,
  message    text,
  tip_amount numeric,
  created_at timestamptz not null default now()
);
