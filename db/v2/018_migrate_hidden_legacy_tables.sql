-- ============================================================================
-- GCR v2 — 018_migrate_hidden_legacy_tables.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- A full exact-count sweep of every table in public (not just the ones this
-- migration already knew about) found several real tables that were never
-- looked at, because early estimates from list_tables (Postgres planner
-- statistics, not real counts) showed them as near-empty. Direct COUNT(*)
-- proved otherwise. This is the same mistake that hid entity_tags (shown as
-- 2,496, really 81,206) — worth re-learning: never trust an estimated count.
--
-- Found and migrated:
--   businesses         625 rows, 619 of them NOT in public.entity at all —
--                       619 real, active, named businesses (Hooters, a
--                       DoubleTree hotel, real charters) with ZERO presence
--                       anywhere in v2 before this file. This was the most
--                       serious gap found in the whole project.
--   entity_secondary_hours  1,041 rows — kitchen/bar/off-season hour sets.
--   marina_details          6 rows — real, detailed marina facts (slips,
--                           fuel, VHF channel, rates) that the marina_details
--                           table had been sitting empty for, waiting on.
--   charter_trips           63 rows — real per-boat charter/tour products
--                           with pricing, fish species, inclusions.
--   entity_sides            3 rows — menu side items.
--   ai_facts                53 rows — AI-generated facts about businesses.
-- ============================================================================

-- ---- 619 businesses that exist ONLY in the legacy `businesses` table ---------
INSERT INTO v2.entities (id, slug, name, entity_type, entity_subtype, status, icon, description,
  rating, price_range, hh_days, hh_description, created_at, updated_at)
SELECT b.id, b.slug, COALESCE(b.name, b.slug), b.category, b.category,
  CASE WHEN b.is_active THEN 'active' ELSE 'hidden' END,
  b.icon, b.description, b.rating, NULLIF(b.price_range,''),
  NULLIF(b.hh_days,''), NULLIF(b.hh_description,''),
  COALESCE(b.created_at, now()), COALESCE(b.updated_at, now())
FROM public.businesses b
WHERE NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_key_map (entity_id, key_type, key_value)
SELECT id, 'slug', slug FROM public.businesses b
WHERE NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_contacts (entity_id, contact_type, value, is_primary)
SELECT id, 'phone', phone, true FROM public.businesses b
WHERE phone IS NOT NULL AND phone <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id);
INSERT INTO v2.entity_contacts (entity_id, contact_type, value, is_primary)
SELECT id, 'email', email, true FROM public.businesses b
WHERE email IS NOT NULL AND email <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id);

INSERT INTO v2.entity_links (entity_id, link_type, url)
SELECT id, 'website', website FROM public.businesses b WHERE website IS NOT NULL AND website <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
UNION ALL SELECT id, 'directions', directions_url FROM public.businesses b WHERE directions_url IS NOT NULL AND directions_url <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
UNION ALL SELECT id, 'booking', booking_url FROM public.businesses b WHERE booking_url IS NOT NULL AND booking_url <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
UNION ALL SELECT id, 'reservation', reservation_url FROM public.businesses b WHERE reservation_url IS NOT NULL AND reservation_url <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id);

INSERT INTO v2.entity_social_profiles (entity_id, platform, url)
SELECT id, 'instagram', social_instagram FROM public.businesses b WHERE social_instagram IS NOT NULL AND social_instagram <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
UNION ALL SELECT id, 'facebook', social_facebook FROM public.businesses b WHERE social_facebook IS NOT NULL AND social_facebook <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_locations (entity_id, location_type, address_line_1, city, is_primary)
SELECT id, 'physical', address_line_1, city, true FROM public.businesses b
WHERE (address_line_1 IS NOT NULL OR city IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id);

INSERT INTO v2.media_assets (url, media_type, legacy_ref)
SELECT hero_image_url, 'image', id::text FROM public.businesses b
WHERE hero_image_url IS NOT NULL AND hero_image_url <> '' AND NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id);
INSERT INTO v2.entity_media (entity_id, media_id, role)
SELECT b.id, m.id, 'hero' FROM public.businesses b
JOIN v2.media_assets m ON m.legacy_ref = b.id::text
WHERE NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id);
UPDATE v2.entities e SET primary_media_id = m.id
FROM v2.entity_media em JOIN v2.media_assets m ON m.id = em.media_id
WHERE em.entity_id = e.id AND em.role = 'hero' AND e.primary_media_id IS NULL;
-- Result: 619/619 entities, 3164 contacts total, 3148 links total, 3967 locations
-- total, 3396 hero photos total, across the combined 4,047-entity database.

