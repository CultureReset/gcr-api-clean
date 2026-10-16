-- DRAFT. NOT RUN. Reviews (+ requests from cybercheck-api-database), artists/songs/requests/votes, leads/forms, QR.
create table if not exists ng.review (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  source        text not null default 'direct',   -- direct, google, yelp, tripadvisor, facebook
  external_id   text,
  author_name   text,
  rating        smallint check (rating between 1 and 5),
  body          text,
  reply         text,
  published     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (business_id, source, external_id)
);
create table if not exists ng.review_request (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  customer_id uuid references ng.customer(id), booking_id uuid references ng.booking(id), order_id uuid references ng."order"(id),
  channel text not null default 'sms', token text unique, status text not null default 'queued',
  sent_at timestamptz, responded_at timestamptz);

-- Artists are businesses (ng.business.kind = 'artist'). These are their extra tables.
create table if not exists ng.song (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  title text not null, artist_name text, genres text[] not null default '{}', lyrics_url text,
  enabled boolean not null default true);
create table if not exists ng.live_session (     -- a night / a show where the room votes
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  event_id uuid references ng.event(id), venue_business_id uuid references ng.business(id),
  free_votes int not null default 3, vote_price_cents int, requests_enabled boolean not null default false,
  started_at timestamptz, ended_at timestamptz, now_playing_song_id uuid references ng.song(id));
create table if not exists ng.vote (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references ng.live_session(id) on delete cascade,
  song_id uuid not null references ng.song(id), voter_key text not null, votes int not null default 1,
  paid boolean not null default false, created_at timestamptz not null default now());
create table if not exists ng.song_request (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  session_id uuid references ng.live_session(id),
  song_id uuid references ng.song(id), requested_title text, requester_name text, message text,
  tip_payment_id uuid references ng.payment(id),
  status text not null default 'open', created_at timestamptz not null default now()); -- open, added, done, declined

create table if not exists ng.form (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  kind text not null,            -- contact, quote, valuation, inquiry, booking_request, recruit, checkin
  name text not null, schema jsonb not null default '{}', active boolean not null default true);
create table if not exists ng.form_submission (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  form_id uuid references ng.form(id), customer_id uuid references ng.customer(id),
  data jsonb not null, media_ids uuid[] not null default '{}', status text not null default 'new',
  created_at timestamptz not null default now());   -- also replaces business_leads, artist_booking_requests

create table if not exists ng.qr_code (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  code text not null unique, target text not null,   -- menu, shop, vote, book, waiver, link, url:<…>
  label text, location text, theme jsonb, created_at timestamptz not null default now());
create table if not exists ng.qr_scan (
  id bigserial primary key, qr_id uuid not null references ng.qr_code(id) on delete cascade,
  scanned_at timestamptz not null default now(), ua text, ref text);
