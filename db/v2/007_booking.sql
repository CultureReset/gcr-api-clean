-- ============================================================================
-- GCR v2 — 007_booking.sql  (Booking module pack)
-- Availability, canonical bookings and their line items/guests/payments/
-- waivers, plus waitlists and service quote requests.
-- ============================================================================

create table if not exists v2.availability_slots (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  offering_id uuid references v2.offerings(id) on delete cascade,
  resource_id uuid references v2.resources(id) on delete cascade,
  slot_date   date not null,
  start_time  time,
  end_time    time,
  capacity    integer,
  booked      integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_avail_slots on v2.availability_slots (entity_id, slot_date);

create table if not exists v2.availability_blocks (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references v2.resources(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  reason      text,
  created_at  timestamptz not null default now()
);

create table if not exists v2.bookings (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references v2.entities(id) on delete cascade,
  customer_name text,
  customer_email text,
  customer_phone text,
  start_date    date,
  end_date      date,
  start_time    time,
  status        text not null default 'pending', -- pending | confirmed | cancelled | completed | no_show
  total         numeric,
  source        text,                            -- direct | ical | email_parser | provider
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_v2_bookings_entity on v2.bookings (entity_id, status);

create table if not exists v2.booking_items (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references v2.bookings(id) on delete cascade,
  offering_id uuid references v2.offerings(id) on delete set null,
  resource_id uuid references v2.resources(id) on delete set null,
  price_id    uuid references v2.offering_prices(id) on delete set null,
  quantity    integer not null default 1,
  unit_price  numeric,
  created_at  timestamptz not null default now()
);

create table if not exists v2.booking_guests (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references v2.bookings(id) on delete cascade,
  full_name    text,
  age          integer,
  waiver_signed boolean not null default false
);

create table if not exists v2.booking_payments (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references v2.bookings(id) on delete cascade,
  payment_type text not null,                 -- deposit | balance | refund
  amount      numeric not null,
  provider    text,                           -- stripe | square | cash
  provider_ref text,
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

create table if not exists v2.booking_waivers (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references v2.bookings(id) on delete cascade,
  guest_id    uuid references v2.booking_guests(id) on delete set null,
  document_url text,
  signed_at   timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists v2.waitlists (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  offering_id uuid references v2.offerings(id) on delete set null,
  resource_id uuid references v2.resources(id) on delete set null,
  requested_date date,
  customer_name text,
  customer_phone text,
  status      text not null default 'waiting',
  created_at  timestamptz not null default now()
);

create table if not exists v2.quote_requests (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  offering_id  uuid references v2.offerings(id) on delete set null,
  customer_name text,
  customer_email text,
  customer_phone text,
  details      text,
  status       text not null default 'new',
  created_at   timestamptz not null default now()
);
