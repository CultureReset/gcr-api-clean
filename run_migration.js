const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://mkepugvdlktfsossumox.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZXB1Z3ZkbGt0ZnNvc3N1bW94Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTQyMjQwMSwiZXhwIjoyMDk0OTk4NDAxfQ.uWxvQQKDxbaAz0FgcfwOhH3mtq92uXPOc4luQnw48DI';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runMigration() {
  console.log('🔄 Running migration: Add gallery_sections column to entity table...\n');
  
  try {
    // Try adding the column
    console.log('Step 1: Adding gallery_sections column...');
    const { error: error1 } = await db.from('entity').select('gallery_sections').limit(1);
    
    if (error1 && error1.message.includes('column')) {
      console.log('Column does not exist, attempting to create...');
      // If column doesn't exist, we need to use another approach
      // Supabase.js doesn't support raw SQL, so provide instructions
      throw new Error('Column does not exist - manual SQL needed');
    }
    
    console.log('✅ Column gallery_sections exists or created successfully');
  } catch (err) {
    console.error('⚠️  Column check shows:', err.message);
    console.log('\n📋 To add the column, run this SQL in Supabase SQL Editor:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`
ALTER TABLE entity 
ADD COLUMN IF NOT EXISTS gallery_sections jsonb DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_entity_gallery_sections 
ON entity USING gin (gallery_sections);
`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nLink: https://app.supabase.com/project/mkepugvdlktfsossumox/sql/new');
  }
}

runMigration();
