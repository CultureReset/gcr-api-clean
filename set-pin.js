require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  const testPin = '1234';
  const { error } = await db.from('entity')
    .update({ menu_pin: testPin })
    .eq('slug', 'tiki-raw-bar');
  
  if (error) {
    console.error('Error:', error);
  } else {
    console.log(`✓ Set menu_pin to '${testPin}' for tiki-raw-bar`);
  }
  process.exit(0);
})();
