-- GCR universal entity graph and structured booking foundation
-- Additive migration: preserves all current tables and backfills compatibility data.
-- Apply to a Supabase development branch first, validate, then promote.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.gcr_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Canonical entity identity
-- ---------------------------------------------------------------------------

alter table public.entity
  add column if not exists entity_kind text;

comment on column public.entity.entity_kind is
  'Database object kind: destination, business, venue, marina, restaurant, store, attraction, department, condo_complex, condo_unit, resource_profile, information_page, collection, etc.';

update public.entity
set entity_kind = case
  when entity_kind is not null then entity_kind
  when entity_subtype in ('condominium_complex', 'apartment_complex', 'resort') then 'condo_complex'
  when entity_type in ('condo', 'vacation-rental')
       and (unit_number is not null or parent_entity_slug is not null) then 'condo_unit'
  when entity_type = 'restaurant' then 'restaurant'
  when entity_subtype ilike '%marina%' then 'marina'
  when entity_type = 'shopping' then 'store'
  when entity_type = 'hotel' then 'property'
  when entity_type = 'artist' then 'artist'
  else 'business'
end
where entity_kind is null;

create index if not exists entity_entity_kind_idx
  on public.entity(entity_kind);

-- ---------------------------------------------------------------------------
-- 2. Typed entity relationships and unlimited nesting
-- ---------------------------------------------------------------------------

create table if not exists public.entity_relationships (
  id uuid primary key default gen_random_uuid(),
  parent_entity_id uuid not null references public.entity(id) on delete cascade,
  child_entity_id uuid not null references public.entity(id) on delete cascade,
  relationship_type text not null default 'legacy_parent',
  is_primary_context boolean not null default false,
  display_on_parent boolean not null default true,
  display_on_root boolean not null default true,
  inherit_location boolean not null default false,
  inherit_parking boolean not null default false,
  inherit_amenities boolean not null default false,
  inherit_contact boolean not null default false,
  directory_group text,
  sort_order integer not null default 0,
  verified_status text not null default 'unverified',
  source_url text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entity_relationships_not_self check (parent_entity_id <> child_entity_id),
  constraint entity_relationships_unique unique (parent_entity_id, child_entity_id, relationship_type)
);

create unique index if not exists entity_relationships_one_primary_context
  on public.entity_relationships(child_entity_id)
  where is_primary_context = true and active = true;

create index if not exists entity_relationships_parent_idx
  on public.entity_relationships(parent_entity_id, active, sort_order);

create index if not exists entity_relationships_child_idx
  on public.entity_relationships(child_entity_id, active);

create index if not exists entity_relationships_type_idx
  on public.entity_relationships(relationship_type, active);

insert into public.entity_relationships (
  parent_entity_id,
  child_entity_id,
  relationship_type,
  is_primary_context,
  display_on_parent,
  display_on_root,
  verified_status,
  notes
)
select
  p.id,
  c.id,
  'legacy_parent',
  true,
  true,
  true,
  'needs_classification',
  'Backfilled from entity.parent_entity_slug. Classify as part_of, located_at, operates_from, unit_of, department_of, or resource_of.'
from public.entity c
join public.entity p on p.slug = c.parent_entity_slug
where c.parent_entity_slug is not null
on conflict (parent_entity_id, child_entity_id, relationship_type) do nothing;

create table if not exists public.entity_relationship_closure (
  ancestor_entity_id uuid not null references public.entity(id) on delete cascade,
  descendant_entity_id uuid not null references public.entity(id) on delete cascade,
  depth integer not null check (depth >= 0),
  primary key (ancestor_entity_id, descendant_entity_id)
);

create index if not exists entity_relationship_closure_descendant_idx
  on public.entity_relationship_closure(descendant_entity_id, depth);

