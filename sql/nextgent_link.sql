-- ============================================================
-- NEXT GENT — the business link (CONTRACT §1, §4, §6)
-- ============================================================
--
-- One Paperclip company is one business. company_links is the only place that
-- says which: middleware/ownerAuth.js resolves a Paperclip token's company_id
-- through it, exactly as it resolves a Supabase session through entity_owners.
-- The slug is never taken from the request.
--
-- Also here, because they are part of the same step:
--
--   platform_admins.paperclip_user_id   an instance admin is honoured only if
--                                       their Paperclip user id is listed.
--   business_mcp_tokens.permissions     resource:action list. NULL keeps the
--                                       legacy behaviour of `scope`.
--   business_mcp_tokens.install_id      the store install a token belongs to.
--   business_mcp_tokens.company_id      the Paperclip company it was issued to.
--   business_claims.paperclip_*         who asked, so an admin approval of a
--                                       review claim can create the link.
--
-- Needs sql/business_mcp_tokens.sql and sql/business_claims_entity_slug.sql
-- first (see sql/ORDER.md). Additive only. Safe to re-run.

create table if not exists public.company_links (
    company_id  text primary key,
    entity_slug text unique not null,
    linked_at   timestamptz default now(),
    linked_by   text
);

alter table public.company_links enable row level security;
revoke all on public.company_links from anon, authenticated;

comment on table public.company_links is
    'Paperclip company -> entity_slug, one row per linked business. Written only by gcr-api-clean (routes/nextgent.js, routes/claims.js, admin claim approval).';

-- Instance admins, by their Paperclip user id. Nullable: existing rows are
-- Supabase users and keep working through the Supabase path.
alter table public.platform_admins
    add column if not exists paperclip_user_id text;

create unique index if not exists platform_admins_paperclip_user_idx
    on public.platform_admins (paperclip_user_id)
    where paperclip_user_id is not null;

-- Business token permissions (CONTRACT §6).
alter table public.business_mcp_tokens
    add column if not exists permissions text[];
alter table public.business_mcp_tokens
    add column if not exists install_id text;
alter table public.business_mcp_tokens
    add column if not exists company_id text;

create index if not exists business_mcp_tokens_install_idx
    on public.business_mcp_tokens (install_id)
    where install_id is not null;
create index if not exists business_mcp_tokens_company_idx
    on public.business_mcp_tokens (company_id)
    where company_id is not null;

comment on column public.business_mcp_tokens.permissions is
    'resource:action list (business, menu, availability, bookings, events, reviews, transactions, messages x read, write, send). NULL = legacy, governed by scope.';

-- Who filed a claim from Paperclip, so approving it can link the company.
alter table public.business_claims
    add column if not exists paperclip_company_id text;
alter table public.business_claims
    add column if not exists paperclip_user_id text;

notify pgrst, 'reload schema';
