-- DRAFT. NOT RUN. One booking model (replaces entity_bookings, bookings+booking_calendar, charter/boat/photo verticals).
create table if not exists ng.offering (       -- what can be booked: a trip, a rental, a class, a session
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  listing_id    uuid references ng.listing(id),
  name          text not null,
  description   text,
  duration_min  int,
  capacity      int,                              -- per slot
  booking_mode  text not null default 'slot',     -- slot, range (rentals), request (quote first)
  deposit_cents int,
  waiver_template_id uuid,                        -- fk below
  active        boolean not null default true
);
create table if not exists ng.offering_price (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references ng.offering(id) on delete cascade,
  label text not null,           -- adult, child, half-day, full-day, private
  price_cents int not null, per text not null default 'person'); -- person, booking, hour
create table if not exists ng.resource (       -- boats, rooms, guides, vehicles
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  listing_id uuid references ng.listing(id), name text not null, kind text, capacity int);
create table if not exists ng.addon (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  name text not null, price_cents int not null, per text not null default 'booking');
create table if not exists ng.location (       -- docks, meeting points
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  name text not null, address jsonb, instructions text);

create table if not exists ng.availability_rule (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  offering_id   uuid references ng.offering(id) on delete cascade,
  resource_id   uuid references ng.resource(id) on delete cascade,
  recurrence    text not null,                    -- RRULE
  start_time    time not null,
  end_time      time,
  capacity      int,
  valid_from    date, valid_to date
);
create table if not exists ng.availability_exception (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  offering_id uuid references ng.offering(id), resource_id uuid references ng.resource(id),
  date date not null, closed boolean not null default true, reason text);  -- blackout dates

create table if not exists ng.booking (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  offering_id   uuid references ng.offering(id),
  resource_id   uuid references ng.resource(id),
  location_id   uuid references ng.location(id),
  customer_id   uuid references ng.customer(id),
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  party_size    int not null default 1,
  status        text not null default 'held',     -- held, confirmed, cancelled, completed, no_show
  hold_expires_at timestamptz,
  total_cents   int,
  source        text,                             -- direct, fareharbor, email_parser, ical, phone
  external_ref  text,
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists ng_booking_biz_time on ng.booking (business_id, starts_at);
create table if not exists ng.booking_line (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references ng.booking(id) on delete cascade,
  kind text not null,            -- price, addon, fee, discount
  ref_id uuid, label text not null, qty int not null default 1, unit_cents int not null);
alter table ng.payment drop constraint if exists ng_payment_booking_fk;
alter table ng.payment add constraint ng_payment_booking_fk foreign key (booking_id) references ng.booking(id);

create table if not exists ng.external_calendar (  -- iCal feeds in/out
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  resource_id uuid references ng.resource(id), direction text not null, url text not null, last_synced_at timestamptz);

create table if not exists ng.waiver_template (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  name text not null, sections jsonb not null default '[]', version int not null default 1, active boolean not null default true);
alter table ng.offering drop constraint if exists ng_offering_waiver_fk;
alter table ng.offering add constraint ng_offering_waiver_fk foreign key (waiver_template_id) references ng.waiver_template(id);
create table if not exists ng.waiver_signature (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  template_id uuid not null references ng.waiver_template(id),
  template_version int not null,
  booking_id uuid references ng.booking(id), customer_id uuid references ng.customer(id),
  signer_name text not null, signer_email text, signed_at timestamptz not null default now(),
  signature jsonb, ip text);

create table if not exists ng.waitlist_entry (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  customer_id uuid references ng.customer(id), party_size int, status text not null default 'waiting',
  quoted_min int, created_at timestamptz not null default now(), notified_at timestamptz);
