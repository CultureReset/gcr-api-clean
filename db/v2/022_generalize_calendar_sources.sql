-- ============================================================================
-- GCR v2 — 022_generalize_calendar_sources.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- Discovered mid-build: a complete, real iCal sync system already existed in
-- this codebase (routes/email-parser.js + routes/dashboard.js's /ical/external
-- endpoints) — cron-scheduled hourly, with a "sync now" button already wired
-- into the owner dashboard, and even a reverse export feed. It had just never
-- been used (0 rows). A brand-new parallel system (021_ical_sync.sql, using a
-- different library, writing to different tables) was built before this was
-- found. That duplicate has been deleted — routes/gcr-v2-ical-sync.js is
-- gone, the node-ical dependency is removed, and the ORIGINAL system has been
-- repointed at v2 instead of the legacy business_availability/
-- entity_external_calendars tables.
--
-- The original system supports connecting a calendar either to ONE resource
-- (a specific condo unit in a multi-unit building) or to the WHOLE entity
-- when there's no separate resource concept (a standalone rental). v2's
-- tables are generalized here to support both, matching that real design.
-- ============================================================================

ALTER TABLE v2.resource_calendar_sources ALTER COLUMN resource_id DROP NOT NULL;
ALTER TABLE v2.resource_calendar_sources ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES v2.entities(id) ON DELETE CASCADE;
ALTER TABLE v2.resource_calendar_sources ADD COLUMN IF NOT EXISTS source_label text;
ALTER TABLE v2.resource_calendar_sources ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE v2.resource_calendar_sources ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE v2.resource_calendar_sources ADD COLUMN IF NOT EXISTS last_sync_status text;
CREATE INDEX IF NOT EXISTS idx_v2_calendar_sources_entity ON v2.resource_calendar_sources(entity_id);

ALTER TABLE v2.availability_blocks ALTER COLUMN resource_id DROP NOT NULL;
ALTER TABLE v2.availability_blocks ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES v2.entities(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_v2_avail_blocks_entity ON v2.availability_blocks(entity_id);

-- A plain expression-based unique index doesn't support ON CONFLICT cleanly.
-- A real generated column does, and works exactly like a normal unique
-- constraint for upsert purposes -- verified directly.
ALTER TABLE v2.availability_blocks
  ADD COLUMN IF NOT EXISTS scope_key text GENERATED ALWAYS AS (COALESCE(resource_id::text, entity_id::text, '')) STORED;
ALTER TABLE v2.availability_blocks
  ADD CONSTRAINT uq_v2_avail_blocks_scope_uid UNIQUE (scope_key, external_uid);
ALTER TABLE v2.availability_blocks
  ADD CONSTRAINT chk_v2_avail_blocks_has_scope CHECK (resource_id IS NOT NULL OR entity_id IS NOT NULL);

-- Verified directly against the live schema: a resource-scoped upsert, an
-- entity-scoped upsert, and a re-sync of the same resource-scoped event all
-- behave correctly -- the re-sync updates in place rather than duplicating.
-- Test rows removed after verification.
