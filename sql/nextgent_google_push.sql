-- ============================================================
-- NEXT GENT — pushing facts to Google, reading Google's copy back (plan §9)
-- ============================================================
--
-- google_fact_sources   which business tables carry which fact Google shows
--                       (hours, special_hours, attributes, menus, services,
--                       posts). Rows, so a new section maps with an insert.
-- google_attribute_map  our attribute key -> Google's attribute id, per the
--                       field catalogue (plan §9 "Fields come from the same
--                       catalog"). Empty until the catalogue is filled.
-- google_push_queue     one pending push per business and fact (the latest
--                       data is read when it is sent), one per post.
--                       status: pending | done | blocked | failed | skipped.
-- google_push_state     per business: verified (Voice of Merchant) and when
--                       it was checked, the edit window, last push and error.
-- fact_source_ranks     how much each source is trusted (higher wins):
--                       owner > verified API > forwarded email > calendar feed
--                       > Google's copy > public source.
-- fact_observations     every reading of a fact from a source; Google's copy
--                       read back after each push. differs_from_ours marks a
--                       suggested edit for the owner to review.
--
-- Additive only. Safe to re-run.

create table if not exists public.google_fact_sources (
    table_name  text primary key,
    kind        text not null,
    constraint google_fact_sources_kind_check check (kind in ('hours', 'special_hours', 'attributes', 'menus', 'services', 'posts'))
);

insert into public.google_fact_sources (table_name, kind) values
    ('entity_hours', 'hours'),
    ('hours_exceptions', 'special_hours'),
    ('entity_attributes', 'attributes'),
    ('menu_items', 'menus'),
    ('services', 'services'),
    ('entity_social_posts', 'posts')
on conflict (table_name) do nothing;

create table if not exists public.google_attribute_map (
    attribute_key        text primary key,
    google_attribute_id  text not null,
    value_type           text not null default 'BOOL'
);

create table if not exists public.google_push_queue (
    id               uuid primary key default gen_random_uuid(),
    entity_slug      text not null,
    kind             text not null,
    ref              text not null default '',
    status           text not null default 'pending',
    payload          jsonb,
    attempts         integer not null default 0,
    last_error       text,
    queued_at        timestamptz not null default now(),
    next_attempt_at  timestamptz,
    pushed_at        timestamptz,

    constraint google_push_queue_status_check check (status in ('pending', 'done', 'blocked', 'failed', 'skipped'))
);

create unique index if not exists google_push_queue_one_pending
    on public.google_push_queue (entity_slug, kind, ref) where status = 'pending';
create index if not exists google_push_queue_due_idx on public.google_push_queue (queued_at) where status = 'pending';

create table if not exists public.google_push_state (
    entity_slug          text primary key,
    verified             boolean,
    verified_checked_at  timestamptz,
    window_start         timestamptz,
    edits_in_window      integer not null default 0,
    last_push_at         timestamptz,
    last_error           text,
    updated_at           timestamptz not null default now()
);

create table if not exists public.fact_source_ranks (
    source  text primary key,
    rank    integer not null
);

insert into public.fact_source_ranks (source, rank) values
    ('owner', 100),
    ('verified_api', 80),
    ('forwarded_email', 60),
    ('calendar_feed', 40),
    ('google', 20),
    ('public', 10)
on conflict (source) do nothing;

create table if not exists public.fact_observations (
    id                 uuid primary key default gen_random_uuid(),
    entity_slug        text not null,
    fact               text not null,
    source             text not null,
    trust_rank         integer,
    value              jsonb,
    differs_from_ours  boolean,
    review_status      text,
    observed_at        timestamptz not null default now()
);

create index if not exists fact_observations_slug_idx on public.fact_observations (entity_slug, fact, observed_at desc);

alter table public.google_fact_sources  enable row level security;
alter table public.google_attribute_map enable row level security;
alter table public.google_push_queue    enable row level security;
alter table public.google_push_state    enable row level security;
alter table public.fact_source_ranks    enable row level security;
alter table public.fact_observations    enable row level security;
revoke all on public.google_fact_sources  from anon, authenticated;
revoke all on public.google_attribute_map from anon, authenticated;
revoke all on public.google_push_queue    from anon, authenticated;
revoke all on public.google_push_state    from anon, authenticated;
revoke all on public.fact_source_ranks    from anon, authenticated;
revoke all on public.fact_observations    from anon, authenticated;

notify pgrst, 'reload schema';
