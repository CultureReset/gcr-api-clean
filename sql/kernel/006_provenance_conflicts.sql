-- ############################################################################
-- ##  NOT YET APPLIED. Read sql/kernel/README.md first. Confirm the target  ##
-- ##  is "cyber check" (mkepugvdlktfsossumox). See HANDOFF.md.              ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 006 · PROVENANCE AND CONFLICTS
-- ============================================================================
--
-- Google says the restaurant closes at 9. Yelp says 10. Their own website says
-- 9:30 and the sign on the door says something else again. All four are
-- "the hours."
--
-- A platform that promises one update everywhere has to survive meeting a
-- business for the first time, when everywhere already disagrees. There are
-- only two honest ways to handle that, and picking wrong poisons the canonical
-- record permanently:
--
--   Overwrite silently with whichever source was read last. Fast, and the
--   business's real hours are now whatever a scraper happened to see.
--
--   Record every observation with where it came from, notice when they
--   disagree, and ask the one person who actually knows.
--
-- This file is the second one.
--
-- `entity_sources` already exists and tracks provenance at the SOURCE level —
-- this slug was seen on this system at this URL. That is not enough to resolve
-- a conflict, because a conflict is about one FIELD. These tables go a level
-- finer without replacing it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- FIELD-LEVEL OBSERVATIONS
-- ----------------------------------------------------------------------------
-- Append only. An observation is a historical fact — "on this date, Google
-- said this" — and it stays true even after the value changes. Nothing here is
-- ever updated in place; a newer reading is a new row.
--
-- `field_path` is the canonical dotted path, the same vocabulary the Field Map
-- uses to translate between our shape and each tool's shape. It is what makes
-- an observation from Google comparable to one from Toast at all.
-- ----------------------------------------------------------------------------
create table if not exists public.source_field_observations (
  id              uuid primary key default gen_random_uuid(),
  entity_slug     text not null references public.entity(slug) on update cascade on delete cascade,

  field_path      text not null,          -- 'hours.monday.close', 'profile.phone'
  value_json      jsonb,                  -- the value, in canonical shape
  value_text      text,                   -- as literally seen, before parsing

  source_system   text not null,          -- 'google_business','yelp','website','owner','toast'
  source_url      text,
  source_kind     text not null default 'observed'
                  check (source_kind in ('observed','declared','inferred','imported')),

  -- 'declared' by the owner outranks anything 'observed' by a crawler. This is
  -- the ranking the conflict resolver reads; it is not a free-text note.
  authority_rank  integer not null default 100,   -- lower is more authoritative
  confidence      numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  observed_at     timestamptz not null default now(),
  collector       text,                   -- which crawler, agent or import produced it
  evidence_path   text,                   -- object storage pointer, if any
  created_at      timestamptz not null default now()
);

create index if not exists source_field_observations_lookup_idx
  on public.source_field_observations (entity_slug, field_path, observed_at desc);

create index if not exists source_field_observations_source_idx
  on public.source_field_observations (source_system, observed_at desc);

-- ----------------------------------------------------------------------------
-- CONFLICTS
-- ----------------------------------------------------------------------------
-- Raised when two live observations of the same field disagree and no rule
-- settles it. One open conflict per field per business — that is the partial
-- unique index below, and it is what stops a nightly crawl from generating the
-- same question forty times.
--
-- A conflict is a question put to a person. It is not an error.
-- ----------------------------------------------------------------------------
create table if not exists public.data_conflicts (
  id                  uuid primary key default gen_random_uuid(),
  entity_slug         text not null references public.entity(slug) on update cascade on delete cascade,
  field_path          text not null,

  status              text not null default 'open'
                      check (status in ('open','resolved','ignored','superseded')),

  detected_at         timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  occurrences         integer not null default 1,

  -- Set when resolved. `canonical_value_json` is the answer, and it is what
  -- gets written to the business's real record and pushed everywhere.
  resolved_at         timestamptz,
  resolved_by_user_id uuid,
  resolution_kind     text check (resolution_kind in ('owner_chose','owner_entered','rule','auto_highest_authority')),
  canonical_value_json jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists data_conflicts_one_open_per_field_idx
  on public.data_conflicts (entity_slug, field_path) where status = 'open';

create index if not exists data_conflicts_open_idx
  on public.data_conflicts (entity_slug, detected_at desc) where status = 'open';

-- ----------------------------------------------------------------------------
-- THE CHOICES
-- ----------------------------------------------------------------------------
-- What the owner is shown: each distinct value, where it came from, when it was
-- seen. The screen renders these rows directly, so what is stored is exactly
-- what was offered — which matters later, when someone asks why they picked it.
-- ----------------------------------------------------------------------------
create table if not exists public.data_conflict_options (
  id              uuid primary key default gen_random_uuid(),
  conflict_id     uuid not null references public.data_conflicts(id) on delete cascade,
  observation_id  uuid references public.source_field_observations(id) on delete set null,

  value_json      jsonb,
  display_value   text not null,          -- rendered for a human: "Closes 9:00 PM"
  source_system   text not null,
  source_url      text,
  observed_at     timestamptz,
  authority_rank  integer not null default 100,

  is_selected     boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists data_conflict_options_conflict_idx
  on public.data_conflict_options (conflict_id, authority_rank);

-- At most one selected option per conflict.
create unique index if not exists data_conflict_options_one_selected_idx
  on public.data_conflict_options (conflict_id) where is_selected;

-- ----------------------------------------------------------------------------
-- WHAT IS WAITING ON THE OWNER
-- ----------------------------------------------------------------------------
create or replace view public.data_conflicts_open as
select
  c.id,
  c.entity_slug,
  c.field_path,
  c.detected_at,
  c.occurrences,
  count(o.id) as option_count,
  string_agg(distinct o.source_system, ', ' order by o.source_system) as sources
from public.data_conflicts c
left join public.data_conflict_options o on o.conflict_id = c.id
where c.status = 'open'
group by c.id, c.entity_slug, c.field_path, c.detected_at, c.occurrences
order by c.detected_at;

comment on view public.data_conflicts_open is
  'Fields where the sources disagree and nobody has decided. Each row is a question for the business owner, not an error.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'data_conflicts_touch_updated_at'
      and tgrelid = 'public.data_conflicts'::regclass
  ) then
    create trigger data_conflicts_touch_updated_at
      before update on public.data_conflicts
      for each row execute function public.kernel_touch_updated_at();
  end if;
end
$$;
