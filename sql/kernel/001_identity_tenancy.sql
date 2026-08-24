-- ############################################################################
-- ##  NOT YET APPLIED.                                                      ##
-- ##                                                                        ##
-- ##  Before running anything in sql/kernel/, read sql/kernel/README.md and ##
-- ##  confirm the target is Supabase project "cyber check"                  ##
-- ##  (ref mkepugvdlktfsossumox) by checking that `platform_connections`    ##
-- ##  exists. Two other projects on this account hold stale copies of       ##
-- ##  `entity` and will look plausible. See HANDOFF.md.                     ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 001 · IDENTITY AND TENANCY
-- ============================================================================
--
-- Today a logged-in person resolves to a business through `entity_owners`, and
-- `entity_owners` has zero rows. That single fact is why nothing in the owner
-- dashboard can work: middleware/ownerAuth.js looks the caller up, finds
-- nothing, and every handler downstream has no slug to filter on.
--
-- It also takes `.limit(1)`, so the moment a person owns two businesses the
-- answer is whichever row Postgres hands back first. That is not a bug you can
-- fix with an ORDER BY — a person who owns three restaurants needs to say
-- which one they are acting as, and that choice needs somewhere to live.
--
-- So this file adds the layer above a business:
--
--   workspace          one customer account. Holds one business or fifty.
--   workspace_members  who is in it, and as what.
--   workspace_entities which businesses it contains.
--   roles              named bundles of permissions.
--   role_permissions   the bundle contents, keyed to permission_catalog.
--
-- `entity_owners` is not replaced. It stays as the direct person → business
-- grant, and gains the constraints that make ownerAuth's lookup deterministic.
--
-- Nothing here drops, renames or rewrites an existing table. Every statement
-- is create-if-not-exists or add-column-if-not-exists, and every insert is
-- on-conflict-do-nothing, so running it twice changes nothing the second time.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Shared touch trigger. Every kernel table with an updated_at uses this one
-- function rather than each carrying its own copy.
-- ----------------------------------------------------------------------------
create or replace function public.kernel_touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- WORKSPACES
-- ----------------------------------------------------------------------------
-- A workspace is the billing and membership boundary. `organization_id` in the
-- ID list from Flow_.html is this. There is deliberately no separate
-- organization table: a second container above this one would have no columns
-- of its own today and every join would pay for it.
-- ----------------------------------------------------------------------------
create table if not exists public.workspaces (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text unique,
  owner_user_id     uuid not null,
  plan_key          text,
  status            text not null default 'active'
                    check (status in ('active','suspended','closed')),
  settings          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists workspaces_owner_user_id_idx
  on public.workspaces (owner_user_id);

-- ----------------------------------------------------------------------------
-- ROLES AND ROLE PERMISSIONS
-- ----------------------------------------------------------------------------
-- `permission_catalog` already exists and is keyed by a text permission_key.
-- Roles are named bundles over it. A role is scoped: a workspace role governs
-- membership and billing, an entity role governs one business's data.
--
-- `is_system` marks the roles this platform depends on by name. A customer may
-- add their own; they may not delete these.
-- ----------------------------------------------------------------------------
create table if not exists public.roles (
  role_key      text primary key,
  name          text not null,
  description   text,
  scope         text not null default 'entity'
                check (scope in ('workspace','entity','platform')),
  is_system     boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_key        text not null references public.roles(role_key) on delete cascade,
  permission_key  text not null references public.permission_catalog(permission_key) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (role_key, permission_key)
);

insert into public.roles (role_key, name, description, scope, is_system, sort_order) values
  ('workspace_owner', 'Workspace owner', 'Owns the account. Billing, members, every business in it.', 'workspace', true, 10),
  ('workspace_admin', 'Workspace admin', 'Everything except billing and closing the account.',        'workspace', true, 20),
  ('owner',           'Owner',           'Full control of one business.',                             'entity',    true, 30),
  ('manager',         'Manager',         'Day-to-day operation. No billing, no member changes.',      'entity',    true, 40),
  ('staff',           'Staff',           'Works inside installed apps. Cannot install or connect.',   'entity',    true, 50),
  ('viewer',          'Viewer',          'Read only.',                                                'entity',    true, 60),
  ('platform_admin',  'Platform admin',  'Ghost staff. Checked against platform_admins, not this.',   'platform',  true, 90)
on conflict (role_key) do nothing;

-- ----------------------------------------------------------------------------
-- WORKSPACE MEMBERSHIP
-- ----------------------------------------------------------------------------
-- `user_id` is a Supabase auth.users id. It is not declared as a foreign key
-- into auth.users on purpose: that schema is owned by Supabase, and a cascade
-- across a schema boundary we do not control is a bad trade for a constraint
-- the API already enforces on the way in.
-- ----------------------------------------------------------------------------
create table if not exists public.workspace_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null,
  role_key      text not null references public.roles(role_key),
  status        text not null default 'active'
                check (status in ('invited','active','suspended','removed')),
  invited_by    uuid,
  invited_at    timestamptz,
  joined_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists workspace_members_user_id_idx
  on public.workspace_members (user_id) where status = 'active';

-- ----------------------------------------------------------------------------
-- WHICH BUSINESSES A WORKSPACE CONTAINS
-- ----------------------------------------------------------------------------
-- Keyed on entity.slug, which carries a unique constraint, because slug is the
-- identifier every handler in this API already filters on. entity_id is
-- carried alongside it so a join to entity does not have to go through text.
--
-- A business belongs to exactly one workspace. If a business ever needs to be
-- shared across two accounts, that is a grant, not a second home, and it goes
-- somewhere else.
-- ----------------------------------------------------------------------------
create table if not exists public.workspace_entities (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  entity_slug   text not null references public.entity(slug) on update cascade on delete cascade,
  entity_id     uuid references public.entity(id) on delete cascade,
  is_primary    boolean not null default false,
  added_by      uuid,
  created_at    timestamptz not null default now(),
  unique (entity_slug)
);

create index if not exists workspace_entities_workspace_id_idx
  on public.workspace_entities (workspace_id);

-- One primary business per workspace: this is what the dashboard opens on when
-- the caller has not chosen. A partial unique index makes "at most one" a
-- database fact rather than something the API is trusted to remember.
create unique index if not exists workspace_entities_one_primary_idx
  on public.workspace_entities (workspace_id) where is_primary;

-- ----------------------------------------------------------------------------
-- ENTITY_OWNERS — the table that is empty
-- ----------------------------------------------------------------------------
-- Left in place, given the columns it needs to be trusted. It currently holds
-- zero rows, so every constraint below applies to an empty table and cannot
-- fail on existing data.
--
--   is_primary   gives ownerAuth's `.limit(1)` a defined answer instead of a
--                lucky one, until the workspace selector replaces it.
--   role         already exists; it now points at `roles` by name.
--   unique       one grant per person per business.
-- ----------------------------------------------------------------------------
alter table public.entity_owners
  add column if not exists is_primary boolean not null default false;

alter table public.entity_owners
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;

alter table public.entity_owners
  add column if not exists status text not null default 'active';

create unique index if not exists entity_owners_user_entity_idx
  on public.entity_owners (user_id, entity_slug);

create index if not exists entity_owners_entity_slug_idx
  on public.entity_owners (entity_slug);

-- One primary business per person, same reasoning as above.
create unique index if not exists entity_owners_one_primary_idx
  on public.entity_owners (user_id) where is_primary;

-- ----------------------------------------------------------------------------
-- PARENT AND CHILD BUSINESSES
-- ----------------------------------------------------------------------------
-- `entity.parent_entity_slug`, `is_parent` and `depth` already exist and are
-- already populated for some rows. What is missing is anything stopping a
-- typo: a parent slug that names no business, or a business that is its own
-- parent.
--
-- The foreign key is added NOT VALID. That enforces it on every future insert
-- and update while leaving the 4,000-odd existing rows unchecked, so this
-- cannot fail on data written before the rule existed. Validating it is a
-- separate, deliberate step:
--
--   alter table public.entity validate constraint entity_parent_entity_slug_fkey;
--
-- Run that only after `select slug, parent_entity_slug from entity where
-- parent_entity_slug is not null and parent_entity_slug not in (select slug
-- from entity)` comes back empty.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entity_parent_entity_slug_fkey'
      and conrelid = 'public.entity'::regclass
  ) then
    alter table public.entity
      add constraint entity_parent_entity_slug_fkey
      foreign key (parent_entity_slug) references public.entity(slug)
      on update cascade on delete set null
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'entity_not_its_own_parent'
      and conrelid = 'public.entity'::regclass
  ) then
    alter table public.entity
      add constraint entity_not_its_own_parent
      check (parent_entity_slug is null or parent_entity_slug <> slug)
      not valid;
  end if;
end
$$;

create index if not exists entity_parent_entity_slug_idx
  on public.entity (parent_entity_slug) where parent_entity_slug is not null;

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['workspaces','workspace_members'] loop
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
