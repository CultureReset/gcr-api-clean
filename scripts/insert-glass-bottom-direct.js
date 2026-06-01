require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL.trim(),
  process.env.GCR_SUPABASE_SERVICE_KEY.trim()
);

const slug = 'glass-bottom-dolphin-tours';

const entity = {
  slug,
  name: 'Glass Bottom Dolphin Tours',
  subtitle: 'by Dolphins Down Under',
  entity_type: 'activity',
  entity_subtype: 'dolphin_cruise',
  description: 'One of the only glass-bottom dolphin cruise experiences in Orange Beach. Custom glass-bottom catamarans with large underwater viewing panels let you watch marine life beneath the boat while spotting dolphins above. 90-minute narrated cruises through back bays and Gulf waters — family-friendly, educational, and a uniquely immersive experience compared to standard sightseeing boats.',
  phone: '(251) 968-4386',
  address_line_1: '28101 Perdido Beach Blvd',
  city: 'Orange Beach',
  state: 'AL',
  zip: '36561',
  price_range: '$$',
  icon: '🐬',
  good_for_kids: true,
  good_for_groups: true,
  featured: false,
  is_active: true,
};

const tags = [
  { tag_name: 'Dolphin Cruise',         tag_category: 'activity' },
  { tag_name: 'Glass Bottom Boat',       tag_category: 'activity' },
  { tag_name: 'Sunset Cruise',           tag_category: 'activity' },
  { tag_name: 'Wildlife Tours',          tag_category: 'activity' },
  { tag_name: 'Sightseeing Cruises',     tag_category: 'activity' },
  { tag_name: 'Family Activities',       tag_category: 'audience' },
  { tag_name: 'Scenic Cruises',          tag_category: 'activity' },
  { tag_name: 'Dolphin Watching',        tag_category: 'activity' },
  { tag_name: 'Orange Beach Activities', tag_category: 'location' },
  { tag_name: 'Water Activities',        tag_category: 'activity' },
  { tag_name: 'Marine Life Viewing',     tag_category: 'activity' },
  { tag_name: 'Educational Activities',  tag_category: 'experience' },
  { tag_name: 'Boat Tours',              tag_category: 'activity' },
  { tag_name: 'Tourist Attractions',     tag_category: 'audience' },
  { tag_name: 'Vacation Activities',     tag_category: 'audience' },
  { tag_name: 'Good For Kids',            tag_category: 'audience' },
  { tag_name: 'Photography Friendly',    tag_category: 'experience' },
  { tag_name: 'First-Time Visitors',     tag_category: 'audience' },
  { tag_name: 'Unique Experience',       tag_category: 'experience' },
  { tag_name: 'Free Parking',            tag_category: 'feature' },
  { tag_name: 'Wheelchair Accessible',   tag_category: 'feature' },
  { tag_name: 'Relaxed Pace',            tag_category: 'atmosphere' },
  { tag_name: 'Not For Thrill Seekers',  tag_category: 'atmosphere' },
];


