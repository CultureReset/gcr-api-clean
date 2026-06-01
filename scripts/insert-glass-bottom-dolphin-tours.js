require('dotenv').config();
const fetch = require('node-fetch');

const API_BASE = process.env.API_BASE || 'https://gcr-api-clean.vercel.app';
const ADMIN_TOKEN = process.env.ADMIN_SECRET || process.env.GCR_SUPABASE_SERVICE_KEY;

const payload = {
  entity: {
    slug: 'glass-bottom-dolphin-tours',
    name: 'Glass Bottom Dolphin Tours',
    subtitle: 'by Dolphins Down Under',
    entity_type: 'activity',
    entity_subtype: 'dolphin_cruise',
    description: 'One of the few glass-bottom dolphin cruise experiences in Orange Beach. 90-minute narrated cruises through back bay waterways and Gulf waters with underwater viewing panels, dolphin watching, wildlife spotting, and sunset cruise options. Family-friendly, educational, and scenic.',
    phone: '(251) 968-4386',
    address_line_1: '28101 Perdido Beach Blvd',
    city: 'Orange Beach',
    state: 'AL',
    zip: '36561',
    price_range: '$$',
    price_from: 30,
    price_unit: 'person',
    duration_text: '90 minutes',
    rating: null,
    outdoor_seating: false,
    good_for_kids: true,
    good_for_groups: true,
    featured: false,
    is_active: true,
    icon: '🐬',
    what_makes_it_different: 'One of the only glass-bottom dolphin cruise experiences in Orange Beach. Underwater viewing panels give guests a closer, more immersive look at marine life than standard sightseeing boats — combining dolphin watching, wildlife spotting, and scenic Gulf Coast views in one 90-minute narrated cruise.',
    known_for: [
      'Glass-bottom viewing panels',
      'Dolphin watching',
      'Scenic narrated cruises',
      'Wildlife spotting',
      'Family-friendly sightseeing',
      'Educational onboard narration',
    ],
    highlights: [
      'Dolphins in Gulf waters and back bay',
      'Marine life through glass-bottom panels',
      'Coastal wildlife',
      'Orange Beach waterways',
      'Sunset views',
      'Gulf Coast scenery',
      'Restrooms onboard',
      'Snacks available',
    ],
    good_for: [
      'Families',
      'Kids',
      'Dolphin photography',
      'Wildlife enthusiasts',
      'Sunset cruise guests',
      'Educational marine-life experiences',
      'Scenic sightseeing',
      'Visitors wanting a unique boat experience',
    ],
    secondary_subtypes: ['sunset_cruise', 'boat_tour', 'wildlife_tour', 'boat_rental'],
    seo_keywords: [
      'Glass Bottom Dolphin Tours',
      'Glass Bottom Dolphin Cruise Orange Beach',
      'Orange Beach Dolphin Cruise',
      'Orange Beach Glass Bottom Boat',
      'Dolphin Watching Orange Beach',
      'Family Activities Orange Beach',
      'Orange Beach Sunset Cruise',
      'Wildlife Tours Orange Beach',
      'Gulf Coast Dolphin Cruise',
      'Orange Beach Water Activities',
    ],
  },

  tags: [
    { tag_name: 'Dolphin Cruise',          tag_category: 'activity' },
    { tag_name: 'Glass Bottom Boat',        tag_category: 'activity' },
    { tag_name: 'Sunset Cruise',            tag_category: 'activity' },
    { tag_name: 'Wildlife Tours',           tag_category: 'activity' },
    { tag_name: 'Sightseeing Cruises',      tag_category: 'activity' },
    { tag_name: 'Family Activities',        tag_category: 'audience' },
    { tag_name: 'Scenic Cruises',           tag_category: 'activity' },
    { tag_name: 'Dolphin Watching',         tag_category: 'activity' },
    { tag_name: 'Orange Beach Activities',  tag_category: 'location' },
    { tag_name: 'Water Activities',         tag_category: 'activity' },
    { tag_name: 'Marine Life Viewing',      tag_category: 'activity' },
    { tag_name: 'Educational Activities',   tag_category: 'experience' },
    { tag_name: 'Boat Tours',               tag_category: 'activity' },
    { tag_name: 'Tourist Attractions',      tag_category: 'audience' },
    { tag_name: 'Vacation Activities',      tag_category: 'audience' },
    { tag_name: 'Good For Kids',            tag_category: 'audience' },
    { tag_name: 'Photography Friendly',     tag_category: 'experience' },
  ],

  // Pricing as menu sections (estimated — not operator-confirmed)
  menu: [
    {
      section_name: 'Cruise Pricing (Estimated)',
      items: [
        {
          item_name: 'Adult Ticket',
          description: 'Approximately $30–40 per adult. Verify with operator before booking.',
          price: 35.00,
        },
        {
          item_name: 'Child Ticket',
          description: 'Approximately $20–30 per child. Verify with operator before booking.',
          price: 25.00,
        },
        {
          item_name: 'Infant',
          description: 'Check directly with operator for infant pricing.',
          price: null,
        },
        {
          item_name: 'Private Charter',
          description: 'Significantly higher — price varies by boat type, group size, and duration. Contact operator directly.',
          price: null,
        },
      ],
    },
    {
      section_name: 'What\'s Included',
      items: [
        { item_name: 'Glass-Bottom Viewing Panels',  description: 'See marine life beneath the boat' },
        { item_name: 'Dolphin Watching',              description: 'Guided dolphin spotting in Gulf waters and back bay' },
        { item_name: 'Narrated Tour',                description: 'Onboard narration throughout the cruise' },
        { item_name: 'Restrooms Onboard',            description: '' },
        { item_name: 'Snacks Available',             description: '' },
        { item_name: 'Approximately 90 Minutes',     description: 'Cruise duration' },
      ],
    },
  ],

  events: [
    {
      event_name: 'Sunset Dolphin Cruise',
      description: 'Evening glass-bottom dolphin cruise with sunset views over the Gulf Coast.',
      day_of_week: 'Daily',
      recurring: true,
      start_time: '18:00',
      is_active: true,
    },
    {
      event_name: 'Glass-Bottom Dolphin Cruise',
      description: '90-minute narrated dolphin watching cruise with glass-bottom viewing panels through Orange Beach waterways.',
      day_of_week: 'Daily',
      recurring: true,
      is_active: true,
    },
  ],
};

async function run() {
  console.log('Uploading Glass Bottom Dolphin Tours...\n');

  const res = await fetch(`${API_BASE}/api/admin/gcr/import-master`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('❌ Failed:', data);
    process.exit(1);
  }

  console.log('✅ Uploaded successfully!');
  console.log('   Slug:', data.slug);
  console.log('   Results:', JSON.stringify(data.results, null, 2));
}

run();
