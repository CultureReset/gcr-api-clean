-- ============================================================================
-- GCR v2 — 014_migrate_core_data.sql  (Phase 6-7 data migration, EXECUTED)
-- ----------------------------------------------------------------------------
-- Copies real data from public.* into v2.* (additive only — public.* untouched).
-- This file documents exactly what was run against the live "cyber check"
-- database (mkepugvdlktfsossumox) on 2026-07-15. Row counts below were
-- verified exact (source count == v2 count) at execution time.
--
--   entities 3428/3428 · photos->media 19866/19866 · hours 13805/13805
--   menu_sections 1585/1585 · menu_items 9227/9227 · drink_items 403/403
--   happy_hour_items 134/134 · reviews 10481/10481 · events 922/922
--   specials 33/33 · sections 287/287 · faqs(merged) 544/544 · policies 35/35
--   team->people 15/15 · tags(deduped) 81206 -> 29428
--
-- Safe to re-run on a fresh v2 schema: uses ON CONFLICT DO NOTHING / count
-- checks are for verification, not idempotency guards on every statement —
-- do not re-run against a v2 schema that already has this data without
-- truncating v2 tables first, or you will get duplicates on tables with no
-- unique constraint (menus, entity_reviews, entity_events, entity_specials,
-- content_blocks, entity_policies, entity_faqs).
-- ============================================================================

-- ---- Core identity ----------------------------------------------------------
INSERT INTO v2.entities (id, slug, name, entity_type, entity_subtype, status, featured, icon, subtitle, description, created_at, updated_at)
SELECT id, slug, COALESCE(name, slug), entity_type, entity_subtype,
       CASE WHEN is_active THEN 'active' ELSE 'hidden' END,
       COALESCE(featured, false), icon, subtitle, description,
       COALESCE(created_at, now()), COALESCE(updated_at, now())
FROM public.entity
ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_key_map (entity_id, key_type, key_value)
SELECT id, 'slug', slug FROM public.entity ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_key_map (entity_id, key_type, key_value)
SELECT id, 'entity_uuid_v1', id::text FROM public.entity ON CONFLICT DO NOTHING;
INSERT INTO v2.entity_key_map (entity_id, key_type, key_value)
SELECT id, 'google_place_id', google_place_id FROM public.entity
WHERE google_place_id IS NOT NULL AND google_place_id <> '' ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_locations (entity_id, location_type, address_line_1, address_line_2, city, state, zip, latitude, longitude, is_primary)
SELECT id, 'physical', address_line_1, address_line_2, city, state, zip, latitude, longitude, true
FROM public.entity WHERE address_line_1 IS NOT NULL OR city IS NOT NULL;

INSERT INTO v2.entity_contacts (entity_id, contact_type, value, is_primary)
SELECT id, 'phone', phone, true FROM public.entity WHERE phone IS NOT NULL AND phone <> '';
INSERT INTO v2.entity_contacts (entity_id, contact_type, value, is_primary)
SELECT id, 'email', email, true FROM public.entity WHERE email IS NOT NULL AND email <> '';

INSERT INTO v2.entity_links (entity_id, link_type, url)
SELECT id, 'website', website_url FROM public.entity WHERE website_url IS NOT NULL AND website_url <> ''
UNION ALL SELECT id, 'menu', menu_url FROM public.entity WHERE menu_url IS NOT NULL AND menu_url <> ''
UNION ALL SELECT id, 'reservation', reservation_url FROM public.entity WHERE reservation_url IS NOT NULL AND reservation_url <> ''
UNION ALL SELECT id, 'order', order_url FROM public.entity WHERE order_url IS NOT NULL AND order_url <> ''
UNION ALL SELECT id, 'booking', booking_url FROM public.entity WHERE booking_url IS NOT NULL AND booking_url <> ''
UNION ALL SELECT id, 'directions', directions_url FROM public.entity WHERE directions_url IS NOT NULL AND directions_url <> '';

INSERT INTO v2.entity_social_profiles (entity_id, platform, url)
SELECT id, 'instagram', social_instagram FROM public.entity WHERE social_instagram IS NOT NULL AND social_instagram <> ''
UNION ALL SELECT id, 'facebook', social_facebook FROM public.entity WHERE social_facebook IS NOT NULL AND social_facebook <> ''
UNION ALL SELECT id, 'tiktok', social_tiktok FROM public.entity WHERE social_tiktok IS NOT NULL AND social_tiktok <> ''
ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, t.tag_name, t.tag_category
FROM public.entity_tags t JOIN v2.entities e ON e.slug = t.entity_slug
WHERE t.tag_name IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO v2.entity_tags (entity_id, tag_name, tag_category)
SELECT e.id, a.amenity, COALESCE(a.category,'amenity')
FROM public.entity_amenities a JOIN v2.entities e ON e.slug = a.entity_slug
WHERE a.amenity IS NOT NULL ON CONFLICT DO NOTHING;

-- ---- Hours -------------------------------------------------------------------
INSERT INTO v2.entity_hour_sets (entity_id, set_key, label, is_primary)
SELECT DISTINCT e.id, 'business', 'Business Hours', true
FROM public.entity_hours h JOIN v2.entities e ON e.slug = h.entity_slug
ON CONFLICT (entity_id, set_key) DO NOTHING;

