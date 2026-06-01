-- ============================================================
-- Migration: Add activity/experience fields to entity table
-- Run in Supabase SQL Editor
-- ============================================================

ALTER TABLE entity ADD COLUMN IF NOT EXISTS duration_text        text;
ALTER TABLE entity ADD COLUMN IF NOT EXISTS price_from           numeric;
ALTER TABLE entity ADD COLUMN IF NOT EXISTS price_unit           text;          -- 'person', 'group', 'hour'
ALTER TABLE entity ADD COLUMN IF NOT EXISTS known_for            text[];        -- ['Glass-bottom viewing', 'Dolphin watching']
ALTER TABLE entity ADD COLUMN IF NOT EXISTS highlights           text[];        -- what you'll see / experience features
ALTER TABLE entity ADD COLUMN IF NOT EXISTS good_for             text[];        -- ['Families', 'Kids', 'Wildlife enthusiasts']
ALTER TABLE entity ADD COLUMN IF NOT EXISTS what_makes_it_different text;       -- USP paragraph
ALTER TABLE entity ADD COLUMN IF NOT EXISTS secondary_subtypes   text[];        -- ['sunset_cruise', 'wildlife_tour', 'boat_tour']
ALTER TABLE entity ADD COLUMN IF NOT EXISTS seo_keywords         text[];        -- ['Orange Beach dolphin cruise', ...]
