-- ============================================================
-- NEXT GENT — messages a business sends and receives (CONTRACT §6, plan §8)
-- ============================================================
--
-- message_threads     one conversation per business, channel and customer.
--                     mode 'agent' lets agents and automations answer;
--                     'owner' means the owner took it over and nothing
--                     automatic sends into it until they hand it back.
-- business_messages   every message in and out: owner, agent, automation,
--                     customer. status: draft | pending_approval | queued |
--                     sent | failed | blocked | received. A blocked message
--                     says why (status_reason), e.g. no consent on file.
-- message_consent     a customer's yes (or later no) to texts from one
--                     business. Texts go only to a phone with consent here
--                     or an sms_consent opt-in (booking_opt_ins), and never
--                     to one in sms_opt_outs.
--
-- All three carry entity_slug but are platform rows, written through
-- lib/messages.js (lib/businessTables.js PLATFORM_TABLES holds them back from
-- the generic section writer).
--
-- Additive only. Safe to re-run.

create table if not exists public.message_threads (
    id                uuid primary key default gen_random_uuid(),
    entity_slug       text not null,
    channel           text not null,
    customer_address  text not null,
    mode              text not null default 'agent',
    taken_over_at     timestamptz,
    taken_over_by     text,
    last_message_at   timestamptz,
    created_at        timestamptz not null default now(),

    constraint message_threads_channel_check check (channel in ('email', 'sms', 'voice')),
    constraint message_threads_mode_check    check (mode in ('agent', 'owner')),
    unique (entity_slug, channel, customer_address)
);

create table if not exists public.business_messages (
    id                   uuid primary key default gen_random_uuid(),
    entity_slug          text not null,
    thread_id            uuid,
    channel              text not null,
    direction            text not null,
    customer_address     text not null,
    business_address     text,
    subject              text,
    body                 text not null,
    status               text not null,
    status_reason        text,
    author               text not null,
    install_id           text,
    automation_run_id    text,
    provider_message_id  text,
    edited_at            timestamptz,
    sent_at              timestamptz,
    created_at           timestamptz not null default now(),

    constraint business_messages_channel_check   check (channel in ('email', 'sms', 'voice')),
    constraint business_messages_direction_check check (direction in ('in', 'out')),
    constraint business_messages_status_check    check (status in ('draft', 'pending_approval', 'queued', 'sent', 'failed', 'blocked', 'received'))
);

create index if not exists business_messages_thread_idx on public.business_messages (thread_id, created_at);
create index if not exists business_messages_slug_idx   on public.business_messages (entity_slug, created_at desc);
create index if not exists message_threads_slug_idx     on public.message_threads (entity_slug, last_message_at desc);

create table if not exists public.message_consent (
    id            uuid primary key default gen_random_uuid(),
    entity_slug   text not null,
    channel       text not null default 'sms',
    phone         text not null,
    status        text not null default 'granted',
    source        text,
    consent_text  text,
    recorded_by   text,
    recorded_at   timestamptz not null default now(),

    constraint message_consent_status_check check (status in ('granted', 'revoked')),
    unique (entity_slug, channel, phone)
);

alter table public.message_threads   enable row level security;
alter table public.business_messages enable row level security;
alter table public.message_consent   enable row level security;
revoke all on public.message_threads   from anon, authenticated;
revoke all on public.business_messages from anon, authenticated;
revoke all on public.message_consent   from anon, authenticated;

notify pgrst, 'reload schema';
