-- Trigram indexes for the search bar's ILIKE '%word%' matching
-- (routes/gcr.js searchEntitySlugs). Without them every search scanned each
-- table in full; entity_tags alone (81k rows) took ~100 ms per search.
-- Words under three letters can't use a trigram index and still scan.
create extension if not exists pg_trgm;

create index if not exists entity_name_trgm        on public.entity            using gin (name gin_trgm_ops);
create index if not exists entity_description_trgm on public.entity            using gin (description gin_trgm_ops);
create index if not exists entity_subtitle_trgm    on public.entity            using gin (subtitle gin_trgm_ops);
create index if not exists entity_city_trgm        on public.entity            using gin (city gin_trgm_ops);
create index if not exists entity_subtype_trgm     on public.entity            using gin (entity_subtype gin_trgm_ops);
create index if not exists entity_tags_name_trgm   on public.entity_tags       using gin (tag_name gin_trgm_ops);
create index if not exists menu_items_name_trgm    on public.menu_items        using gin (item_name gin_trgm_ops);
create index if not exists menu_items_desc_trgm    on public.menu_items        using gin (description gin_trgm_ops);
create index if not exists entity_amenities_trgm   on public.entity_amenities  using gin (amenity gin_trgm_ops);
create index if not exists entity_highlights_trgm  on public.entity_highlights using gin (highlight gin_trgm_ops);
