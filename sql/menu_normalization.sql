-- ############################################################
-- ##  DO NOT RUN. See HANDOFF.md in the repository root.    ##
-- ##                                                        ##
-- ##  This file was written against the WRONG database and  ##
-- ##  has never been validated against the real one         ##
-- ##  (Supabase project "cyber check" / mkepugvdlktfsossumox).##
-- ############################################################

-- ============================================================
-- MENU NORMALISATION — additive, drops nothing
-- ============================================================
--
--   NOTHING IN THIS FILE DROPS OR ALTERS AN EXISTING COLUMN.
--
-- `menu_sections`, `menu_items`, `menu_item_options`, `menu_item_variations`,
-- `sides` and `daily_features` are live and hold real data. Every statement
-- below is `create table if not exists` or `add column if not exists`. The
-- existing `menu_items.price`, `menu_items.description` and `menu_items.tags`
-- are left exactly as they are and keep working.
--
-- ── What this adds and why ──────────────────────────────────────────────
--
-- Two things about a menu item repeat, and a repeating group belongs in its
-- own table rather than squeezed into one column:
--
--   price      "Small $9 / Large $14", "Lunch $12 / Dinner $18". One column
--              cannot hold that, and a comma-separated string cannot be
--              searched or summed.
--   dietary    gluten-free AND vegetarian AND contains-nuts. A catalog and a
--              join, so "show me the gluten-free items" is an index lookup.
--
-- ── Service periods ─────────────────────────────────────────────────────
--
-- The times breakfast is served are a fact about the RESTAURANT, not about
-- each item. Recording them once and pointing sections at them means a section
-- tagged breakfast already knows it runs 7–11, and every item in that section
-- inherits it. Nobody types 7–11 onto forty items, and changing the time is
-- one edit instead of forty.
--
--   psql "$DATABASE_URL" -f sql/menu_normalization.sql

/* ── service periods ─────────────────────────────────────────────────── */

create table if not exists public.service_periods (
  id            uuid primary key default gen_random_uuid(),
  entity_slug   text not null,

  key           text not null,        -- breakfast | brunch | lunch | happy_hour | dinner | late_night
  label         text,                 -- what this restaurant calls it
  starts_at     time,
  ends_at       time,

  -- Which days it runs. A row per day rather than a list, because "brunch is
  -- Saturday and Sunday only" is a real and common answer.
  sort_order    integer default 0,
  is_active     boolean default true,

  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),

  constraint service_periods_unique unique (entity_slug, key)
);

create index if not exists service_periods_entity_idx on public.service_periods (entity_slug);

create table if not exists public.service_period_days (
  period_id     uuid not null references public.service_periods(id) on delete cascade,
  day_of_week   smallint not null,    -- 0 = Sunday
  starts_at     time,                 -- overrides the period's own time on this day
  ends_at       time,
  primary key (period_id, day_of_week)
);

-- Point a section at a period. Adding a nullable column to a live table is
-- safe: every existing section keeps working with it null, which means "no
-- particular period", exactly as things behave today.
alter table public.menu_sections
  add column if not exists service_period_id uuid references public.service_periods(id) on delete set null;

create index if not exists menu_sections_period_idx
  on public.menu_sections (service_period_id) where service_period_id is not null;

/* ── prices ──────────────────────────────────────────────────────────── */
--
-- `menu_items.price` stays and is untouched — it is the single headline price
-- and plenty of items have nothing else. These rows are for the items that
-- have more than one.

create table if not exists public.menu_item_prices (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null,

  label         text,                 -- Small | Large | Lunch | Dinner | Half dozen
  price         numeric(10,2) not null,
  -- The one to show when there is no room to show them all.
  is_default    boolean default false,
  -- Only during this period, if it differs by time of day.
  period_id     uuid references public.service_periods(id) on delete set null,

  sort_order    integer default 0
);

create index if not exists menu_item_prices_item_idx on public.menu_item_prices (menu_item_id);
create index if not exists menu_item_prices_price_idx on public.menu_item_prices (price);

/* ── dietary ─────────────────────────────────────────────────────────── */
--
-- A catalog and a join, never a comma-separated string, so "gluten-free items
-- near me" is an index lookup rather than a scan and a LIKE.

create table if not exists public.dietary_tags (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  label       text not null,
  kind        text,                   -- diet | allergen | preparation
  sort_order  integer default 0
);

create table if not exists public.menu_item_dietary (
  menu_item_id  uuid not null,
  dietary_id    uuid not null references public.dietary_tags(id) on delete cascade,
  primary key (menu_item_id, dietary_id)
);

create index if not exists menu_item_dietary_tag_idx on public.menu_item_dietary (dietary_id);

/* ── seed the dietary catalog ────────────────────────────────────────── */

insert into public.dietary_tags (key, label, kind, sort_order) values
  ('vegetarian','Vegetarian','diet',10),
  ('vegan','Vegan','diet',20),
  ('pescatarian','Pescatarian','diet',30),
  ('gluten_free','Gluten free','diet',40),
  ('dairy_free','Dairy free','diet',50),
  ('keto','Keto','diet',60),
  ('low_carb','Low carb','diet',70),
  ('halal','Halal','diet',80),
  ('kosher','Kosher','diet',90),
  ('contains_nuts','Contains nuts','allergen',100),
  ('contains_shellfish','Contains shellfish','allergen',110),
  ('contains_soy','Contains soy','allergen',120),
  ('contains_egg','Contains egg','allergen',130),
  ('contains_dairy','Contains dairy','allergen',140),
  ('contains_gluten','Contains gluten','allergen',150),
  ('raw','Served raw','preparation',160),
  ('spicy','Spicy','preparation',170),
  ('fried','Fried','preparation',180),
  ('grilled','Grilled','preparation',190),
  ('blackened','Blackened','preparation',200)
on conflict (key) do nothing;

/* ── verification ────────────────────────────────────────────────────── */

do $$
begin
  if to_regclass('public.menu_items') is null then
    raise notice 'NOTE: public.menu_items is absent — prices and dietary rows reference it by id';
  end if;
  raise notice 'added: service_periods, service_period_days, menu_item_prices, dietary_tags, menu_item_dietary';
  raise notice 'menu_sections.service_period_id added (nullable — existing rows unaffected)';
  raise notice 'nothing was dropped or altered';
end $$;
