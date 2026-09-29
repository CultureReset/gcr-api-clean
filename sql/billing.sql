-- ============================================================
-- BILLING — ported from Huly (plugins/billing, EPL-2.0)
-- ============================================================
--
-- Huly's model, with the one thing that would not survive contact with this
-- platform taken out.
--
-- Theirs hardcodes the plans in TypeScript:
--
--     export const TIER_LIMITS_GB: Record<TierPlan, TierLimitsGB> = {
--       common:    { storageGB: 10,    trafficGB: 10 },
--       rare:      { storageGB: 100,   trafficGB: 100 },
--       ...
--     }
--
-- Four plan names and two metered dimensions, compiled in. Changing a price or
-- adding a dimension is a release. Here plans are rows and dimensions are rows,
-- so a new plan is an insert and a new thing to meter is an insert — neither is
-- a deploy.
--
-- What is kept from theirs, because it is the good part: a business that goes
-- over its limit is NOT cut off. It enters a grace period, gets warned, and is
-- only restricted when the grace period runs out. See lib/billing.js.

create table if not exists billing_plan (
    key             text primary key,
    name            text not null,
    description     text,
    price_monthly   numeric(10,2) not null default 0,
    currency        text not null default 'usd',
    -- Sort order in the pricing table. Not an identity — renaming a plan or
    -- inserting one between two others must not renumber anything.
    sort_order      integer not null default 0,
    is_public       boolean not null default true,
    -- The plan a business gets when it has no subscription. Exactly one row
    -- should carry this; the partial unique index below enforces it.
    is_default      boolean not null default false,
    created_at      timestamptz not null default now()
);

create unique index if not exists billing_plan_one_default
    on billing_plan (is_default) where is_default;

-- What a plan is allowed to do, one row per metered thing.
--
-- `dimension` is free text on purpose. The API does not know what dimensions
-- exist, which is what lets "photos" or "device_pushes" or something invented
-- next month be metered without this file changing.
create table if not exists billing_plan_limit (
    plan_key        text not null references billing_plan(key) on delete cascade,
    dimension       text not null,
    -- null means unlimited. 0 means the feature is off, which is a different
    -- thing and must stay distinguishable.
    max_value       bigint,
    primary key (plan_key, dimension)
);

create table if not exists billing_subscription (
    entity_slug     text primary key,
    plan_key        text not null references billing_plan(key),
    status          text not null default 'active',
    started_at      timestamptz not null default now(),
    current_period_end timestamptz,
    -- Set the first time usage is observed over the limit, cleared the first
    -- time it is back under. The whole grace-period calculation hangs off this
    -- one column, which is why it is stored rather than derived: the clock has
    -- to survive a restart and a redeploy.
    limits_exceeded_since timestamptz,
    -- Whatever the payment processor calls this customer. Nothing in this
    -- schema assumes which processor; stripe.js and square.js already exist.
    provider        text,
    provider_ref    text,
    updated_at      timestamptz not null default now()
);

-- Observed usage, one row per business per dimension.
create table if not exists billing_usage (
    entity_slug     text not null,
    dimension       text not null,
    value           bigint not null default 0,
    observed_at     timestamptz not null default now(),
    primary key (entity_slug, dimension)
);

create index if not exists billing_usage_slug on billing_usage (entity_slug);

-- A free default so every business has a plan from the moment it signs up and
-- nothing has to special-case "no subscription". Priced plans are the
-- operator's to insert; this file ships none, because a price list in a
-- migration is the same mistake as a price list in TypeScript.
insert into billing_plan (key, name, description, price_monthly, sort_order, is_default)
values ('free', 'Free', 'Everything a business needs to be listed.', 0, 0, true)
on conflict (key) do nothing;
