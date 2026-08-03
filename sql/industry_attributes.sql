-- Structured listing data, per industry.
--
-- The fields themselves are defined in routes/industry-blueprints.js — what a
-- condo unit stores, what a charter boat stores, what a venue stores — and
-- they all land here.
--
-- One table rather than eight (condo_units, charter_boats, cruise_vessels, …)
-- because what varies between industries is the FIELD LIST, not the shape of
-- storage: every one of them is (this listing, this attribute, this value).
-- Eight tables would mean a migration per new field and a bespoke search per
-- vertical; this way a new field is one line of JavaScript.
--
-- The cost of that choice is that the value cannot be one typed column, so
-- there are four and exactly one is filled per row. That is what makes
-- "bedrooms >= 2" an indexed integer comparison rather than a string cast —
-- the part that would actually hurt if it were done as a single text column.
--
--   psql "$DATABASE_URL" -f sql/industry_attributes.sql

create table if not exists public.entity_attributes (
  id            uuid primary key default gen_random_uuid(),

  -- The listing this describes. For a condo building the building's own
  -- attributes hang off the parent slug and each unit's off its own, because
  -- "2 bed 2 bath" is a fact about unit 1204, not about Phoenix West.
  entity_slug   text not null,

  -- Matches a `key` in the blueprint for this business's industry. Not a
  -- foreign key: the blueprint is code, and a field removed from it should
  -- leave its stored values alone rather than cascade-delete customer data.
  attr_key      text not null,

  -- Exactly one of these is set, chosen by the field's declared type.
  value_text    text,
  value_num     numeric,
  value_bool    boolean,
  value_list    text[],

  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),

  constraint entity_attributes_unique unique (entity_slug, attr_key)
);

-- Read path 1: "show me everything about this listing" — the editor, the
-- profile page, the AI.
create index if not exists entity_attributes_slug_idx
  on public.entity_attributes (entity_slug);

-- Read path 2: "which listings have bedrooms >= 2" — the match search. The
-- key leads because every filter names one, and the value follows so the
-- comparison is served from the index rather than a heap fetch.
create index if not exists entity_attributes_key_num_idx
  on public.entity_attributes (attr_key, value_num)
  where value_num is not null;

create index if not exists entity_attributes_key_text_idx
  on public.entity_attributes (attr_key, value_text)
  where value_text is not null;

create index if not exists entity_attributes_key_bool_idx
  on public.entity_attributes (attr_key)
  where value_bool is true;

-- Read path 3: "which listings target red snapper" — array containment needs
-- GIN; btree cannot answer `@>`.
create index if not exists entity_attributes_list_idx
  on public.entity_attributes using gin (value_list)
  where value_list is not null;

comment on table public.entity_attributes is
  'Structured listing data — the fields a guest searches on. Field definitions live in routes/industry-blueprints.js; exactly one value_* column is set per row, chosen by the field type.';

/* ── verification ────────────────────────────────────────────────────── */

do $$
begin
  if to_regclass('public.entity') is null then
    raise notice 'MISSING: public.entity — attributes reference it by slug';
  end if;
  raise notice 'entity_attributes ready. Field definitions: routes/industry-blueprints.js';
end $$;
