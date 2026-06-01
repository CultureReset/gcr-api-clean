require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  // Get menu sections
  const { data: sections } = await db.from('menu_sections')
    .select('*')
    .eq('entity_id', 'ac7fce66-a989-4ff7-a7ad-1142f2d94a5c')
    .limit(1);
  
  if (sections && sections.length > 0) {
    console.log('menu_sections columns:');
    console.log(Object.keys(sections[0]));
    console.log('Sample data:', sections[0]);
  } else {
    console.log('No menu_sections found');
  }
  
  // Get entity hours
  const { data: hours } = await db.from('entity_hours')
    .select('*')
    .eq('entity_id', 'ac7fce66-a989-4ff7-a7ad-1142f2d94a5c')
    .limit(1);
  
  if (hours && hours.length > 0) {
    console.log('\nentity_hours columns:');
    console.log(Object.keys(hours[0]));
    console.log('Sample data:', hours[0]);
  } else {
    console.log('No entity_hours found');
  }
  
  process.exit(0);
})();
