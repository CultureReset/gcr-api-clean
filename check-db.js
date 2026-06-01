require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  const { data, error } = await db.from('entity')
    .select('id, slug, name, menu_pin')
    .limit(10);
  
  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Sample entities:');
    data.forEach(e => {
      console.log(`- ${e.slug}: ${e.name} (menu_pin: ${e.menu_pin ? 'SET (' + e.menu_pin + ')' : 'NOT SET'})`);
    });
  }
  process.exit(0);
})();