create or replace function public.gcr_refresh_entity_relationship_closure()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.entity_relationship_closure;

  insert into public.entity_relationship_closure (
    ancestor_entity_id,
    descendant_entity_id,
    depth
  )
  select id, id, 0
  from public.entity;

  with recursive walk as (
    select
      r.parent_entity_id as ancestor_entity_id,
      r.child_entity_id as descendant_entity_id,
      1 as depth,
      array[r.parent_entity_id, r.child_entity_id]::uuid[] as path
    from public.entity_relationships r
    where r.active = true
      and r.is_primary_context = true

    union all

    select
      w.ancestor_entity_id,
      r.child_entity_id,
      w.depth + 1,
      w.path || r.child_entity_id
    from walk w
    join public.entity_relationships r
      on r.parent_entity_id = w.descendant_entity_id
     and r.active = true
     and r.is_primary_context = true
    where not r.child_entity_id = any(w.path)
      and w.depth < 25
  ), shortest as (
    select distinct on (ancestor_entity_id, descendant_entity_id)
      ancestor_entity_id,
      descendant_entity_id,
      depth
    from walk
    order by ancestor_entity_id, descendant_entity_id, depth
  )
  insert into public.entity_relationship_closure (
    ancestor_entity_id,
    descendant_entity_id,
    depth
  )
  select ancestor_entity_id, descendant_entity_id, depth
  from shortest
  on conflict (ancestor_entity_id, descendant_entity_id)
  do update set depth = least(public.entity_relationship_closure.depth, excluded.depth);
end;
$$;

create or replace function public.gcr_validate_entity_relationship_cycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cycle_found boolean;
begin
  if new.parent_entity_id = new.child_entity_id then
    raise exception 'An entity cannot be its own parent';
  end if;

  with recursive ancestors as (
    select r.parent_entity_id
    from public.entity_relationships r
    where r.child_entity_id = new.parent_entity_id
      and r.active = true
      and r.is_primary_context = true
      and r.id is distinct from new.id

    union

    select r.parent_entity_id
    from public.entity_relationships r
    join ancestors a on r.child_entity_id = a.parent_entity_id
    where r.active = true
      and r.is_primary_context = true
      and r.id is distinct from new.id
  )
  select exists(
    select 1 from ancestors where parent_entity_id = new.child_entity_id
  ) into cycle_found;

  if cycle_found then
    raise exception 'Entity relationship would create a hierarchy cycle';
  end if;

  return new;
end;
$$;

drop trigger if exists entity_relationships_cycle_guard on public.entity_relationships;
create trigger entity_relationships_cycle_guard
before insert or update of parent_entity_id, child_entity_id, is_primary_context, active
on public.entity_relationships
for each row
when (new.is_primary_context = true and new.active = true)
execute function public.gcr_validate_entity_relationship_cycle();

drop trigger if exists entity_relationships_touch_updated_at on public.entity_relationships;
create trigger entity_relationships_touch_updated_at
before update on public.entity_relationships
for each row execute function public.gcr_touch_updated_at();

select public.gcr_refresh_entity_relationship_closure();

-- ---------------------------------------------------------------------------
-- 3. Categories and directory groupings (not fake businesses)
-- ---------------------------------------------------------------------------

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  parent_category_id uuid references public.categories(id) on delete set null,
  category_type text not null default 'directory',
  description text,
  icon text,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.entity_category_links (
  entity_id uuid not null references public.entity(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (entity_id, category_id)
);

create index if not exists entity_category_links_category_idx
  on public.entity_category_links(category_id, sort_order);

drop trigger if exists categories_touch_updated_at on public.categories;
create trigger categories_touch_updated_at
before update on public.categories
for each row execute function public.gcr_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Expand the existing offerings catalog without replacing it
-- ---------------------------------------------------------------------------

alter table public.offerings
  add column if not exists entity_id uuid,
  add column if not exists offering_slug text,
  add column if not exists booking_mode text,
  add column if not exists is_bookable boolean not null default false,
  add column if not exists source_url text,
  add column if not exists last_verified_at timestamptz;

update public.offerings o
set entity_id = e.id
from public.entity e
where o.entity_id is null
  and e.slug = o.entity_slug;

update public.offerings
set offering_slug = trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
where offering_slug is null or offering_slug = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'offerings_entity_id_fkey'
  ) then
    alter table public.offerings
      add constraint offerings_entity_id_fkey
      foreign key (entity_id) references public.entity(id) on delete cascade;
  end if;
