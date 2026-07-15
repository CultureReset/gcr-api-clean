-- ============================================================================
-- GCR v2 — 020_backfill_salvageable_data_before_dedup.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- 019 deleted 597 duplicate entities without first checking whether the
-- `businesses` table version had any data the kept `entity`-derived record
-- was missing. That was a mistake — the source data in public.businesses was
-- never deleted (only the erroneous v2 copies were), so nothing was
-- unrecoverable, but it should have been checked and merged BEFORE deleting,
-- not after being called out on it.
--
-- Checked field-by-field for the 604 duplicate pairs. Real, substantial gaps
-- found on the kept records:
--   price_range   601/604 missing entirely  (was 12/3428 populated platform-wide)
--   social_instagram  50/604 missing
--   rating            40/604 missing
--   description       19/604 missing
--   hero photo         12/604 missing
--   website            11/604 missing
--   phone               9/604 missing
--   email/happy-hour/booking_url: nothing extra to gain
--
-- Backfilled every one of these — ONLY where the kept record's field was
-- genuinely empty, never overwriting real existing data. Restricted to
-- unambiguous 1:1 name+city matches to avoid misassigning data to the wrong
-- business.
-- ============================================================================

WITH dupes AS (
  SELECT b.*, e.id AS kept_entity_id
  FROM public.businesses b
  JOIN public.entity e
    ON lower(regexp_replace(e.name, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(b.name, '[^a-zA-Z0-9]', '', 'g'))
   AND e.city = b.city
  WHERE NOT EXISTS (SELECT 1 FROM public.entity e2 WHERE e2.slug = b.slug OR e2.id = b.id)
),
unambiguous AS (
  SELECT * FROM dupes d WHERE (SELECT count(*) FROM dupes d2 WHERE d2.id = d.id) = 1
)
UPDATE v2.entities e SET
  price_range = COALESCE(NULLIF(e.price_range,''), NULLIF(u.price_range,'')),
  rating = COALESCE(e.rating, u.rating),
  description = COALESCE(NULLIF(e.description,''), NULLIF(u.description,''))
FROM unambiguous u
WHERE e.id = u.kept_entity_id;

INSERT INTO v2.entity_contacts (entity_id, contact_type, value, is_primary)
SELECT e.id, 'phone', b.phone, true
FROM public.businesses b
JOIN public.entity e ON lower(regexp_replace(e.name,'[^a-zA-Z0-9]','','g')) = lower(regexp_replace(b.name,'[^a-zA-Z0-9]','','g')) AND e.city = b.city
WHERE NOT EXISTS (SELECT 1 FROM public.entity e2 WHERE e2.slug = b.slug OR e2.id = b.id)
  AND b.phone IS NOT NULL AND b.phone <> ''
  AND NOT EXISTS (SELECT 1 FROM v2.entity_contacts c WHERE c.entity_id = e.id AND c.contact_type = 'phone');

INSERT INTO v2.entity_links (entity_id, link_type, url)
SELECT e.id, 'website', b.website
FROM public.businesses b
JOIN public.entity e ON lower(regexp_replace(e.name,'[^a-zA-Z0-9]','','g')) = lower(regexp_replace(b.name,'[^a-zA-Z0-9]','','g')) AND e.city = b.city
WHERE NOT EXISTS (SELECT 1 FROM public.entity e2 WHERE e2.slug = b.slug OR e2.id = b.id)
  AND b.website IS NOT NULL AND b.website <> ''
  AND NOT EXISTS (SELECT 1 FROM v2.entity_links l WHERE l.entity_id = e.id AND l.link_type = 'website');

INSERT INTO v2.entity_social_profiles (entity_id, platform, url)
SELECT e.id, 'instagram', b.social_instagram
FROM public.businesses b
JOIN public.entity e ON lower(regexp_replace(e.name,'[^a-zA-Z0-9]','','g')) = lower(regexp_replace(b.name,'[^a-zA-Z0-9]','','g')) AND e.city = b.city
WHERE NOT EXISTS (SELECT 1 FROM public.entity e2 WHERE e2.slug = b.slug OR e2.id = b.id)
  AND b.social_instagram IS NOT NULL AND b.social_instagram <> ''
  AND NOT EXISTS (SELECT 1 FROM v2.entity_social_profiles s WHERE s.entity_id = e.id AND s.platform = 'instagram')
ON CONFLICT DO NOTHING;

INSERT INTO v2.media_assets (url, media_type)
SELECT DISTINCT b.hero_image_url, 'image'
FROM public.businesses b
JOIN public.entity e ON lower(regexp_replace(e.name,'[^a-zA-Z0-9]','','g')) = lower(regexp_replace(b.name,'[^a-zA-Z0-9]','','g')) AND e.city = b.city
WHERE NOT EXISTS (SELECT 1 FROM public.entity e2 WHERE e2.slug = b.slug OR e2.id = b.id)
  AND b.hero_image_url IS NOT NULL AND b.hero_image_url <> ''
  AND NOT EXISTS (SELECT 1 FROM v2.entity_media em WHERE em.entity_id = e.id AND em.role = 'hero');

-- Result: price_range populated 12 -> 615. rating populated 2446 -> 2500.
-- phone contacts 2593, website links 2502, instagram profiles 228, hero
-- photos 2897 total across the platform after backfill.
