-- ============================================================
-- NEXT GENT — Stripe webhook events, each processed once
-- ============================================================
--
-- stripe_webhook_events   one row per Stripe event id this API has acted on.
--                         Both webhook paths (/api/stripe/webhook and the
--                         older /api/webhooks/stripe) run the same handler
--                         (routes/stripe.js), which claims the event id here
--                         before doing anything; a second delivery of the
--                         same event, on either path or by Stripe's retry,
--                         finds the row and does nothing. A handler failure
--                         releases the claim so the retry can run.
--
-- Additive only. Safe to re-run.

create table if not exists public.stripe_webhook_events (
    event_id     text primary key,
    type         text,
    received_at  timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
revoke all on public.stripe_webhook_events from anon, authenticated;

notify pgrst, 'reload schema';
