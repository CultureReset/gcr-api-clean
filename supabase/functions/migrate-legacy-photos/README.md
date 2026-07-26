# Legacy photo migration

Copies entity images that only ever existed in the legacy project
(`adpnhipmdefutkzzltbs`, "gulf coast radar") into production
(`mkepugvdlktfsossumox`) storage, and links them in `entity_photos`.

## Join key

`legacy entity.google_places_id = production entity.google_place_id`.

This is the only safe key. Slugs do **not** correspond: legacy slugs carry a
`-ChIJ<place id prefix>` suffix that production slugs lack, and stripping that
suffix collapses two distinct legacy businesses onto one production slug for
100 slugs — which would attach one business's photos to another. Verified
across all loaded rows: 220/220 source folders matched on place ID, 0
mismatches.

Coverage limit: only 969 of 2,301 legacy entities have a place ID, and 908 of
those have bucket photos. 861 matched a production entity; the rest are
presumed closed or delisted.

## Queue state as loaded

- 2,424 rows across 861 businesses, no duplicates
- Reconciles against the source: 2,424 pending + 288 already linked = 2,712,
  against 2,713 objects in the legacy `entity-images` bucket

## Rebuilding the queue from scratch

Nothing depends on local scratch files. Run against the legacy project to get
one token per business (`md5(place_id)[0:8]` + legacy entity uuid + the photo
indexes present):

```sql
WITH d AS (
  SELECT DISTINCT ON (e.google_places_id, split_part(p.image_url,'/',-1))
         e.google_places_id AS pid, p.entity_id::text AS lid,
         replace(replace(split_part(p.image_url,'/',-1),'image_',''),'.jpg','')::int AS n
  FROM entity_photos p JOIN entity e ON e.id = p.entity_id
  WHERE p.image_url LIKE '%/entity-images/%' AND e.google_places_id IS NOT NULL
  ORDER BY e.google_places_id, split_part(p.image_url,'/',-1)
)
SELECT string_agg(ph||lid||ns, ';' ORDER BY ph)
FROM (
  SELECT left(md5(pid),8) AS ph, lid, string_agg(n::text,'' ORDER BY n) AS ns
  FROM d GROUP BY left(md5(pid),8), lid
) g;
```

Filenames are uniformly `image_N.jpg`, and across all 2,664 source rows
`sort_order = n-1` and `is_cover = (n = 1)`, so only the indexes need carrying.

Feed that string to production, which resolves the slug locally:

```sql
WITH toks AS (
  SELECT substr(tok,1,8) AS ph, substr(tok,9,36) AS lid, substr(tok,45) AS ns
  FROM unnest(string_to_array('<token string>', ';')) AS tok
), expanded AS (
  SELECT t.ph, t.lid, n.ch::int AS n
  FROM toks t, LATERAL regexp_split_to_table(t.ns,'') AS n(ch)
  WHERE n.ch <> ''
), cand AS (
  SELECT e.slug AS entity_slug,
         'https://adpnhipmdefutkzzltbs.supabase.co/storage/v1/object/public/entity-images/'
           ||x.lid||'/image_'||x.n||'.jpg' AS source_url,
         (x.n = 1) AS is_cover,
         100 + (x.n - 1) AS sort_order
  FROM expanded x
  JOIN entity e ON left(md5(e.google_place_id),8) = x.ph
)
INSERT INTO legacy_photo_migration_queue (entity_slug, source_url, is_cover, sort_order)
SELECT c.* FROM cand c
WHERE NOT EXISTS (
  SELECT 1 FROM entity_photos ep
  WHERE ep.entity_slug = c.entity_slug AND ep.url = c.source_url
)
ON CONFLICT (entity_slug, source_url) DO NOTHING;
```

`ON CONFLICT` relies on the unique index in
`supabase/migrations/1785023179_legacy_photo_queue_dedupe.sql`, which is what
makes re-running a batch a no-op instead of a duplicate.

## Running the copy

```bash
supabase secrets set MIGRATION_SECRET=<value>
supabase functions deploy migrate-legacy-photos --no-verify-jwt

# repeat until "remaining": 0
curl -X POST "$PROJECT_URL/functions/v1/migrate-legacy-photos?batch=50" \
     -H "x-migration-secret: $MIGRATION_SECRET"
```

Then verify. `blue-parrot-7` should go from 1 photo to 3:

```sql
SELECT status, count(*) FROM legacy_photo_migration_queue GROUP BY status;
SELECT count(*) FROM entity_photos WHERE entity_slug = 'blue-parrot-7';
```

Note `entity_photos` has ~6,460 pre-existing duplicate `(entity_slug, url)`
groups, so a unique index there would fail today. The function therefore guards
inserts with an existence check rather than relying on a constraint.
