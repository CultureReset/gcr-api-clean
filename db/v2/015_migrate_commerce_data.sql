-- ============================================================================
-- GCR v2 — 015_migrate_commerce_data.sql  (second migration wave, EXECUTED)
-- ----------------------------------------------------------------------------
-- The first wave (014) covered restaurant-style content. This wave covers the
-- charter/rental/service/booking side that was missed: modules, offerings,
-- prices, bookable resources, requirements, what's-included, what-to-bring,
-- fish species, and artists. All row counts verified exact against the live
-- "cyber check" database (mkepugvdlktfsossumox) on 2026-07-15 — see
-- db/v2/README.md "Second wave" section for the full reconciliation, including
-- the 237 pre-existing orphaned entity_modules rows and the unmerged
-- artists/artist_profiles tables, both logged to v2.entity_conflicts rather
-- than silently dropped or fabricated.
-- ============================================================================

-- ---- Module catalog + per-entity enabled modules ------------------------------
INSERT INTO v2.module_catalog (module_key, name, description, created_at)
SELECT module_key, name, tagline, COALESCE(created_at, now())
FROM public.module_catalog
ON CONFLICT (module_key) DO NOTHING;

INSERT INTO v2.module_catalog (module_key, name)
SELECT DISTINCT em.module_key, em.module_key
FROM public.entity_modules em
LEFT JOIN v2.module_catalog mc ON mc.module_key = em.module_key
WHERE mc.module_key IS NULL AND em.module_key IS NOT NULL
ON CONFLICT (module_key) DO NOTHING;

INSERT INTO v2.entity_modules (entity_id, module_key, enabled, settings, sort_order)
SELECT e.id, em.module_key, COALESCE(em.enabled,true), COALESCE(em.settings,'{}'::jsonb), COALESCE(em.sort_order,0)
FROM public.entity_modules em
JOIN v2.entities e ON e.slug = em.entity_slug
WHERE em.module_key IS NOT NULL
ON CONFLICT (entity_id, module_key) DO NOTHING;

-- Surface (don't drop) entity_modules rows referencing a nonexistent entity_slug
INSERT INTO v2.entity_conflicts (entity_id, conflict_type, detail)
SELECT NULL, 'orphan_row', jsonb_build_object('source_table','entity_modules','entity_slug',em.entity_slug,'module_key',em.module_key)
FROM public.entity_modules em
LEFT JOIN v2.entities e ON e.slug = em.entity_slug
WHERE e.id IS NULL;

-- ---- Offerings (charters, tours, rentals, services, packages) -----------------
ALTER TABLE v2.offerings ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_offerings_legacy ON v2.offerings(legacy_ref);

INSERT INTO v2.offerings (entity_id, offering_type, name, description, duration_minutes, capacity_max, is_active, sort_order, legacy_ref)
SELECT e.id, COALESCE(o.kind,'service'), o.name, o.description, o.duration_minutes, o.capacity, COALESCE(o.active,true), COALESCE(o.sort_order,0), o.id::text
FROM public.offerings o
JOIN v2.entities e ON e.slug = o.entity_slug;

INSERT INTO v2.offering_prices (offering_id, label, price, season, sort_order)
SELECT vo.id, op.label, op.price, op.season, COALESCE(op.sort_order,0)
FROM public.offering_prices op
JOIN v2.offerings vo ON vo.legacy_ref = op.offering_id::text;

-- offerings with a price_from but no offering_prices row get one synthesized
INSERT INTO v2.offering_prices (offering_id, label, price)
SELECT vo.id, 'Standard', o.price_from
FROM public.offerings o
JOIN v2.offerings vo ON vo.legacy_ref = o.id::text
WHERE o.price_from IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM v2.offering_prices WHERE offering_id = vo.id);

-- ---- Bookable resources (condo units, boats, vehicles) ------------------------
ALTER TABLE v2.resources ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_resources_legacy ON v2.resources(legacy_ref);

INSERT INTO v2.resources (entity_id, resource_type, name, description, capacity, bedrooms, bathrooms, is_active, legacy_ref)
SELECT e.id, COALESCE(br.resource_type,'unit'), br.name, br.description, br.capacity, br.bedrooms, br.bathrooms, COALESCE(br.is_active,true), br.id::text
FROM public.bookable_resources br
JOIN v2.entities e ON e.slug = br.entity_slug;

INSERT INTO v2.resource_rates (resource_id, rate_type, price, min_nights)
SELECT vr.id, 'nightly', br.nightly_price, br.min_nights
FROM public.bookable_resources br
JOIN v2.resources vr ON vr.legacy_ref = br.id::text
WHERE br.nightly_price IS NOT NULL;

INSERT INTO v2.resource_fees (resource_id, fee_type, label, amount, is_mandatory)
SELECT vr.id, 'cleaning', 'Cleaning Fee', br.cleaning_fee, true
FROM public.bookable_resources br JOIN v2.resources vr ON vr.legacy_ref = br.id::text
WHERE br.cleaning_fee IS NOT NULL
UNION ALL
SELECT vr.id, 'service', 'Service Fee', br.service_fee, true
FROM public.bookable_resources br JOIN v2.resources vr ON vr.legacy_ref = br.id::text
WHERE br.service_fee IS NOT NULL;

