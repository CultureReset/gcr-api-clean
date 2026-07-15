-- ============================================================================
-- GCR v2 — 021_ical_sync.sql  (EXECUTED, SUPERSEDED — see 022)
-- ----------------------------------------------------------------------------
-- SUPERSEDED: this migration and its route (routes/gcr-v2-ical-sync.js, now
-- deleted) duplicated a complete, already-working iCal system that already
-- existed in routes/email-parser.js + routes/dashboard.js (cron-scheduled,
-- dashboard "sync now" button already wired up) — it had just never been
-- used. Rather than run two parallel sync systems, the original was
-- repointed at v2 instead (022_generalize_calendar_sources.sql) and this
-- one's route was deleted. The columns/constraints below are still in
-- place and still used — just not through this file's now-deleted route.
-- Left here, not deleted, as an honest record of the duplicate mistake and
-- how it was found and corrected.
--
-- Supports real availability sync from Airbnb/VRBO/booking-platform iCal
-- feeds into v2.availability_blocks, per resource (condo unit, boat).
-- ============================================================================

ALTER TABLE v2.availability_blocks ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE v2.availability_blocks ADD COLUMN IF NOT EXISTS external_uid text;
ALTER TABLE v2.availability_blocks ADD COLUMN IF NOT EXISTS synced_at timestamptz;

-- A PARTIAL unique index (WHERE external_uid IS NOT NULL) does NOT work with
-- a plain `ON CONFLICT (resource_id, external_uid)` from PostgREST/supabase-js
-- upserts (Postgres error 42P10 — verified by testing, not assumed). A plain
-- UNIQUE CONSTRAINT is correct here anyway: NULLs never collide with each
-- other under standard SQL uniqueness semantics, so manually-entered blocks
-- (external_uid IS NULL) are unaffected.
ALTER TABLE v2.availability_blocks ADD CONSTRAINT uq_v2_avail_blocks_resource_uid UNIQUE (resource_id, external_uid);

-- Verified end-to-end against a real resource row:
--   1. Upsert two synthetic events (test-uid-1, test-uid-2) -> both landed.
--   2. Re-sync simulating uid-2's booking being cancelled (only uid-1 in the
--      feed) -> uid-1 updated in place, uid-2 correctly deleted.
--   3. node-ical (added to package.json) verified to parse a real Airbnb-style
--      VEVENT block (DTSTART/DTEND/UID/SUMMARY) correctly.
-- Test rows removed after verification; no synthetic data left in the table.
