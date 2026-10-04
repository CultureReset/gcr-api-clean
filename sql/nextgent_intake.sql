-- ============================================================
-- NEXT GENT — forwarded-email intake: confirmations, senders, payments
-- (plan §9 "How data comes in", build step 7)
-- ============================================================
--
-- forwarding_confirmation_rules   how to recognise a mail provider's
--                                 "confirm forwarding" email: who sends it,
--                                 and where the code and link are. Rows, so a
--                                 new provider is an insert, not a deploy.
--                                 Patterns are case-insensitive regexes; the
--                                 first capture group is the value.
-- forwarding_confirmations        a confirmation that arrived at a business's
--                                 forwarding address: the code and link the
--                                 owner needs in onboarding.
-- intake_known_senders            who forwards mail into a business. A sender
--                                 not here (or not approved) waits for review
--                                 and the owner is told; approving it
--                                 processes what was held.
-- email_parser_log.intake_state   processed | held (unknown sender) | review
-- email_parser_log.raw_html       the html part of a held email, so html-only
-- email_webhook_log.raw_html      mail can be read after approval
-- payments_detected              payments read from forwarded email
--                                 ('claimed' until matched) or from a signed
--                                 provider webhook ('verified').
--
-- Additive only. Safe to re-run.

create table if not exists public.forwarding_confirmation_rules (
    provider          text primary key,
    label             text not null,
    from_pattern      text not null,
    subject_pattern   text,
    code_pattern      text,
    link_pattern      text,
    mailbox_pattern   text,
    enabled           boolean not null default true,
    updated_at        timestamptz not null default now()
);

-- The two providers the plan names. Their senders and formats are the
-- providers' own; edit these rows when a provider changes its email.
insert into public.forwarding_confirmation_rules
    (provider, label, from_pattern, subject_pattern, code_pattern, link_pattern, mailbox_pattern)
values
    ('gmail', 'Gmail',
     'forwarding-noreply@google\.com',
     'forwarding confirmation',
     '(?:confirmation code|\(#)\s*:?\s*(\d{6,12})',
     '(https://mail(?:-settings)?\.google\.com/\S+)',
     '([^\s<>()]+@[^\s<>()]+) has requested to automatically forward'),
    ('outlook', 'Outlook',
     '@(?:[a-z0-9-]+\.)*(?:microsoft|outlook|live)\.com',
     '(?:verify|forward)',
     '(?:security code|verification code|code)\s*:?\s*(\d{4,10})',
     '(https://(?:[a-z0-9-]+\.)*(?:microsoft|live|outlook)\.com/\S+)',
     null)
on conflict (provider) do nothing;

create table if not exists public.forwarding_confirmations (
    id              uuid primary key default gen_random_uuid(),
    entity_slug     text not null,
    provider        text not null,
    code            text,
    link            text,
    mailbox         text,
    from_email      text,
    subject         text,
    received_at     timestamptz not null default now(),
    used_at         timestamptz
);

create index if not exists forwarding_confirmations_slug_idx
    on public.forwarding_confirmations (entity_slug, received_at desc);

create table if not exists public.intake_known_senders (
    id              uuid primary key default gen_random_uuid(),
    entity_slug     text not null,
    sender          text not null,
    status          text not null default 'pending',
    example_subject text,
    first_seen_at   timestamptz not null default now(),
    decided_at      timestamptz,
    decided_by      text,

    constraint intake_known_senders_status_check check (status in ('pending', 'approved', 'blocked')),
    unique (entity_slug, sender)
);

alter table public.email_parser_log add column if not exists intake_state text;

-- A held email must be readable later exactly as it would have been read on
-- arrival, so held rows keep the whole body: raw_text (the text part) and
-- raw_html (the html part, for html-only mail). Processed rows keep the
-- truncated text they always did.
alter table public.email_parser_log add column if not exists raw_html text;
alter table if exists public.email_webhook_log add column if not exists raw_html text;

-- Seed known senders from what has already worked: every sender whose
-- forwarded email a business has read into a booking before this table
-- existed is approved for that business, so applying this file does not
-- stop the forwards that were working. Derived from the parser's own log;
-- no sender is named here. Which senders are held is the owner's rule and
-- is not changed by this.
insert into public.intake_known_senders (entity_slug, sender, status, example_subject, first_seen_at, decided_at, decided_by)
select l.entity_slug,
       s.sender,
       'approved',
       min(l.subject),
       coalesce(min(l.created_at), now()),
       now(),
       'seed:email_parser_log'
from public.email_parser_log l
cross join lateral (
    select lower(trim(coalesce(substring(l.from_email from '<([^>]+)>'), l.from_email))) as sender
) s
where l.entity_slug is not null
  and l.parsed is true
  and l.event_date is not null
  and coalesce(l.manual, false) is false
  and coalesce(l.bulk, false) is false
  and s.sender like '%@%'
group by l.entity_slug, s.sender
on conflict (entity_slug, sender) do nothing;

create table if not exists public.payments_detected (
    id              uuid primary key default gen_random_uuid(),
    entity_slug     text not null,
    amount_cents    integer,
    currency        text,
    payer           text,
    source          text not null,
    status          text not null default 'claimed',
    reference       text,
    received_at     timestamptz not null default now(),
    details         jsonb not null default '{}'::jsonb,

    constraint payments_detected_status_check check (status in ('claimed', 'verified', 'refunded')),
    unique (entity_slug, source, reference)
);

create index if not exists payments_detected_slug_idx on public.payments_detected (entity_slug, received_at desc);

alter table public.forwarding_confirmation_rules enable row level security;
alter table public.forwarding_confirmations      enable row level security;
alter table public.intake_known_senders          enable row level security;
alter table public.payments_detected             enable row level security;
revoke all on public.forwarding_confirmation_rules from anon, authenticated;
revoke all on public.forwarding_confirmations      from anon, authenticated;
revoke all on public.intake_known_senders          from anon, authenticated;
revoke all on public.payments_detected             from anon, authenticated;

notify pgrst, 'reload schema';
