-- ############################################################################
-- ##  NOT YET APPLIED. Read sql/kernel/README.md first. Confirm the target  ##
-- ##  is "cyber check" (mkepugvdlktfsossumox). See HANDOFF.md.              ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 007 · THE SIX ECOSYSTEMS AND THEIR INSTALLS
-- ============================================================================
--
-- Six kinds of thing a business can add. They are not one thing with a `type`
-- column, and the temptation to merge them should be resisted every time it
-- comes up — each has different install mechanics, a different consent
-- conversation, and a different failure mode.
--
--   Data Modules   canonical business data. Menu, hours, rooms, fleet.
--   Ghost Apps     screens the business or its customers use.
--   Connections    an authorized account on an external tool.
--   Device Apps    software on a phone, tablet or kiosk they own.
--   Plugins        code that extends an app or the platform.
--   Automations    a trigger and a sequence of capabilities.
--
-- ── THE RULE THIS FILE EXISTS FOR ──────────────────────────────────────────
--
-- INSTALL CONTROLS VISIBILITY. No install row means no nav entry, no
-- permissions, no surface, no API route that will answer. Not a hidden menu
-- item — nothing.
--
-- Song Request is the test case. A bar installs it; it appears in their
-- dashboard, its customer-facing page starts answering, its permissions become
-- grantable to staff. A restaurant that never installed it has no trace of it
-- anywhere, and asking the API for it gets the same answer as asking for
-- something that does not exist.
--
-- ── WHAT ALREADY EXISTS AND IS NOT REBUILT ─────────────────────────────────
--
--   module_catalog        29 rows.    Data Module catalog. Reused as is.
--   platform_connections  1,070 rows. Connection catalog. Reused as is.
--   entity_connections    0 rows.     Connection installs. Reused as is.
--
--   apps / site_apps      0 rows each, keyed on site_id, from the generation
--                         before entity_slug. Superseded by app_catalog and
--                         entity_app_installs below. Left in place — they are
--                         empty, so nothing is lost by ignoring them, and
--                         dropping tables is not something this repo does.
--
-- Every install table below has the same shape on purpose: entity_slug, a
-- catalog key, status, settings, who installed it and when. One shape means
-- the manifest endpoint reads six tables with one query pattern, and a seventh
-- ecosystem — if one ever exists — is a table, not a redesign.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- GHOST APPS
-- ----------------------------------------------------------------------------
-- `surface` is the column that stops the two audiences being confused. An
-- owner-facing app is a dashboard screen. A customer-facing app is a public
-- page the bar's patrons load on their phones. Song Request is both, which is
-- why this is an array rather than a single value.
-- ----------------------------------------------------------------------------
create table if not exists public.app_catalog (
  app_key         text primary key check (app_key ~ '^[a-z][a-z0-9_-]*$'),
  name            text not null,
  tagline         text,
  description     text,
  category        text,
  icon            text,

  surfaces        text[] not null default array['owner']::text[],  -- owner, customer, staff, device, public
  entry_path      text,                  -- route the dashboard mounts it at
  public_path     text,                  -- route the public page is served at

  -- What it needs to work. An app that declares a capability it has no route
  -- for is installable and visibly degraded, not silently broken.
  required_capabilities text[] not null default array[]::text[],
  required_modules      text[] not null default array[]::text[],

  monthly_price   numeric(10,2),
  is_core         boolean not null default false,
  status          text not null default 'available'
                  check (status in ('draft','available','deprecated','withdrawn')),
  sort_order      integer not null default 1000,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.entity_app_installs (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null references public.entity(slug) on update cascade on delete cascade,
  app_key           text not null references public.app_catalog(app_key) on delete restrict,

  status            text not null default 'active'
                    check (status in ('active','suspended','uninstalled')),
  settings          jsonb not null default '{}'::jsonb,
  sort_order        integer not null default 1000,

  installed_by      uuid,
  installed_at      timestamptz not null default now(),
  uninstalled_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (entity_slug, app_key)
);

create index if not exists entity_app_installs_active_idx
  on public.entity_app_installs (entity_slug, sort_order) where status = 'active';

-- ----------------------------------------------------------------------------
-- DEVICE APPS
-- ----------------------------------------------------------------------------
-- Software running on hardware the business owns — the tablet on the table,
-- the kiosk by the door, the Android phone in the rack that drives an app no
-- vendor gave us an API for.
--
-- Kept separate from Ghost Apps because a device app has a physical install,
-- a device to be paired, and it can be offline. None of those are true of a
-- screen in a browser.
-- ----------------------------------------------------------------------------
create table if not exists public.device_app_catalog (
  device_app_key  text primary key check (device_app_key ~ '^[a-z][a-z0-9_-]*$'),
  name            text not null,
  description     text,
  platform        text not null
                  check (platform in ('android','ios','web_kiosk','desktop','embedded')),
  package_id      text,                  -- e.g. an Android package name
  min_version     text,
  icon            text,
  required_capabilities text[] not null default array[]::text[],
  status          text not null default 'available'
                  check (status in ('draft','available','deprecated','withdrawn')),
  sort_order      integer not null default 1000,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.entity_device_app_installs (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null references public.entity(slug) on update cascade on delete cascade,
  device_app_key    text not null references public.device_app_catalog(device_app_key) on delete restrict,
  device_id         text,                -- the specific unit, when it is one unit

  status            text not null default 'active'
                    check (status in ('active','suspended','uninstalled')),
  installed_version text,
  last_seen_at      timestamptz,
  settings          jsonb not null default '{}'::jsonb,

  installed_by      uuid,
  installed_at      timestamptz not null default now(),
  uninstalled_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (entity_slug, device_app_key, device_id)
);

create index if not exists entity_device_app_installs_active_idx
  on public.entity_device_app_installs (entity_slug) where status = 'active';

-- ----------------------------------------------------------------------------
-- PLUGINS
-- ----------------------------------------------------------------------------
-- Code that extends something else. A plugin declares what it hooks and where
-- it runs; nothing is loaded into the API process without both being stated.
-- ----------------------------------------------------------------------------
create table if not exists public.plugin_catalog (
  plugin_key      text primary key check (plugin_key ~ '^[a-z][a-z0-9_-]*$'),
  name            text not null,
  description     text,
  author          text,
  version         text,
  icon            text,

  extends_kind    text not null default 'platform'
                  check (extends_kind in ('platform','app','module','connection','automation')),
  extends_key     text,                  -- which one, when it extends a specific thing
  hooks           text[] not null default array[]::text[],

  -- Where the code runs. 'sandbox' is the default because third-party code
  -- getting the API's database credentials is the one mistake that ends this.
  runtime         text not null default 'sandbox'
                  check (runtime in ('sandbox','browser','edge','device')),
  source_url      text,
  integrity_hash  text,                  -- pinned build. Verified before load.

  required_capabilities text[] not null default array[]::text[],
  status          text not null default 'available'
                  check (status in ('draft','available','deprecated','withdrawn')),
  sort_order      integer not null default 1000,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.entity_plugin_installs (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null references public.entity(slug) on update cascade on delete cascade,
  plugin_key        text not null references public.plugin_catalog(plugin_key) on delete restrict,

  status            text not null default 'active'
                    check (status in ('active','suspended','uninstalled')),
  pinned_version    text,
  settings          jsonb not null default '{}'::jsonb,

  installed_by      uuid,
  installed_at      timestamptz not null default now(),
  uninstalled_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (entity_slug, plugin_key)
);

create index if not exists entity_plugin_installs_active_idx
  on public.entity_plugin_installs (entity_slug) where status = 'active';

-- ----------------------------------------------------------------------------
-- AUTOMATIONS
-- ----------------------------------------------------------------------------
-- A trigger and a sequence of capabilities. The catalog holds the template the
-- platform ships; the install holds one business's configured copy, which is
-- why the install carries `steps` of its own — an owner who reorders the steps
-- has not created a new catalog entry.
--
-- Automations run as an actor. Everything they do goes through the same policy
-- and receipt path as a human click, which is what stops an automation from
-- being a way around ASK.
-- ----------------------------------------------------------------------------
create table if not exists public.automation_catalog (
  automation_key  text primary key check (automation_key ~ '^[a-z][a-z0-9_-]*$'),
  name            text not null,
  description     text,
  category        text,
  icon            text,

  trigger_kind    text not null
                  check (trigger_kind in ('event','schedule','webhook','manual','condition')),
  trigger_config  jsonb not null default '{}'::jsonb,
  steps           jsonb not null default '[]'::jsonb,   -- ordered capability_keys plus inputs

  required_capabilities text[] not null default array[]::text[],
  status          text not null default 'available'
                  check (status in ('draft','available','deprecated','withdrawn')),
  sort_order      integer not null default 1000,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.entity_automation_installs (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null references public.entity(slug) on update cascade on delete cascade,
  automation_key    text not null references public.automation_catalog(automation_key) on delete restrict,

  status            text not null default 'active'
                    check (status in ('active','paused','suspended','uninstalled')),
  trigger_config    jsonb not null default '{}'::jsonb,
  steps             jsonb,               -- null means "as shipped"
  settings          jsonb not null default '{}'::jsonb,

  last_run_at       timestamptz,
  last_run_status   text,
  run_count         integer not null default 0,

  installed_by      uuid,
  installed_at      timestamptz not null default now(),
  uninstalled_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (entity_slug, automation_key)
);

create index if not exists entity_automation_installs_active_idx
  on public.entity_automation_installs (entity_slug) where status = 'active';

-- ----------------------------------------------------------------------------
-- DATA MODULES — presence is not a preference
-- ----------------------------------------------------------------------------
-- `entity_modules` holds 37,847 rows across roughly 4,000 businesses: a
-- module_key, an `enabled` flag and a sort order per business. It reads as an
-- install table and it is not one, because it was populated by writing a
-- preset list of modules against every business rather than by anyone
-- installing anything. A business with `enabled = true` for a module it has
-- never put a single row into is not using that module.
--
-- The correction: a Data Module is DISCOVERED. If a business has menu rows,
-- they have a menu. Presence comes from the data existing, not from a flag
-- saying it should.
--
-- What is genuinely a preference — the order sections appear in, whether one
-- is pinned or hidden, per-module settings — is real and survives. It moves
-- here, to a table whose name says what it is.
--
-- `entity_modules` is NOT dropped, renamed or emptied. Routes still read it.
-- It stops being consulted once the manifest endpoint ships, and it can be
-- reconsidered then, with the new table already carrying anything worth
-- keeping.
-- ----------------------------------------------------------------------------
create table if not exists public.entity_module_preferences (
  id            uuid primary key default gen_random_uuid(),
  entity_slug   text not null references public.entity(slug) on update cascade on delete cascade,
  module_key    text not null references public.module_catalog(module_key) on delete cascade,

  -- Not "enabled". A business cannot disable data it has; it can choose not to
  -- look at it, which is a different and much smaller claim.
  is_hidden     boolean not null default false,
  is_pinned     boolean not null default false,
  sort_order    integer not null default 1000,
  display_name  text,                    -- an owner renaming "Menu" to "Food"
  settings      jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (entity_slug, module_key)
);

create index if not exists entity_module_preferences_entity_idx
  on public.entity_module_preferences (entity_slug, sort_order);

-- Carry across the only part of entity_modules that was a real choice: the
-- order. `enabled` is deliberately not carried — it never meant what its name
-- said, and importing it would launder a preset back in as a decision.
insert into public.entity_module_preferences (entity_slug, module_key, sort_order, settings)
select m.entity_slug, m.module_key, coalesce(m.sort_order, 1000), coalesce(m.settings, '{}'::jsonb)
from public.entity_modules m
join public.module_catalog c on c.module_key = m.module_key
join public.entity e on e.slug = m.entity_slug
on conflict (entity_slug, module_key) do nothing;

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'app_catalog','entity_app_installs',
    'device_app_catalog','entity_device_app_installs',
    'plugin_catalog','entity_plugin_installs',
    'automation_catalog','entity_automation_installs',
    'entity_module_preferences'
  ] loop
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
