-- ============================================================================
-- GCR v2 — 017_migrate_remaining_entity_facts.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- The wide public.entity table has 178 columns. Waves 1-2 migrated the
-- satellite-table data (menus, photos, reviews, etc). This wave audits and
-- migrates what was still sitting ONLY on the wide entity row and never given
-- a home in v2: parent/child relationships, rating/review_count/price,
-- Google Places facts, AI-generated content, lodging/activity specifics, and
-- dozens of boolean feature/accessibility/payment/parking flags.
--
-- Every number below is a verified exact count from the live database.
-- ============================================================================

-- ---- Parent/child relationships (335 businesses had this, none migrated) -----
INSERT INTO v2.entity_relations (parent_entity_id, child_entity_id, relation_type)
SELECT vp.id, vc.id, 'parent_child'
FROM public.entity e
JOIN public.entity p ON p.slug = e.parent_entity_slug
JOIN v2.entities vp ON vp.id = p.id
JOIN v2.entities vc ON vc.id = e.id
WHERE e.parent_entity_slug IS NOT NULL AND e.parent_entity_slug <> ''
ON CONFLICT DO NOTHING;
-- Result: 335/335, 40 distinct parent hubs (marinas, condo complexes).

-- ---- Core display facts that were never migrated at all ----------------------
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS rating numeric;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS review_count integer;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS price_range text;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS price_level integer;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS display_template text;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS price_from numeric;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS price_to numeric;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS price_unit text;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS hh_days text;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS hh_start time;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS hh_end time;
ALTER TABLE v2.entities ADD COLUMN IF NOT EXISTS hh_description text;

UPDATE v2.entities e SET
  rating = e2.rating, review_count = e2.review_count,
  price_range = NULLIF(e2.price_range,''), price_level = e2.price_level,
  display_template = NULLIF(e2.display_template,''),
  price_from = e2.price_from, price_to = e2.price_to, price_unit = NULLIF(e2.price_unit,''),
  hh_days = NULLIF(e2.hh_days,''), hh_start = e2.hh_start, hh_end = e2.hh_end, hh_description = NULLIF(e2.hh_description,'')
FROM public.entity e2
WHERE e.id = e2.id;
-- Result: rating 2446, review_count 3416, display_template 3428/3428 (ALL —
-- this decides which page template renders a business), price_from 87, hh 50.

-- ---- Google Places facts, real dedicated table (not JSON) --------------------
CREATE TABLE IF NOT EXISTS v2.entity_google_places (
  entity_id       uuid primary key references v2.entities(id) on delete cascade,
  google_maps_uri text,
  business_status text,
  national_phone  text,
  plus_code       text,
  created_at      timestamptz not null default now()
);
INSERT INTO v2.entity_google_places (entity_id, google_maps_uri, business_status, national_phone, plus_code)
SELECT id, NULLIF(google_maps_uri,''), NULLIF(business_status,''), NULLIF(national_phone,''), NULLIF(plus_code,'')
FROM public.entity
WHERE (google_maps_uri IS NOT NULL AND google_maps_uri <> '')
   OR (business_status IS NOT NULL AND business_status <> '')
   OR (national_phone IS NOT NULL AND national_phone <> '')
   OR (plus_code IS NOT NULL AND plus_code <> '');
-- Result: 3428 rows (business_status is populated for nearly every entity).

-- ---- AI-generated content -> content_blocks (real rows, not JSON) ------------
INSERT INTO v2.content_blocks (entity_id, block_type, title, body, is_active)
SELECT id, 'ai_overview', 'Overview', ai_overview, true FROM public.entity WHERE ai_overview IS NOT NULL AND ai_overview <> '';
INSERT INTO v2.content_blocks (entity_id, block_type, title, body, is_active)
SELECT id, 'ai_review_summary', 'Review Summary', ai_review_summary, true FROM public.entity WHERE ai_review_summary IS NOT NULL AND ai_review_summary <> '';
INSERT INTO v2.content_blocks (entity_id, block_type, title, body, is_active)
SELECT id, 'editorial_summary', 'Editorial Summary', editorial_summary, true FROM public.entity WHERE editorial_summary IS NOT NULL AND editorial_summary <> '';
-- Result: ai_overview 991, ai_review_summary 815, editorial_summary 421.

