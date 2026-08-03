-- ############################################################
-- ##  DO NOT RUN. See HANDOFF.md in the repository root.    ##
-- ##                                                        ##
-- ##  This file was written against the WRONG database and  ##
-- ##  has never been validated against the real one         ##
-- ##  (Supabase project "cyber check" / mkepugvdlktfsossumox).##
-- ############################################################

-- ============================================================
-- BOOKING INGESTION TABLES — the five the pipeline writes to
-- ============================================================
--
-- `booking_ingestion.sql` said these tables "exist in the live database" and
-- deliberately did not define them. That was wrong. Checked against the live
-- GCR project, all five were absent:
--
--   email_parser_log            every inbound email
--   business_availability       capacity per business per day
--   booking_calendar            entity-wide blocks and bookings
--   entity_external_calendars   iCal feeds
--   gcr_deals                   last-minute deals
--
-- So the parser could never have written a row, and Booking Sources,
-- Inventory & Capacity, Availability, Calendar Feeds, Openings and Deals were
-- all reading tables that were not there.
--
-- ── Where these columns came from ───────────────────────────────────────
--
-- Not invented. Every column below is one that live code in this repo reads
-- or writes — extracted from the actual `.select(…)`, `.eq(…)`, `.insert({…})`
-- and `.update({…})` calls in routes/email-parser.js, routes/platform.js,
-- routes/deals.js, routes/menu-editor.js, routes/gcr.js, routes/admin.js,
-- routes/dashboard.js, routes/tourist.js, routes/public.js,
-- routes/availability-engine.js and routes/admin-platform.js.
--
-- Everything is nullable except the identifying columns, because different
-- writers fill in different subsets — the parser knows a party size, the menu
-- editor knows a capacity, and neither knows what the other knows.
--
--   psql "$DATABASE_URL" -f sql/booking_ingestion_tables.sql
--
-- Re-runnable. Creates nothing that already exists, drops nothing.

/* ══════════════════════════════════════════════════════════════════════
   email_parser_log — one row per inbound email
   ══════════════════════════════════════════════════════════════════════ */
--
-- `raw_text` holds up to 5,000 characters of the email body, and
-- `customer_name` / `from_email` are personal data. Nothing here should ever
-- be served by an unauthenticated route.

create table if not exists public.email_parser_log (
  id              uuid primary key default gen_random_uuid(),
  entity_slug     text,

  from_email      text,
  to_email        text,
  raw_text        text,
  email_hash      text,               -- dedupe key: the same confirmation
                                      -- forwarded twice is one booking
  confirmation_no text,

  customer_name   text,
  party_size      integer,
  event_date      date,
  event_time      text,
  seated_time     text,
  left_time       text,
  end_time        text,
  table_number    text,
  activity_name   text,

  platform        text,               -- which extractor matched
  booking_type    text,
  status          text,
  parsed          boolean default false,
  bulk            boolean default false,
  manual          boolean default false,

  created_at      timestamptz default now()
);

create index if not exists email_parser_log_entity_idx on public.email_parser_log (entity_slug);
create index if not exists email_parser_log_created_idx on public.email_parser_log (created_at desc);
create index if not exists email_parser_log_hash_idx on public.email_parser_log (email_hash);
create index if not exists email_parser_log_date_idx on public.email_parser_log (event_date);

/* ══════════════════════════════════════════════════════════════════════
   business_availability — capacity per business per day
   ══════════════════════════════════════════════════════════════════════ */
--
-- The first of the three availability sources. The parser counts a party size
-- down from `total_capacity`; `remaining_spots` is what is left.
--
-- `visible_on_profile` defaults TRUE. The parser's insert does not set it, and
-- the public feed filters on `visible_on_profile = true` — so defaulting it
-- false would mean every row the parser writes is invisible to the widget and
-- the public API, which is the opposite of the point. A business hides a day
-- by setting it false.

create table if not exists public.business_availability (
  id                 uuid primary key default gen_random_uuid(),
  entity_slug        text not null,
  resource_id        text,            -- a specific boat/unit, when known

  availability_date  date not null,
  time_slot          text,            -- '00:00' for a whole-day row
  end_time           text,

  status             text,            -- available | limited | full | blocked
  total_capacity     integer,
  booked_count       integer default 0,
  remaining_spots    integer,

  booking_type       text,
  source_platform    text,            -- which extractor or feed claimed it
  visible_on_profile boolean default true,

  last_minute_deal   text,
  last_minute_price  numeric(10,2),
  original_price     numeric(10,2),

  last_email_log_id  uuid,
  last_updated       timestamptz default now(),
  created_at         timestamptz default now()
);

create index if not exists business_availability_entity_idx
  on public.business_availability (entity_slug);
