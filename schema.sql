-- ============================================================
-- GCR Production Database Schema — CLEAN BUILD
-- New Supabase project — paste entire file into SQL Editor and run
-- ============================================================

-- 1. ENTITY (core business record)
CREATE TABLE entity (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  is_active boolean DEFAULT true,
  featured boolean DEFAULT false,
  icon text,
  entity_type text,
  entity_subtype text,
  description text,
  subtitle text,
  phone text,
  email text,
  website_url text,
  menu_url text,
  menu_pin text,
  reservation_url text,
  order_url text,
  booking_url text,
  directions_url text,
  call_url text,
  social_instagram text,
  social_facebook text,
  social_tiktok text,
  address_line_1 text,
  address_line_2 text,
  city text,
  state text DEFAULT 'AL',
  zip text,
  latitude numeric,
  longitude numeric,
  rating numeric CHECK (rating >= 0 AND rating <= 5),
  review_count integer DEFAULT 0,
  price_range text,
  hero_image_url text,
  hero_image_path text,
  logo_url text,
  logo_image_path text,
  hh_days text,
  hh_start time,
  hh_end time,
  hh_description text,
  serves_breakfast boolean DEFAULT false,
  serves_brunch boolean DEFAULT false,
  serves_lunch boolean DEFAULT false,
  serves_dinner boolean DEFAULT false,
  outdoor_seating boolean DEFAULT false,
  live_music boolean DEFAULT false,
  reservable boolean DEFAULT false,
  dine_in boolean DEFAULT true,
  takeout boolean DEFAULT false,
  delivery boolean DEFAULT false,
  serves_beer boolean DEFAULT false,
  serves_wine boolean DEFAULT false,
  serves_cocktails boolean DEFAULT false,
  good_for_groups boolean DEFAULT false,
  good_for_kids boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. ENTITY_HOURS (7 rows per business: 0=Sun, 1=Mon ... 6=Sat)
CREATE TABLE entity_hours (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  day_of_week integer NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  opens_at time,
  closes_at time,
  is_closed boolean DEFAULT false
);

-- 3. ENTITY_PHOTOS
CREATE TABLE entity_photos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  url text NOT NULL,
  image_path text,
  is_cover boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  caption text
);

-- 4. ENTITY_TAGS
CREATE TABLE entity_tags (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  tag_name text NOT NULL,
  tag_category text
);

-- 5. MENU_SECTIONS
CREATE TABLE menu_sections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  section_name text NOT NULL,
  sort_order integer DEFAULT 0
);

-- 6. MENU_ITEMS
CREATE TABLE menu_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  section_id uuid REFERENCES menu_sections(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  item_name text NOT NULL,
  description text,
  price numeric(10,2),
  tags text[],
  image_url text,
  image_path text
);

-- 7. DRINK_SECTIONS
CREATE TABLE drink_sections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  section_name text NOT NULL,
  sort_order integer DEFAULT 0
);

-- 8. DRINK_ITEMS
CREATE TABLE drink_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  section_id uuid REFERENCES drink_sections(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  item_name text NOT NULL,
  description text,
  price numeric(10,2),
  image_url text,
  image_path text
);

-- 9. HAPPY_HOUR_SECTIONS
CREATE TABLE happy_hour_sections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  section_name text NOT NULL,
  sort_order integer DEFAULT 0
);

-- 10. HAPPY_HOUR_ITEMS
CREATE TABLE happy_hour_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  section_id uuid REFERENCES happy_hour_sections(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  item_name text NOT NULL,
  description text,
  price numeric(10,2),
  original_price numeric(10,2),
  image_url text,
  image_path text
);

-- 11. ENTITY_SPECIALS
CREATE TABLE entity_specials (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  entity_name text,
  special_name text NOT NULL,
  description text,
  discount_type text,
  discount_value numeric,
  discount_text text,
  days text,
  day_of_week text,
  start_time time,
  end_time time,
  start_date date,
  end_date date,
  is_active boolean DEFAULT true,
  image_url text,
  image_path text
);

