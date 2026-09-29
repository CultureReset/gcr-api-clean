-- ============================================================
-- THE STORE — one catalog for everything the operator ships
-- ============================================================
--
-- An item is anything a business can be given: an app, a module, a map, a
-- parser, an automation pack, a Ghost box release. Every kind goes through the
-- same five steps, so there is one place to add, price, grant, publish and
-- push, not one per kind.
--
--   store_items        the thing: its key, kind, how it is reached (free, by
--                      plan, or by grant only), and which version is released
--                      to everyone.
--   store_versions     an immutable snapshot per publish: semver, the manifest
--                      (the cybercheck-marketplace app-manifest v1 shape for
--                      apps; kind-specific for the rest) and the changelog.
--   store_plan_items   which plan includes which item. Plans are billing_plan
--                      rows (sql/billing.sql), so the price and the entitlement
--                      live in one place.
--   store_grants       the operator giving one business one item by hand:
--                      a pilot, a comp, a partner. Can expire or be revoked.
--   store_installs     one row per business per item: the installed version,
--                      the version offered to it early (a staged rollout), the
--                      permissions it accepted, its settings. A business that
--                      was offered an item it has not installed yet has a row
--                      with status 'offered'.
--   store_deployments  one row per push: what, which version, to whom, how,
--                      and how it went.
--
-- A business may see and install an item when it is released (or offered to
-- it) AND it is entitled: the item is free, or its plan includes it, or it
-- holds a live grant. lib/entitlements.js is the one copy of that rule.
--
-- store_installs and store_grants carry entity_slug but are written only by
-- routes/store.js; lib/businessTables.js holds them back from the generic
-- writer, the dashboard's sections and the MCP tools.
--
-- Row-level security on with no policies, like the rest of the database: the
-- API's service key sees everything, anon and authenticated see nothing.
--
-- Needs sql/billing.sql first (store_plan_items references billing_plan).
-- Additive only. Safe to re-run.

create table if not exists public.store_items (
    id                uuid primary key default gen_random_uuid(),
    key               text not null unique,
    kind              text not null,
    name              text not null,
    summary           text,
    description       text,
    icon              text,
    category          text,
    publisher         text not null default 'operator',
    access            text not null default 'plan',
    status            text not null default 'draft',
    latest_version    integer not null default 0,
    released_version  integer,
    created_by        uuid,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    constraint store_items_key_check    check (key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
    constraint store_items_kind_check   check (kind in ('app', 'module', 'map', 'parser', 'automation', 'box_release', 'integration')),
    constraint store_items_access_check check (access in ('free', 'plan', 'grant')),
    constraint store_items_status_check check (status in ('draft', 'published', 'archived'))
);

create table if not exists public.store_versions (
    id            uuid primary key default gen_random_uuid(),
    item_id       uuid not null references public.store_items (id),
    version       integer not null,
    semver        text not null,
    manifest      jsonb not null default '{}'::jsonb,
    permissions   text[] not null default '{}',
    changelog     text,
    published_by  uuid,
    published_at  timestamptz not null default now(),

    constraint store_versions_unique unique (item_id, version),
    constraint store_versions_semver_unique unique (item_id, semver)
);

create table if not exists public.store_plan_items (
    plan_key  text not null references public.billing_plan (key) on delete cascade,
    item_id   uuid not null references public.store_items (id) on delete cascade,
    primary key (plan_key, item_id)
);

create table if not exists public.store_grants (
    id           uuid primary key default gen_random_uuid(),
    entity_slug  text not null,
    item_id      uuid not null references public.store_items (id),
    note         text,
    expires_at   timestamptz,
    revoked_at   timestamptz,
    granted_by   uuid,
    created_at   timestamptz not null default now()
);

create index if not exists store_grants_slug_idx on public.store_grants (entity_slug);
create unique index if not exists store_grants_live_idx
    on public.store_grants (entity_slug, item_id) where revoked_at is null;

create table if not exists public.store_deployments (
    id           uuid primary key default gen_random_uuid(),
    item_id      uuid not null references public.store_items (id),
    version      integer not null,
    action       text not null,
    audience     jsonb not null,
    status       text not null default 'running',
    targeted     integer not null default 0,
    applied      integer not null default 0,
    skipped      integer not null default 0,
    failed       integer not null default 0,
    notes        text,
    created_by   uuid,
    created_at   timestamptz not null default now(),
    finished_at  timestamptz,

    constraint store_deployments_action_check check (action in ('offer', 'install', 'force', 'release')),
    constraint store_deployments_status_check check (status in ('running', 'done', 'failed'))
);

create table if not exists public.store_installs (
    id                    uuid primary key default gen_random_uuid(),
    entity_slug           text not null,
    item_id               uuid not null references public.store_items (id),
    version               integer not null,
    offered_version       integer,
    status                text not null default 'installed',
    granted_permissions   text[] not null default '{}',
    config                jsonb not null default '{}'::jsonb,
    deployment_id         uuid references public.store_deployments (id),
    installed_by          uuid,
    installed_at          timestamptz not null default now(),
    updated_at            timestamptz not null default now(),

    constraint store_installs_unique unique (entity_slug, item_id),
    constraint store_installs_status_check check (status in ('offered', 'installed', 'disabled', 'uninstalled'))
);

create index if not exists store_installs_item_idx on public.store_installs (item_id, status);

alter table public.store_items       enable row level security;
alter table public.store_versions    enable row level security;
alter table public.store_plan_items  enable row level security;
alter table public.store_grants      enable row level security;
alter table public.store_deployments enable row level security;
alter table public.store_installs    enable row level security;

revoke all on public.store_items       from anon, authenticated;
revoke all on public.store_versions    from anon, authenticated;
revoke all on public.store_plan_items  from anon, authenticated;
revoke all on public.store_grants      from anon, authenticated;
revoke all on public.store_deployments from anon, authenticated;
revoke all on public.store_installs    from anon, authenticated;
