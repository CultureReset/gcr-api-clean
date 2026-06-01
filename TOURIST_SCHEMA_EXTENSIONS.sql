-- ============================================================
-- GCR Tourist Platform Schema Extensions
-- Add to existing GCR Production schema for Phase 1 & Phase 2
-- Paste into Supabase SQL Editor: https://supabase.com/dashboard/project/YOUR_PROJECT/sql
-- ============================================================

-- ============================================================
-- PHASE 1: GROUP SHARING & ITINERARY (Required for MVP)
-- ============================================================

-- 1. TOURIST_GROUPS (group trips that can be shared)
CREATE TABLE IF NOT EXISTS tourist_groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  trip_start_date date,
  trip_end_date date,
  trip_location text,
  budget_total numeric,
  budget_per_person numeric,
  group_type text CHECK (group_type IN ('family', 'friends', 'couple', 'business', 'solo')),
  max_members integer DEFAULT 10,
  is_public boolean DEFAULT false,
  share_token text UNIQUE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. TOURIST_GROUP_MEMBERS (who's in each group)
CREATE TABLE IF NOT EXISTS tourist_group_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES tourist_groups(id) ON DELETE CASCADE,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  role text CHECK (role IN ('creator', 'member', 'moderator')) DEFAULT 'member',
  invited_at timestamptz DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE(group_id, tourist_id)
);

-- 3. TOURIST_GROUP_SAVES (items saved to a specific group's itinerary)
CREATE TABLE IF NOT EXISTS tourist_group_saves (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES tourist_groups(id) ON DELETE CASCADE,
  entity_slug text NOT NULL REFERENCES entity(slug) ON DELETE CASCADE,
  added_by_tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE SET NULL,
  day_number integer,
  time_slot text,
  notes text,
  cost_estimate numeric,
  saved_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(group_id, entity_slug)
);

-- ============================================================
-- PHASE 2: GROUP COMMUNICATION & AI
-- ============================================================

-- 4. TOURIST_MESSAGES (group chat for trip planning)
CREATE TABLE IF NOT EXISTS tourist_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES tourist_groups(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE SET NULL,
  message_text text NOT NULL,
  message_type text CHECK (message_type IN ('text', 'suggestion', 'poll', 'reminder')) DEFAULT 'text',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 5. TOURIST_AI_CONVERSATIONS (AI itinerary generation per group)
CREATE TABLE IF NOT EXISTS tourist_ai_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES tourist_groups(id) ON DELETE CASCADE,
  started_by_tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE SET NULL,
  conversation_title text,
  conversation_data jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 6. USER_PREFERENCE_SCORES (track tourist interests for AI recommendations)
CREATE TABLE IF NOT EXISTS user_preference_scores (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  tag text NOT NULL,
  score numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(tourist_id, tag)
);

-- 7. TOURIST_MEMORIES (save trip memories/notes)
CREATE TABLE IF NOT EXISTS tourist_memories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tourist_id uuid NOT NULL REFERENCES tourist_profiles(id) ON DELETE CASCADE,
  group_id uuid REFERENCES tourist_groups(id) ON DELETE CASCADE,
  category text,
  key text,
  value text,
  tags text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 8. PLATFORM_SETTINGS (configuration for SMS, features, etc.)
CREATE TABLE IF NOT EXISTS platform_settings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key text UNIQUE NOT NULL,
  value jsonb,
  updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tourist_groups_creator ON tourist_groups(creator_id);
CREATE INDEX IF NOT EXISTS idx_tourist_group_members_group ON tourist_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_tourist_group_members_tourist ON tourist_group_members(tourist_id);
CREATE INDEX IF NOT EXISTS idx_tourist_group_saves_group ON tourist_group_saves(group_id);
CREATE INDEX IF NOT EXISTS idx_tourist_group_saves_entity ON tourist_group_saves(entity_slug);
CREATE INDEX IF NOT EXISTS idx_tourist_messages_group ON tourist_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_tourist_ai_conversations_group ON tourist_ai_conversations(group_id);
CREATE INDEX IF NOT EXISTS idx_user_preference_scores_tourist ON user_preference_scores(tourist_id);
CREATE INDEX IF NOT EXISTS idx_tourist_memories_tourist ON tourist_memories(tourist_id);
CREATE INDEX IF NOT EXISTS idx_tourist_memories_group ON tourist_memories(group_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE tourist_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_group_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE tourist_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service full access" ON tourist_groups FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_group_members FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_group_saves FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_messages FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_ai_conversations FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON user_preference_scores FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON tourist_memories FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service full access" ON platform_settings FOR ALL USING (auth.role() = 'service_role');
