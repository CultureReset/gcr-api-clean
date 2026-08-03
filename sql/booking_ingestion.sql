-- Schema the admin ingestion views depend on.
--
-- Deliberately tiny. The routes added for Booking Sources, Inventory &
-- Capacity, Availability, Calendar Feeds and Openings are READ views over
-- tables that the live pipeline already writes every day:
--
--   email_parser_log            routes/email-parser.js, on every inbound email
--   business_availability       routes/email-parser.js, routes/admin.js,
--                               routes/menu-editor.js
--   booking_calendar            routes/platform.js, routes/email-parser.js
--   entity_external_calendars   routes/dashboard.js (owner-side iCal setup)
--   gcr_deals                   routes/deals.js, routes/email-parser.js
--
-- None of those are created here. They exist in the live database, none of
-- them has a definition checked into this repo, and guessing a CREATE TABLE
-- for a table that is already in production is a good way to end up with a
-- shape that disagrees with the code writing to it.
--
-- What IS here: the two columns on `entity` that capacity depends on. The
-- parser reads and writes them (routes/email-parser.js), so they should
-- already be present — these statements are no-ops if so, and make a fresh
-- database work if not.
--
--   psql "$DATABASE_URL" -f sql/booking_ingestion.sql

/* ── capacity ────────────────────────────────────────────────────────── */
-- The number the parser subtracts a party size from. Without it a booking is
-- logged but `remaining_spots` stays null, so the business can never report an
-- opening however many confirmations it forwards.

alter table public.entity
  add column if not exists daily_capacity integer;

comment on column public.entity.daily_capacity is
  'Total bookable units per day — seats, rooms, boats. The email parser counts down from this; null means availability cannot be computed.';

-- For businesses that run several departures a day rather than one daily count.
alter table public.entity
  add column if not exists capacity_per_slot integer;

comment on column public.entity.capacity_per_slot is
  'Capacity of a single departure / time slot, for businesses that run more than one a day.';

/* ── verification ────────────────────────────────────────────────────── */
-- Reports anything the admin views read that is missing, rather than creating
-- it blind. Run this after applying the file; every line it prints is a screen
-- that will come back empty.

do $$
declare
  t text;
begin
  foreach t in array array[
    'email_parser_log',
    'business_availability',
    'booking_calendar',
    'entity_external_calendars',
    'gcr_deals'
  ] loop
    if to_regclass('public.' || t) is null then
      raise notice 'MISSING: public.% — the admin view over it will return empty', t;
    end if;
  end loop;
end $$;
