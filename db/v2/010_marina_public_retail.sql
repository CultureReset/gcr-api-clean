-- ============================================================================
-- GCR v2 — 010_marina_public_retail.sql  (Marina + Public Places + Retail packs)
-- ============================================================================

-- ---- Marina ----------------------------------------------------------------
create table if not exists v2.marina_details (
  entity_id    uuid primary key references v2.entities(id) on delete cascade,
  slip_count   integer,
  max_length_ft integer,
  fuel_gas     boolean,
  fuel_diesel  boolean,
  power_available boolean,
  storage      boolean,
  bait_shop    boolean,
  boat_ramp    boolean,
  pump_out     boolean,
  description  text,
  created_at   timestamptz not null default now()
);

-- ---- Public Places (parks / beaches / attractions) -------------------------
create table if not exists v2.facilities (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  name       text not null,                   -- restrooms | picnic area | boardwalk | pavilion | showers
  description text,
  sort_order integer not null default 0
);

create table if not exists v2.access_rules (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  rule_type  text not null,                   -- parking | entry | access | restriction | fee
  label      text,
  body       text,
  fee_amount numeric
);

create table if not exists v2.live_conditions (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  condition_type text not null,               -- surf | weather | beach_flag | closure | crowd
  value       text,
  observed_at timestamptz not null default now()
);
create index if not exists idx_v2_live_conditions_entity on v2.live_conditions (entity_id, observed_at desc);

-- ---- Retail ----------------------------------------------------------------
create table if not exists v2.product_categories (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  name       text not null,
  sort_order integer not null default 0
);

create table if not exists v2.products (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  category_id uuid references v2.product_categories(id) on delete set null,
  name        text not null,
  description text,
  price       numeric,
  media_id    uuid references v2.media_assets(id) on delete set null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_products_entity on v2.products (entity_id);

create table if not exists v2.product_variants (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references v2.products(id) on delete cascade,
  sku        text,
  size       text,
  color      text,
  price      numeric
);

create table if not exists v2.product_inventory (
  id                 uuid primary key default gen_random_uuid(),
  product_variant_id uuid not null references v2.product_variants(id) on delete cascade,
  location           text,
  quantity           integer not null default 0
);
