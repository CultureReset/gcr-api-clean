const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

async function checkTables() {
  const problematic = ['entity_sides', 'entity_daily_features', 'entity_happy_hour'];
  
  for (const table of problematic) {
    console.log(`\n=== ${table} ===`);
    const { data, error } = await db.from(table).select('*').limit(1);
    if (error) {
      console.log(`Error: ${error.code} - ${error.message}`);
      if (error.code === 'PGRST116') {
        console.log(`Table does not exist`);
      }
    } else {
      console.log(`Table exists, data:`, data);
    }
  }
}

checkTables().catch(console.error);
