require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

async function deleteAdmin() {
  const { error } = await db.from('admin_users').delete().eq('email', 'info@cybercheckinc.com');
  if (error) {
    console.error('Error deleting:', error);
  } else {
    console.log('✅ Deleted old admin user');
  }
}

deleteAdmin();
