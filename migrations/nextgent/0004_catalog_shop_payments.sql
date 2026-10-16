-- DRAFT. NOT RUN. Listings/catalog, shop (products, services, merch), orders, payments ledger, tips.
-- One catalog for anything a business shows or sells: homes, boats, trips, merch, photo packs, gift cards.
create table if not exists ng.listing (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  kind          text not null,                    -- property, vessel, trip, unit, vehicle, service
  title         text not null,
  description   text,
  status        text not null default 'active',   -- active, pending, sold, hidden
  price_cents   int,
  attributes    jsonb not null default '{}',      -- beds, baths, capacity, length, species…
  address       jsonb,
  category      text,
  sort_order    int not null default 0,
  updated_at    timestamptz not null default now()
);
create table if not exists ng.listing_media (
  listing_id uuid not null references ng.listing(id) on delete cascade,
  media_id uuid not null references ng.media(id) on delete cascade,
  sort_order int not null default 0, primary key (listing_id, media_id));

create table if not exists ng.product (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  kind          text not null default 'physical', -- physical, digital, service, gift_card, ticket
  name          text not null,
  description   text,
  price_cents   int not null,
  media_id      uuid references ng.media(id),
  fulfilment    text[] not null default '{ship,pickup}', -- ship, pickup, at_venue, digital
  flat_postage_cents int,
  visible       boolean not null default true,
  sort_order    int not null default 0
);
create table if not exists ng.product_variant (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references ng.product(id) on delete cascade,
  name          text not null,                    -- "L / Black"
  options       jsonb not null default '{}',      -- {size:"L",color:"Black"}
  price_cents   int,
  stock         int,                              -- null = unlimited
  sold_out      boolean not null default false    -- stays visible when sold out (MySet)
);

create table if not exists ng.customer (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  account_id    uuid references ng.account(id),
  name          text, email text, phone text,
  tags          text[] not null default '{}',
  notes         text,
  sms_opt_in    boolean not null default false,
  email_opt_in  boolean not null default false,
  source        text,
  created_at    timestamptz not null default now(),
  unique (business_id, phone), unique (business_id, email)
);

create table if not exists ng."order" (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  customer_id   uuid references ng.customer(id),
  status        text not null default 'pending',  -- pending, paid, fulfilled, cancelled, refunded
  fulfilment    text,                             -- ship, pickup, at_venue, digital
  pickup_code   text,                             -- short code read at the table (MySet)
  subtotal_cents int not null default 0,
  postage_cents int not null default 0,
  total_cents   int not null default 0,
  currency      text not null default 'USD',
  shipping_address jsonb,
  source        text,                             -- shop, menu_order, booking_addon, vote
  created_at    timestamptz not null default now()
);
create table if not exists ng.order_item (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references ng."order"(id) on delete cascade,
  product_id uuid references ng.product(id), variant_id uuid references ng.product_variant(id),
  menu_item_id uuid references ng.menu_item(id),
  name text not null, qty int not null default 1, unit_cents int not null);

-- "Make a request" (MySet): a fan or customer asks for something unlisted.
create table if not exists ng.custom_request (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  customer_id uuid references ng.customer(id),
  module text not null,          -- shop, menu, songs, bookings
  body text not null, status text not null default 'open', created_at timestamptz not null default now());

-- Money ledger: every charge, tip, refund, payout across modules.
create table if not exists ng.payment (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  kind          text not null,                    -- charge, tip, vote_purchase, membership, refund, payout
  amount_cents  int not null,
  currency      text not null default 'USD',
  status        text not null,                    -- pending, succeeded, failed, refunded
  provider      text not null,                    -- stripe, square, cash
  provider_ref  text,
  order_id      uuid references ng."order"(id),
  booking_id    uuid,                             -- fk added in 0005
  customer_id   uuid references ng.customer(id),
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists ng_payment_biz on ng.payment (business_id, created_at);
