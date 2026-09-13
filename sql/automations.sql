-- ============================================================
-- AUTOMATION BUILDER — build once, push to every business dashboard
-- ============================================================
--
-- Five tables, all additive. Nothing existing is touched.
--
--   automations             the thing the operator builds: a trigger, a list
--                           of steps, and the settings a business may fill in.
--                           This row is the DRAFT — editing it changes nothing
--                           on any dashboard until it is published.
--
--   automation_versions     an immutable snapshot per publish. A business runs
--                           the version it has installed, never the draft, so
--                           an operator can keep editing without anything
--                           changing under a business until the next push.
--
--   automation_deployments  one row per push: which version, to whom, and how
--                           it went. This is the "cloud update" record.
--
--   entity_automations      one row per business per automation — the install.
--                           Carries the installed version, whether the business
--                           has it switched on, and the settings they chose.
--
--   automation_runs         every execution, with a per-step log. A run that
--                           quietly did nothing is the failure that actually
--                           happens, and it is invisible without this.
--
-- Two of these carry entity_slug. They are NOT business sections: the API's
-- schema discovery (lib/businessTables.js) holds them back so they never show
-- up as an editable table on a dashboard or through the generic writer — the
-- platform writes them on the business's behalf, through routes/automations.js.
--
-- Row-level security is switched on with no policies, which is the same state
-- the rest of the live database is in: the service key the API holds sees
-- everything, the anon and authenticated keys see nothing.
--
-- Safe to re-run.

create table if not exists public.automations (
    id             uuid primary key default gen_random_uuid(),
    key            text not null unique,                 -- stable handle, e.g. weekly-menu-reminder
    name           text not null,
    description    text,
    icon           text not null default '⚡',
    category       text not null default 'general',
    kind           text not null default 'automation',   -- automation | script
    trigger        jsonb not null default '{"type":"manual"}'::jsonb,
    steps          jsonb not null default '[]'::jsonb,
    config_schema  jsonb not null default '[]'::jsonb,   -- settings a business may fill in
    version        integer not null default 0,           -- last published version; 0 = never published
    status         text not null default 'draft',        -- draft | published | archived
    created_by     text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create table if not exists public.automation_versions (
    id             uuid primary key default gen_random_uuid(),
    automation_id  uuid not null references public.automations(id),
    version        integer not null,
    definition     jsonb not null,                       -- full snapshot: trigger, steps, config_schema, name…
    changelog      text,
    published_by   text,
    published_at   timestamptz not null default now(),
    unique (automation_id, version)
);

create table if not exists public.automation_deployments (
    id             uuid primary key default gen_random_uuid(),
    automation_id  uuid not null references public.automations(id),
    version        integer not null,
    audience       jsonb not null default '{"mode":"owners"}'::jsonb,
    status         text not null default 'done',         -- done | failed
    targeted       integer not null default 0,
    installed      integer not null default 0,           -- new installs
    updated        integer not null default 0,           -- existing installs moved to this version
    failed         integer not null default 0,
    notes          text,
    created_by     text,
    created_at     timestamptz not null default now(),
    finished_at    timestamptz
);

create table if not exists public.entity_automations (
    id               uuid primary key default gen_random_uuid(),
    entity_slug      text not null,
    automation_id    uuid not null references public.automations(id),
    version          integer not null,
    enabled          boolean not null default true,
    config           jsonb not null default '{}'::jsonb,   -- the business's own settings
    hook_token       text unique,                          -- inbound webhook credential, per install
    deployment_id    uuid,
    installed_at     timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    last_run_at      timestamptz,
    last_run_status  text,
    unique (entity_slug, automation_id)
);

create table if not exists public.automation_runs (
    id             uuid primary key default gen_random_uuid(),
    automation_id  uuid not null,
    entity_slug    text,
    version        integer,
    trigger        text not null default 'manual',       -- manual | schedule | event | webhook | test
    status         text not null default 'ok',           -- ok | failed | skipped
    dry_run        boolean not null default false,
    started_at     timestamptz not null default now(),
    finished_at    timestamptz,
    duration_ms    integer,
    steps_log      jsonb not null default '[]'::jsonb,
    output         jsonb,
    error          text
);

create index if not exists idx_automations_status          on public.automations (status);
create index if not exists idx_automation_versions_auto    on public.automation_versions (automation_id, version desc);
create index if not exists idx_automation_deployments_auto on public.automation_deployments (automation_id, created_at desc);
create index if not exists idx_entity_automations_slug     on public.entity_automations (entity_slug);
create index if not exists idx_entity_automations_auto     on public.entity_automations (automation_id, enabled);
create index if not exists idx_automation_runs_auto        on public.automation_runs (automation_id, started_at desc);
create index if not exists idx_automation_runs_slug        on public.automation_runs (entity_slug, started_at desc);

alter table public.automations            enable row level security;
alter table public.automation_versions    enable row level security;
alter table public.automation_deployments enable row level security;
alter table public.entity_automations     enable row level security;
alter table public.automation_runs        enable row level security;

revoke all on public.automations            from anon, authenticated;
revoke all on public.automation_versions    from anon, authenticated;
revoke all on public.automation_deployments from anon, authenticated;
revoke all on public.entity_automations     from anon, authenticated;
revoke all on public.automation_runs        from anon, authenticated;
