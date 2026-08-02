-- ============================================================================
-- 90 — LEGACY BACKFILL  (defines functions; moves NO data on apply)
-- ============================================================================
-- Requires: 00-spine.sql (plus the vertical files for whichever you backfill)
--
-- ⚠️  APPLYING THIS FILE MIGRATES NOTHING.
-- It only defines backfill functions. Data moves when you deliberately call
-- one, one legacy table at a time, and check the result. That separation is
-- the point: a data migration that runs as a side effect of applying a schema
-- file is how live bookings get mangled.
--
-- THE SITUATION: seven parallel booking tables exist because each vertical was
-- built standalone before the spine existed.
--
--   entity_bookings          bookings.js        shape KNOWN (schema.sql:569)
--   charter_bookings         charter.js         shape UNKNOWN
--   boat_rentals             boat-rental.js     shape UNKNOWN
--   photo_bookings           photographer.js    shape UNKNOWN
--   booking_events           rentals/services   shape UNKNOWN
--   transportation_requests  transportation.js  shape UNKNOWN
--   artist_bookings          artist-bookings.js shape UNKNOWN
--
-- Only entity_bookings has a CREATE TABLE anywhere in this repo. The other six
-- are referenced by route code but defined nowhere, so a mapping for them
-- would be guesswork. Run the audit in §1 against the LIVE database, then fill
-- in the templates in §3.
--
-- MIGRATION POSTURE — non-destructive, reversible, verifiable:
--   1. Legacy tables are READ ONLY here. Nothing is dropped, altered, deleted.
--   2. Every migrated row is tagged source='legacy:<table>' and keeps its
--      original id in details->>'legacy_id', so a backfill is re-runnable
--      (idempotent) and fully reversible with one DELETE on the tag.
--   3. Leave the old routes mounted and serving reads until the new path is
--      proven. Dual-write, then cut over, then unmount. Do not big-bang.
-- ============================================================================


-- ── 1. AUDIT — run this FIRST, against the live database ────────────────────
-- Tells you which legacy tables actually exist, how many rows are at stake,
-- and what columns they really have.
--
-- SELECT table_name,
--        string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position)
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name IN ('entity_bookings','charter_bookings','boat_rentals',
--                      'photo_bookings','booking_events','transportation_requests',
--                      'artist_bookings','bookable_resources','charter_listings',
--                      'boat_listings','photo_sessions')
-- GROUP BY table_name ORDER BY table_name;
--
-- SELECT 'entity_bookings' t, count(*) FROM entity_bookings
-- UNION ALL SELECT 'charter_bookings', count(*) FROM charter_bookings
-- UNION ALL SELECT 'boat_rentals', count(*) FROM boat_rentals
-- UNION ALL SELECT 'photo_bookings', count(*) FROM photo_bookings
-- UNION ALL SELECT 'booking_events', count(*) FROM booking_events
-- UNION ALL SELECT 'transportation_requests', count(*) FROM transportation_requests
-- UNION ALL SELECT 'artist_bookings', count(*) FROM artist_bookings;


-- ── 2. ENTITY_BOOKINGS → BOOKINGS  (shape known, mapping is real) ───────────
-- Source shape confirmed at schema.sql:569.
--   guest_name → customer_name    guest_email → email    guest_phone → phone
--   booking_date → date           booking_time → start_time
--   guest_count → party_size      service_id → details.service_id
--   status maps 1:1 (pending|confirmed|completed|cancelled all exist on bookings)
--
-- Call it:   SELECT backfill_entity_bookings();           -- all entities
--            SELECT backfill_entity_bookings('some-slug'); -- one, to test first
-- Returns the number of rows inserted. Safe to re-run: already-migrated rows
-- are skipped on the legacy_id tag.
CREATE OR REPLACE FUNCTION backfill_entity_bookings(p_entity_slug text DEFAULT NULL)
RETURNS integer AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF to_regclass('public.entity_bookings') IS NULL THEN
    RAISE NOTICE 'entity_bookings does not exist — nothing to do';
    RETURN 0;
  END IF;

  INSERT INTO bookings (
    entity_slug, customer_name, email, phone,
    date, start_time, party_size, total_price,
    status, source, vertical, details, created_at, updated_at
  )
  SELECT
    eb.entity_slug,
    eb.guest_name,
    eb.guest_email,
    eb.guest_phone,
    eb.booking_date,
    eb.booking_time,
    eb.guest_count,
    eb.total_price,
    eb.status,
    'legacy:entity_bookings',
    NULL,
    jsonb_build_object(
      'legacy_id',        eb.id::text,
      'legacy_table',     'entity_bookings',
      'service_id',       eb.service_id,
      'duration_hours',   eb.duration_hours,
      'special_requests', eb.special_requests
    ),
    eb.created_at,
    eb.updated_at
  FROM entity_bookings eb
  WHERE (p_entity_slug IS NULL OR eb.entity_slug = p_entity_slug)
    AND NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.source = 'legacy:entity_bookings'
        AND b.details->>'legacy_id' = eb.id::text
    );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql;


