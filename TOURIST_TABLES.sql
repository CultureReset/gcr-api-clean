-- GCR Tourist/User Tables
-- Paste this into Supabase SQL Editor to create tourist tables for phone OTP auth
-- https://supabase.com/dashboard/project/mkepugvdlktfsossumox/sql

-- 1. TOURIST_PROFILES (tourist/user accounts — keyed by phone)
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

-- 2. TOURIST_SESSIONS (OTP sessions — fallback if tourist_profiles fails)
CREATE TABLE IF NOT EXISTS tourist_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone text UNIQUE NOT NULL,
  otp_code text,
  otp_expires timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 3. TOURIST_SAVES (entities saved by users across both modes)
CREATE TABLE IF NOT EXISTS tourist_saves (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  saved_at timestamptz DEFAULT now(),
  UNIQUE(tourist_id, entity_slug)
);

-- 4. TOURIST_SWIPES (swipe events in trip-swipe mode)
CREATE TABLE IF NOT EXISTS tourist_swipes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  direction text CHECK (direction IN ('left', 'right')),
  category text,
  swiped_at timestamptz DEFAULT now()
);

-- 5. TOURIST_SEEN (card-seen tracking for swipe deck reset)
CREATE TABLE IF NOT EXISTS tourist_seen (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  seen_at timestamptz DEFAULT now(),
  UNIQUE(tourist_id, entity_slug)
);

-- 6. TOURIST_ITINERARIES (saved trip plans)
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

-- Enable Row-Level Security
ALTER TABLE tourist_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_swipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_itineraries ENABLE ROW LEVEL SECURITY;

-- Service role policies for auth operations
CREATE POLICY "Service full access" ON tourist_profiles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_sessions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_saves FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_swipes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_seen FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_itineraries FOR ALL USING (auth.role() = 'service_role');

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tourist_profiles_phone ON tourist_profiles(phone);
CREATE INDEX IF NOT EXISTS idx_tourist_saves_tourist_id ON tourist_saves(tourist_id);
CREATE INDEX IF NOT EXISTS idx_tourist_swipes_tourist_id ON tourist_swipes(tourist_id);
CREATE INDEX IF NOT EXISTS idx_tourist_seen_tourist_id ON tourist_seen(tourist_id);
CREATE INDEX IF NOT EXISTS idx_tourist_itineraries_tourist_id ON tourist_itineraries(tourist_id);
