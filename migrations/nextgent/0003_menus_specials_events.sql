-- DRAFT. NOT RUN. Menus (food, drinks, happy hour as menu kinds), specials, events.
create table if not exists ng.menu (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  kind          text not null default 'food',     -- food, drinks, happy_hour, brunch, kids, catering
  name          text not null,
  hours_kind    text,                             -- links to ng.hours.kind (e.g. happy_hour)
  sort_order    int not null default 0,
  published     boolean not null default true
);
create table if not exists ng.menu_section (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  menu_id       uuid not null references ng.menu(id) on delete cascade,
  name          text not null,
  description   text,
  sort_order    int not null default 0,
  available     jsonb                             -- {days:[1..5], start:"16:00", end:"18:00"}
);
create table if not exists ng.menu_item (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  section_id    uuid not null references ng.menu_section(id) on delete cascade,
  name          text not null,
  description   text,
  price_cents   int,                              -- the simple case; ng.menu_item_price for sizes
  media_id      uuid references ng.media(id),
  dietary       text[] not null default '{}',     -- gf, v, vg, nuts, spicy
  is_available  boolean not null default true,
  is_feature    boolean not null default false,   -- daily feature / chef's pick
  sort_order    int not null default 0,
  updated_at    timestamptz not null default now()
);
create index if not exists ng_menu_item_biz on ng.menu_item (business_id);
create table if not exists ng.menu_item_price (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references ng.menu_item(id) on delete cascade,
  label text not null, price_cents int not null, sort_order int not null default 0);
create table if not exists ng.menu_option_group (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references ng.menu_item(id) on delete cascade,
  name text not null, min_select int default 0, max_select int default 1);
create table if not exists ng.menu_option (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references ng.menu_option_group(id) on delete cascade,
  name text not null, price_cents int not null default 0);

create table if not exists ng.special (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  title         text not null,
  description   text,
  price_cents   int,
  media_id      uuid references ng.media(id),
  recurrence    text,                             -- RFC 5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=TU
  starts_at     timestamptz,
  ends_at       timestamptz,
  menu_item_id  uuid references ng.menu_item(id),
  active        boolean not null default true
);

create table if not exists ng.event (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  title         text not null,
  description   text,
  kind          text,                             -- live_music, trivia, show, tour_departure, open_house
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  recurrence    text,                             -- RRULE (MySet residencies, weekly trivia)
  venue_business_id uuid references ng.business(id), -- artist plays at a venue
  performer_business_id uuid references ng.business(id),
  ticket_url    text,
  price_cents   int,
  media_id      uuid references ng.media(id),
  status        text not null default 'scheduled'
);
create index if not exists ng_event_biz_time on ng.event (business_id, starts_at);
create index if not exists ng_event_venue on ng.event (venue_business_id, starts_at);
