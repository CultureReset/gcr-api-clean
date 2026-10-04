-- ============================================================
-- NEXT GENT — scheduler state: what the scheduled checks remember
-- ============================================================
--
-- scheduler_state   one row per key. The first user is the booking
--                   completion check (lib/businessEvents.js completeBookings):
--                   key booking_complete_watermark holds the time the check
--                   first ran. Only bookings that end after that moment are
--                   ever marked completed, so enabling the check does not
--                   mark a business's whole history completed and fire
--                   booking.completed (review requests) for all of it. The
--                   value is written once, by the first run; it is never a
--                   date typed into code.
--
-- Until this table exists the completion check does nothing and says so in
-- its result, rather than guessing a starting point.
--
-- Additive only. Safe to re-run.

create table if not exists public.scheduler_state (
    key         text primary key,
    value       text,
    updated_at  timestamptz not null default now()
);

alter table public.scheduler_state enable row level security;
revoke all on public.scheduler_state from anon, authenticated;

notify pgrst, 'reload schema';
