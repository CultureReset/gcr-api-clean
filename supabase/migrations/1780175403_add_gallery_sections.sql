-- Add gallery_sections column to entity table
ALTER TABLE entity 
ADD COLUMN IF NOT EXISTS gallery_sections jsonb DEFAULT '[]'::jsonb;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_entity_gallery_sections ON entity USING gin (gallery_sections);