INSERT INTO v2.entity_hour_periods (hour_set_id, day_of_week, opens_at, closes_at, is_closed)
SELECT hs.id, h.day_of_week, h.opens_at, h.closes_at, COALESCE(h.is_closed, false)
FROM public.entity_hours h
JOIN v2.entities e ON e.slug = h.entity_slug
JOIN v2.entity_hour_sets hs ON hs.entity_id = e.id AND hs.set_key = 'business';

-- ---- Photos / media -----------------------------------------------------------
ALTER TABLE v2.media_assets ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_media_legacy_ref ON v2.media_assets(legacy_ref);

INSERT INTO v2.media_assets (url, storage_path, media_type, source_name, source_url, ai_tags, ai_description, legacy_ref)
SELECT url, image_path, 'image', source_name, source_page_url, COALESCE(ai_tags,'[]'::jsonb), ai_description, id::text
FROM public.entity_photos WHERE url IS NOT NULL;

INSERT INTO v2.entity_media (entity_id, media_id, role, caption, sort_order)
SELECT e.id, m.id, CASE WHEN p.is_cover THEN 'hero' ELSE 'gallery' END, p.caption, COALESCE(p.sort_order,0)
FROM public.entity_photos p
JOIN v2.entities e ON e.slug = p.entity_slug
JOIN v2.media_assets m ON m.legacy_ref = p.id::text
WHERE p.url IS NOT NULL ON CONFLICT DO NOTHING;

WITH cover AS (
  SELECT DISTINCT ON (entity_slug) entity_slug, id AS photo_id
  FROM public.entity_photos WHERE is_cover = true ORDER BY entity_slug, sort_order
)
UPDATE v2.entities e SET primary_media_id = m.id
FROM cover c JOIN v2.media_assets m ON m.legacy_ref = c.photo_id::text
WHERE e.slug = c.entity_slug;

-- ---- Food / drink / happy-hour menus ------------------------------------------
ALTER TABLE v2.menu_sections ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_menu_sections_legacy ON v2.menu_sections(legacy_ref);

INSERT INTO v2.menus (entity_id, menu_type, name, is_active)
SELECT DISTINCT e.id, 'food', 'Food Menu', true FROM public.menu_sections ms JOIN v2.entities e ON e.slug = ms.entity_slug;
INSERT INTO v2.menu_sections (menu_id, section_name, sort_order, is_active, legacy_ref)
SELECT m.id, ms.section_name, COALESCE(ms.sort_order,0), COALESCE(ms.is_active, true), ms.id::text
FROM public.menu_sections ms
JOIN v2.entities e ON e.slug = ms.entity_slug
JOIN v2.menus m ON m.entity_id = e.id AND m.menu_type = 'food';
INSERT INTO v2.menu_items (section_id, entity_id, item_name, description, price, is_available, is_featured, is_catch_of_day, is_on_tap, has_market_price, sort_order)
SELECT vs.id, e.id, mi.item_name, mi.description, mi.price, COALESCE(mi.is_available,true), COALESCE(mi.is_featured,false), COALESCE(mi.is_catch_of_day,false), COALESCE(mi.is_on_tap,false), COALESCE(mi.has_market_price,false), COALESCE(mi.sort_order,0)
FROM public.menu_items mi
JOIN v2.entities e ON e.slug = mi.entity_slug
JOIN v2.menu_sections vs ON vs.legacy_ref = mi.section_id::text;

INSERT INTO v2.menus (entity_id, menu_type, name, is_active)
SELECT DISTINCT e.id, 'drink', 'Drink Menu', true FROM public.drink_sections ds JOIN v2.entities e ON e.slug = ds.entity_slug;
INSERT INTO v2.menu_sections (menu_id, section_name, sort_order, is_active, legacy_ref)
SELECT m.id, COALESCE(ds.section_name,'Drinks'), COALESCE(ds.sort_order,0), true, ds.id::text
FROM public.drink_sections ds
JOIN v2.entities e ON e.slug = ds.entity_slug
JOIN v2.menus m ON m.entity_id = e.id AND m.menu_type = 'drink';
INSERT INTO v2.menu_items (section_id, entity_id, item_name, description, price, is_available, is_on_tap, sort_order)
SELECT vs.id, e.id, di.item_name, di.description, di.price, COALESCE(di.is_available,true), COALESCE(di.is_on_tap,false), COALESCE(di.sort_order,0)
FROM public.drink_items di
JOIN v2.entities e ON e.slug = di.entity_slug
JOIN v2.menu_sections vs ON vs.legacy_ref = di.section_id::text;

