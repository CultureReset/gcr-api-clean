-- ============================================================
-- NEXT GENT — computers: QR pairing, remote view, receipts (plan §11)
-- ============================================================
--
-- node_pairings          the TV sign-in (OAuth device flow): the computer's
--                        device code and the short code it shows, both as
--                        hashes; the owner approves the short code for their
--                        business; the computer collects its node token once
--                        (held sealed until then, erased after).
-- node_remote_sessions   short-lived links to view a computer's screen.
-- ghost_node_requests    + paperclip_task_id: the Paperclip task an
--                        instruction belongs to (plan §11 "one path to the
--                        computer"); + receipt_posted_at / receipt_error:
--                        whether the result went back to Paperclip as a
--                        receipt (POST /api/nextgent/receipts).
--
-- Needs sql/ghost_nodes.sql (and ghost_mcp_tokens.sql). Additive only. Safe
-- to re-run.

create table if not exists public.node_pairings (
    id                uuid primary key default gen_random_uuid(),
    device_code_hash  text not null unique,
    user_code_hash    text not null,
    name              text,
    status            text not null default 'pending',
    entity_slug       text,
    node_id           uuid,
    token_sealed      text,
    expires_at        timestamptz not null,
    approved_at       timestamptz,
    approved_by       text,
    collected_at      timestamptz,
    created_at        timestamptz not null default now(),

    constraint node_pairings_status_check check (status in ('pending', 'approved', 'collected'))
);

create index if not exists node_pairings_user_code_idx on public.node_pairings (user_code_hash) where status = 'pending';

create table if not exists public.node_remote_sessions (
    id           uuid primary key default gen_random_uuid(),
    node_id      uuid not null,
    entity_slug  text not null,
    token_hash   text not null unique,
    expires_at   timestamptz not null,
    revoked_at   timestamptz,
    created_by   text,
    created_at   timestamptz not null default now()
);

alter table public.ghost_node_requests add column if not exists paperclip_task_id text;
alter table public.ghost_node_requests add column if not exists receipt_posted_at timestamptz;
alter table public.ghost_node_requests add column if not exists receipt_error     text;

alter table public.node_pairings        enable row level security;
alter table public.node_remote_sessions enable row level security;
revoke all on public.node_pairings        from anon, authenticated;
revoke all on public.node_remote_sessions from anon, authenticated;

notify pgrst, 'reload schema';
