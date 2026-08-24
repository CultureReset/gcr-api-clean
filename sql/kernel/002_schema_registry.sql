-- ############################################################################
-- ##  NOT YET APPLIED. Read sql/kernel/README.md first. Confirm the target  ##
-- ##  is "cyber check" (mkepugvdlktfsossumox) — `platform_connections`      ##
-- ##  exists there and nowhere else. See HANDOFF.md.                        ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 002 · THE TABLE REGISTRY
-- ============================================================================
--
-- lib/businessTables.js decides what a business can see with one line:
--
--     if (!props || !hasOwnProperty(props, 'entity_slug')) continue;
--
-- Any table with an entity_slug column is a section of the owner dashboard.
-- That was a good trade when the database was small — add a table, it appears,
-- no deploy. It does not survive what this platform is becoming, for three
-- reasons, and all three are already true today:
--
--   1. There are 319 columns named entity_slug in this database. A tenant key
--      is not the same claim as "a business should see this." An app's private
--      working table is scoped to a business AND must never appear in nav.
--
--   2. Visibility is a second axis, not the same one. `menu_items` is
--      per-business and PUBLIC. `booking_payments` is per-business and
--      FINANCIAL. Both pass the entity_slug test identically.
--
--   3. It fails open. Create a table with an entity_slug column and it is
--      exposed the instant PostgREST notices it — no review, no permission,
--      no decision. The failure mode of a discovery rule should be
--      "invisible", never "visible."
--
-- So the registry below becomes the source of truth, and the discovery rule
-- becomes how rows get PROPOSED to it. A table that PostgREST can see but that
-- nobody has classified lands as UNCLASSIFIED, and UNCLASSIFIED is invisible.
-- The dashboard shows nothing new until a person says what a thing is.
--
-- Two axes, held separately on purpose:
--
--   classification    what the table IS
--   visibility_class  who may see what is in it
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLE REGISTRY
-- ----------------------------------------------------------------------------
create table if not exists public.table_registry (
  schema_name       text not null default 'public',
  table_name        text not null,

  -- What the table is.
  classification    text not null default 'UNCLASSIFIED'
                    check (classification in (
                      'UNCLASSIFIED',        -- discovered, nobody has said. Invisible.
                      'DATA_MODULE',         -- canonical business truth. Menu, hours, rooms.
                      'APP_PRIVATE',         -- a Ghost App's own working storage.
                      'CUSTOMER_SUBMISSION', -- written by the public. Song requests, reviews.
                      'PLATFORM_INTERNAL',   -- Ghost's own bookkeeping. Never a business section.
                      'SYSTEM'               -- Postgres/Supabase/PostgREST plumbing.
                    )),

  -- Who may see it. Orthogonal to the above — a DATA_MODULE can be PUBLIC or
  -- FINANCIAL, and the answer is not derivable from the classification.
  visibility_class  text not null default 'SYSTEM_INTERNAL'
                    check (visibility_class in (
                      'PUBLIC',               -- safe to serve to anyone, unauthenticated.
                      'PUBLIC_SAFE_DERIVED',  -- aggregate or redacted view of private data.
                      'BUSINESS_PRIVATE',     -- the owner and their staff.
                      'CUSTOMER_PRIVATE',     -- one end customer's own rows.
                      'STAFF_PRIVATE',        -- employees. Schedules, notes, HR.
                      'FINANCIAL',            -- money. Narrower than BUSINESS_PRIVATE.
                      'AUTH_SECRET',          -- tokens, keys, credentials. Never leaves the API.
                      'SYSTEM_INTERNAL'       -- not exposed by any tenant-facing route.
                    )),

  -- How a row in this table is attached to a business. Three generations of
  -- this database disagree — site_id, business_id, entity_slug — and naming
  -- the column per table is what lets one query layer read all of them.
  tenant_column     text
                    check (tenant_column is null or tenant_column in
                          ('entity_slug','entity_id','site_id','business_id','workspace_id')),

  -- Nav. A table can be a DATA_MODULE and still not be its own screen, because
  -- it hangs off another one (menu_item_options under menu_items).
  is_business_section boolean not null default false,
  parent_table_name   text,
  module_key          text references public.module_catalog(module_key) on delete set null,

  -- Permissions, keyed to the catalog that already exists.
  read_permission_key   text references public.permission_catalog(permission_key) on delete set null,
  write_permission_key  text references public.permission_catalog(permission_key) on delete set null,

  display_name      text,
  description       text,
  sort_order        integer not null default 1000,

  -- A classification is a claim someone made. Unsigned claims stay UNCLASSIFIED.
  reviewed_by       uuid,
  reviewed_at       timestamptz,

  row_count_seen    bigint,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  primary key (schema_name, table_name)
);

create index if not exists table_registry_section_idx
  on public.table_registry (sort_order, table_name)
  where is_business_section and classification <> 'UNCLASSIFIED';

create index if not exists table_registry_module_key_idx
  on public.table_registry (module_key) where module_key is not null;

create index if not exists table_registry_unclassified_idx
  on public.table_registry (table_name) where classification = 'UNCLASSIFIED';

-- A reviewed row must actually say who reviewed it. Anything other than
-- UNCLASSIFIED is a decision, and a decision has an author.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'table_registry_reviewed_has_author'
      and conrelid = 'public.table_registry'::regclass
  ) then
    alter table public.table_registry
      add constraint table_registry_reviewed_has_author
      check (classification = 'UNCLASSIFIED' or reviewed_at is not null);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- COLUMN REGISTRY
