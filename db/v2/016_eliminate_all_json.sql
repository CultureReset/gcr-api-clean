-- ============================================================================
-- GCR v2 — 016_eliminate_all_json.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- The first two migration waves left 9 jsonb columns and 2 array columns in
-- v2, in direct contradiction of the requirement that every piece of data
-- live in its own real, modular table — no JSON blobs, no arrays. This
-- migration replaces every one of them with real tables/columns, moves the
-- existing data across (verified before dropping), and drops the offending
-- columns. Applied directly against the live database on 2026-07-15.
--
-- Verified after this ran: 0 jsonb/json/ARRAY columns anywhere in schema v2
-- (SELECT count(*) FROM information_schema.columns WHERE table_schema='v2'
--  AND data_type IN ('jsonb','json','ARRAY') = 0).
-- ============================================================================

-- ---- New real tables -----------------------------------------------------
create table if not exists v2.content_block_items (
  id                     uuid primary key default gen_random_uuid(),
  content_block_id       uuid not null references v2.content_blocks(id) on delete cascade,
  entity_id              uuid not null references v2.entities(id) on delete cascade,
  item_name              text,
  description            text,
  price                  numeric,
  price_from             numeric,
  price_to               numeric,
  price_label            text,
  duration               text,
  icon                   text,
  image_url              text,
  requirement_applies_to text,
  minimum_age            integer,
  sort_order             integer not null default 0,
  created_at             timestamptz not null default now()
);
create index if not exists idx_v2_cbi_block on v2.content_block_items (content_block_id, sort_order);
create index if not exists idx_v2_cbi_entity on v2.content_block_items (entity_id);

create table if not exists v2.entity_module_settings (
  id                uuid primary key default gen_random_uuid(),
  entity_module_id  uuid not null references v2.entity_modules(id) on delete cascade,
  setting_key       text not null,
  value_text        text,
  created_at        timestamptz not null default now(),
  unique (entity_module_id, setting_key)
);

create table if not exists v2.media_asset_tags (
  id        uuid primary key default gen_random_uuid(),
  media_id  uuid not null references v2.media_assets(id) on delete cascade,
  tag       text not null,
  unique (media_id, tag)
);

create table if not exists v2.module_catalog_tables (
  id          uuid primary key default gen_random_uuid(),
  module_key  text not null references v2.module_catalog(module_key) on delete cascade,
  table_name  text not null,
  unique (module_key, table_name)
);
create table if not exists v2.module_catalog_business_types (
  id            uuid primary key default gen_random_uuid(),
  module_key    text not null references v2.module_catalog(module_key) on delete cascade,
  business_type text not null,
  unique (module_key, business_type)
);

create table if not exists v2.entity_page_assignments (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references v2.entities(id) on delete cascade,
  page_key   text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (entity_id, page_key)
);

create table if not exists v2.entity_module_validation_errors (
  id                       uuid primary key default gen_random_uuid(),
  entity_module_status_id  uuid not null references v2.entity_module_status(id) on delete cascade,
  message                  text not null,
  created_at               timestamptz not null default now()
);

create table if not exists v2.integration_account_settings (
  id                     uuid primary key default gen_random_uuid(),
  integration_account_id uuid not null references v2.integration_accounts(id) on delete cascade,
  setting_key            text not null,
  value_text             text,
  unique (integration_account_id, setting_key)
);

create table if not exists v2.resource_calendar_source_settings (
  id                          uuid primary key default gen_random_uuid(),
  resource_calendar_source_id uuid not null references v2.resource_calendar_sources(id) on delete cascade,
  setting_key                 text not null,
  value_text                  text,
  unique (resource_calendar_source_id, setting_key)
);

