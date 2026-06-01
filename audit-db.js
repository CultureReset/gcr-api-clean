require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  console.log('=== DATABASE AUDIT ===\n');
  
  const tables = [
    'entity',
    'entity_photos',
    'entity_hours',
    'menu_sections',
    'menu_items',
    'drink_sections',
    'drink_items',
    'entity_specials',
    'entity_events',
    'tourist_groups',
    'tourist_group_members',
    'tourist_group_saves',
    'tourist_messages'
  ];
  
  for (const table of tables) {
    const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
    
    if (error) {
      console.log(`❌ ${table}: NOT FOUND`);
    } else {
      console.log(`✅ ${table}: ${count} rows`);
    }
  }
  
  console.log('\n=== ENTITIES ===');
  const { data: entities } = await db.from('entity').select('slug, name, menu_pin');
  if (entities) {
    entities.forEach(e => {
      console.log(`- ${e.slug}: "${e.name}" (menu_pin: ${e.menu_pin ? 'SET' : 'not set'})`);
    });
  }
  
  process.exit(0);
})();