create index if not exists business_availability_date_idx
  on public.business_availability (availability_date);
create index if not exists business_availability_lookup_idx
  on public.business_availability (entity_slug, availability_date, time_slot);

/* ══════════════════════════════════════════════════════════════════════
   booking_calendar — blocks and bookings
   ══════════════════════════════════════════════════════════════════════ */
--
-- The third source, and the one that wins: a row with `kind = 'block'` and a
-- null `offering_id` takes the whole entity off the board for its date range,
-- applied after everything else.
--
-- `details` is jsonb because routes/platform.js already writes it that way.
-- It is the one column here that is not a real typed column, and it is not new
-- — it is carried over so existing code keeps working rather than added as a
-- new place to put JSON.

create table if not exists public.booking_calendar (
  id           uuid primary key default gen_random_uuid(),
  entity_slug  text not null,
  booking_id   uuid,
  offering_id  uuid,

  date         date not null,
  end_date     date,                  -- inclusive; a multi-night stay
  start_time   text,

  kind         text,                  -- block | booking
  status       text,
  source       text,
  title        text,
  party        integer,
  external_uid text,                  -- the iCal UID, so a re-sync updates

  details      jsonb,

  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists booking_calendar_entity_idx on public.booking_calendar (entity_slug);
create index if not exists booking_calendar_date_idx on public.booking_calendar (date);
create index if not exists booking_calendar_kind_idx on public.booking_calendar (kind);
create index if not exists booking_calendar_uid_idx on public.booking_calendar (external_uid);

/* ══════════════════════════════════════════════════════════════════════
   entity_external_calendars — iCal feeds
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.entity_external_calendars (
  id               uuid primary key default gen_random_uuid(),
  entity_slug      text not null,
  ical_url         text not null,

  provider         text,              -- airbnb | vrbo | google | other
  source_label     text,              -- what to stamp on the blocks it creates
  resource_id      text,              -- which unit/boat this feed is for

  last_synced_at   timestamptz,
  last_sync_status text,
  is_active        boolean default true,

  created_at       timestamptz default now()
);

create index if not exists entity_external_calendars_entity_idx
  on public.entity_external_calendars (entity_slug);

/* ══════════════════════════════════════════════════════════════════════
   gcr_deals — last-minute availability worth telling someone about
   ══════════════════════════════════════════════════════════════════════ */

create table if not exists public.gcr_deals (
  id               uuid primary key default gen_random_uuid(),
  entity_slug      text,
  entity_name      text,
  entity_type      text,
  entity_subtype   text,

  headline         text,
  description      text,
  deal_type        text,

  deal_price       numeric(10,2),
  original_price   numeric(10,2),
  price_label      text,
  price_unit       text,

  valid_date       date,
  valid_start_time text,
  valid_end_time   text,
  expires_at       timestamptz,

  spots_total      integer,
  spots_remaining  integer,

  claim_type       text,              -- url | phone | walk_in
  claim_url        text,
  claim_phone      text,
  claim_text       text,

  image_url        text,
  swipe_card       boolean default false,

  is_active        boolean default true,
  is_featured      boolean default false,
  is_today_only    boolean default false,
  promoted_feed    boolean default false,
  promoted_sms     boolean default false,
  sms_blast_at     timestamptz,
  click_count      integer default 0,

  posted_by        text,
  poster_name      text,
  poster_phone     text,
  poster_verified  boolean default false,

  source           text,
  source_log_id    uuid,

  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists gcr_deals_entity_idx on public.gcr_deals (entity_slug);
create index if not exists gcr_deals_valid_idx on public.gcr_deals (valid_date);
create index if not exists gcr_deals_active_idx on public.gcr_deals (is_active) where is_active is true;

/* ══════════════════════════════════════════════════════════════════════
   availability — the second source, already live but short some columns
   ══════════════════════════════════════════════════════════════════════ */
--
-- This table already exists with `id, entity_id, item_id, date, status,
-- booking_id, notes, created_at`. routes/availability-engine.js reads
-- `entity_slug, date, start_time, end_time, status, spots_total,
-- spots_remaining` from it, so five of those seven were not there and the
-- per-resource half of the merge could not run.
--
-- Added, never altered: `entity_id`, `item_id`, `booking_id` and `notes` are
-- left exactly as they are.

alter table public.availability add column if not exists entity_slug     text;
alter table public.availability add column if not exists start_time      text;
alter table public.availability add column if not exists end_time        text;
alter table public.availability add column if not exists spots_total     integer;
alter table public.availability add column if not exists spots_remaining integer;

create index if not exists availability_entity_slug_idx on public.availability (entity_slug);
create index if not exists availability_date_idx on public.availability (date);