end;
$$;

create index if not exists offerings_entity_id_idx
  on public.offerings(entity_id, active, sort_order);

create index if not exists offerings_slug_idx
  on public.offerings(entity_id, offering_slug);

create table if not exists public.offering_variants (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.offerings(id) on delete cascade,
  slug text not null,
  label text not null,
  description text,
  duration_value numeric,
  duration_unit text,
  minimum_participants integer,
  maximum_participants integer,
  included_participants integer,
  minimum_age integer,
  maximum_age integer,
  pricing_basis text not null default 'flat_rate',
  booking_mode text,
  deposit_required boolean not null default false,
  deposit_amount numeric,
  deposit_type text,
  active boolean not null default true,
  sort_order integer not null default 0,
  source_url text,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offering_id, slug)
);

create index if not exists offering_variants_offering_idx
  on public.offering_variants(offering_id, active, sort_order);

drop trigger if exists offering_variants_touch_updated_at on public.offering_variants;
create trigger offering_variants_touch_updated_at
before update on public.offering_variants
for each row execute function public.gcr_touch_updated_at();

-- Convert distinct legacy duration labels into real variants.
insert into public.offering_variants (
  offering_id,
  slug,
  label,
  duration_value,
  duration_unit,
  pricing_basis,
  sort_order
)
select distinct on (p.offering_id, normalized.slug)
  p.offering_id,
  normalized.slug,
  p.duration_label,
  case
    when p.duration_label ~* '[0-9]' then
      nullif(substring(p.duration_label from '([0-9]+(?:\.[0-9]+)?)'), '')::numeric
    else null
  end,
  case
    when p.duration_label ilike '%hour%' or p.duration_label ilike '% hr%' then 'hour'
    when p.duration_label ilike '%minute%' or p.duration_label ilike '% min%' then 'minute'
    when p.duration_label ilike '%day%' then 'day'
    when p.duration_label ilike '%night%' then 'night'
    when p.duration_label ilike '%week%' then 'week'
    else null
  end,
  case
    when lower(replace(o.unit, '_', ' ')) like '%person%' then 'per_person'
    when lower(replace(o.unit, '_', ' ')) like '%seat%' then 'per_seat'
    when lower(replace(o.unit, '_', ' ')) like '%hour%' then 'per_hour'
    when lower(replace(o.unit, '_', ' ')) like '%day%' then 'per_day'
    when lower(replace(o.unit, '_', ' ')) like '%night%' then 'per_night'
    when lower(replace(o.unit, '_', ' ')) like '%week%' then 'per_week'
    when lower(replace(o.unit, '_', ' ')) like '%vessel%' or lower(replace(o.unit, '_', ' ')) like '%boat%' then 'per_vessel'
    when lower(replace(o.unit, '_', ' ')) like '%vehicle%' then 'per_vehicle'
    when lower(replace(o.unit, '_', ' ')) like '%foot%' then 'per_foot'
    else 'flat_rate'
  end,
  coalesce(p.sort_order, 0)
from public.offering_prices p
join public.offerings o on o.id = p.offering_id
cross join lateral (
  select trim(both '-' from regexp_replace(lower(p.duration_label), '[^a-z0-9]+', '-', 'g')) as slug
) normalized
where p.offering_id is not null
  and p.duration_label is not null
  and trim(p.duration_label) <> ''
  and normalized.slug <> ''
on conflict (offering_id, slug) do nothing;

create table if not exists public.participant_types (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  age_min integer,
  age_max integer,
  sort_order integer not null default 0,
  active boolean not null default true
);

insert into public.participant_types (slug, name, age_min, age_max, sort_order)
values
  ('adult', 'Adult', 18, null, 10),
  ('child', 'Child', 3, 17, 20),
  ('infant', 'Infant', 0, 2, 30),
  ('senior', 'Senior', null, null, 40),
  ('student', 'Student', null, null, 50),
  ('military', 'Military', null, null, 60),
  ('resident', 'Resident', null, null, 70),
  ('non-resident', 'Non-resident', null, null, 80)
