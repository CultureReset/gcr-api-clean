-- DRAFT. NOT RUN. Hours, media, contact actions, FAQs, team, policies.
create table if not exists ng.hours (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  kind          text not null default 'regular',  -- regular, happy_hour, kitchen, brunch, season:<name>
  weekday       smallint not null check (weekday between 0 and 6),
  opens         time,
  closes        time,                             -- may be < opens (past midnight)
  closed        boolean not null default false,
  valid_from    date,
  valid_to      date
);
create index if not exists ng_hours_biz on ng.hours (business_id, kind);

create table if not exists ng.hours_exception (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  date          date not null,
  closed        boolean not null default true,
  opens         time,
  closes        time,
  note          text
);

create table if not exists ng.media (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  url           text not null,
  kind          text not null default 'photo',    -- photo, video, document
  alt           text,
  caption       text,
  tags          text[] not null default '{}',
  source        text,                             -- upload, google, instagram, community
  sort_order    int not null default 0,
  analysis      jsonb,                            -- AI photo analysis
  created_at    timestamptz not null default now()
);
create index if not exists ng_media_biz on ng.media (business_id, sort_order);

-- A9ENT-style contact buttons, usable on the profile, a listing, a product or an offering.
create table if not exists ng.contact_action (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references ng.business(id) on delete cascade,
  target_table  text,                             -- null = business-wide; else ng.listing / ng.product …
  target_id     uuid,
  kind          text not null,                    -- call, sms, whatsapp, email, calendly, form, link, vcard
  label         text,
  value         text not null,
  sort_order    int not null default 0
);

create table if not exists ng.faq (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  question text not null, answer text not null, sort_order int not null default 0);

create table if not exists ng.team_member (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  name text not null, role text, bio text, media_id uuid references ng.media(id),
  account_id uuid references ng.account(id), sort_order int not null default 0);

create table if not exists ng.policy (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  kind text not null,            -- cancellation, refund, pets, age, weather, privacy
  title text, body text not null);
