-- ============================================================
-- ghost_mcp_tokens — credentials for an agent to reach one enrolled Ghost
-- ============================================================
-- Tokens are scoped to one node, not just a business. Only SHA-256 hashes are
-- stored; raw tokens are returned once by POST /api/nodes/:id/mcp-token.
-- The API service role is the only reader/writer.

create table if not exists public.ghost_mcp_tokens (
    id           uuid primary key default gen_random_uuid(),
    node_id      uuid        not null references public.ghost_nodes (id) on delete cascade,
    entity_slug  text        not null,
    label        text        not null default 'Paperclip',
    token_hash   text        not null unique,
    token_hint   text        not null default '',
    created_by   uuid,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);

create index if not exists ghost_mcp_tokens_node_idx
    on public.ghost_mcp_tokens (node_id);

alter table public.ghost_mcp_tokens enable row level security;
revoke all on public.ghost_mcp_tokens from anon, authenticated;

comment on table public.ghost_mcp_tokens is
    'Hashed MCP credentials scoped to one Ghost node. Revoke by node/token id; revoking the Ghost also disables its agent credentials.';
