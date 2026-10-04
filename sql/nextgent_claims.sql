-- ============================================================
-- NEXT GENT — claim codes (plan §5, "Claiming a listed business")
-- ============================================================
--
-- A code sent to the listing's own phone, by text or by an automated call when
-- the number cannot take texts. Only an HMAC of the code is stored. Attempts
-- are counted so a six-digit code cannot be walked.
--
-- The admin-review fallback does not use this table: it files a row in the
-- existing business_claims (see sql/nextgent_link.sql for its new columns).
--
-- Additive only. Safe to re-run.

create table if not exists public.claim_codes (
    id                 uuid primary key default gen_random_uuid(),
    company_id         text not null,
    paperclip_user_id  text,
    entity_slug        text not null,
    phone              text not null,
    channel            text not null,
    code_hash          text not null,
    attempts           integer not null default 0,
    expires_at         timestamptz not null,
    verified_at        timestamptz,
    created_at         timestamptz not null default now(),

    constraint claim_codes_channel_check check (channel in ('sms', 'voice'))
);

create index if not exists claim_codes_company_idx on public.claim_codes (company_id, created_at desc);
create index if not exists claim_codes_slug_idx    on public.claim_codes (entity_slug);

alter table public.claim_codes enable row level security;
revoke all on public.claim_codes from anon, authenticated;

notify pgrst, 'reload schema';
