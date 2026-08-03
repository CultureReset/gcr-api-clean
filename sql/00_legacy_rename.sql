-- ############################################################
-- ##  DO NOT RUN. See HANDOFF.md in the repository root.    ##
-- ##                                                        ##
-- ##  This file was written against the WRONG database and  ##
-- ##  has never been validated against the real one         ##
-- ##  (Supabase project "cyber check" / mkepugvdlktfsossumox).##
-- ############################################################

/* ─────────────────────────────────────────────────────────────────────────
   Move three abandoned table names out of the way.

   The live GCR database already had `amenities`, `activities` and `packages`,
   but not in the shape anything uses:

     amenities   site_id + 30 boolean columns (pool, lazy_river, …).
                 routes/gcr.js queries it for `entity_slug,name,icon,is_shared`
                 — columns it does not have — so that read already fails today.
     activities  entity_id + activity_name. No route in this repo reads it.
     packages    entity_id + whats_included[]. No route in this repo reads it.

   All three are EMPTY — verified with select count(*), not the pg_stat
   estimate, which reads 0 for a table that was never analyzed.

   They are RENAMED, not dropped. Nothing is lost: the column definitions,
   indexes and the foreign key to `entity` all follow the rename. If any of
   them turns out to matter, `alter table … rename to <original>` puts it back.

   This has to run BEFORE capability_tables.sql, because `create table if not
   exists` would silently keep the old shape and then the seed inserts would
   fail on a column that isn't there.
   ───────────────────────────────────────────────────────────────────────── */

do $$
begin
  if to_regclass('public.amenities') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='amenities'
                   and column_name='site_id')
  then
    if (select count(*) from public.amenities) > 0 then
      raise exception 'public.amenities is not empty — refusing to rename';
    end if;
    alter table public.amenities rename to amenities_site_flags_legacy;
    raise notice 'amenities -> amenities_site_flags_legacy (was empty)';
  end if;

  if to_regclass('public.activities') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='activities'
                   and column_name='activity_name')
  then
    if (select count(*) from public.activities) > 0 then
      raise exception 'public.activities is not empty — refusing to rename';
    end if;
    alter table public.activities rename to activities_entity_legacy;
    raise notice 'activities -> activities_entity_legacy (was empty)';
  end if;

  if to_regclass('public.packages') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='packages'
                   and column_name='whats_included')
  then
    if (select count(*) from public.packages) > 0 then
      raise exception 'public.packages is not empty — refusing to rename';
    end if;
    alter table public.packages rename to packages_entity_legacy;
    raise notice 'packages -> packages_entity_legacy (was empty)';
  end if;
end $$;