on conflict (slug) do nothing;

create table if not exists public.offering_price_records (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.offerings(id) on delete cascade,
  variant_id uuid references public.offering_variants(id) on delete cascade,
  participant_type_id uuid references public.participant_types(id) on delete set null,
  legacy_offering_price_id uuid unique references public.offering_prices(id) on delete set null,
  label text,
  charge_type text not null default 'base',
  pricing_basis text not null default 'flat_rate',
  amount numeric,
  amount_min numeric,
  amount_max numeric,
  currency text not null default 'USD',
  is_free boolean not null default false,
  quote_required boolean not null default false,
  included_quantity integer,
  minimum_quantity integer,
  maximum_quantity integer,
  age_min integer,
  age_max integer,
  season text,
  effective_from date,
  effective_to date,
  required boolean not null default true,
  description text,
  sort_order integer not null default 0,
  source_url text,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists offering_price_records_offering_idx
  on public.offering_price_records(offering_id, variant_id, participant_type_id, sort_order);

create index if not exists offering_price_records_effective_idx
  on public.offering_price_records(effective_from, effective_to);

drop trigger if exists offering_price_records_touch_updated_at on public.offering_price_records;
create trigger offering_price_records_touch_updated_at
before update on public.offering_price_records
for each row execute function public.gcr_touch_updated_at();

insert into public.offering_price_records (
  offering_id,
  variant_id,
  participant_type_id,
  legacy_offering_price_id,
  label,
  charge_type,
  pricing_basis,
  amount,
  is_free,
  age_min,
  age_max,
  season,
  sort_order
)
select
  p.offering_id,
  v.id,
  pt.id,
  p.id,
  p.label,
  case
    when p.age_min is not null or p.age_max is not null then 'participant'
    when p.label ilike '%child%' or p.label ilike '%adult%' or p.label ilike '%infant%' then 'participant'
    else 'base'
  end,
  case
    when lower(replace(o.unit, '_', ' ')) like '%person%' then 'per_person'
    when lower(replace(o.unit, '_', ' ')) like '%seat%' then 'per_seat'
    when lower(replace(o.unit, '_', ' ')) like '%hour%' then 'per_hour'
    when lower(replace(o.unit, '_', ' ')) like '%day%' then 'per_day'
    when lower(replace(o.unit, '_', ' ')) like '%night%' then 'per_night'
    when lower(replace(o.unit, '_', ' ')) like '%week%' then 'per_week'
    when lower(replace(o.unit, '_', ' ')) like '%vessel%' or lower(replace(o.unit, '_', ' ')) like '%boat%' then 'per_vessel'
    when lower(replace(o.unit, '_', ' ')) like '%vehicle%' then 'per_vehicle'
    when lower(replace(o.unit, '_', ' ')) like '%foot%' then 'per_foot'
    else 'flat_rate'
  end,
  p.price,
  coalesce(p.price, 0) = 0,
  p.age_min,
  p.age_max,
  p.season,
  p.sort_order
from public.offering_prices p
join public.offerings o on o.id = p.offering_id
left join public.offering_variants v
  on v.offering_id = p.offering_id
 and v.slug = trim(both '-' from regexp_replace(lower(coalesce(p.duration_label, '')), '[^a-z0-9]+', '-', 'g'))
left join public.participant_types pt on pt.slug = case
  when p.label ilike '%infant%' or p.label ilike '%under 2%' or p.label ilike '%under 3%' then 'infant'
  when p.label ilike '%child%' or p.label ilike '%kid%' then 'child'
  when p.label ilike '%adult%' then 'adult'
  when p.label ilike '%senior%' then 'senior'
  when p.label ilike '%military%' then 'military'
  else null
end
where p.offering_id is not null
on conflict (legacy_offering_price_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Canonical resources and typed details
-- ---------------------------------------------------------------------------

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  owner_entity_id uuid not null references public.entity(id) on delete cascade,
  profile_entity_id uuid references public.entity(id) on delete set null,
  legacy_bookable_resource_id uuid unique references public.bookable_resources(id) on delete set null,
  resource_type text not null,
  slug text not null,
  name text not null,
  description text,
  capacity integer,
  is_bookable boolean not null default false,
  display_publicly boolean not null default false,
  booking_url text,
  source_url text,
  last_verified_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_entity_id, slug)
);

