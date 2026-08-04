-- Tie a claim to the listing it is about.
--
-- The "Claim my business" button on a GCR profile page knows exactly which
-- business the visitor is looking at. Without this column that knowledge is
-- thrown away and an admin has to match a typed name back to one of 4,067
-- listings by hand.
--
-- The admin dashboard's Claims screen already reads `entity_slug` — it renders
-- it under the business name and uses it for the "Open" button that jumps to
-- the entity editor. Adding the column is what makes that work.
--
-- ADDITIVE AND REVERSIBLE. One nullable column and one index. No existing row
-- changes, no data is read or rewritten, nothing is dropped. Claims filed
-- before this runs keep working and simply carry no slug.
--
-- Verified against the real database (Supabase project "cyber check" /
-- mkepugvdlktfsossumox) on 2026-08-04: business_claims exists with 12 columns
-- and no entity_slug; entity.slug is text and unique.
--
--   psql "$DATABASE_URL" -f sql/business_claims_entity_slug.sql
--
-- To undo:  alter table public.business_claims drop column entity_slug;

alter table public.business_claims
  add column if not exists entity_slug text;

comment on column public.business_claims.entity_slug is
  'The entity.slug this claim is about, when the claim came from a profile page. Null for claims filed against a business with no listing yet.';

-- Deliberately NOT a foreign key. A claim is a lead, and it should survive a
-- listing being renamed or removed while an admin is still working it.

create index if not exists business_claims_entity_slug_idx
  on public.business_claims (entity_slug)
  where entity_slug is not null;

-- Claims waiting on someone. The Claims screen opens on this set.
create index if not exists business_claims_status_created_idx
  on public.business_claims (status, created_at desc);
