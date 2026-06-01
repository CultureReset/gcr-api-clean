require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  console.log('=== VERIFYING SAVED DATA ===\n');
  
  const { data: entity } = await db.from('entity')
    .select('id, slug, name, subtitle')
    .eq('slug', 'tiki-raw-bar')
    .single();
  
  if (!entity) {
    console.error('Entity not found!');
    process.exit(1);
  }
  
  console.log(`Entity: "${entity.name}"`);
  console.log(`ID: ${entity.id}\n`);
  
  // Check menu sections
  const { data: sections, error: secErr } = await db.from('menu_sections')
    .select('*')
    .eq('entity_slug', 'tiki-raw-bar');
  
  console.log(`Menu Sections (${sections?.length || 0}):`);
  if (secErr) {
    console.log('  Error:', secErr.message);
  } else {
    sections.forEach((s, i) => {
      console.log(`  ${i+1}. ${s.section_name} (sort_order: ${s.sort_order})`);
    });
  }
  
  // Check menu items
  const { data: items, error: itemErr } = await db.from('menu_items')
    .select('*')
    .eq('entity_slug', 'tiki-raw-bar');
  
  console.log(`\nMenu Items (${items?.length || 0}):`);
  if (itemErr) {
    console.log('  Error:', itemErr.message);
  } else {
    items.forEach(i => {
      console.log(`  - ${i.item_name} (${ i.price})`);
    });
  }
  
  // Check hours
  const { data: hours, error: hourErr } = await db.from('entity_hours')
    .select('*')
    .eq('entity_slug', 'tiki-raw-bar')
    .order('day_of_week');
  
  console.log(`\nHours (${hours?.length || 0} days):`);
  if (hourErr) {
    console.log('  Error:', hourErr.message);
  } else {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    hours.forEach(h => {
      const day = dayNames[h.day_of_week];
      if (h.is_closed) {
        console.log(`  ${day}: CLOSED`);
      } else {
        console.log(`  ${day}: ${h.opens_at} - ${h.closes_at}`);
      }
    });
  }
  
  process.exit(0);
})();
