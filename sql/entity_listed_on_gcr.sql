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
-- The rule is geographic: within 25 miles of the shoreline, from New Orleans
-- east along the Gulf, around the Florida peninsula and the Keys, and north up
-- the Atlantic coast to the Georgia line. lib/serviceArea.js holds the 75
-- anchor towns and is the single definition — the VALUES list below is
-- generated from it, so the two cannot drift.
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
  (29.95,-90.07),
  (30.28,-89.78),
  (30.31,-89.33),
  (30.37,-89.09),
  (30.4,-88.89),
  (30.37,-88.56),
  (30.25,-88.11),
  (30.69,-88.04),
  (30.52,-87.9),
  (30.25,-87.7),
  (30.27,-87.58),
  (30.29,-87.44),
  (30.42,-87.22),
  (30.33,-87.14),
  (30.39,-86.87),
  (30.42,-86.62),
  (30.39,-86.5),
  (30.38,-86.37),
  (30.33,-86.17),
  (30.18,-85.81),
  (30.16,-85.66),
  (29.94,-85.42),
  (29.81,-85.3),
  (29.73,-84.98),
  (29.85,-84.66),
  (30.03,-84.39),
  (30.16,-84.21),
  (29.81,-83.59),
  (29.67,-83.38),
  (29.33,-83.14),
  (29.14,-83.03),
  (29.03,-82.72),
  (28.9,-82.59),
  (28.78,-82.61),
  (28.47,-82.66),
  (28.36,-82.69),
  (28.15,-82.76),
  (27.97,-82.8),
  (27.95,-82.46),
  (27.77,-82.64),
  (27.5,-82.57),
  (27.34,-82.53),
  (27.1,-82.45),
  (26.93,-82.05),
  (26.64,-81.87),
  (26.34,-81.78),
  (26.14,-81.79),
  (25.94,-81.72),
  (25.86,-81.38),
  (25.14,-80.92),
  (25.09,-80.45),
  (24.92,-80.63),
  (24.71,-81.09),
  (24.67,-81.35),
  (24.56,-81.78),
  (25.47,-80.48),
  (25.76,-80.19),
  (25.79,-80.13),
  (26.12,-80.14),
  (26.35,-80.08),
  (26.71,-80.05),
  (26.93,-80.09),
  (27.2,-80.25),
  (27.45,-80.33),
  (27.64,-80.4),
  (28.08,-80.61),
  (28.32,-80.61),
  (28.61,-80.81),
  (29.03,-80.93),
  (29.21,-81.02),
  (29.58,-81.21),
  (29.9,-81.31),
  (30.29,-81.39),
  (30.33,-81.66),
  (30.67,-81.46)
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
