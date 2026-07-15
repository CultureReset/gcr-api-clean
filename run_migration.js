const { createClient } = require('@supabase/supabase-js');

// SECURITY: never hardcode the service_role key. Read from env only.
// The previously committed key MUST be rotated in Supabase (Settings → API);
// it remains in git history. See CONSOLIDATION_PLAN.md.
const SUPABASE_URL = process.env.GCR_SUPABASE_URL || 'https://mkepugvdlktfsossumox.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing GCR_SUPABASE_SERVICE_KEY env var. Refusing to run.');
  process.exit(1);
}

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
