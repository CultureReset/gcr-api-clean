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

notify pgrst, 'reload schema';
