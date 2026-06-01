const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

async function checkDB() {
  console.log('\n=== ENTITIES ===');
  const { data: entities } = await db.from('entity').select('slug, name, menu_pin').limit(5);
  if (entities?.length) {
    entities.forEach(e => console.log(`  ${e.slug}: ${e.name} - PIN: ${e.menu_pin ? '✅ SET' : '❌ NOT SET'}`));
  } else {
    console.log('  ❌ NO ENTITIES FOUND');
  }
  
  console.log('\n=== TABLE ROW COUNTS ===');
  const tables = [
    'entity', 'entity_hours', 'entity_photos', 'entity_tags',
    'menu_sections', 'menu_items',
    'drink_sections', 'drink_items',
    'happy_hour_sections', 'happy_hour_items',
    'entity_specials', 'entity_events',
    'entity_sides', 'entity_daily_features', 'entity_happy_hour'
  ];
  
  for (const table of tables) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
    if (error?.code === 'PGRST116') {
      console.log(`  ❌ ${table}: DOES NOT EXIST`);
    } else if (error) {
      console.log(`  ⚠️  ${table}: ERROR - ${error.message}`);
    } else {
      console.log(`  ✅ ${table}: ${count} rows`);
    }
  }
}

checkDB().catch(console.error);
