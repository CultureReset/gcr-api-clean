-- ############################################################################
-- ##  NOT YET APPLIED. Read sql/kernel/README.md first. Confirm the target  ##
-- ##  is "cyber check" (mkepugvdlktfsossumox). See HANDOFF.md.              ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 003 · CAPABILITIES, IMPLEMENTATIONS AND ROUTES
-- ============================================================================
--
-- ── A NAMING COLLISION, READ THIS FIRST ────────────────────────────────────
--
-- This repository already uses the word "capability" for something else.
-- routes/capabilities.js and sql/capability_tables.sql mean a business's
-- INVENTORY — vessels, trips, gear, spaces. "This marina has the capability to
-- run charters." That is a real, working meaning and it is not going away.
--
-- Everything in THIS file means the other thing: a verb the platform can
-- perform on a business's behalf. `business.hours.update`. `social.post.publish`.
--
-- The two never share a table, and every table here is prefixed `capability_`
-- with a dotted-key primary key, so a `capability_key` and a `capability_id`
-- are visibly different things at a glance. If the collision ever causes a
-- real mistake, this layer renames to `action_*`, not the inventory one — the
-- inventory tables are the ones with customers' data in them.
--
-- ── WHAT THIS LAYER IS ─────────────────────────────────────────────────────
--
-- Three tables, three questions, deliberately not merged:
--
--   capability_catalog          WHAT can be asked for.       (global)
--   capability_implementations  HOW it can be carried out.   (global)
--   execution_routes            WHO does it for THIS business. (per tenant)
--
-- Splitting HOW from WHO is the whole point. "Publish a social post" is one
-- request. It can land through a browser driving a web UI, through an Android
-- phone tapping a real app, or through a vendor API — and which one is right
-- depends on the business, on what they have connected, and on which route
-- was working this morning. A caller asks for the capability. It is this
-- layer's job, not the caller's, to know that today it goes out over Android
-- because the web UI changed last Tuesday.
--
-- That is also why a route can be reordered and disabled per business without
-- a deploy: when a provider breaks, the fix is a row, not a release.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- CAPABILITY CATALOG
-- ----------------------------------------------------------------------------
-- Dotted keys, `domain.object.verb`. They are read by people in permission
-- screens and audit logs, so every one carries a display_label written for a
-- restaurant owner rather than for us.
--
-- `default_policy` is the platform's opinion, not the answer. The answer comes
-- from the policy engine at request time, which may narrow AUTO to ASK for a
-- given business. It may never widen NEVER.
-- ----------------------------------------------------------------------------
create table if not exists public.capability_catalog (
  capability_key    text primary key
                    check (capability_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  display_label     text not null,
  description       text,
  domain            text not null,        -- business, social, sms, browser, android, …
  verb              text not null,        -- read, update, publish, send, run, open

  is_sensitive      boolean not null default false,
  is_write          boolean not null default true,

  -- What the platform will do when nobody has said otherwise.
  default_policy    text not null default 'ASK'
                    check (default_policy in ('AUTO','ASK','NEVER')),
  risk_tier         text not null default 'medium'
                    check (risk_tier in ('low','medium','high','critical')),

  -- Whether a receipt for this capability may be issued without a read-back.
  -- Default false: execution is not evidence. See 004.
  requires_verification boolean not null default true,

  input_schema      jsonb,                -- JSON Schema for the request payload
  output_schema     jsonb,
  permission_key    text references public.permission_catalog(permission_key) on delete set null,

  active            boolean not null default true,
  sort_order        integer not null default 1000,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists capability_catalog_domain_idx
  on public.capability_catalog (domain, sort_order) where active;

-- ----------------------------------------------------------------------------
-- IMPLEMENTATIONS
-- ----------------------------------------------------------------------------
-- One capability, many ways to carry it out. `provider_kind` is the executor
-- family — this is the seam the OSS choices sit behind, and it is why swapping
-- Playwright for something else, or DroidRun for something else, is a row and
-- an adapter rather than a rewrite. No vendor name appears in a column name.
--
-- `tool_id` points at the external tool being driven. It is nullable and its
-- foreign key is soft-deleted rather than cascading, because not every target
-- is a Composio connection: an Android implementation drives an installed app,
-- and a browser implementation drives a website, neither of which is required
-- to exist in platform_connections.
-- ----------------------------------------------------------------------------
create table if not exists public.capability_implementations (
  id                uuid primary key default gen_random_uuid(),
  capability_key    text not null references public.capability_catalog(capability_key) on delete cascade,

  provider_key      text not null,        -- stable id of the adapter, e.g. 'browser.playwright'
  provider_kind     text not null
                    check (provider_kind in ('api','browser','android','desktop','mcp','manual')),

  tool_id           text references public.platform_connections(tool_id) on delete set null,
  tool_surface      text,                 -- which surface of the tool: 'web','android','api'

  display_label     text not null,
  config            jsonb not null default '{}'::jsonb,

  -- How the result is proved. Named here rather than at the route, because it
  -- is a property of the way the work is done: an API write can be checked with
  -- a GET, a browser write can only be checked by reloading the page.
  verify_strategy   text not null default 'read_back'
                    check (verify_strategy in ('read_back','api_get','screenshot_diff','none','human')),

  -- Set true only once a real run has produced a VERIFIED receipt on this
  -- implementation. Nothing sets it by hand.
  is_proven         boolean not null default false,
  last_proven_at    timestamptz,

  priority          integer not null default 100,  -- lower wins
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (capability_key, provider_key, tool_surface)
);

create index if not exists capability_implementations_capability_idx
  on public.capability_implementations (capability_key, priority) where active;

-- An implementation that claims no verification may not back a capability that
-- requires it. Enforced in the API rather than here, because the check spans
-- two tables; this comment is the note that it must be enforced somewhere.

-- ----------------------------------------------------------------------------
-- EXECUTION ROUTES — the per-business binding
-- ----------------------------------------------------------------------------
-- What THIS business's `social.post.publish` actually does, in what order, with
-- which connected account.
--
-- `connection_id` points at entity_connections, which is where a business's
-- authorized accounts already live (entity_slug + tool_id + account_ref). That
-- table exists and is empty; this is the first thing that will need it.
--
-- Note what is NOT here: no credentials. Tokens stay in the secret store, and
-- a route names the connection, never the secret.
-- ----------------------------------------------------------------------------
create table if not exists public.execution_routes (
  id                uuid primary key default gen_random_uuid(),
  entity_slug       text not null references public.entity(slug) on update cascade on delete cascade,
  capability_key    text not null references public.capability_catalog(capability_key) on delete cascade,
  implementation_id uuid not null references public.capability_implementations(id) on delete cascade,
  connection_id     uuid references public.entity_connections(id) on delete set null,

  -- Per-business narrowing of the platform default. A business may tighten
  -- AUTO to ASK or NEVER. Widening is refused by the policy layer, not here.
  policy_override   text check (policy_override in ('AUTO','ASK','NEVER')),

  config            jsonb not null default '{}'::jsonb,
  priority          integer not null default 100,   -- lower is tried first
  enabled           boolean not null default true,

  -- Health, written by the execution layer. A route that keeps failing sinks
  -- without anyone touching it.
  last_success_at   timestamptz,
  last_failure_at   timestamptz,
  consecutive_failures integer not null default 0,
  disabled_reason   text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (entity_slug, capability_key, implementation_id)
);

create index if not exists execution_routes_lookup_idx
  on public.execution_routes (entity_slug, capability_key, priority) where enabled;

-- ----------------------------------------------------------------------------
-- SEED — the first proof target and what surrounds it
-- ----------------------------------------------------------------------------
-- These are the capabilities named in the build plan as the thing to prove
-- first: one request, two provider kinds, same policy, same receipt.
-- Implementations and routes are deliberately NOT seeded — an implementation
-- row is a claim that an adapter exists, and none do yet.
-- ----------------------------------------------------------------------------
insert into public.capability_catalog
  (capability_key, display_label, description, domain, verb, is_sensitive, is_write,
   default_policy, risk_tier, requires_verification, sort_order)
values
  ('business.hours.read',    'See your hours',            'Read the opening hours currently published for this business.', 'business', 'read',    false, false, 'AUTO',  'low',      false,  10),
  ('business.hours.update',  'Change your hours',         'Update opening hours everywhere they are published.',           'business', 'update',  false, true,  'ASK',   'medium',   true,   20),
  ('business.menu.read',     'See your menu',             'Read the menu as currently published.',                         'business', 'read',    false, false, 'AUTO',  'low',      false,  30),
  ('business.menu.update',   'Change your menu',          'Update the menu everywhere it is published.',                   'business', 'update',  false, true,  'ASK',   'medium',   true,   40),
  ('business.profile.update','Change your business info', 'Name, address, phone, description, categories.',                'business', 'update',  false, true,  'ASK',   'medium',   true,   50),
  ('social.post.publish',    'Post to social',            'Publish a post to a connected social account.',                 'social',   'publish', true,  true,  'ASK',   'high',     true,  100),
  ('sms.send',               'Send a text message',       'Send an SMS from the business number.',                         'sms',      'send',    true,  true,  'ASK',   'high',     true,  200),
  ('browser.run',            'Drive a website',           'Operate a website in a browser on the business''s behalf.',     'browser',  'run',     true,  true,  'ASK',   'critical', true,  300),
  ('android.open_app',       'Open an app on a phone',    'Open an installed Android app on a controlled device.',         'android',  'open',    true,  true,  'ASK',   'critical', true,  310)
on conflict (capability_key) do nothing;

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['capability_catalog','capability_implementations','execution_routes'] loop
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