-- ---- entity_secondary_hours -> real named hour sets + periods ----------------
INSERT INTO v2.entity_hour_sets (entity_id, set_key, label, is_primary)
SELECT DISTINCT e.id, sh.hours_type, sh.hours_type, false
FROM public.entity_secondary_hours sh JOIN v2.entities e ON e.slug = sh.entity_slug
ON CONFLICT (entity_id, set_key) DO NOTHING;
INSERT INTO v2.entity_hour_periods (hour_set_id, day_of_week, opens_at, closes_at, is_closed)
SELECT hs.id, sh.day_of_week, sh.opens_at, sh.closes_at, COALESCE(sh.is_closed,false)
FROM public.entity_secondary_hours sh
JOIN v2.entities e ON e.slug = sh.entity_slug
JOIN v2.entity_hour_sets hs ON hs.entity_id = e.id AND hs.set_key = sh.hours_type;
-- Result: 1041/1041.

-- ---- marina_details -> real, rich data (table expanded to match source) ------
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS total_slips integer;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS transient_slips integer;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS max_vessel_length_ft integer;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS max_vessel_beam_ft integer;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS max_vessel_draft_ft integer;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_launch_ramp boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_dry_storage boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_wet_storage boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_live_bait boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_frozen_bait boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_tackle boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_ice boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_ship_store boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_restrooms boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_showers boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_electricity boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_water_hookup boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_wifi boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS has_fish_cleaning_station boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS vhf_channel text;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS monitoring_channel text;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS shore_power_amps text;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS tackle_notes text;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS daily_rate_per_ft numeric;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS weekly_rate_per_ft numeric;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS monthly_rate_per_ft numeric;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS transient_rate_per_ft numeric;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS parking_available boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS check_in_time text;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS check_out_time text;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS reservation_required boolean;
ALTER TABLE v2.marina_details ADD COLUMN IF NOT EXISTS notes text;

INSERT INTO v2.marina_details (entity_id, total_slips, transient_slips, max_vessel_length_ft, max_vessel_beam_ft,
  max_vessel_draft_ft, fuel_gas, fuel_diesel, power_available, storage, bait_shop, boat_ramp, pump_out,
  has_launch_ramp, has_dry_storage, has_wet_storage, has_live_bait, has_frozen_bait, has_tackle, has_ice,
  has_ship_store, has_restrooms, has_showers, has_electricity, has_water_hookup, has_wifi,
  has_fish_cleaning_station, vhf_channel, monitoring_channel, shore_power_amps, tackle_notes,
  daily_rate_per_ft, weekly_rate_per_ft, monthly_rate_per_ft, transient_rate_per_ft,
  parking_available, check_in_time, check_out_time, reservation_required, notes)
SELECT e.id, m.total_slips, m.transient_slips, m.max_vessel_length_ft, m.max_vessel_beam_ft, m.max_vessel_draft_ft,
  m.has_gas, m.has_diesel, m.has_electricity, (m.has_dry_storage OR m.has_wet_storage), m.has_live_bait OR m.has_frozen_bait,
  m.has_boat_ramp OR m.has_launch_ramp, m.has_pump_out,
  m.has_launch_ramp, m.has_dry_storage, m.has_wet_storage, m.has_live_bait, m.has_frozen_bait, m.has_tackle, m.has_ice,
  m.has_ship_store, m.has_restrooms, m.has_showers, m.has_electricity, m.has_water_hookup, m.has_wifi,
  m.has_fish_cleaning_station, m.vhf_channel, m.monitoring_channel, m.shore_power_amps, m.tackle_notes,
  m.daily_rate_per_ft, m.weekly_rate_per_ft, m.monthly_rate_per_ft, m.transient_rate_per_ft,
  m.parking_available, m.check_in_time, m.check_out_time, m.reservation_required, m.notes
FROM public.marina_details m JOIN v2.entities e ON e.slug = m.entity_slug
ON CONFLICT (entity_id) DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, ft, 'fuel_type' FROM public.marina_details m JOIN v2.entities e ON e.slug = m.entity_slug, unnest(m.fuel_types) AS ft
WHERE m.fuel_types IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, bi, 'bait_item' FROM public.marina_details m JOIN v2.entities e ON e.slug = m.entity_slug, unnest(m.bait_items) AS bi
WHERE m.bait_items IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, si, 'store_item' FROM public.marina_details m JOIN v2.entities e ON e.slug = m.entity_slug, unnest(m.store_items) AS si
WHERE m.store_items IS NOT NULL ON CONFLICT DO NOTHING;
-- Result: 6/6 marina_details rows, 39 fuel/bait/store tag rows (arrays unnested, not copied as arrays).

-- ---- charter_trips -> offerings + prices + resources + fish_species + more ----
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS duration_hours_min numeric;
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS duration_hours_max numeric;
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS booking_url text;
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS badge text;
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS best_for text;
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_offerings_legacy2 ON v2.offerings(legacy_ref);

INSERT INTO v2.offerings (entity_id, offering_type, name, description, duration_hours_min, duration_hours_max,
  capacity_min, capacity_max, is_active, sort_order, booking_url, badge, best_for, legacy_ref)
