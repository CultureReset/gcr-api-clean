-- ============================================================================
-- GCR v2 — 019_fix_duplicate_businesses_and_ai_facts.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- Fixes two real mistakes introduced by 018:
--
-- 1. The "619 recovered businesses" claim was WRONG. Matching only on exact
--    slug/id missed that the legacy `businesses` table used different
--    auto-generated slugs for the SAME real business already in `entity`
--    ("Acme Oyster House" in both, different slug spelling). A name+city
--    check found 597 of the 619 (96%) are duplicates, not new businesses.
--    Those 597 duplicate entities (and their cascaded contacts/links/social/
--    locations/media/key_map rows) are deleted here.
--    The remaining 22 — name matches a different city, or no name match at
--    all — are NOT auto-kept or auto-deleted. Logged to entity_conflicts for
--    a real human decision. v2.entities: 4,047 -> 3,450 (3,428 + 22 pending).
--
-- 2. ai_facts (53 rows, all with a NULL fact_key) had landed in
--    entity_attributes keyed by 'charter'/'core' — a real row, but a
--    near-meaningless key shared by dozens of unrelated facts. This is
--    free-text AI-generated prose, same shape as ai_overview/editorial_summary,
--    so it belongs in content_blocks (block_type='ai_note'), not a fake-keyed
--    attribute. Moved, verified 53/53, the bad attribute rows deleted.
-- ============================================================================

WITH new_biz AS (
  SELECT b.id, b.name, b.city,
    lower(regexp_replace(b.name, '[^a-zA-Z0-9]', '', 'g')) AS norm_name
  FROM public.businesses b
  WHERE NOT EXISTS (SELECT 1 FROM public.entity e WHERE e.slug = b.slug OR e.id = b.id)
),
existing AS (
  SELECT lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')) AS norm_name, city
  FROM public.entity
),
dupes AS (
  SELECT nb.id FROM new_biz nb
  WHERE EXISTS (SELECT 1 FROM existing ex WHERE ex.norm_name = nb.norm_name AND ex.city = nb.city)
)
DELETE FROM v2.entities WHERE id IN (SELECT id FROM dupes);

INSERT INTO v2.entity_conflicts (entity_id, conflict_type, source_table, note)
SELECT b.id, 'unresolved_key', 'businesses',
  'Possible duplicate of an existing entity (name matches, city differs) or genuinely new -- needs human review, not auto-merged or auto-kept.'
FROM public.businesses b
WHERE b.id IN (SELECT id FROM v2.entities)
  AND EXISTS (
    SELECT 1 FROM public.entity e
    WHERE lower(regexp_replace(e.name, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(b.name, '[^a-zA-Z0-9]', '', 'g'))
  );

INSERT INTO v2.content_blocks (entity_id, block_type, title, body, is_active)
SELECT e.id, 'ai_note', initcap(COALESCE(af.source_module, af.module, 'note')),
  COALESCE(af.fact_value, af.content), true
FROM public.ai_facts af
JOIN v2.entities e ON e.slug = af.entity_slug
WHERE af.fact_value IS NOT NULL OR af.content IS NOT NULL;

DELETE FROM v2.entity_attributes WHERE key IN ('charter','core')
  AND entity_id IN (SELECT e.id FROM public.ai_facts af JOIN v2.entities e ON e.slug = af.entity_slug);

-- Result: v2.entities = 3,450. content_blocks 'ai_note' = 53. Bad attrs = 0.