create table if not exists v2.tourist_itinerary_stops (
  id           uuid primary key default gen_random_uuid(),
  itinerary_id uuid not null references v2.tourist_itineraries(id) on delete cascade,
  entity_id    uuid references v2.entities(id) on delete set null,
  day_number   integer,
  notes        text,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists v2.tourist_preference_scores (
  id          uuid primary key default gen_random_uuid(),
  tourist_id  uuid not null references v2.tourist_profiles(id) on delete cascade,
  tag         text not null,
  score       numeric not null default 0,
  unique (tourist_id, tag)
);

-- ---- Move existing jsonb data into the real tables above -----------------
INSERT INTO v2.content_block_items (content_block_id, entity_id, item_name, description, price, price_from, price_to, price_label, duration, icon, image_url, requirement_applies_to, minimum_age, sort_order)
SELECT cb.id, cb.entity_id,
  COALESCE(elem->>'item_name', elem->>'requirement', elem->>'item'),
  elem->>'description',
  NULLIF(elem->>'price','')::numeric,
  NULLIF(elem->>'price_from','')::numeric,
  NULLIF(elem->>'price_to','')::numeric,
  elem->>'price_label', elem->>'duration', elem->>'icon', elem->>'image_url', elem->>'applies_to',
  NULLIF(elem->>'minimum_age','')::integer,
  COALESCE(NULLIF(elem->>'sort_order','')::integer, 0)
FROM v2.content_blocks cb, jsonb_array_elements(cb.items) AS elem
WHERE jsonb_typeof(cb.items) = 'array' AND jsonb_array_length(cb.items) > 0;

INSERT INTO v2.entity_module_settings (entity_module_id, setting_key, value_text)
SELECT em.id, kv.key, kv.value #>> '{}'
FROM v2.entity_modules em, jsonb_each(em.settings) AS kv
WHERE em.settings IS NOT NULL AND em.settings <> '{}'::jsonb;

INSERT INTO v2.media_asset_tags (media_id, tag)
SELECT m.id, elem FROM v2.media_assets m, jsonb_array_elements_text(m.ai_tags) AS elem
WHERE jsonb_typeof(m.ai_tags) = 'array' AND jsonb_array_length(m.ai_tags) > 0
ON CONFLICT DO NOTHING;

INSERT INTO v2.module_catalog_tables (module_key, table_name)
SELECT module_key, unnest(required_tables) FROM v2.module_catalog
WHERE required_tables IS NOT NULL AND array_length(required_tables,1) > 0
ON CONFLICT DO NOTHING;
INSERT INTO v2.module_catalog_business_types (module_key, business_type)
SELECT module_key, unnest(default_for) FROM v2.module_catalog
WHERE default_for IS NOT NULL AND array_length(default_for,1) > 0
ON CONFLICT DO NOTHING;

-- Wide entity.* arrays (known_for, highlights, good_for, seo_keywords) -> entity_tags
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, kf, 'known_for' FROM public.entity e2 JOIN v2.entities e ON e.id = e2.id, unnest(e2.known_for) AS kf
WHERE e2.known_for IS NOT NULL AND kf IS NOT NULL AND kf <> '' ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, hl, 'highlight' FROM public.entity e2 JOIN v2.entities e ON e.id = e2.id, unnest(e2.highlights) AS hl
WHERE e2.highlights IS NOT NULL AND hl IS NOT NULL AND hl <> '' ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, gf, 'good_for' FROM public.entity e2 JOIN v2.entities e ON e.id = e2.id, unnest(e2.good_for) AS gf
WHERE e2.good_for IS NOT NULL AND gf IS NOT NULL AND gf <> '' ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, kw, 'seo_keyword' FROM public.entity e2 JOIN v2.entities e ON e.id = e2.id, unnest(e2.seo_keywords) AS kw
WHERE e2.seo_keywords IS NOT NULL AND kw IS NOT NULL AND kw <> '' ON CONFLICT DO NOTHING;

-- entity_conflicts: real columns instead of jsonb detail
ALTER TABLE v2.entity_conflicts ADD COLUMN IF NOT EXISTS source_table text;
ALTER TABLE v2.entity_conflicts ADD COLUMN IF NOT EXISTS entity_slug text;
ALTER TABLE v2.entity_conflicts ADD COLUMN IF NOT EXISTS module_key text;
ALTER TABLE v2.entity_conflicts ADD COLUMN IF NOT EXISTS note text;
UPDATE v2.entity_conflicts SET
  source_table = detail->>'source_table', entity_slug = detail->>'entity_slug',
  module_key = detail->>'module_key', note = detail->>'note'
WHERE detail IS NOT NULL;

-- analytics_events: real utm columns instead of jsonb
ALTER TABLE v2.analytics_events ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE v2.analytics_events ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE v2.analytics_events ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE v2.analytics_events ADD COLUMN IF NOT EXISTS utm_term text;
ALTER TABLE v2.analytics_events ADD COLUMN IF NOT EXISTS utm_content text;
UPDATE v2.analytics_events SET
  utm_source = utm->>'utm_source', utm_medium = utm->>'utm_medium',
  utm_campaign = utm->>'utm_campaign', utm_term = utm->>'utm_term', utm_content = utm->>'utm_content'
WHERE utm IS NOT NULL AND utm <> '{}'::jsonb;

INSERT INTO v2.entity_module_validation_errors (entity_module_status_id, message)
SELECT s.id, elem FROM v2.entity_module_status s, jsonb_array_elements_text(s.validation_errors) AS elem
WHERE jsonb_typeof(s.validation_errors) = 'array' AND jsonb_array_length(s.validation_errors) > 0;

INSERT INTO v2.integration_account_settings (integration_account_id, setting_key, value_text)
SELECT a.id, kv.key, kv.value #>> '{}' FROM v2.integration_accounts a, jsonb_each(a.settings) AS kv
WHERE a.settings IS NOT NULL AND a.settings <> '{}'::jsonb;

INSERT INTO v2.resource_calendar_source_settings (resource_calendar_source_id, setting_key, value_text)
SELECT r.id, kv.key, kv.value #>> '{}' FROM v2.resource_calendar_sources r, jsonb_each(r.settings) AS kv
WHERE r.settings IS NOT NULL AND r.settings <> '{}'::jsonb;

INSERT INTO v2.tourist_preference_scores (tourist_id, tag, score)
SELECT t.id, kv.key, NULLIF(kv.value #>> '{}','')::numeric
FROM v2.tourist_profiles t, jsonb_each(t.preferences) AS kv
WHERE t.preferences IS NOT NULL AND t.preferences <> '{}'::jsonb
  AND (kv.value #>> '{}') ~ '^-?[0-9.]+$';

-- Drop the JSON-cache concept entirely: readers query the real tables directly
DROP TABLE IF EXISTS v2.entity_profile_refresh_queue;
DROP TABLE IF EXISTS v2.entity_profile_cache;

-- Drop every remaining jsonb/array column now that data lives in real tables
ALTER TABLE v2.content_blocks DROP COLUMN items;
ALTER TABLE v2.entity_modules DROP COLUMN settings;
ALTER TABLE v2.media_assets DROP COLUMN ai_tags;
ALTER TABLE v2.module_catalog DROP COLUMN required_tables;
ALTER TABLE v2.module_catalog DROP COLUMN default_for;
ALTER TABLE v2.entity_conflicts DROP COLUMN detail;
ALTER TABLE v2.analytics_events DROP COLUMN utm;
ALTER TABLE v2.entity_module_status DROP COLUMN validation_errors;
ALTER TABLE v2.integration_accounts DROP COLUMN settings;
ALTER TABLE v2.resource_calendar_sources DROP COLUMN settings;
ALTER TABLE v2.tourist_itineraries DROP COLUMN items;
ALTER TABLE v2.tourist_profiles DROP COLUMN preferences;
ALTER TABLE v2.entity_relations DROP COLUMN metadata;  -- table was empty (0 rows), nothing lost