create index if not exists resources_owner_idx
  on public.resources(owner_entity_id, active, display_publicly);

create index if not exists resources_profile_idx
  on public.resources(profile_entity_id);

create index if not exists resources_type_idx
  on public.resources(resource_type, active);

drop trigger if exists resources_touch_updated_at on public.resources;
create trigger resources_touch_updated_at
before update on public.resources
for each row execute function public.gcr_touch_updated_at();

insert into public.resources (
  owner_entity_id,
  profile_entity_id,
  legacy_bookable_resource_id,
  resource_type,
  slug,
  name,
  description,
  capacity,
  is_bookable,
  display_publicly,
  booking_url,
  active
)
select
  owner.id,
  profile.id,
  br.id,
  br.resource_type,
  br.slug,
  br.name,
  br.description,
  br.capacity,
  br.booking_url is not null,
  (
    br.booking_url is not null
    or br.bedrooms is not null
    or br.bathrooms is not null
    or br.capacity is not null
    or br.nightly_price is not null
    or br.sqft is not null
  ),
  br.booking_url,
  coalesce(br.is_active, true)
from public.bookable_resources br
join public.entity owner on owner.slug = br.entity_slug
left join public.entity profile on profile.slug = br.slug
on conflict (legacy_bookable_resource_id) do nothing;