-- ----------------------------------------------------------------------------
-- lib/businessTables.js also carries a hardcoded SYSTEM_COLUMNS set — id,
-- entity_slug, created_at, search_vector, embedding and so on — stripped from
-- every response. That set is right about those seven columns and silent about
-- every other one.
--
-- Visibility is per column, not per table. `entity` is the clearest case in
-- this database: name and address are PUBLIC, the owner's phone number is
-- BUSINESS_PRIVATE, and ical_token is AUTH_SECRET. One visibility_class on the
-- table cannot express that, and picking the strictest would hide the menu.
--
-- Same fail-closed rule, inverted to suit how columns actually behave: a
-- column with no row here inherits its table's visibility_class. Inheriting is
-- safe because the table default is already the conservative answer; what this
-- table exists for is to say when a column is MORE sensitive than its table.
-- ----------------------------------------------------------------------------
create table if not exists public.column_registry (
  schema_name      text not null default 'public',
  table_name       text not null,
  column_name      text not null,

  visibility_class text
                   check (visibility_class is null or visibility_class in (
                     'PUBLIC','PUBLIC_SAFE_DERIVED','BUSINESS_PRIVATE','CUSTOMER_PRIVATE',
                     'STAFF_PRIVATE','FINANCIAL','AUTH_SECRET','SYSTEM_INTERNAL'
                   )),

  is_system        boolean not null default false,  -- plumbing. Never rendered, never edited.
  is_readonly      boolean not null default false,  -- shown, but the API refuses writes.
  canonical_field  text,                            -- dotted canonical path, e.g. hours.monday.open
  display_name     text,
  form_control     text,
  sort_order       integer not null default 1000,

  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  primary key (schema_name, table_name, column_name),
  foreign key (schema_name, table_name)
    references public.table_registry (schema_name, table_name) on delete cascade
);

create index if not exists column_registry_canonical_field_idx
  on public.column_registry (canonical_field) where canonical_field is not null;

-- ----------------------------------------------------------------------------
-- DISCOVERY
-- ----------------------------------------------------------------------------
-- Every base table in `public` gets a registry row, with its tenant column
-- detected. Classification is left at UNCLASSIFIED, which means invisible —
-- so seeding this on a live database exposes nothing. It only makes the list
-- of undecided tables visible to the people who have to decide.
--
-- on conflict do nothing: re-running never overwrites a human's judgment.
-- ----------------------------------------------------------------------------
insert into public.table_registry (schema_name, table_name, tenant_column)
select
  t.table_schema,
  t.table_name,
  coalesce(
    max(case when c.column_name = 'entity_slug'  then 'entity_slug'  end),
    max(case when c.column_name = 'entity_id'    then 'entity_id'    end),
    max(case when c.column_name = 'business_id'  then 'business_id'  end),
    max(case when c.column_name = 'site_id'      then 'site_id'      end),
    max(case when c.column_name = 'workspace_id' then 'workspace_id' end)
  )
from information_schema.tables t
left join information_schema.columns c
  on c.table_schema = t.table_schema and c.table_name = t.table_name
where t.table_schema = 'public'
  and t.table_type = 'BASE TABLE'
group by t.table_schema, t.table_name
on conflict (schema_name, table_name) do nothing;

-- Mark the seven columns lib/businessTables.js already strips, so that the
-- rewrite reads them from here rather than from a constant in a JS file.
insert into public.column_registry (schema_name, table_name, column_name, is_system, visibility_class)
select c.table_schema, c.table_name, c.column_name, true, 'SYSTEM_INTERNAL'
from information_schema.columns c
join public.table_registry r
  on r.schema_name = c.table_schema and r.table_name = c.table_name
where c.table_schema = 'public'
  and c.column_name in ('id','entity_slug','entity_id','site_id','created_at',
                        'updated_at','search_vector','embedding')
on conflict (schema_name, table_name, column_name) do nothing;

-- ----------------------------------------------------------------------------
-- WHAT NOBODY HAS DECIDED YET
-- ----------------------------------------------------------------------------
-- A registry whose gaps are silent drifts back into a guess. This view is the
-- work queue: tables that are scoped to a business and still have no answer.
-- It should trend to empty and stay there.
-- ----------------------------------------------------------------------------
create or replace view public.table_registry_gaps as
select
  r.schema_name,
  r.table_name,
  r.tenant_column,
  r.first_seen_at,
  case
    when r.classification = 'UNCLASSIFIED' then 'never classified'
    when r.reviewed_at is null             then 'classified without a reviewer'
  end as gap
from public.table_registry r
where r.tenant_column is not null
  and (r.classification = 'UNCLASSIFIED' or r.reviewed_at is null)
order by r.table_name;

comment on view public.table_registry_gaps is
  'Business-scoped tables nobody has classified. Each row is invisible to every dashboard until someone decides what it is. This should be empty.';

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['table_registry','column_registry'] loop
    if not exists (
      select 1 from pg_trigger
      where tgname = t || '_touch_updated_at'
        and tgrelid = ('public.' || t)::regclass
    ) then
      execute format(
        'create trigger %I before update on public.%I
           for each row execute function public.kernel_touch_updated_at()',
        t || '_touch_updated_at', t
      );
    end if;
  end loop;
end
$$;