const sections = [
  {
    section_type: 'tour_types',
    section_name: 'Cruise Types',
    items: [
      { item_name: 'Daily Dolphin Cruise', description: 'The standard tour focused on dolphin spotting, wildlife viewing, and scenic cruising through the back bays and Gulf Coast waterways.', duration: '90 min' },
      { item_name: 'Sunset Dolphin Cruise', description: 'Combines dolphin spotting with sunset views over the water. Typically runs 75–90 minutes depending on sunset timing.', duration: '75–90 min' },
      { item_name: 'Private Charters', description: 'Private bookings for families, birthday parties, company outings, group events, and custom sightseeing trips.' },
      { item_name: 'Snorkeling Tours', description: 'Seasonal snorkeling experiences. Availability varies — contact operator directly.' },
    ],
  },
  {
    section_type: 'whats_included',
    section_name: "What's Included",
    items: [
      { item_name: 'Glass-Bottom Viewing Panels', description: 'Large underwater viewing panels built into the boat — see marine life beneath the vessel.' },
      { item_name: 'Narrated Tour', description: 'Educational onboard narration throughout the cruise.' },
      { item_name: 'Marine Restroom', description: 'Restroom onboard.' },
      { item_name: 'Snack Bar', description: 'Snacks available for purchase.' },
      { item_name: 'Beverages', description: 'Both alcoholic and non-alcoholic beverages available.' },
      { item_name: 'Life Jackets', description: 'Provided onboard. Children 8 and under required to wear them.' },
    ],
  },
  {
    section_type: 'highlights',
    section_name: "What You'll See",
    items: [
      { item_name: 'Wild Bottlenose Dolphins', icon: '🐬' },
      { item_name: 'Stingrays & Coastal Fish', icon: '🐟' },
      { item_name: 'Ospreys & Great Blue Herons', icon: '🦅' },
      { item_name: 'Orange Beach Waterways & Back Bays', icon: '🌊' },
      { item_name: 'Sunset Views over the Gulf', icon: '🌅' },
      { item_name: 'Coastal Wetlands & Marina Areas', icon: '🌿' },
    ],
  },
  {
    section_type: 'pricing',
    section_name: 'Estimated Pricing',
    items: [
      { item_name: 'Adult Ticket', price_from: 30, price_to: 40, price_label: 'per person', description: 'Estimated. Verify directly with operator — pricing fluctuates seasonally.' },
      { item_name: 'Child Ticket', price_from: 20, price_to: 30, price_label: 'per child', description: 'Estimated. Verify directly with operator.' },
      { item_name: 'Infant', price_label: 'Contact operator', description: 'Check directly with operator for infant pricing.' },
      { item_name: 'Private Charter', price_label: 'Varies', description: 'Price varies by boat type, group size, and duration. Contact operator directly.' },
    ],
  },
  {
    section_type: 'best_for',
    section_name: 'Best For',
    items: [
      { item_name: 'Families with Kids', icon: '👨‍👩‍👧' },
      { item_name: 'First-Time Visitors', icon: '🌟' },
      { item_name: 'Dolphin Photography', icon: '📸' },
      { item_name: 'Wildlife Enthusiasts', icon: '🦅' },
      { item_name: 'Sunset Cruise Seekers', icon: '🌅' },
      { item_name: 'Educational Activities', icon: '🎓' },
      { item_name: 'Scenic Sightseeing', icon: '🌊' },
    ],
  },
  {
    section_type: 'policies',
    section_name: 'Policies & Accessibility',
    items: [
      { item_name: 'No Outside Coolers or Beverages' },
      { item_name: 'No Strollers or Car Seats Onboard' },
      { item_name: 'Children 8 & Under Must Wear Life Jackets' },
      { item_name: 'Free Parking Available' },
      { item_name: 'Wheelchair-Accessible Parking' },
      { item_name: 'Gender-Neutral Restrooms' },
    ],
  },
];

const events = [
  {
    event_name: 'Glass-Bottom Dolphin Cruise',
    description: '90-minute narrated dolphin watching cruise with glass-bottom viewing panels through Orange Beach waterways.',
    day_of_week: 'Daily',
    recurring: true,
    is_active: true,
  },
  {
    event_name: 'Sunset Dolphin Cruise',
    description: 'Evening glass-bottom dolphin cruise with sunset views over the Gulf Coast.',
    day_of_week: 'Daily',
    recurring: true,
    start_time: '18:00',
    is_active: true,
  },
];

async function run() {
  console.log('Inserting Glass Bottom Dolphin Tours directly into Supabase...\n');

  // 1. Upsert entity
  const { error: e1 } = await db.from('entity').upsert(entity, { onConflict: 'slug' });
  if (e1) { console.error('❌ entity:', e1.message); process.exit(1); }
  console.log('✅ Entity upserted');

  // 2. Tags
  await db.from('entity_tags').delete().eq('entity_slug', slug);
  const { error: e2 } = await db.from('entity_tags').insert(tags.map(t => ({ entity_slug: slug, ...t })));
  if (e2) console.error('⚠️  tags:', e2.message);
  else console.log(`✅ ${tags.length} tags inserted`);

  // 3. Sections (tour types, highlights, policies)
  await db.from('entity_section_items').delete().eq('entity_slug', slug);
  await db.from('entity_sections').delete().eq('entity_slug', slug);
  for (const [i, sec] of sections.entries()) {
    const { data: s, error } = await db.from('entity_sections')
      .insert({ entity_slug: slug, section_type: sec.section_type, section_name: sec.section_name, sort_order: i })
      .select('id').single();
    if (error || !s) { console.error('⚠️  section:', sec.section_name, error?.message); continue; }
    if (sec.items?.length) {
      await db.from('entity_section_items').insert(sec.items.map((item, j) => ({
        entity_slug: slug, section_id: s.id,
        item_name: item.item_name, description: item.description || null,
        duration: item.duration || null, icon: item.icon || null,
        sort_order: j,
      })));
    }
  }
  console.log(`✅ ${sections.length} sections inserted`);

  // 4. Events
  await db.from('entity_events').delete().eq('entity_slug', slug);
  const { error: e4 } = await db.from('entity_events').insert(events.map(e => ({ entity_slug: slug, ...e })));
  if (e4) console.error('⚠️  events:', e4.message);
  else console.log(`✅ ${events.length} events inserted`);

  console.log('\nDone! Glass Bottom Dolphin Tours is live on the Things To Do page.');
}

run();
