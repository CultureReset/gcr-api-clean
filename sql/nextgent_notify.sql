-- ============================================================
-- NEXT GENT — owner notifications (plan §6, step 4)
-- ============================================================
--
-- owner_notify_settings   where a business's owner wants to hear about the
--                         review queue, unknown senders, approvals and failed
--                         actions. Without a row, lib/notify.js falls back to
--                         the listing's own email and phone.
-- owner_notifications     one row per notification sent (or skipped, with the
--                         reason), so a quiet notifier is visible.
--
-- Additive only. Safe to re-run.

create table if not exists public.owner_notify_settings (
    entity_slug  text primary key,
    email        text,
    phone        text,
    email_on     boolean not null default true,
    sms_on       boolean not null default true,
    muted_kinds  text[] not null default '{}',
    updated_at   timestamptz not null default now()
);

create table if not exists public.owner_notifications (
    id           uuid primary key default gen_random_uuid(),
    entity_slug  text not null,
    kind         text not null,
    ref          text,
    title        text not null,
    channels     jsonb not null default '{}'::jsonb,
    created_at   timestamptz not null default now()
);

create index if not exists owner_notifications_slug_idx
    on public.owner_notifications (entity_slug, created_at desc);
create index if not exists owner_notifications_ref_idx
    on public.owner_notifications (entity_slug, kind, ref)
    where ref is not null;

alter table public.owner_notify_settings enable row level security;
alter table public.owner_notifications   enable row level security;
revoke all on public.owner_notify_settings from anon, authenticated;
revoke all on public.owner_notifications   from anon, authenticated;

notify pgrst, 'reload schema';
