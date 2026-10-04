-- ============================================================
-- NEXT GENT — one home for item prices: billing_item_prices
-- ============================================================
--
-- An item's price used to live in two places: store_items.price_cents /
-- price_interval / stripe_price_id (sql/nextgent_billing.sql) and
-- billing_item_prices (sql/nextgent_prices.sql, what Paperclip's store sets).
-- lib/billingStripe.js itemByKey() now reads billing_item_prices only, so this
-- copies every price still held on a store_items row into it.
--
--   * A row already in billing_item_prices wins (on conflict do nothing):
--     that is the price Paperclip set last.
--   * The currency is the default billing plan's (billing_plan.currency, a
--     row, not a literal here). Items are skipped if no default plan exists;
--     set one first.
--   * Free items with no Stripe price need no row: no row means free.
--
-- The three store_items columns are left in place. Dropping them is a later,
-- separate file (see sql/ORDER.md), once this has been applied and checked.
--
-- Needs sql/nextgent_billing.sql and sql/nextgent_prices.sql. Additive only.
-- Safe to re-run.

insert into public.billing_item_prices (item_key, amount_cents, currency, interval, stripe_price_id, updated_at)
select
    si.key,
    coalesce(si.price_cents, 0),
    plan.currency,
    case
        when coalesce(si.price_cents, 0) = 0 then si.price_interval
        else coalesce(si.price_interval, 'one_time')
    end,
    case when coalesce(si.price_cents, 0) > 0 then si.stripe_price_id else null end,
    now()
from public.store_items si
cross join lateral (
    select bp.currency from public.billing_plan bp where bp.is_default limit 1
) plan
where (coalesce(si.price_cents, 0) > 0 or si.stripe_price_id is not null)
  and (si.price_interval is null or si.price_interval in ('one_time', 'month', 'year'))
on conflict (item_key) do nothing;

notify pgrst, 'reload schema';