-- Claim each migrated booking's date on the unified calendar, so availability
-- computed from booking_calendar reflects legacy bookings too. Separate call
-- on purpose — backfill first, verify, then claim.
CREATE OR REPLACE FUNCTION backfill_bookings_to_calendar(p_source text)
RETURNS integer AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO booking_calendar (
    entity_slug, booking_id, offering_id, date, end_date,
    start_time, kind, source, status, title, party, external_uid, details
  )
  SELECT
    b.entity_slug, b.id, b.offering_id, b.date, b.end_date,
    b.start_time, 'booking', b.source,
    CASE WHEN b.status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
    COALESCE(b.customer_name, 'Booking'),
    b.party_size,
    b.id::text,
    jsonb_build_object('backfilled', true)
  FROM bookings b
  WHERE b.source = p_source
    AND b.date IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM booking_calendar c
      WHERE c.entity_slug = b.entity_slug
        AND c.source = b.source
        AND c.external_uid = b.id::text
    );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql;


-- Reverse ANY backfill. Deletes only rows carrying the source tag.
-- Example:  SELECT rollback_backfill('legacy:entity_bookings');
CREATE OR REPLACE FUNCTION rollback_backfill(p_source text)
RETURNS TABLE(deleted_calendar integer, deleted_bookings integer) AS $$
DECLARE
  v_cal integer;
  v_book integer;
BEGIN
  IF p_source NOT LIKE 'legacy:%' THEN
    RAISE EXCEPTION 'refusing to roll back source %, expected a legacy:* tag', p_source;
  END IF;

  DELETE FROM booking_calendar WHERE source = p_source;
  GET DIAGNOSTICS v_cal = ROW_COUNT;

  DELETE FROM bookings WHERE source = p_source;
  GET DIAGNOSTICS v_book = ROW_COUNT;

  RETURN QUERY SELECT v_cal, v_book;
END;
$$ LANGUAGE plpgsql;


-- ── 3. TEMPLATES FOR THE SIX UNKNOWN TABLES ─────────────────────────────────
-- Fill these in AFTER the §1 audit confirms the real column names. Each keeps
-- the same three properties: legacy_id tag, source tag, NOT EXISTS guard.
--
-- charter_bookings → bookings + activity_tickets (+ activity_departures)
--   The departure has to exist before the ticket. Expect to derive departures
--   from DISTINCT (charter_listing_id, trip_date, departure_time) first.
--
--   INSERT INTO activity_departures (entity_slug, offering_id, depart_date,
--                                    depart_time, capacity, status)
--   SELECT DISTINCT cb.entity_slug, <offering>, cb.<trip_date>,
--          cb.<departure_time>, <capacity>, 'departed'
--   FROM charter_bookings cb
--   WHERE NOT EXISTS (...);
--
-- boat_rentals → bookings + rental_contracts (+ rental_assets from boat_listings)
--   boat_listings → rental_assets first, then contracts referencing them.
--   scheduled_start/end are timestamptz here but are probably date + duration
--   in the legacy shape — combine before inserting.
--
-- photo_bookings → bookings + appointments (+ staff_members from photo_sessions)
--   photo_availability likely maps to staff_schedules.
--
-- booking_events (rentals.js + services.js) → bookings + the matching vertical
--   bookable_resources splits by resource_type: 'condo' → lodging_units,
--   everything else → resources or rental_assets. Check the distinct values
--   before deciding.
--
-- transportation_requests → bookings + transport_trips
--   transportation_providers → transport_drivers,
--   transportation_dispatches → transport_dispatch_offers.
--
-- artist_bookings → bookings + appointments
--   Verticalless today; artist_profiles.site_id needs mapping to entity_slug.


-- ── 4. VERIFICATION — run after each backfill ───────────────────────────────
-- Counts must match, and no entity may gain or lose bookings unexpectedly.
--
-- SELECT source, count(*), min(date), max(date)
-- FROM bookings WHERE source LIKE 'legacy:%' GROUP BY source;
--
-- -- every migrated booking should have exactly one calendar claim
-- SELECT b.id FROM bookings b
-- LEFT JOIN booking_calendar c
--   ON c.source = b.source AND c.external_uid = b.id::text
-- WHERE b.source LIKE 'legacy:%' AND b.date IS NOT NULL AND c.id IS NULL;
--
-- -- no double-claims on the same resource/date
-- SELECT entity_slug, offering_id, date, count(*)
-- FROM booking_calendar WHERE status = 'active' AND offering_id IS NOT NULL
-- GROUP BY 1,2,3 HAVING count(*) > 1;
