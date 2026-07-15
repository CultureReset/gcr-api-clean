-- ============================================================================
-- GCR v2 — 004_food.sql  (Food module pack)
-- Restaurant / bar / cafe: separate menus (food/drink/happy-hour/catering),
-- periods, sections, items, dietary flags, option groups, daily features, and
-- QR table sessions/orders. Migrates the current food/drink/happy-hour tables.
-- Beside production in schema `v2`. Non-destructive.
-- ============================================================================

-- menus — a named menu of a given type. Unifies food/drink/HH/catering families.
create table if not exists v2.menus (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  menu_type  text not null default 'food',    -- food | drink | happy_hour | catering | seasonal | kids
  name       text not null,
  description text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_menus_entity on v2.menus (entity_id, menu_type);

-- menu_periods — breakfast/brunch/lunch/dinner/late-night time windows.
create table if not exists v2.menu_periods (
  id         uuid primary key default gen_random_uuid(),
  menu_id    uuid not null references v2.menus(id) on delete cascade,
  name       text not null,                   -- Breakfast | Lunch | Dinner | Late Night ...
  start_time time,
  end_time   time,
  days_of_week text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- menu_sections — appetizers/entrees/cocktails/etc within a menu.
create table if not exists v2.menu_sections (
  id         uuid primary key default gen_random_uuid(),
  menu_id    uuid not null references v2.menus(id) on delete cascade,
  section_name text not null,
  description text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_menu_sections_menu on v2.menu_sections (menu_id, sort_order);

-- menu_items — canonical food/drink/happy-hour item. Belongs to a section.
create table if not exists v2.menu_items (
  id              uuid primary key default gen_random_uuid(),
  section_id      uuid not null references v2.menu_sections(id) on delete cascade,
  entity_id       uuid not null references v2.entities(id) on delete cascade,  -- denormalized for fast per-business reads
  item_name       text not null,
  description     text,
  price           numeric,
  has_market_price boolean not null default false,
  is_available    boolean not null default true,
  is_featured     boolean not null default false,
  is_catch_of_day boolean not null default false,
  is_on_tap       boolean not null default false,
  media_id        uuid references v2.media_assets(id) on delete set null,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_v2_menu_items_section on v2.menu_items (section_id, sort_order);
create index if not exists idx_v2_menu_items_entity  on v2.menu_items (entity_id);

-- menu_item_availability — days/times/locations/temporary availability.
create table if not exists v2.menu_item_availability (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references v2.menu_items(id) on delete cascade,
  days_of_week text,
  start_time   time,
  end_time     time,
  start_date   date,
  end_date     date,
  created_at   timestamptz not null default now()
);

-- menu_item_dietary — gluten-free/vegan/allergen flags.
create table if not exists v2.menu_item_dietary (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references v2.menu_items(id) on delete cascade,
  flag         text not null,                 -- gluten_free | vegan | vegetarian | dairy_free | nut_allergen ...
  created_at   timestamptz not null default now(),
  unique (menu_item_id, flag)
);

-- option_groups / option_items — size/sides/temperature/dressing choices.
create table if not exists v2.option_groups (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  name        text not null,                  -- Size | Sides | Temperature | Dressing
  min_select  integer not null default 0,
  max_select  integer,
  created_at  timestamptz not null default now()
);
create table if not exists v2.option_items (
  id              uuid primary key default gen_random_uuid(),
  option_group_id uuid not null references v2.option_groups(id) on delete cascade,
  name            text not null,
  price_delta     numeric not null default 0,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);
create table if not exists v2.menu_item_option_groups (
  id              uuid primary key default gen_random_uuid(),
  menu_item_id    uuid not null references v2.menu_items(id) on delete cascade,
  option_group_id uuid not null references v2.option_groups(id) on delete cascade,
  is_required     boolean not null default false,
  sort_order      integer not null default 0,
  unique (menu_item_id, option_group_id)
);

-- daily_features — catch of the day / rotating daily features.
create table if not exists v2.daily_features (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  feature_date date,
  title        text not null,
  description  text,
  price        numeric,
  media_id     uuid references v2.media_assets(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_daily_features_entity on v2.daily_features (entity_id, feature_date);

-- table_sessions / table_orders — QR table identity + transaction linkage.
create table if not exists v2.table_sessions (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  table_label  text,
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz
);
create table if not exists v2.table_orders (
  id               uuid primary key default gen_random_uuid(),
  table_session_id uuid not null references v2.table_sessions(id) on delete cascade,
  total            numeric,
  status           text not null default 'open',
  created_at       timestamptz not null default now()
);
