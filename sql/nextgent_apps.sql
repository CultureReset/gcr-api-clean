-- ============================================================
-- NEXT GENT — installed apps: app-owned records
-- ============================================================
--
-- CONTRACT §14. Paperclip is the authority for what is installed, at which
-- version, enabled and entitled. gcr-api-clean keeps a projection of each
-- installed app so public pages and the app's own screens render without
-- calling Paperclip per visit. That projection is an entity_modules row
-- (sql/nextgent_entity_modules.sql, Step 3 contract §B). This file keeps:
--
--   app_records              the records an app keeps for itself (its
--                            manifest's data.tables), scoped by install and
--                            business; one table for every app, no database
--                            per app. `data` holds the declared columns.
--
-- Written and read only through routes/nextgent.js and routes/app-data.js
-- (service key). It carries entity_slug and is held back from the generic
-- business sections by lib/businessTables.js PLATFORM_TABLES / app_records.
--
-- Needs nextgent_installs.sql. Additive only. Safe to re-run.

-- superseded by nextgent_entity_modules.sql
--
-- business_app_instances was the first home of the projection. Nothing reads
-- or writes it any more (lib/appInstances.js is on entity_modules); where it
-- was applied it stays as it is — this repo drops nothing (npm run check:sql).
-- Its DDL, for the record:
--
--   create table if not exists public.business_app_instances (
--       install_id      text primary key references public.nextgent_installs (install_id),
--       entity_slug     text not null,
--       company_id      text not null,
--       app_key         text not null,
--       version         text,
--       enabled         boolean not null default true,
--       public_enabled  boolean not null default true,
--       render_mode     text not null default 'inline',
--       public_label    text,
--       config          jsonb not null default '{}'::jsonb,
--       position        integer,
--       manifest        jsonb,
--       created_at      timestamptz not null default now(),
--       updated_at      timestamptz not null default now(),
--       constraint business_app_instances_render_mode_check check (render_mode in ('inline', 'button', 'page'))
--   );
--   create index if not exists business_app_instances_slug_idx on public.business_app_instances (entity_slug, position);
--   alter table public.business_app_instances enable row level security;
--   revoke all on public.business_app_instances from anon, authenticated;

create table if not exists public.app_records (
    id          uuid primary key default gen_random_uuid(),
    install_id  text not null references public.nextgent_installs (install_id),
    entity_slug text not null,
    app_table   text not null,
    data        jsonb not null default '{}'::jsonb,
    source      text not null default 'owner',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint app_records_source_check check (source in ('owner', 'visitor'))
);

create index if not exists app_records_install_table_idx on public.app_records (install_id, app_table, created_at desc);
create index if not exists app_records_slug_idx on public.app_records (entity_slug);

alter table public.app_records enable row level security;
revoke all on public.app_records from anon, authenticated;

notify pgrst, 'reload schema';