INSERT INTO v2.menus (entity_id, menu_type, name, is_active)
SELECT DISTINCT e.id, 'happy_hour', 'Happy Hour', true FROM public.happy_hour_sections hs JOIN v2.entities e ON e.slug = hs.entity_slug;
INSERT INTO v2.menu_sections (menu_id, section_name, sort_order, is_active, legacy_ref)
SELECT m.id, COALESCE(hs.section_name,'Happy Hour'), COALESCE(hs.sort_order,0), true, hs.id::text
FROM public.happy_hour_sections hs
JOIN v2.entities e ON e.slug = hs.entity_slug
JOIN v2.menus m ON m.entity_id = e.id AND m.menu_type = 'happy_hour';
INSERT INTO v2.menu_items (section_id, entity_id, item_name, description, price, is_available, sort_order)
SELECT vs.id, e.id, hi.item_name, hi.description, hi.price, COALESCE(hi.is_available,true), COALESCE(hi.sort_order,0)
FROM public.happy_hour_items hi
JOIN v2.entities e ON e.slug = hi.entity_slug
JOIN v2.menu_sections vs ON vs.legacy_ref = hi.section_id::text;

-- ---- Reviews / events / specials ----------------------------------------------
INSERT INTO v2.entity_reviews (entity_id, reviewer_name, reviewer_email, rating, title, body, verified, approved, helpful_count, created_at)
SELECT e.id, r.reviewer_name, r.reviewer_email, r.rating, r.title, r.body,
       COALESCE(r.verified_purchase,false), COALESCE(r.approved,false), COALESCE(r.helpful_count,0), COALESCE(r.created_at, now())
FROM public.entity_reviews r JOIN v2.entities e ON e.slug = r.entity_slug;

INSERT INTO v2.entity_events (entity_id, event_name, description, event_date, start_time, end_time, day_of_week, recurring, artist_name, cover_charge, is_active)
SELECT e.id, ev.event_name, ev.description, ev.event_date, ev.start_time, ev.end_time, ev.day_of_week,
       COALESCE(ev.recurring,false), ev.artist_name, ev.cover_charge, COALESCE(ev.is_active,true)
FROM public.entity_events ev JOIN v2.entities e ON e.slug = ev.entity_slug;

INSERT INTO v2.entity_specials (entity_id, special_name, description, discount_type, discount_value, discount_text, days, start_time, end_time, start_date, end_date, is_active)
SELECT e.id, sp.special_name, sp.description, sp.discount_type, sp.discount_value, sp.discount_text, sp.days,
       sp.start_time, sp.end_time, sp.start_date, sp.end_date, COALESCE(sp.is_active,true)
FROM public.entity_specials sp JOIN v2.entities e ON e.slug = sp.entity_slug;

-- ---- Sections / content_blocks -------------------------------------------------
ALTER TABLE v2.content_blocks ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_content_blocks_legacy ON v2.content_blocks(legacy_ref);

INSERT INTO v2.content_blocks (entity_id, block_type, title, subtitle, items, sort_order, is_active, legacy_ref)
SELECT e.id, COALESCE(s.section_type,'section'), s.section_name, s.subtitle, '[]'::jsonb, COALESCE(s.sort_order,0), COALESCE(s.is_active,true), s.id::text
FROM public.entity_sections s JOIN v2.entities e ON e.slug = s.entity_slug;

UPDATE v2.content_blocks cb SET items = agg.items
FROM (
  SELECT si.section_id::text AS legacy_ref, jsonb_agg(jsonb_build_object(
     'item_name', si.item_name, 'description', si.description,
     'price_from', si.price_from, 'price_to', si.price_to, 'price_label', si.price_label,
     'duration', si.duration, 'icon', si.icon, 'image_url', si.image_url, 'sort_order', si.sort_order
  ) ORDER BY si.sort_order) AS items
  FROM public.entity_section_items si GROUP BY si.section_id
) agg
WHERE cb.legacy_ref = agg.legacy_ref;

-- ---- FAQs (merge faqs + entity_faqs) / Policies / Team --------------------------
INSERT INTO v2.entity_faqs (entity_id, question, answer, category, sort_order)
SELECT e.id, f.question, f.answer, f.category, COALESCE(f.sort_order,0)
FROM public.entity_faqs f JOIN v2.entities e ON e.slug = f.entity_slug WHERE f.question IS NOT NULL
UNION ALL
SELECT e.id, f.question, f.answer, f.category, COALESCE(f.sort_order,0)
FROM public.faqs f JOIN v2.entities e ON e.slug = f.entity_slug WHERE f.question IS NOT NULL;

INSERT INTO v2.entity_policies (entity_id, policy_type, title, body)
SELECT e.id, COALESCE(p.policy_type, p.type, 'general'), p.title, COALESCE(p.body, p.content)
FROM public.entity_policies p JOIN v2.entities e ON e.slug = p.entity_slug;

ALTER TABLE v2.people ADD COLUMN IF NOT EXISTS legacy_ref text;
INSERT INTO v2.people (full_name, bio, legacy_ref)
SELECT name, bio, id::text FROM public.entity_team_members WHERE name IS NOT NULL;
INSERT INTO v2.entity_people (entity_id, person_id, title, bio, sort_order)
SELECT e.id, p.id, tm.title, tm.bio, COALESCE(tm.sort_order,0)
FROM public.entity_team_members tm
JOIN v2.entities e ON e.slug = tm.entity_slug
JOIN v2.people p ON p.legacy_ref = tm.id::text;