-- 12. ARTISTS (reusable profiles — linked to events across all venues)
CREATE TABLE artists (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  bio text,
  genre text,
  hometown text,
  image_url text,
  image_path text,
  website_url text,
  social_instagram text,
  social_facebook text,
  social_tiktok text,
  spotify_url text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 13. ENTITY_EVENTS
CREATE TABLE entity_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  entity_name text,
  event_name text NOT NULL,
  description text,
  event_date date,
  start_time time,
  end_time time,
  day_of_week text,
  recurring boolean DEFAULT false,
  artist_id uuid REFERENCES artists(id) ON DELETE SET NULL,
  artist_name text,
  cover_charge numeric(10,2),
  is_active boolean DEFAULT true,
  image_url text,
  image_path text
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_entity_slug ON entity(slug);
CREATE INDEX idx_entity_active ON entity(is_active);
CREATE INDEX idx_entity_subtype ON entity(entity_subtype);
CREATE INDEX idx_entity_city ON entity(city);
CREATE INDEX idx_entity_featured ON entity(featured);
CREATE INDEX idx_hours_slug ON entity_hours(entity_slug);
CREATE INDEX idx_photos_slug ON entity_photos(entity_slug);
CREATE INDEX idx_tags_slug ON entity_tags(entity_slug);
CREATE INDEX idx_menu_sections_slug ON menu_sections(entity_slug);
CREATE INDEX idx_menu_items_slug ON menu_items(entity_slug);
CREATE INDEX idx_menu_items_section ON menu_items(section_id);
CREATE INDEX idx_drink_sections_slug ON drink_sections(entity_slug);
CREATE INDEX idx_drink_items_slug ON drink_items(entity_slug);
CREATE INDEX idx_hh_sections_slug ON happy_hour_sections(entity_slug);
CREATE INDEX idx_hh_items_slug ON happy_hour_items(entity_slug);
CREATE INDEX idx_specials_slug ON entity_specials(entity_slug);
CREATE INDEX idx_specials_active ON entity_specials(is_active);
CREATE INDEX idx_artists_slug ON artists(slug);
CREATE INDEX idx_artists_active ON artists(is_active);
CREATE INDEX idx_events_slug ON entity_events(entity_slug);
CREATE INDEX idx_events_date ON entity_events(event_date);
CREATE INDEX idx_events_active ON entity_events(is_active);
CREATE INDEX idx_events_artist ON entity_events(artist_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE drink_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE drink_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_hour_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_hour_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_specials ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON entity FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_hours FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_photos FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_tags FOR SELECT USING (true);
CREATE POLICY "Public read" ON menu_sections FOR SELECT USING (true);
CREATE POLICY "Public read" ON menu_items FOR SELECT USING (true);
CREATE POLICY "Public read" ON drink_sections FOR SELECT USING (true);
CREATE POLICY "Public read" ON drink_items FOR SELECT USING (true);
CREATE POLICY "Public read" ON happy_hour_sections FOR SELECT USING (true);
CREATE POLICY "Public read" ON happy_hour_items FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_specials FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_events FOR SELECT USING (true);
CREATE POLICY "Public read" ON artists FOR SELECT USING (true);

CREATE POLICY "Service write" ON entity FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_hours FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_photos FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_tags FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON menu_sections FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON menu_items FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON drink_sections FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON drink_items FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON happy_hour_sections FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON happy_hour_items FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_specials FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_events FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON artists FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- STORAGE BUCKET: create 'media' as public in Supabase UI
-- Folder structure:
--   entities/{slug}/hero.jpg
--   entities/{slug}/logo.jpg
--   menu-items/{id}/photo.jpg
--   drink-items/{id}/photo.jpg
--   happy-hour-items/{id}/photo.jpg
--   events/{id}/photo.jpg
--   specials/{id}/photo.jpg
-- ============================================================
