-- ============================================================
-- ghost_nodes — a business's Ghost boxes, and the relay to reach them
-- ============================================================
--
-- A Ghost is a Linux box at the business, owned by the business. It never
-- accepts inbound connections. Instead it calls out to this API: it sends a
-- heartbeat, pulls requests the owner queued from the dashboard, and posts
-- the answers back. routes/nodes.js reads and writes these tables.
--
-- The node token is never stored; only sha256(token) is, like
-- business_mcp_tokens. token_hint is the last six characters for display.
-- The business (entity_slug) always comes from the owner's session or from
-- the node's own token — never from the request body.
--
-- Safe to re-run: create if not exists only.

create table if not exists public.ghost_nodes (
    id            uuid primary key default gen_random_uuid(),
    entity_slug   text        not null,
    name          text        not null default 'Ghost',
    token_hash    text        not null unique,
    token_hint    text        not null default '',
    version       text,
    health        jsonb,
    created_by    uuid,
    created_at    timestamptz not null default now(),
    last_seen_at  timestamptz,
    revoked_at    timestamptz
);

create index if not exists ghost_nodes_entity_slug_idx on public.ghost_nodes (entity_slug);

create table if not exists public.ghost_node_requests (
    id              uuid primary key default gen_random_uuid(),
    node_id         uuid        not null references public.ghost_nodes (id),
    entity_slug     text        not null,
    method          text        not null default 'GET',
    path            text        not null,
    body            jsonb,
    status          text        not null default 'queued',
    response_status integer,
    response_body   jsonb,
    created_by      uuid,
    created_at      timestamptz not null default now(),
    dispatched_at   timestamptz,
    completed_at    timestamptz,

    constraint ghost_node_requests_method_check check (method in ('GET', 'POST')),
    constraint ghost_node_requests_status_check check (status in ('queued', 'dispatched', 'done', 'failed'))
);

create index if not exists ghost_node_requests_node_status_idx
    on public.ghost_node_requests (node_id, status, created_at);

-- Only the API's service role touches these tables; nothing is granted to anon.
alter table public.ghost_nodes enable row level security;
alter table public.ghost_node_requests enable row level security;
