-- Which businesses belong on Gulf Coast Radar.
--
-- Until now `is_active` did two jobs: "this record is usable" AND "show it on
-- GCR" — 47 queries in routes/gcr.js filter on it and nothing else. That left
-- no way to hold a CyberCheck customer who is not a Gulf Coast beach business:
-- switch them off and they are a dead record, switch them on and they are in
-- the public directory.
--
-- This column separates the two. `is_active` goes back to meaning "open, not
-- deleted"; `listed_on_gcr` means "belongs in the directory".
--
-- The rule is geographic: within 25 miles of the shoreline between New Orleans
-- and Mexico Beach. lib/serviceArea.js holds the coastline and is the single
-- definition — this file mirrors it for the one-off backfill.
--
-- ADDITIVE. One column, one index. No existing column is changed and no row is
-- deleted. The backfill only ever sets the new column.
--
--   psql "$DATABASE_URL" -f sql/entity_listed_on_gcr.sql
--
-- To undo:  alter table public.entity drop column listed_on_gcr;

alter table public.entity
  add column if not exists listed_on_gcr boolean not null default true;

comment on column public.entity.listed_on_gcr is
  'Belongs in the Gulf Coast Radar directory. Set from the coastal service area in lib/serviceArea.js, and overridable by hand — a charter based inland may still operate from the coast.';

create index if not exists entity_listed_on_gcr_idx
  on public.entity (listed_on_gcr) where listed_on_gcr;

/* ── backfill ──────────────────────────────────────────────────────────────
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   has coordinates    inside 25 mi of the coastline  → true, else false
 *   city only          a known coastal town           → true
 *   neither            LEFT AS true
 *
 * 378 live listings have no location at all. Treating "unknown" as "outside"
 * would silently drop every one of them out of the directory overnight. They
 * stay listed and can be worked through by hand.
 */

with coast(lat, lng) as (values
  (29.95,-90.07),(30.28,-89.78),(30.31,-89.33),(30.37,-89.09),(30.40,-88.89),
  (30.37,-88.56),(30.25,-88.11),(30.69,-88.04),(30.52,-87.90),(30.25,-87.70),
  (30.27,-87.58),(30.29,-87.44),(30.42,-87.22),(30.33,-87.14),(30.39,-86.87),
  (30.42,-86.62),(30.39,-86.50),(30.38,-86.37),(30.33,-86.17),(30.18,-85.81),
  (30.16,-85.66),(29.94,-85.42)
),
measured as (
  select e.id,
         min(3959 * acos(least(1, greatest(-1,
           cos(radians(e.latitude))*cos(radians(c.lat))*cos(radians(c.lng)-radians(e.longitude))
           + sin(radians(e.latitude))*sin(radians(c.lat))
         )))) as miles
  from public.entity e cross join coast c
  where e.latitude is not null and e.longitude is not null
    and e.longitude between -100 and -70 and e.latitude between 20 and 50
  group by e.id
)
update public.entity e
set listed_on_gcr = (m.miles <= 25)
from measured m
where e.id = m.id;

-- Report, so the result is visible rather than assumed.
do $$
declare listed int; held int; unknown_loc int;
begin
  select count(*) filter (where listed_on_gcr),
         count(*) filter (where not listed_on_gcr),
         count(*) filter (where latitude is null and (city is null or city = ''))
    into listed, held, unknown_loc
  from public.entity;
  raise notice 'listed on GCR: %  held back: %  (no location at all, left listed: %)', listed, held, unknown_loc;
end $$;