-- ---- Entity-scoped commerce content (requirements/included/bring/pricing) -----
INSERT INTO v2.content_blocks (entity_id, block_type, title, items, is_active)
SELECT e.id, 'requirements', 'Requirements',
       jsonb_agg(jsonb_build_object('requirement', COALESCE(r.requirement_name, r.requirement_text), 'applies_to', r.applies_to, 'sort_order', r.sort_order) ORDER BY r.sort_order),
       true
FROM public.requirements r
JOIN v2.entities e ON e.slug = r.entity_slug
GROUP BY e.id;

INSERT INTO v2.content_blocks (entity_id, block_type, title, items, is_active)
SELECT e.id, 'whats_included', 'What''s Included',
       jsonb_agg(jsonb_build_object('item', COALESCE(wi.item_name, wi.included_item), 'icon', wi.icon, 'sort_order', wi.sort_order) ORDER BY wi.sort_order),
       true
FROM public.whats_included wi
JOIN v2.entities e ON e.slug = wi.entity_slug
GROUP BY e.id;

INSERT INTO v2.content_blocks (entity_id, block_type, title, items, is_active)
SELECT e.id, 'what_to_bring', 'What To Bring',
       jsonb_agg(jsonb_build_object('item', wtb.item, 'sort_order', wtb.sort_order) ORDER BY wtb.sort_order),
       true
FROM public.what_to_bring wtb
JOIN v2.entities e ON e.slug = wtb.entity_slug
GROUP BY e.id;

INSERT INTO v2.content_blocks (entity_id, block_type, title, items, is_active)
SELECT e.id, 'pricing', 'Pricing',
       jsonb_agg(jsonb_build_object('item_name', pi.item_name, 'description', pi.description, 'price', pi.price,
                 'price_from', pi.price_from, 'price_to', pi.price_to, 'price_label', pi.price_label,
                 'duration', pi.duration, 'minimum_age', pi.minimum_age, 'sort_order', pi.sort_order) ORDER BY pi.sort_order),
       true
FROM public.pricing_items pi
JOIN v2.entities e ON e.slug = pi.entity_slug
GROUP BY e.id;

INSERT INTO v2.fish_species (entity_id, name, season, method, regulation)
SELECT e.id, fs.species, fs.season, array_to_string(fs.fishing_method, ', '), fs.regulation_notes
FROM public.fish_species fs
JOIN v2.entities e ON e.slug = fs.entity_slug;

-- ---- Artists (disconnected mini-app; entity_id stays NULL — see README) -------
ALTER TABLE v2.artist_profiles ADD COLUMN IF NOT EXISTS legacy_ref text;
CREATE INDEX IF NOT EXISTS idx_v2_artist_profiles_legacy ON v2.artist_profiles(legacy_ref);

INSERT INTO v2.artist_profiles (entity_id, stage_name, genre, bio, is_active, legacy_ref)
SELECT e.id, ap.artist_name, ap.genre, ap.bio, COALESCE(ap.is_active,true), ap.id::text
FROM public.artist_profiles ap
LEFT JOIN v2.entities e ON e.slug = ap.entity_slug;

INSERT INTO v2.music_links (artist_id, platform, url)
SELECT va.id, 'spotify', ap.spotify_url FROM public.artist_profiles ap JOIN v2.artist_profiles va ON va.legacy_ref = ap.id::text WHERE ap.spotify_url IS NOT NULL AND ap.spotify_url <> ''
UNION ALL
SELECT va.id, 'youtube', ap.youtube_url FROM public.artist_profiles ap JOIN v2.artist_profiles va ON va.legacy_ref = ap.id::text WHERE ap.youtube_url IS NOT NULL AND ap.youtube_url <> '';

INSERT INTO v2.tip_links (artist_id, platform, handle)
SELECT va.id, 'venmo', COALESCE(ap.venmo_handle, ap.venmo) FROM public.artist_profiles ap JOIN v2.artist_profiles va ON va.legacy_ref = ap.id::text WHERE COALESCE(ap.venmo_handle, ap.venmo) IS NOT NULL AND COALESCE(ap.venmo_handle, ap.venmo) <> ''
UNION ALL
SELECT va.id, 'cashapp', COALESCE(ap.cashapp_handle, ap.cashtag) FROM public.artist_profiles ap JOIN v2.artist_profiles va ON va.legacy_ref = ap.id::text WHERE COALESCE(ap.cashapp_handle, ap.cashtag) IS NOT NULL AND COALESCE(ap.cashapp_handle, ap.cashtag) <> '';

INSERT INTO v2.entity_conflicts (conflict_type, detail)
SELECT 'duplicate_slug', jsonb_build_object('note','public.artists (390 rows) not yet merged with public.artist_profiles (390 rows) — same count, needs a real dedup decision, not auto-merged','table','artists');
