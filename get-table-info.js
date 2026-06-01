require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  // Check menu_sections
  const { data: menSec } = await db.from('menu_sections').select('*').limit(1);
  if (menSec && menSec[0]) {
    console.log('menu_sections columns:');
    console.log(JSON.stringify(Object.keys(menSec[0]), null, 2));
  }
  
  // Check entity_hours
  const { data: ehours } = await db.from('entity_hours').select('*').limit(1);
  if (ehours && ehours[0]) {
    console.log('\nentity_hours columns:');
    console.log(JSON.stringify(Object.keys(ehours[0]), null, 2));
  }
  
  // Check menu_items
  const { data: mitems } = await db.from('menu_items').select('*').limit(1);
  if (mitems && mitems[0]) {
    console.log('\nmenu_items columns:');
    console.log(JSON.stringify(Object.keys(mitems[0]), null, 2));
  }
  
  process.exit(0);
})();