SELECT e.id, COALESCE(ct.trip_type,'charter'), ct.trip_name, ct.description, ct.duration_hours_min, ct.duration_hours_max,
  ct.passenger_min, ct.passenger_max, COALESCE(ct.is_active,true), COALESCE(ct.sort_order,0),
  ct.booking_url, ct.badge, ct.best_for, ct.id::text
FROM public.charter_trips ct JOIN v2.entities e ON e.slug = ct.entity_slug;

INSERT INTO v2.offering_prices (offering_id, label, price)
SELECT vo.id, 'Private Charter', ct.price_private FROM public.charter_trips ct JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text WHERE ct.price_private IS NOT NULL
UNION ALL SELECT vo.id, 'Per Person', ct.price_per_person FROM public.charter_trips ct JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text WHERE ct.price_per_person IS NOT NULL
UNION ALL SELECT vo.id, 'Child', ct.price_child FROM public.charter_trips ct JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text WHERE ct.price_child IS NOT NULL;

INSERT INTO v2.resources (entity_id, resource_type, name, description, capacity, is_active)
SELECT DISTINCT ON (e.id, ct.boat_name) e.id, 'boat', ct.boat_name, ct.boat_model, ct.passenger_max, true
FROM public.charter_trips ct JOIN v2.entities e ON e.slug = ct.entity_slug
WHERE ct.boat_name IS NOT NULL AND ct.boat_name <> '';

INSERT INTO v2.offering_resources (offering_id, resource_id)
SELECT vo.id, r.id FROM public.charter_trips ct
JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text
JOIN v2.entities e ON e.slug = ct.entity_slug
JOIN v2.resources r ON r.entity_id = e.id AND r.name = ct.boat_name AND r.resource_type = 'boat'
WHERE ct.boat_name IS NOT NULL AND ct.boat_name <> '' ON CONFLICT DO NOTHING;

INSERT INTO v2.fish_species (entity_id, offering_id, name)
SELECT e.id, vo.id, fs FROM public.charter_trips ct
JOIN v2.entities e ON e.slug = ct.entity_slug
JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text, unnest(ct.fish_species) AS fs
WHERE ct.fish_species IS NOT NULL;

INSERT INTO v2.offering_inclusions (offering_id, label)
SELECT vo.id, wi FROM public.charter_trips ct JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text, unnest(ct.whats_included) AS wi
WHERE ct.whats_included IS NOT NULL;
INSERT INTO v2.offering_requirements (offering_id, req_type, label)
SELECT vo.id, 'bring', wtb FROM public.charter_trips ct JOIN v2.offerings vo ON vo.legacy_ref = ct.id::text, unnest(ct.what_to_bring) AS wtb
WHERE ct.what_to_bring IS NOT NULL;
-- Result: 63/63 charters, 49 distinct boats as real resources.

-- ---- entity_sides -> content_blocks (same pattern as whats_included/pricing) --
INSERT INTO v2.content_blocks (entity_id, block_type, title, is_active)
SELECT DISTINCT e.id, 'sides', 'Sides', true FROM public.entity_sides s JOIN v2.entities e ON e.slug = s.entity_slug;
INSERT INTO v2.content_block_items (content_block_id, entity_id, item_name, description, price)
SELECT cb.id, e.id, COALESCE(s.item_name, s.side_name), s.description, s.price
FROM public.entity_sides s
JOIN v2.entities e ON e.slug = s.entity_slug
JOIN v2.content_blocks cb ON cb.entity_id = e.id AND cb.block_type = 'sides';
-- Result: 3/3.

-- ---- ai_facts -> entity_attributes (real key/value fit) -----------------------
INSERT INTO v2.entity_attributes (entity_id, key, value_text)
SELECT e.id, COALESCE(af.fact_key, af.source_module, af.module, 'ai_fact'), COALESCE(af.fact_value, af.content)
FROM public.ai_facts af JOIN v2.entities e ON e.slug = af.entity_slug
WHERE af.fact_value IS NOT NULL OR af.content IS NOT NULL;
-- Result: 53/53.

-- v2.entities total after this file: 4,047 (3,428 original + 619 recovered).
-- Verified after this file: 0 jsonb/json/ARRAY columns anywhere in schema v2.

-- ---- Deliberately not migrated -------------------------------------------------
-- deep_crawl_jobs (200 rows): operational crawl-queue table, not business content.
-- gcr_page_views/tourist_swipe_events/tourist_seen/tourist_click_events/
-- tourist_otps/qr_codes/qr_scans/users/admin_users/permission_catalog/
-- ai_provider_config/points_config/leads/business_claims/weather_conditions/
-- transportation_providers/tourist_setup_questions/tourist_profiles: analytics,
-- auth, or platform-config tables — out of scope for per-business structured
-- data, live on in the legacy system unchanged.
