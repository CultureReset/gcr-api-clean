-- ============================================================
-- NEXT GENT — item prices set by Paperclip's store (CONTRACT §12)
-- ============================================================
--
-- PUT /api/nextgent/items/:itemKey/price writes here. lib/billingStripe.js
-- itemByKey() lays this row over the store_items row (or stands in for it when
-- this API's store has no such item), so entitlement answers and install
-- charges use the price Paperclip set. stripe_price_id is the Stripe Price
-- created for the current amount; Stripe prices never change, so a new amount
-- gets a new price and installs already billed keep theirs.
--
-- Additive only. Safe to re-run.

create table if not exists public.billing_item_prices (
    item_key           text primary key,
    amount_cents       integer not null default 0,
    currency           text not null,
    interval           text,
    model              text,
    stripe_product_id  text,
    stripe_price_id    text,
    updated_at         timestamptz not null default now(),

    constraint billing_item_prices_amount_check   check (amount_cents >= 0),
    constraint billing_item_prices_interval_check check (interval is null or interval in ('one_time', 'month', 'year'))
);

alter table public.billing_item_prices enable row level security;
revoke all on public.billing_item_prices from anon, authenticated;

notify pgrst, 'reload schema';
