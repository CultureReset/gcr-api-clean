require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

const schema = `
CREATE TABLE IF NOT EXISTS tourist_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tourist_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  creator_id UUID NOT NULL,
  trip_start_date DATE,
  trip_end_date DATE,
  destination TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (creator_id) REFERENCES tourist_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tourist_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES tourist_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES tourist_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tourist_group_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL,
  entity_slug TEXT NOT NULL,
  saved_by_user_id UUID,
  rating INT,
  notes TEXT,
  is_must_visit BOOLEAN DEFAULT FALSE,
  visit_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(group_id, entity_slug),
  FOREIGN KEY (group_id) REFERENCES tourist_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_slug) REFERENCES entity(slug) ON DELETE CASCADE,
  FOREIGN KEY (saved_by_user_id) REFERENCES tourist_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tourist_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL,
  user_id UUID NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (group_id) REFERENCES tourist_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES tourist_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tourist_itineraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL,
  day_date DATE NOT NULL,
  entity_slug TEXT,
  activity_name TEXT,
  scheduled_time TIME,
  notes TEXT,
  is_confirmed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(group_id, day_date, entity_slug),
  FOREIGN KEY (group_id) REFERENCES tourist_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_slug) REFERENCES entity(slug) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tourist_group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL,
  invite_email TEXT NOT NULL,
  invited_by_user_id UUID,
  invite_code TEXT UNIQUE NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (group_id) REFERENCES tourist_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_user_id) REFERENCES tourist_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_creator ON tourist_groups(creator_id);
CREATE INDEX IF NOT EXISTS idx_groups_active ON tourist_groups(is_active);
CREATE INDEX IF NOT EXISTS idx_members_group ON tourist_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON tourist_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_saves_group ON tourist_group_saves(group_id);
CREATE INDEX IF NOT EXISTS idx_saves_entity ON tourist_group_saves(entity_slug);
CREATE INDEX IF NOT EXISTS idx_messages_group ON tourist_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON tourist_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_itineraries_group ON tourist_itineraries(group_id);
CREATE INDEX IF NOT EXISTS idx_itineraries_date ON tourist_itineraries(group_id, day_date);
CREATE INDEX IF NOT EXISTS idx_invites_group ON tourist_group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_invites_code ON tourist_group_invites(invite_code);
`;

(async () => {
  try {
    const { error } = await db.rpc('exec_sql', { sql: schema });
    if (error) {
      console.log('Note: RPC method may not exist. Using alternative approach...');
      // Supabase doesn't have an exec_sql RPC by default, need to use direct SQL
      console.log('Tables will be created via Supabase SQL editor.');
      console.log('Copy and paste the SQL from /tmp/tourist-schema.sql into your Supabase SQL editor');
    } else {
      console.log('✅ Schema deployed successfully!');
    }
  } catch (err) {
    console.log('Supabase direct SQL execution not available via client.');
    console.log('Please run the SQL manually in Supabase dashboard: https://app.supabase.com');
    console.log('\nSQL saved at: /tmp/tourist-schema.sql');
  }
  process.exit(0);
})();
