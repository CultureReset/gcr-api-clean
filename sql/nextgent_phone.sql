-- ============================================================
-- NEXT GENT — phone: verification codes (more below as the
-- Phone Agent pieces land)
-- ============================================================
--
-- phone_verification_codes   one-time codes texted through lib/telephony
--                            (lib/phoneVerification.js). Only an HMAC of the
--                            code is stored; asking again consumes the last.
--
-- Additive only. Safe to re-run.

create table if not exists public.phone_verification_codes (
    id           uuid primary key default gen_random_uuid(),
    phone        text not null,
    purpose      text not null,
    code_hash    text not null,
    expires_at   timestamptz not null,
    attempts     integer not null default 0,
    consumed_at  timestamptz,
    created_at   timestamptz not null default now()
);

create index if not exists phone_verification_codes_live_idx
    on public.phone_verification_codes (phone, purpose, created_at desc)
    where consumed_at is null;

alter table public.phone_verification_codes enable row level security;
revoke all on public.phone_verification_codes from anon, authenticated;

-- business_phone_numbers   a number bought for a business (a Phone Agent
--                          install). registration_status is the texting
--                          registration (US A2P 10DLC), an outside process:
--                          not_started | pending | approved | rejected. It is
--                          set by whoever handles the filing, never assumed;
--                          a business texts from its number only once it is
--                          approved (lib/messages.js).

create table if not exists public.business_phone_numbers (
    id                    uuid primary key default gen_random_uuid(),
    entity_slug           text not null,
    company_id            text,
    install_id            text,
    phone_number          text not null unique,
    provider              text not null,
    provider_ref          text,
    purpose               text not null default 'phone_agent',
    status                text not null default 'active',
    registration_status   text not null default 'not_started',
    registration_ref      text,
    registration_note     text,
    registration_updated_at timestamptz,
    charged               boolean not null default false,
    created_at            timestamptz not null default now(),
    released_at           timestamptz,

    constraint business_phone_numbers_status_check check (status in ('active', 'released', 'failed')),
    constraint business_phone_numbers_registration_check
        check (registration_status in ('not_started', 'pending', 'approved', 'rejected'))
);

create index if not exists business_phone_numbers_slug_idx    on public.business_phone_numbers (entity_slug);
create index if not exists business_phone_numbers_install_idx on public.business_phone_numbers (install_id);

alter table public.business_phone_numbers enable row level security;
revoke all on public.business_phone_numbers from anon, authenticated;

notify pgrst, 'reload schema';

-- forwarding_codes   how an owner forwards their own line to the Phone
--                    Agent number, per network type. {e164} and {national}
--                    are filled with the number. These are the standard
--                    network codes (GSM supplementary-service codes, and the
--                    *72 family many North American carriers use); a carrier
--                    with its own codes is another row.
create table if not exists public.forwarding_codes (
    key                text primary key,
    label              text not null,
    network            text,
    when_forwarded     text,
    enable_template    text not null,
    disable_template   text,
    note               text,
    sort_order         integer not null default 100
);

insert into public.forwarding_codes (key, label, network, when_forwarded, enable_template, disable_template, sort_order) values
    ('gsm-unanswered',   'Forward calls you do not answer',     'gsm',  'no_answer',   '**61*{e164}#', '##61#', 10),
    ('gsm-busy',         'Forward calls when you are busy',      'gsm',  'busy',        '**67*{e164}#', '##67#', 20),
    ('gsm-unreachable',  'Forward calls when your phone is off', 'gsm',  'unreachable', '**62*{e164}#', '##62#', 30),
    ('gsm-all',          'Forward every call',                   'gsm',  'always',      '**21*{e164}#', '##21#', 40),
    ('star72-all',       'Forward every call',                   'star', 'always',      '*72{national}', '*73',  50),
    ('star71-unanswered','Forward calls you do not answer',      'star', 'no_answer',   '*71{national}', '*73',  60)
on conflict (key) do nothing;

-- nextgent_installs: what the install payload said about itself, so the live
-- handlers (routes/telephony-live.js) know the agent's instructions.
alter table public.nextgent_installs add column if not exists capabilities text[] not null default '{}';
alter table public.nextgent_installs add column if not exists instructions text;

alter table public.forwarding_codes enable row level security;
revoke all on public.forwarding_codes from anon, authenticated;

notify pgrst, 'reload schema';

-- live_conversations   one call or text conversation answered live by the
--                      concierge or a Phone Agent (routes/telephony-live.js):
--                      who called whom, the transcript, the voice loop's
--                      state, and whether it was recorded to Paperclip
--                      (POST /api/nextgent/conversations).
create table if not exists public.live_conversations (
    id                uuid primary key default gen_random_uuid(),
    channel           text not null,
    mode              text not null,
    entity_slug       text,
    company_id        text,
    from_number       text,
    to_number         text,
    provider_ref      text unique,
    transcript        jsonb not null default '[]'::jsonb,
    tool_calls        jsonb not null default '[]'::jsonb,
    status            text not null default 'open',
    state             text,
    transcribing      boolean not null default false,
    outcome           text,
    started_at        timestamptz not null default now(),
    last_activity_at  timestamptz not null default now(),
    ended_at          timestamptz,
    recorded_at       timestamptz,
    record_error      text,

    constraint live_conversations_channel_check check (channel in ('voice', 'sms')),
    constraint live_conversations_status_check  check (status in ('open', 'closed'))
);

create index if not exists live_conversations_open_sms_idx
    on public.live_conversations (from_number, to_number, last_activity_at desc) where status = 'open';

-- nextgent_ai_keys   the LiteLLM key a company's live calls run on, made once
--                    with the master key and kept sealed (lib/litellm.js).
create table if not exists public.nextgent_ai_keys (
    company_id  text primary key,
    key_sealed  text not null,
    created_at  timestamptz not null default now()
);

alter table public.live_conversations enable row level security;
alter table public.nextgent_ai_keys   enable row level security;
revoke all on public.live_conversations from anon, authenticated;
revoke all on public.nextgent_ai_keys   from anon, authenticated;

notify pgrst, 'reload schema';
