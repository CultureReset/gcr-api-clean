-- ============================================================
-- business_mcp_tokens — the keys an AI assistant connects with
-- ============================================================
--
-- One row per MCP client a business has authorised. routes/mcp.js reads this
-- to decide which business a request acts as, and whether it may write.
--
-- The token itself is never stored. Only sha256(token) is, so a leak of this
-- table does not hand anybody a working key — and a lost token is replaced,
-- not recovered. token_hint is the last six characters, purely so a dashboard
-- can show which row is which.
--
-- Safe to re-run.

create table if not exists public.business_mcp_tokens (
    id           uuid primary key default gen_random_uuid(),
    entity_slug  text        not null,
    label        text        not null default 'AI assistant',
    token_hash   text        not null unique,
    token_hint   text        not null default '',
    scope        text        not null default 'read',
    created_by   uuid,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,

    -- Read or write, nothing else. A typo in the API would otherwise become a
    -- scope nobody checks, which reads as "not write" and fails open on reads.
    constraint business_mcp_tokens_scope_check check (scope in ('read', 'write'))
);

-- Every sign-in is a lookup by hash, so this is the index that matters. The
-- unique constraint above already provides it; named here for clarity.
create index if not exists business_mcp_tokens_slug_idx
    on public.business_mcp_tokens (entity_slug);

-- Only gcr-api-clean reads this table, and it holds the service key, which
-- bypasses RLS. Enabling RLS with no policy therefore changes nothing for the
-- API and closes the table to anon and authenticated entirely — which is the
-- point: a browser must never be able to list credential rows, even hashed.
alter table public.business_mcp_tokens enable row level security;

revoke all on public.business_mcp_tokens from anon, authenticated;

comment on table public.business_mcp_tokens is
    'MCP client credentials, one per AI assistant a business has authorised. Hashes only — see routes/mcp.js.';
