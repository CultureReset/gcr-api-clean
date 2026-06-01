require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

(async () => {
  console.log('=== VERIFYING SAVED DATA ===\n');
  
  // Get entity
  const { data: entity } = await db.from('entity')
    .select('id, slug, name, subtitle')
    .eq('slug', 'tiki-raw-bar')
    .single();
  
  if (!entity) {
    console.error('Entity not found!');
    process.exit(1);
  }
  
  console.log(`Entity ID: ${entity.id}`);
  console.log(`Slug: ${entity.slug}`);
  console.log(`Name: ${entity.name}`);
  console.log(`Subtitle: ${entity.subtitle}\n`);
  
  // Check menu sections
  const { data: sections, error: sectionsError } = await db.from('menu_sections')
    .select('id, title, sort_order, entity_id')
    .eq('entity_id', entity.id);
  
  console.log(`Menu Sections for entity ${entity.id}:`);
  if (sectionsError) {
    console.log('  Error:', sectionsError.message);
  } else {
    console.log(`  Found ${sections.length} sections`);
    sections.forEach(s => {
      console.log(`    - ${s.title} (order: ${s.sort_order})`);
    });
  }
  
  // Check hours
  const { data: hours, error: hoursError } = await db.from('entity_hours')
    .select('day_of_week, open_time, close_time, is_closed')
    .eq('entity_id', entity.id)
    .order('day_of_week');
  
  console.log(`\nHours:`);
  if (hoursError) {
    console.log('  Error:', hoursError.message);
  } else {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    hours.forEach(h => {
      const day = dayNames[h.day_of_week];
      if (h.is_closed) {
        console.log(`  ${day}: CLOSED`);
      } else {
        console.log(`  ${day}: ${h.open_time} - ${h.close_time}`);
      }
    });
  }
  
  process.exit(0);
})();
