const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and SUPABASE_KEY environment variables are required');
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseKey);

module.exports = db;
