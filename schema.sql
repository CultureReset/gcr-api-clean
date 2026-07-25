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
  -- entity_type controls which PRIMARY page this business appears on
  -- Valid values: restaurant | coffee | dessert | bakery | activity |
  --               service | shopping | hotel | condo | vacation-rental | park
  entity_type text CHECK (entity_type IN (
    'restaurant','coffee','dessert','bakery','activity',
    'service','shopping','hotel','condo','vacation-rental','park'
  )),
  entity_subtype text,
  -- also_appears_on lets a business show on additional pages beyond its primary type
  -- Valid page values: restaurants | coffee-sweets | things-to-do | services |
  --                    shopping | staying | public-spots
  -- Example: a dinner-cruise activity that also shows on the restaurants page:
  --   entity_type='activity', also_appears_on='{restaurants}'
  also_appears_on text[] DEFAULT '{}',
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

  -- Things To Do / Activity
  price_from            numeric(10,2),
  price_to              numeric(10,2),
  price_unit            text,             -- "per person" | "per boat" | "per night" | "per hour"
  duration_text         text,
  duration_label        text,             -- "2-3 hours" | "Half Day" | "Full Day"
  capacity_min          integer,
  capacity_max          integer,
  minimum_age           integer,
  booking_advance_days  integer,

  -- Staying (hotel / condo / vacation-rental)
  bedrooms_min          integer,
  bedrooms_max          integer,
  sleeps_min            integer,
  sleeps_max            integer,
  check_in_time         time,
  check_out_time        time,
  pet_friendly          boolean DEFAULT false,
  pool                  boolean DEFAULT false,
  parking               boolean DEFAULT false,

  -- Universal cross-category
  known_for             text,
  highlights            text[],
  good_for              text[],
  what_makes_it_different text,
  secondary_subtypes    text[],
  seo_keywords          text[],

  -- Multi-page support
  also_appears_on       text[] DEFAULT '{}',

  -- Flexible JSON sections (legacy / bonus)
  gallery_sections      jsonb,
  rotating_sections     jsonb,
  theme                 jsonb,

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

-- 14b. ENTITY_SECTIONS (flexible sections for non-restaurant entity types)
-- section_type controls frontend rendering:
--   Things To Do: tour_types | whats_included | highlights | policies
--   Services:     service_packages | what_we_do | faqs
--   Staying:      room_types | amenities | policies
CREATE TABLE entity_sections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  section_type text NOT NULL,
  section_name text NOT NULL,
  sort_order integer DEFAULT 0
);

-- 14c. ENTITY_SECTION_ITEMS
CREATE TABLE entity_section_items (
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

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_entity_slug ON entity(slug);
CREATE INDEX idx_entity_active ON entity(is_active);
CREATE INDEX idx_entity_subtype ON entity(entity_subtype);
CREATE INDEX idx_entity_city ON entity(city);
CREATE INDEX idx_entity_featured ON entity(featured);
CREATE INDEX idx_entity_also_appears_on ON entity USING GIN(also_appears_on);
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
CREATE INDEX idx_entity_sections_slug ON entity_sections(entity_slug);
CREATE INDEX idx_entity_section_items_section ON entity_section_items(section_id);
CREATE INDEX idx_entity_section_items_slug ON entity_section_items(entity_slug);
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
-- 14. TOURIST_PROFILES (tourist/user accounts — keyed by phone)
CREATE TABLE IF NOT EXISTS tourist_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone text UNIQUE NOT NULL,
  name text,
  email text,
  avatar_url text,
  otp_code text,
  otp_expires timestamptz,
  sms_opt_in boolean DEFAULT true,
  sms_opted_in_at timestamptz,
  setup_complete boolean DEFAULT false,
  preferences jsonb DEFAULT '{}',
  last_active timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 15. TOURIST_SESSIONS (OTP sessions — fallback if tourist_profiles fails)
CREATE TABLE IF NOT EXISTS tourist_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone text UNIQUE NOT NULL,
  otp_code text,
  otp_expires timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 16. TOURIST_SAVES (entities saved by users across both modes)
CREATE TABLE IF NOT EXISTS tourist_saves (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  saved_at timestamptz DEFAULT now(),
  UNIQUE(tourist_id, entity_slug)
);

-- 17. TOURIST_SWIPES (swipe events in trip-swipe mode)
CREATE TABLE IF NOT EXISTS tourist_swipes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  direction text CHECK (direction IN ('left', 'right')),
  category text,
  swiped_at timestamptz DEFAULT now()
);

-- 18. TOURIST_SEEN (card-seen tracking for swipe deck reset)
CREATE TABLE IF NOT EXISTS tourist_seen (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  seen_at timestamptz DEFAULT now(),
  UNIQUE(tourist_id, entity_slug)
);

-- 19. TOURIST_ITINERARIES (saved trip plans)
CREATE TABLE IF NOT EXISTS tourist_itineraries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  days jsonb DEFAULT '[]',
  start_date date,
  end_date date,
  shared_with text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

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
ALTER TABLE entity_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_section_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_specials ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_swipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_itineraries ENABLE ROW LEVEL SECURITY;

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
CREATE POLICY "Public read" ON entity_sections FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_section_items FOR SELECT USING (true);
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
CREATE POLICY "Service write" ON entity_sections FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_section_items FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_specials FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_events FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON artists FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service full access" ON tourist_profiles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_sessions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_saves FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_swipes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_seen FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_itineraries FOR ALL USING (auth.role() = 'service_role');

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

