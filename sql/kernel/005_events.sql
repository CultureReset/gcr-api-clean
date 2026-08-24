-- ############################################################################
-- ##  NOT YET APPLIED. Read sql/kernel/README.md first. Confirm the target  ##
-- ##  is "cyber check" (mkepugvdlktfsossumox). See HANDOFF.md.              ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 005 · THE EVENT LOG
-- ============================================================================
--
-- "Update once, land everywhere" is an event problem, not an integration
-- problem. The owner changes their hours in one place. What happens next —
-- Google Business updated, the QR menu on the table updated, the website
-- updated — must not be a list of calls hardcoded into whatever handled the
-- edit. The moment it is, adding a seventh destination means editing the code
-- that saved the hours, and that code becomes the place every integration goes
-- to die.
--
-- So the edit emits one fact: `business.hours.changed`. Everything downstream
-- subscribes. A new destination is a subscriber, not a patch to the writer.
--
-- ── Ordering ───────────────────────────────────────────────────────────────
--
-- `id` is a bigint identity and it, not occurred_at, is the order. Timestamps
-- from a fleet of nodes are not monotonic and two events in the same
-- millisecond are ordinary. A consumer resumes from the last id it processed.
--
-- ── Correlation ────────────────────────────────────────────────────────────
--
-- correlation_id ties everything caused by one human action together — the
-- edit, the six jobs, the six receipts. causation_id names the single event
-- that directly produced this one. With both, "why did this post go out?"
-- resolves to a person and a click, however many hops back that is.
-- ============================================================================

create table if not exists public.platform_events (
  id              bigint generated always as identity primary key,
  event_id        uuid not null unique default gen_random_uuid(),

  event_type      text not null
                  check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  schema_version  integer not null default 1,

  -- Scope. Both nullable: a platform-level event belongs to no business.
  entity_slug     text references public.entity(slug) on update cascade on delete set null,
  workspace_id    uuid references public.workspaces(id) on delete set null,

  -- Who or what caused it.
  actor_kind      text not null default 'system'
                  check (actor_kind in ('user','agent','system','device','customer','integration')),
  actor_id        text,

  -- What it happened to. Loose on purpose: this log spans every table, and a
  -- foreign key here would mean one column per table.
  subject_table   text,
  subject_id      text,

  payload         jsonb not null default '{}'::jsonb,

  correlation_id  uuid,
  causation_id    uuid,

  occurred_at     timestamptz not null default now(),
  recorded_at     timestamptz not null default now()
);

create index if not exists platform_events_type_idx
  on public.platform_events (event_type, id desc);

create index if not exists platform_events_entity_idx
  on public.platform_events (entity_slug, id desc) where entity_slug is not null;

create index if not exists platform_events_correlation_idx
  on public.platform_events (correlation_id) where correlation_id is not null;

create index if not exists platform_events_subject_idx
  on public.platform_events (subject_table, subject_id) where subject_table is not null;

-- ----------------------------------------------------------------------------
-- CONSUMER POSITIONS
-- ----------------------------------------------------------------------------
-- Where each consumer has read to. One row per consumer, updated in the same
-- transaction as its work, which is what makes replay after a crash produce
-- the same result rather than a second social post.
-- ----------------------------------------------------------------------------
create table if not exists public.event_consumers (
  consumer_key    text primary key,
  display_name    text,
  last_event_id   bigint not null default 0,
  event_types     text[],                -- null means every type
  status          text not null default 'active'
                  check (status in ('active','paused','failed')),
  last_error      text,
  last_read_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'event_consumers_touch_updated_at'
      and tgrelid = 'public.event_consumers'::regclass
  ) then
    create trigger event_consumers_touch_updated_at
      before update on public.event_consumers
      for each row execute function public.kernel_touch_updated_at();
  end if;
end
$$;
