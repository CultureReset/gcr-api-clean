-- ============================================================
-- NEXT GENT — store installs as gcr-api-clean sees them (CONTRACT §4)
-- ============================================================
--
-- Paperclip holds the catalog and the install record. gcr-api-clean keeps only
-- what it needs to enforce and bill an install:
--
--   install_id           Paperclip's id, the key for DELETE.
--   permissions          what the owner approved (also on the token row).
--   routine_webhook_*    for automation installs: where the "give to agent"
--                        step posts. The secret is stored encrypted
--                        (AES-256-GCM, key derived from NEXTGENT_SERVICE_SECRET).
--   status               active | removed. Part 2's automation engine reads it.
--
-- Additive only. Safe to re-run.

create table if not exists public.nextgent_installs (
    install_id                text primary key,
    company_id                text not null,
    entity_slug               text not null,
    item_key                  text not null,
    kind                      text not null,
    version                   text,
    permissions               text[] not null default '{}',
    routine_webhook_url       text,
    routine_webhook_secret    text,
    status                    text not null default 'active',
    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),
    removed_at                timestamptz,

    constraint nextgent_installs_kind_check   check (kind in ('agent', 'app', 'automation')),
    constraint nextgent_installs_status_check check (status in ('active', 'removed'))
);

create index if not exists nextgent_installs_company_idx on public.nextgent_installs (company_id);
create index if not exists nextgent_installs_slug_idx    on public.nextgent_installs (entity_slug);

alter table public.nextgent_installs enable row level security;
revoke all on public.nextgent_installs from anon, authenticated;

notify pgrst, 'reload schema';