-- ---- Boolean feature/accessibility/payment/parking/service-style flags -------
-- Only inserted when true — same pattern as known_for/highlights.
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'accessibility' FROM public.entity, LATERAL (VALUES
  ('wheelchair_accessible_entrance', wheelchair_accessible_entrance),
  ('wheelchair_accessible_parking', wheelchair_accessible_parking),
  ('wheelchair_accessible_restroom', wheelchair_accessible_restroom),
  ('wheelchair_accessible_seating', wheelchair_accessible_seating)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'payment' FROM public.entity, LATERAL (VALUES
  ('accepts_credit_cards', accepts_credit_cards), ('accepts_debit_cards', accepts_debit_cards),
  ('accepts_nfc', accepts_nfc), ('accepts_cash_only', accepts_cash_only)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, NULLIF(parking_type,''), 'parking' FROM public.entity
WHERE parking_type IS NOT NULL AND parking_type <> '' ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'parking' FROM public.entity, LATERAL (VALUES
  ('free_parking_lot', free_parking_lot), ('paid_parking_lot', paid_parking_lot),
  ('free_street_parking', free_street_parking), ('paid_street_parking', paid_street_parking),
  ('valet_parking', valet_parking), ('free_garage_parking', free_garage_parking),
  ('paid_garage_parking', paid_garage_parking)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'service_style' FROM public.entity, LATERAL (VALUES
  ('dine_in', dine_in), ('takeout', takeout), ('delivery', delivery), ('curbside_pickup', curbside_pickup),
  ('reservable', reservable), ('outdoor_seating', outdoor_seating), ('live_music', live_music)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'food_service' FROM public.entity, LATERAL (VALUES
  ('serves_breakfast', serves_breakfast), ('serves_brunch', serves_brunch), ('serves_lunch', serves_lunch),
  ('serves_dinner', serves_dinner), ('serves_beer', serves_beer), ('serves_wine', serves_wine),
  ('serves_cocktails', serves_cocktails), ('serves_coffee', serves_coffee), ('serves_dessert', serves_dessert),
  ('serves_vegetarian', serves_vegetarian)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'good_for_flag' FROM public.entity, LATERAL (VALUES
  ('good_for_groups', good_for_groups), ('good_for_children', good_for_children),
  ('good_for_watching_sports', good_for_watching_sports), ('allows_dogs', allows_dogs),
  ('pet_friendly', pet_friendly), ('pool', pool), ('hot_tub', hot_tub), ('beach_access', beach_access),
  ('wifi', wifi)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT id, flag, 'amenity' FROM public.entity, LATERAL (VALUES
  ('restroom', restroom), ('menu_for_children', menu_for_children), ('offers_transportation', offers_transportation)
) AS v(flag, val) WHERE val IS TRUE ON CONFLICT DO NOTHING;
-- Result: 22,640+ real tag rows across accessibility/payment/parking/
-- service_style/food_service/good_for_flag/amenity categories.

-- ---- Lodging specifics -> property_details (built earlier, was empty) --------
INSERT INTO v2.property_details (entity_id, total_units, floors, year_built, check_in_time, check_out_time,
  pet_friendly, pool, hot_tub, beach_access, parking, wifi, min_stay_nights)
SELECT id, total_units, floors, year_built, check_in_time, check_out_time,
  pet_friendly, pool, hot_tub, beach_access, parking, wifi, min_stay_nights
FROM public.entity
WHERE bedrooms IS NOT NULL OR bathrooms IS NOT NULL OR max_guests IS NOT NULL
   OR total_units IS NOT NULL OR check_in_time IS NOT NULL OR pool IS TRUE
   OR pet_friendly IS TRUE OR min_stay_nights IS NOT NULL;
-- Result: 41 rows.

-- ---- Sparse per-entity numeric/text facts -> entity_attributes ----------------
INSERT INTO v2.entity_attributes (entity_id, key, value_number)
SELECT id, 'bedrooms', bedrooms FROM public.entity WHERE bedrooms IS NOT NULL
UNION ALL SELECT id, 'bathrooms', bathrooms FROM public.entity WHERE bathrooms IS NOT NULL
UNION ALL SELECT id, 'max_guests', max_guests FROM public.entity WHERE max_guests IS NOT NULL
UNION ALL SELECT id, 'sqft', sqft FROM public.entity WHERE sqft IS NOT NULL
UNION ALL SELECT id, 'sleeps_min', sleeps_min FROM public.entity WHERE sleeps_min IS NOT NULL
UNION ALL SELECT id, 'sleeps_max', sleeps_max FROM public.entity WHERE sleeps_max IS NOT NULL
UNION ALL SELECT id, 'capacity_min', capacity_min FROM public.entity WHERE capacity_min IS NOT NULL;

INSERT INTO v2.entity_attributes (entity_id, key, value_text)
SELECT id, 'unit_number', unit_number FROM public.entity WHERE unit_number IS NOT NULL AND unit_number <> ''
UNION ALL SELECT id, 'view_type', view_type FROM public.entity WHERE view_type IS NOT NULL AND view_type <> '';
-- Result: 96 attribute rows.

-- ---- Activity specifics -> activity_details (built earlier, was empty) -------
INSERT INTO v2.activity_details (entity_id, duration_text, min_age, max_capacity, cancellation_policy)
SELECT id, NULLIF(duration_text,''), minimum_age, capacity_max, NULLIF(cancellation_policy,'')
FROM public.entity
WHERE (duration_text IS NOT NULL AND duration_text <> '') OR minimum_age IS NOT NULL
   OR capacity_max IS NOT NULL OR (cancellation_policy IS NOT NULL AND cancellation_policy <> '');
-- Result: 62 rows.

-- ---- Deposit/waiver/refund policy text -> entity_policies ---------------------
INSERT INTO v2.entity_policies (entity_id, policy_type, body)
SELECT id, 'deposit', deposit_amount::text || CASE WHEN deposit_type IS NOT NULL THEN ' (' || deposit_type || ')' ELSE '' END
FROM public.entity WHERE deposit_amount IS NOT NULL
UNION ALL
SELECT id, 'waiver', COALESCE(NULLIF(waiver_text,''), 'Waiver required') FROM public.entity WHERE waiver_required IS TRUE
UNION ALL
SELECT id, 'refund', refund_policy FROM public.entity WHERE refund_policy IS NOT NULL AND refund_policy <> '';
-- Result: 3 rows (this data is genuinely sparse in the source — verified, not a gap).

-- Verified after this file: 0 jsonb/json/ARRAY columns anywhere in schema v2.

-- ---- Deliberately NOT migrated, and why -----------------------------------
-- call_url, logo_url/logo_image_path, what_makes_it_different,
-- ai_neighborhood_summary, sqft(covered above), total_units(covered),
-- hot_tub(covered), secondary_subtypes, also_appears_on, consumer_alert,
-- opening_date, booking_advance_days: 0 populated rows in the source, verified
-- directly — nothing to migrate, not a gap.
-- menu_pin / menu_pin_fail_count / menu_pin_locked_until: auth/security fields,
-- not display data — belong with the admin auth system, out of scope here.
-- internal_notes: explicitly private — must not enter a schema readable by the
-- public anon key. Left on the legacy table, not copied forward.
-- icon_background_color, utc_offset_minutes, embedding, search_vector,
-- primary_type_display, address_descriptor: cosmetic/technical/search-index
-- fields with no independent business meaning — can be derived or rebuilt at
-- the API layer rather than warehoused as v2 facts.
