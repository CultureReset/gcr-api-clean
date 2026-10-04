-- ============================================================
-- NEXT GENT — automation waits and business events (CONTRACT §9)
-- ============================================================
--
-- automation_waits   a run paused by a `wait` step: which run, the step to
--                    carry on at, when it is due, and the run's context so
--                    far. state: waiting | running | done | failed |
--                    cancelled. The scheduled check (lib/automationEngine.js
--                    tick -> resumeWaits) claims due rows waiting -> running
--                    before running them, so a wait never runs twice.
-- automation_runs    status gains 'running' (written as the run starts) and
--                    'waiting' (paused at a wait). The column is free text.
-- booking_calendar   status gains 'completed': set by the scheduled check
--                    when a booking's end has passed and it was not
--                    cancelled, which is when booking.completed fires.
--
-- Additive only. Safe to re-run.

create table if not exists public.automation_waits (
    id             uuid primary key default gen_random_uuid(),
    run_id         uuid,
    automation_id  uuid,
    version        integer,
    install_id     uuid,
    entity_slug    text not null,
    step_index     integer not null,
    due_at         timestamptz not null,
    state          text not null default 'waiting',
    context        jsonb not null default '{}'::jsonb,
    created_at     timestamptz not null default now(),
    resumed_at     timestamptz,

    constraint automation_waits_state_check check (state in ('waiting', 'running', 'done', 'failed', 'cancelled'))
);

create index if not exists automation_waits_due_idx on public.automation_waits (due_at) where state = 'waiting';
create index if not exists automation_waits_run_idx on public.automation_waits (run_id);

create index if not exists booking_calendar_open_bookings_idx
    on public.booking_calendar (date) where kind = 'booking' and status = 'active';

alter table public.automation_waits enable row level security;
revoke all on public.automation_waits from anon, authenticated;

notify pgrst, 'reload schema';