-- 20. ADMIN_USERS (admin login for cybercheck-login dashboard)
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text DEFAULT 'admin',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);

-- To create the initial admin account, run: node scripts/create-admin.js <email> <password>
-- (do not hardcode credentials or password hashes in this file)

-- ============================================================
-- MISSING TABLES FOR MINI-SITE COMPLETION
-- ============================================================

-- 21. ENTITY_REVIEWS (customer reviews and ratings)
CREATE TABLE IF NOT EXISTS entity_reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  reviewer_name text NOT NULL,
  reviewer_email text,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title text,
  body text,
  verified_purchase boolean DEFAULT false,
  helpful_count integer DEFAULT 0,
  approved boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_slug ON entity_reviews(entity_slug);
CREATE INDEX IF NOT EXISTS idx_reviews_approved ON entity_reviews(approved);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON entity_reviews(rating);

-- 22. ENTITY_TEAM_MEMBERS (staff and team bios)
CREATE TABLE IF NOT EXISTS entity_team_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  name text NOT NULL,
  title text,
  bio text,
  photo_url text,
  photo_path text,
  specialty text,
  certifications text[],
  years_experience integer,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_slug ON entity_team_members(entity_slug);

-- 23. ENTITY_GALLERY (organized photo gallery with categories)
CREATE TABLE IF NOT EXISTS entity_gallery (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  photo_url text NOT NULL,
  photo_path text,
  caption text,
  category text DEFAULT 'general',  -- interior, food, room, team, event, exterior, general
  is_featured boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gallery_slug ON entity_gallery(entity_slug);
CREATE INDEX IF NOT EXISTS idx_gallery_category ON entity_gallery(category);
CREATE INDEX IF NOT EXISTS idx_gallery_featured ON entity_gallery(is_featured);

-- 24. ENTITY_AVAILABILITY (booking calendar slots)
CREATE TABLE IF NOT EXISTS entity_availability (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  available_date date NOT NULL,
  available_slots integer DEFAULT 1,
  booked_slots integer DEFAULT 0,
  blocked boolean DEFAULT false,
  special_pricing numeric(10,2),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(entity_slug, available_date)
);

CREATE INDEX IF NOT EXISTS idx_availability_slug ON entity_availability(entity_slug);
CREATE INDEX IF NOT EXISTS idx_availability_date ON entity_availability(available_date);

-- 25. ENTITY_BOOKINGS (confirmed bookings/reservations)
CREATE TABLE IF NOT EXISTS entity_bookings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  guest_phone text,
  booking_date date NOT NULL,
  booking_time time,
  duration_hours numeric(5,2),
  guest_count integer DEFAULT 1,
  service_id text,
  total_price numeric(10,2),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  special_requests text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_slug ON entity_bookings(entity_slug);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON entity_bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON entity_bookings(status);

-- 26. ENTITY_FAQS (frequently asked questions)
CREATE TABLE IF NOT EXISTS entity_faqs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  category text DEFAULT 'general',  -- general, booking, cancellation, pet-policy, accessibility
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_faqs_slug ON entity_faqs(entity_slug);
CREATE INDEX IF NOT EXISTS idx_faqs_category ON entity_faqs(category);

-- 27. ENTITY_POLICIES (business policies)
CREATE TABLE IF NOT EXISTS entity_policies (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  policy_type text NOT NULL CHECK (policy_type IN ('cancellation', 'refund', 'house_rules', 'accessibility', 'pet_policy')),
  content text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(entity_slug, policy_type)
);

CREATE INDEX IF NOT EXISTS idx_policies_slug ON entity_policies(entity_slug);

-- 28. ENTITY_BLOG_POSTS (business blog/news posts)
CREATE TABLE IF NOT EXISTS entity_blog_posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  title text NOT NULL,
  slug text NOT NULL,
  content text,
  excerpt text,
  featured_image_url text,
  featured_image_path text,
  published_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(entity_slug, slug)
);

CREATE INDEX IF NOT EXISTS idx_blog_slug ON entity_blog_posts(entity_slug);
CREATE INDEX IF NOT EXISTS idx_blog_published ON entity_blog_posts(published_at);

-- Enable RLS and create policies for new tables
ALTER TABLE entity_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_gallery ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_blog_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON entity_reviews FOR SELECT USING (approved = true);
CREATE POLICY "Public read" ON entity_team_members FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_gallery FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_availability FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_faqs FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_policies FOR SELECT USING (true);
CREATE POLICY "Public read" ON entity_blog_posts FOR SELECT USING (published_at IS NOT NULL AND published_at <= now());

CREATE POLICY "Service write" ON entity_reviews FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_team_members FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_gallery FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_availability FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_bookings FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_faqs FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_policies FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write" ON entity_blog_posts FOR ALL USING (auth.role() = 'service_role');
