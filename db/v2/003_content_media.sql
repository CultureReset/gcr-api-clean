-- ============================================================================
-- GCR v2 — 003_content_media.sql  (Content + Media module pack)
-- Canonical media, editorial content, FAQs, policies, events, specials,
-- announcements, reviews. Replaces entity_photos/entity_gallery/photos/
-- business_photos and merges faqs + entity_faqs, specials/promos/coupons/deals.
-- Beside production in schema `v2`. Non-destructive.
-- ============================================================================

-- media_assets — one canonical image/video/doc; can attach to many objects.
create table if not exists v2.media_assets (
  id          uuid primary key default gen_random_uuid(),
  url         text not null,
  storage_path text,
  media_type  text not null default 'image',  -- image | video | document
  width       integer,
  height      integer,
  source_name text,
  source_url  text,
  rights      text,
  ai_tags     jsonb not null default '[]',
  ai_description text,
  created_at  timestamptz not null default now()
);

-- entity_media — a media asset attached to an entity, with role + order.
create table if not exists v2.entity_media (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  media_id   uuid not null references v2.media_assets(id) on delete cascade,
  role       text not null default 'gallery', -- hero | logo | gallery | menu_photo | interior | exterior ...
  caption    text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (entity_id, media_id, role)
);
create index if not exists idx_v2_entity_media_entity on v2.entity_media (entity_id, role, sort_order);

-- Now that media_assets exists, wire entities.primary_media_id.
alter table v2.entities
  add constraint fk_v2_entities_primary_media
  foreign key (primary_media_id) references v2.media_assets(id) on delete set null;

-- content_blocks — flexible-but-schema'd editorial sections (replaces random JSON).
create table if not exists v2.content_blocks (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  block_type text not null,                   -- about | story | rich_text | bullets | cards | callout
  title      text,
  subtitle   text,
  body       text,
  items      jsonb not null default '[]',     -- structured bullets/cards, schema per block_type
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_content_blocks_entity on v2.content_blocks (entity_id, sort_order);

-- entity_faqs — canonical FAQs (merge public.faqs + public.entity_faqs).
create table if not exists v2.entity_faqs (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  question   text not null,
  answer     text,
  category   text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_v2_faqs_entity on v2.entity_faqs (entity_id, sort_order);

-- entity_policies — cancellation/pets/age/smoking/accessibility/operational.
create table if not exists v2.entity_policies (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references v2.entities(id) on delete cascade,
  policy_type text not null,                  -- cancellation | pets | age | smoking | accessibility | deposit | refund ...
  title       text,
  body        text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists idx_v2_policies_entity on v2.entity_policies (entity_id);

-- entity_events — recurring/dated events, artists, ticket links.
create table if not exists v2.entity_events (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references v2.entities(id) on delete cascade,
  event_name   text not null,
  description  text,
  event_date   date,
  start_time   time,
  end_time     time,
  day_of_week  text,
  recurring    boolean not null default false,
  artist_id    uuid,                          -- FK to v2.artist_profiles added in 011_artist.sql
  artist_name  text,
  cover_charge numeric,
  ticket_url   text,
  media_id     uuid references v2.media_assets(id) on delete set null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists idx_v2_events_entity on v2.entity_events (entity_id, event_date);

-- entity_specials — timed offers/daily specials/coupons/promotions.
create table if not exists v2.entity_specials (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references v2.entities(id) on delete cascade,
  special_name  text not null,
  description   text,
  discount_type text,                         -- percent | amount | bogo | fixed_price | text
  discount_value numeric,
  discount_text text,
  days          text,
  start_time    time,
  end_time      time,
  start_date    date,
  end_date      date,
  media_id      uuid references v2.media_assets(id) on delete set null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists idx_v2_specials_entity on v2.entity_specials (entity_id);

-- entity_announcements — temporary public announcements with visibility window.
create table if not exists v2.entity_announcements (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  title      text,
  body       text,
  starts_at  timestamptz,
  ends_at    timestamptz,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- entity_reviews — verified + public reviews (merge reviews/item_reviews).
create table if not exists v2.entity_reviews (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references v2.entities(id) on delete cascade,
  reviewer_name  text,
  reviewer_email text,
  rating         integer,
  title          text,
  body           text,
  verified       boolean not null default false,
  approved       boolean not null default false,
  helpful_count  integer not null default 0,
  media_id       uuid references v2.media_assets(id) on delete set null,
  source         text,                        -- google | yelp | direct ...
  created_at     timestamptz not null default now(),
  check (rating is null or rating between 1 and 5)
);
create index if not exists idx_v2_reviews_entity on v2.entity_reviews (entity_id, approved);

-- Structured review questions/answers + invites.
create table if not exists v2.review_questions (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  prompt     text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists v2.review_answers (
  id          uuid primary key default gen_random_uuid(),
  review_id   uuid not null references v2.entity_reviews(id) on delete cascade,
  question_id uuid not null references v2.review_questions(id) on delete cascade,
  answer      text,
  created_at  timestamptz not null default now()
);
create table if not exists v2.review_invites (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  contact    text,
  status     text not null default 'pending', -- pending | sent | completed | expired
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);
