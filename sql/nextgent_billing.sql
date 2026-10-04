-- ============================================================
-- NEXT GENT — billing additions (plan §15 step 11)
-- ============================================================
--
-- Same one billing system (sql/billing.sql, lib/billing.js, lib/entitlements.js,
-- routes/stripe.js). Prices stay rows, never constants:
--
--   store_items.price_cents / price_interval / stripe_price_id
--       what an item costs when installed. interval: one_time | month | year.
--   billing_plan.stripe_price_id
--       the Stripe price behind a plan's monthly subscription.
--   billing_subscription.stripe_customer_id / stripe_subscription_id
--       the Stripe objects for a business.
--   billing_subscription.payment_failed_since
--       the non-payment clock. It runs the same grace period as usage limits
--       (lib/billing.js restrictionState); when it runs out the business is
--       paused, never deleted.
--   billing_item_charges
--       one row per priced install (store item or Phone Agent number), with
--       the Stripe subscription item / invoice item that bills it.
--   billing_usage_credits
--       AI spend per company per period, as reported from LiteLLM.
--
-- Needs sql/billing.sql and sql/store.sql first. Additive only. Safe to re-run.

alter table public.store_items add column if not exists price_cents     integer not null default 0;
alter table public.store_items add column if not exists price_interval  text;
alter table public.store_items add column if not exists stripe_price_id text;

alter table public.billing_plan add column if not exists stripe_price_id text;

alter table public.billing_subscription add column if not exists stripe_customer_id     text;
alter table public.billing_subscription add column if not exists stripe_subscription_id text;
alter table public.billing_subscription add column if not exists payment_failed_since   timestamptz;
alter table public.billing_subscription add column if not exists paused_at              timestamptz;

create table if not exists public.billing_item_charges (
    id                uuid primary key default gen_random_uuid(),
    entity_slug       text not null,
    company_id        text,
    install_id        text,
    item_key          text not null,
    price_cents       integer not null default 0,
    price_interval    text,
    stripe_ref        text,
    status            text not null default 'active',
    created_at        timestamptz not null default now(),
    removed_at        timestamptz,

    constraint billing_item_charges_status_check check (status in ('active', 'removed', 'failed'))
);

create index if not exists billing_item_charges_slug_idx    on public.billing_item_charges (entity_slug);
create index if not exists billing_item_charges_install_idx on public.billing_item_charges (install_id);

create table if not exists public.billing_usage_credits (
    id            uuid primary key default gen_random_uuid(),
    entity_slug   text not null,
    company_id    text not null,
    source        text not null,
    period_start  timestamptz not null,
    period_end    timestamptz not null,
    spend_usd     numeric(12,4) not null default 0,
    credits       bigint not null default 0,
    recorded_at   timestamptz not null default now(),

    constraint billing_usage_credits_period unique (company_id, source, period_start, period_end)
);

create index if not exists billing_usage_credits_slug_idx on public.billing_usage_credits (entity_slug, period_start desc);

alter table public.billing_item_charges  enable row level security;
alter table public.billing_usage_credits enable row level security;
revoke all on public.billing_item_charges  from anon, authenticated;
revoke all on public.billing_usage_credits from anon, authenticated;

notify pgrst, 'reload schema';
