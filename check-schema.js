require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  // Get all tables and columns from information_schema
  const { data, error } = await db.from('information_schema.columns')
    .select('table_name, column_name')
    .in('table_name', ['menu_sections', 'menu_items', 'entity_hours']);
  
  if (error) {
    console.error('Query error:', error);
    // Try alternative approach - just query the tables with limit 0
    const tables = ['menu_sections', 'menu_items', 'entity_hours'];
    for (const table of tables) {
      console.log(`\n${table}:`);
      const { data: sample, error: err } = await db.from(table).select('*').limit(0);
      if (err) {
        console.log('  Error:', err.message);
      } else {
        console.log('  Available (but limit=0, no data)');
      }
    }
  } else {
    console.log('Schema info:');
    const grouped = {};
    data.forEach(row => {
      if (!grouped[row.table_name]) grouped[row.table_name] = [];
      grouped[row.table_name].push(row.column_name);
    });
    Object.entries(grouped).forEach(([table, cols]) => {
      console.log(`\n${table}:`);
      cols.forEach(col => console.log(`  - ${col}`));
    });
  }
  process.exit(0);
})();
