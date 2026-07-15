-- ============================================================================
-- add-business-availability-ical-columns.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- Unifies iCal calendar sync (Airbnb/VRBO/FareHarbor-style .ics feeds) onto
-- the SAME table the live Reserve page already reads/writes:
-- public.business_availability (via GET/POST /api/email-parser/*).
--
-- Background: an earlier pass built a brand-new, unused v2 schema
-- (v2.availability_blocks / v2.resource_calendar_sources, see
-- db/v2/021_ical_sync.sql and db/v2/022_generalize_calendar_sources.sql) for
-- this feature, before discovering that the live public-facing frontend
-- (gcr-unified's Reserve.jsx / BusinessDetail.jsx) does not read v2 at all —
-- it calls GET /api/email-parser/availability/:slug, which reads
-- business_availability directly. Writing iCal blocks into v2 would have
-- created a second, disconnected "calendar" nobody sees, while the real one
-- stayed blind to Airbnb/VRBO bookings. Fixed by pointing iCal sync at the
-- real, live table instead. The v2 tables are left in place (unused) as an
-- honest record; see db/v2/README.md.
--
-- business_availability already had a resource_id column (for multi-unit
-- properties, referencing bookable_resources.id) but no external_uid, which
-- iCal sync needs to dedupe/update/clean-up individual calendar events.
-- ============================================================================

ALTER TABLE public.business_availability ADD COLUMN IF NOT EXISTS external_uid text;

-- entity_external_calendars already existed with the right shape
-- (entity_slug, resource_id, ical_url, provider, source_label, is_active,
-- last_synced_at, last_sync_status, sync_error, consecutive_failures) and
-- was simply never wired up to anything. No changes needed there.
