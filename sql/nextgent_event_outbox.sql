-- ============================================================
-- NEXT GENT — the business event outbox (DECISIONS #87)
-- ============================================================
--
-- business_event_outbox   one row per business event emitted
--                         (lib/businessEvents.js emit) for a business that is
--                         linked to a Paperclip company. lib/eventOutbox.js
--                         posts each row, signed, as
--                         POST /api/nextgent/events
--                         { companyId, event, eventId, occurredAt, ref }
--                         and records the outcome here. A failed post is
--                         retried (next_attempt_at, doubling) from the
--                         scheduler and the cron until it goes or the row is
--                         parked as dead with its last error.
--
--   id              the event id (uuid): Paperclip's idempotency key
--   ref             ids and a non-PII summary only (booking_id, date,
--                   start_time, party, status, source, app, table, record_id,
--                   …). Never a customer's name, email or phone (#37):
--                   lib/eventOutbox.js refFor builds it from an allow-list.
--
-- Rows are written only while EVENTS_TO_PAPERCLIP is true (off until Phase
-- C of the Step 7 change list). Until this table exists the module logs the
-- missing table and the local fan-out runs as before.
--
-- Additive only. Safe to re-run.

create table if not exists public.business_event_outbox (
    id               text primary key,
    entity_slug      text not null,
    company_id       text not null,
    event            text not null,
    occurred_at      timestamptz not null,
    ref              jsonb not null default '{}'::jsonb,
    status           text not null default 'pending' check (status in ('pending', 'sent', 'dead')),
    attempts         integer not null default 0,
    last_error       text,
    next_attempt_at  timestamptz not null default now(),
    sent_at          timestamptz,
    created_at       timestamptz not null default now()
);

-- The drain reads pending rows that are due, oldest first.
create index if not exists business_event_outbox_due_idx
    on public.business_event_outbox (next_attempt_at)
    where status = 'pending';
create index if not exists business_event_outbox_slug_idx
    on public.business_event_outbox (entity_slug, occurred_at desc);
create index if not exists business_event_outbox_company_idx
    on public.business_event_outbox (company_id, occurred_at desc);

alter table public.business_event_outbox enable row level security;
revoke all on public.business_event_outbox from anon, authenticated;

comment on table public.business_event_outbox is
    'Business events on their way to Paperclip (POST /api/nextgent/events), ids and non-PII summary only. Written only by gcr-api-clean (lib/eventOutbox.js).';

notify pgrst, 'reload schema';
