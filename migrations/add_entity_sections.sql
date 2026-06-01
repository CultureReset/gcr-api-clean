-- Migration: add flexible sections for Things To Do, Services, Staying
-- Paste this into Supabase SQL Editor and run

-- entity_sections: one row per section, section_type tells frontend how to render
-- Things To Do: tour_types | whats_included | highlights | policies
-- Services:     service_packages | what_we_do | faqs
-- Staying:      room_types | amenities | policies
CREATE TABLE IF NOT EXISTS entity_sections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  section_type text NOT NULL,
  section_name text NOT NULL,
  sort_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entity_section_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  section_id uuid NOT NULL REFERENCES entity_sections(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  item_name text NOT NULL,
  description text,
  price_from numeric(10,2),
  price_to numeric(10,2),
  price_label text,
  duration text,
  icon text,
  metadata jsonb DEFAULT '{}',
  sort_order integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entity_sections_slug ON entity_sections(entity_slug);
CREATE INDEX IF NOT EXISTS idx_entity_section_items_section ON entity_section_items(section_id);
CREATE INDEX IF NOT EXISTS idx_entity_section_items_slug ON entity_section_items(entity_slug);

ALTER TABLE entity_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_section_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON entity_sections FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_section_items FOR SELECT USING (true);
CREATE POLICY "Service write" ON entity_sections FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_section_items FOR ALL USING (auth.role() = 'service_role');
