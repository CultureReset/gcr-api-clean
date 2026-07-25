-- Makes legacy_photo_migration_queue safe to load incrementally.
--
-- Run against the TARGET project (mkepugvdlktfsossumox) BEFORE any further
-- loading. Without this index there is nothing stopping a re-run of a chunk
-- from inserting the same photo twice: the table only has a PK on id.
--
-- With it, every insert can use ON CONFLICT DO NOTHING, which makes chunk
-- boundaries and double-fires harmless -- a repeated row is a no-op, not a
-- duplicate.

-- Safety check: this will raise if duplicates already exist, in which case
-- resolve them before creating the index.
DO $$
DECLARE dupes bigint;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT entity_slug, source_url
    FROM legacy_photo_migration_queue
    GROUP BY entity_slug, source_url
    HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Found % duplicated (entity_slug, source_url) pairs; clean these up first', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS legacy_photo_queue_slug_url_key
  ON public.legacy_photo_migration_queue (entity_slug, source_url);

-- Helps the loader's "what is already here?" scan and the worker's claim query.
CREATE INDEX IF NOT EXISTS idx_legacy_photo_queue_slug
  ON public.legacy_photo_migration_queue (entity_slug);