create table if not exists public.unit_details (
  resource_id uuid primary key references public.resources(id) on delete cascade,
  complex_entity_id uuid references public.entity(id) on delete set null,
  unit_number text,
  building text,
  floor integer,
  bedrooms integer,
  bathrooms numeric,
  sleeps integer,
  square_feet integer,
  view_type text,
  nightly_price numeric,
  cleaning_fee numeric,
  service_fee numeric,
  minimum_nights integer,
  check_in_time text,
  check_out_time text,
  parking_info text,
  house_rules text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists unit_details_touch_updated_at on public.unit_details;
create trigger unit_details_touch_updated_at
before update on public.unit_details
for each row execute function public.gcr_touch_updated_at();

insert into public.unit_details (
  resource_id,
  complex_entity_id,
  unit_number,
  building,
  floor,
  bedrooms,
  bathrooms,
  sleeps,
  square_feet,
  view_type,
  nightly_price,
  cleaning_fee,
  service_fee,
  minimum_nights,
  check_in_time,
  check_out_time,
  parking_info,
  house_rules
)
select
  r.id,
  parent.id,
  profile.unit_number,
  profile.building,
  profile.unit_floor,
  br.bedrooms,
  br.bathrooms,
  br.capacity,
  br.sqft,
  profile.view_type,
  br.nightly_price,
  br.cleaning_fee,
  br.service_fee,
  br.min_nights,
  br.check_in_time,
  br.check_out_time,
  br.parking_info,
  br.house_rules
from public.resources r
join public.bookable_resources br on br.id = r.legacy_bookable_resource_id
left join public.entity profile on profile.id = r.profile_entity_id
left join public.entity parent on parent.slug = profile.parent_entity_slug
where br.resource_type in ('condo', 'condo_unit', 'room', 'vacation-rental')
   or br.bedrooms is not null
   or br.bathrooms is not null
on conflict (resource_id) do nothing;

create table if not exists public.vessel_details (
  resource_id uuid primary key references public.resources(id) on delete cascade,
  vessel_type text,
  make text,
  model text,
  year integer,
  length_feet numeric,
  beam_feet numeric,
  passenger_capacity integer,
  captain_included boolean,
  restroom_available boolean,
  air_conditioning boolean,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists vessel_details_touch_updated_at on public.vessel_details;
create trigger vessel_details_touch_updated_at
before update on public.vessel_details
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.offering_resource_links (
  offering_id uuid not null references public.offerings(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  required_quantity integer not null default 1,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (offering_id, resource_id)
);

-- ---------------------------------------------------------------------------
-- 6. Structured amenities for entities and resources
-- ---------------------------------------------------------------------------

create table if not exists public.amenity_definitions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text,
  data_type text not null default 'boolean',
  unit text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.entity_amenity_values (
  entity_id uuid not null references public.entity(id) on delete cascade,
  amenity_id uuid not null references public.amenity_definitions(id) on delete cascade,
  boolean_value boolean,
  text_value text,
  numeric_value numeric,
  unit text,
  inherited_from_entity_id uuid references public.entity(id) on delete set null,
  verified_status text not null default 'unverified',
  source_url text,
  updated_at timestamptz not null default now(),
  primary key (entity_id, amenity_id)
);

create table if not exists public.resource_amenity_values (
  resource_id uuid not null references public.resources(id) on delete cascade,
  amenity_id uuid not null references public.amenity_definitions(id) on delete cascade,
  boolean_value boolean,
  text_value text,
  numeric_value numeric,
  unit text,
  verified_status text not null default 'unverified',
  source_url text,
  updated_at timestamptz not null default now(),
  primary key (resource_id, amenity_id)
);

-- Preserve current entity_amenities as canonical dictionary/value rows.
insert into public.amenity_definitions (slug, name, category)
select distinct
  trim(both '-' from regexp_replace(lower(amenity), '[^a-z0-9]+', '-', 'g')),
  amenity,
  category
from public.entity_amenities
where amenity is not null
  and trim(amenity) <> ''
on conflict (slug) do nothing;

insert into public.entity_amenity_values (
  entity_id,
  amenity_id,
  boolean_value,
  verified_status
)
select
  e.id,
  ad.id,
  true,
  'imported'
from public.entity_amenities ea
join public.entity e on e.slug = ea.entity_slug
join public.amenity_definitions ad
  on ad.slug = trim(both '-' from regexp_replace(lower(ea.amenity), '[^a-z0-9]+', '-', 'g'))
on conflict (entity_id, amenity_id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Exact event roles and roll-up through the graph
-- ---------------------------------------------------------------------------

create table if not exists public.entity_event_links (
  event_id uuid not null references public.entity_events(id) on delete cascade,
  entity_id uuid not null references public.entity(id) on delete cascade,
  role text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (event_id, entity_id, role)
);

create index if not exists entity_event_links_entity_idx
  on public.entity_event_links(entity_id, role);

insert into public.entity_event_links (event_id, entity_id, role, is_primary)
select ev.id, e.id, 'venue', true
from public.entity_events ev
join public.entity e on e.slug = ev.entity_slug
on conflict (event_id, entity_id, role) do nothing;

-- ---------------------------------------------------------------------------
-- 8. iCal, email-parser, CRM/provider connections, availability, and leads
-- ---------------------------------------------------------------------------

create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  provider text not null,
  connection_type text not null,
  external_account_id text,
  status text not null default 'pending',
  settings jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists integration_connections_entity_idx
  on public.integration_connections(entity_id, status);

create unique index if not exists integration_connections_identity_idx
  on public.integration_connections(entity_id, provider, connection_type, coalesce(external_account_id, ''));

drop trigger if exists integration_connections_touch_updated_at on public.integration_connections;
create trigger integration_connections_touch_updated_at
before update on public.integration_connections
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.inbound_email_routes (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete set null,
  forwarding_alias text not null unique,
  sender_patterns text[] not null default '{}'::text[],
  subject_patterns text[] not null default '{}'::text[],
  parser_profile text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists inbound_email_routes_touch_updated_at on public.inbound_email_routes;
create trigger inbound_email_routes_touch_updated_at
before update on public.inbound_email_routes
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete set null,
  resource_id uuid references public.resources(id) on delete cascade,
  offering_id uuid references public.offerings(id) on delete cascade,
  provider text not null,
  feed_type text not null default 'ical',
  feed_url text not null,
  timezone text not null default 'America/Chicago',
  active boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists calendar_feeds_unique_feed_idx
  on public.calendar_feeds(entity_id, provider, feed_url);

create index if not exists calendar_feeds_resource_idx
  on public.calendar_feeds(resource_id, active);

drop trigger if exists calendar_feeds_touch_updated_at on public.calendar_feeds;
create trigger calendar_feeds_touch_updated_at
before update on public.calendar_feeds
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.external_booking_records (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  resource_id uuid references public.resources(id) on delete set null,
  offering_id uuid references public.offerings(id) on delete set null,
  variant_id uuid references public.offering_variants(id) on delete set null,
  source_provider text not null,
  source_record_id text,
  source_message_id text,
  source_feed_id uuid references public.calendar_feeds(id) on delete set null,
  booking_status text not null default 'confirmed',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  quantity integer,
  guest_count integer,
  raw_payload jsonb not null default '{}'::jsonb,
  parsed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_booking_records_valid_range check (ends_at > starts_at)
);

create unique index if not exists external_booking_records_provider_record_idx
  on public.external_booking_records(source_provider, source_record_id)
  where source_record_id is not null;

create unique index if not exists external_booking_records_message_idx
  on public.external_booking_records(source_message_id)
  where source_message_id is not null;

create index if not exists external_booking_records_time_idx
  on public.external_booking_records(entity_id, starts_at, ends_at);

drop trigger if exists external_booking_records_touch_updated_at on public.external_booking_records;
create trigger external_booking_records_touch_updated_at
before update on public.external_booking_records
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.availability_slots (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  resource_id uuid references public.resources(id) on delete cascade,
  offering_id uuid references public.offerings(id) on delete cascade,
  variant_id uuid references public.offering_variants(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  total_capacity integer,
  remaining_capacity integer,
  status text not null default 'unknown',
  price_from numeric,
  currency text not null default 'USD',
  source_type text not null default 'manual',
  source_provider text,
  source_record_id text,
  freshness_at timestamptz not null default now(),
  visible_on_profile boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint availability_slots_valid_range check (ends_at > starts_at),
  constraint availability_slots_capacity_check check (
    total_capacity is null
    or remaining_capacity is null
    or (remaining_capacity >= 0 and remaining_capacity <= total_capacity)
  )
);

create index if not exists availability_slots_entity_time_idx
  on public.availability_slots(entity_id, starts_at, ends_at, status);

create index if not exists availability_slots_resource_time_idx
  on public.availability_slots(resource_id, starts_at, ends_at)
  where resource_id is not null;

create index if not exists availability_slots_offering_time_idx
  on public.availability_slots(offering_id, variant_id, starts_at)
  where offering_id is not null;

create unique index if not exists availability_slots_source_record_idx
  on public.availability_slots(source_provider, source_record_id)
  where source_provider is not null and source_record_id is not null;

drop trigger if exists availability_slots_touch_updated_at on public.availability_slots;
create trigger availability_slots_touch_updated_at
before update on public.availability_slots
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  resource_id uuid references public.resources(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  block_type text not null default 'booked',
  source_provider text,
  source_record_id text,
  reason text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint availability_blocks_valid_range check (ends_at > starts_at)
);

create index if not exists availability_blocks_resource_time_idx
  on public.availability_blocks(resource_id, starts_at, ends_at, active);

drop trigger if exists availability_blocks_touch_updated_at on public.availability_blocks;
create trigger availability_blocks_touch_updated_at
before update on public.availability_blocks
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.widget_instances (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  public_key text not null unique default encode(gen_random_bytes(18), 'hex'),
  allowed_domains text[] not null default '{}'::text[],
  enabled_modules text[] not null default array['availability', 'chat', 'lead_capture']::text[],
  lead_capture_mode text not null default 'before_redirect',
  theme jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists widget_instances_touch_updated_at on public.widget_instances;
create trigger widget_instances_touch_updated_at
before update on public.widget_instances
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.booking_leads (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entity(id) on delete cascade,
  widget_instance_id uuid references public.widget_instances(id) on delete set null,
  offering_id uuid references public.offerings(id) on delete set null,
  variant_id uuid references public.offering_variants(id) on delete set null,
  resource_id uuid references public.resources(id) on delete set null,
  requested_start timestamptz,
  requested_end timestamptz,
  party_size integer,
  adult_count integer,
  child_count integer,
  infant_count integer,
  customer_name text,
  customer_email text,
  customer_phone text,
  consent_to_contact boolean not null default false,
  source_page_url text,
  target_provider text,
  target_booking_url text,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists booking_leads_entity_created_idx
  on public.booking_leads(entity_id, created_at desc);

drop trigger if exists booking_leads_touch_updated_at on public.booking_leads;
create trigger booking_leads_touch_updated_at
before update on public.booking_leads
for each row execute function public.gcr_touch_updated_at();

create table if not exists public.booking_redirect_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.booking_leads(id) on delete set null,
  entity_id uuid not null references public.entity(id) on delete cascade,
  target_provider text,
  target_url text not null,
  clicked_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- 9. Relationship-aware SQL helpers for the API and AI tool layer
-- ---------------------------------------------------------------------------

create or replace function public.gcr_entity_descendants(
  root_slug text,
  max_depth integer default 10
)
returns table (
  entity_id uuid,
  slug text,
  name text,
  entity_kind text,
  entity_type text,
  entity_subtype text,
  depth integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    e.slug,
    e.name,
    e.entity_kind,
    e.entity_type,
    e.entity_subtype,
    c.depth
  from public.entity root
  join public.entity_relationship_closure c
    on c.ancestor_entity_id = root.id
  join public.entity e
    on e.id = c.descendant_entity_id
  where root.slug = root_slug
    and c.depth between 0 and greatest(max_depth, 0)
    and e.is_active = true
  order by c.depth, e.name;
$$;

create or replace function public.gcr_entity_ancestors(
  child_slug text
)
returns table (
  entity_id uuid,
  slug text,
  name text,
  entity_kind text,
  depth integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id,
    e.slug,
    e.name,
    e.entity_kind,
    c.depth
  from public.entity child
  join public.entity_relationship_closure c
    on c.descendant_entity_id = child.id
  join public.entity e
    on e.id = c.ancestor_entity_id
  where child.slug = child_slug
    and e.is_active = true
  order by c.depth desc;
$$;

-- ---------------------------------------------------------------------------
-- 10. Security: all new operational tables are API/service-role only by default
-- ---------------------------------------------------------------------------

alter table public.entity_relationships enable row level security;
alter table public.entity_relationship_closure enable row level security;
alter table public.categories enable row level security;
alter table public.entity_category_links enable row level security;
alter table public.offering_variants enable row level security;
alter table public.participant_types enable row level security;
alter table public.offering_price_records enable row level security;
alter table public.resources enable row level security;
alter table public.unit_details enable row level security;
alter table public.vessel_details enable row level security;
alter table public.offering_resource_links enable row level security;
alter table public.amenity_definitions enable row level security;
alter table public.entity_amenity_values enable row level security;
alter table public.resource_amenity_values enable row level security;
alter table public.entity_event_links enable row level security;
alter table public.integration_connections enable row level security;
alter table public.inbound_email_routes enable row level security;
alter table public.calendar_feeds enable row level security;
alter table public.external_booking_records enable row level security;
alter table public.availability_slots enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.widget_instances enable row level security;
alter table public.booking_leads enable row level security;
alter table public.booking_redirect_events enable row level security;

comment on table public.entity_relationships is
  'Typed graph edges: part_of, located_at, operates_from, unit_of, department_of, resource_of, owned_by, managed_by, listed_in.';
comment on table public.offering_variants is
  'Bookable variations such as 4-hour, 6-hour, 8-hour, nightly, weekly, morning, sunset, private, or shared.';
comment on table public.offering_price_records is
  'Structured prices by offering, variant, participant type, season, charge type, and pricing basis.';
comment on table public.resources is
  'Physical or capacity-bearing inventory such as condo units, rooms, boats, slips, vehicles, staff, or equipment.';
comment on table public.availability_slots is
  'Unified public availability produced by email parsing, iCal feeds, provider APIs, or direct GCR inventory.';
comment on table public.booking_leads is
  'Customer intent captured by GCR/widget before redirecting to an external booking provider.';

commit;
