// ============================================================
// PER-TYPE CONFIGURATION
// Controls: listing card display, profile sections, upload auto-creation
// ============================================================

// What shows on the listing card for each entity_type
const CARD_FIELDS = {
  restaurant:        ['entity_subtype', 'price_range', 'hours', 'hh_days', 'outdoor_seating', 'live_music'],
  coffee:            ['entity_subtype', 'hours'],
  dessert:           ['entity_subtype', 'hours'],
  bakery:            ['entity_subtype', 'hours'],
  activity:          ['entity_subtype', 'price_from', 'price_unit', 'duration_label', 'capacity_min', 'capacity_max', 'good_for', 'booking_url'],
  service:           ['entity_subtype', 'price_from', 'price_unit', 'booking_url'],
  shopping:          ['entity_subtype', 'hours'],
  hotel:             ['price_from', 'price_unit', 'sleeps_max', 'pet_friendly', 'pool', 'booking_url'],
  condo:             ['price_from', 'price_unit', 'bedrooms_min', 'sleeps_max', 'pet_friendly', 'pool', 'booking_url'],
  'vacation-rental': ['price_from', 'price_unit', 'bedrooms_min', 'sleeps_max', 'pet_friendly', 'pool', 'booking_url'],
  park:              ['entity_subtype', 'hours', 'good_for'],
};

// Standard sections auto-created on upload for each type.
// Each entry: { section_type, section_name, required: bool }
// required=true  → always created even if no data
// required=false → only created if matching data exists in the upload payload
const SECTION_TEMPLATES = {
  restaurant: [
    { section_type: 'menu_food',    section_name: 'Menu',        required: false },
    { section_type: 'menu_drinks',  section_name: 'Drinks',      required: false },
    { section_type: 'happy_hour',   section_name: 'Happy Hour',  required: false },
    { section_type: 'specials',     section_name: 'Specials',    required: false },
  ],
  coffee: [
    { section_type: 'menu_food',    section_name: 'Menu',        required: false },
    { section_type: 'menu_drinks',  section_name: 'Drinks',      required: false },
  ],
  dessert: [
    { section_type: 'menu_food',    section_name: 'Menu',        required: false },
  ],
  bakery: [
    { section_type: 'menu_food',    section_name: 'Menu',        required: false },
  ],
  activity: [
    { section_type: 'tour_options',    section_name: 'Options & Pricing', required: true  },
    { section_type: 'whats_included',  section_name: "What's Included",   required: false },
    { section_type: 'highlights',      section_name: 'Highlights',        required: false },
    { section_type: 'policies',        section_name: 'Policies',          required: false },
    { section_type: 'faq',             section_name: 'FAQ',               required: false },
  ],
  service: [
    { section_type: 'packages',     section_name: 'Services & Pricing', required: true  },
    { section_type: 'faq',          section_name: 'FAQ',                required: false },
    { section_type: 'service_areas', section_name: 'Service Areas',     required: false },
  ],
  shopping: [
    { section_type: 'product_categories', section_name: 'What We Carry', required: false },
  ],
  hotel: [
    { section_type: 'room_types',   section_name: 'Rooms & Rates',  required: true  },
    { section_type: 'amenities',    section_name: 'Amenities',       required: true  },
    { section_type: 'policies',     section_name: 'Policies',        required: false },
  ],
  condo: [
    { section_type: 'room_types',   section_name: 'Units & Rates',   required: true  },
    { section_type: 'amenities',    section_name: 'Amenities',       required: true  },
    { section_type: 'policies',     section_name: 'Policies',        required: false },
  ],
  'vacation-rental': [
    { section_type: 'room_types',   section_name: 'Property & Rates', required: true  },
    { section_type: 'amenities',    section_name: 'Amenities',        required: true  },
    { section_type: 'policies',     section_name: 'Policies',         required: false },
  ],
  park: [
    { section_type: 'highlights',   section_name: 'Highlights',      required: false },
    { section_type: 'policies',     section_name: 'Rules & Policies', required: false },
  ],
};

// How upload payload keys map to section_types.
// If the upload data contains any of these keys with content,
// the matching section is auto-created even if not in SECTION_TEMPLATES.
const PAYLOAD_KEY_TO_SECTION = {
  menu_items:        { section_type: 'menu_food',           section_name: 'Menu' },
  menu:              { section_type: 'menu_food',           section_name: 'Menu' },
  food_items:        { section_type: 'menu_food',           section_name: 'Menu' },
  drink_items:       { section_type: 'menu_drinks',         section_name: 'Drinks' },
  drinks:            { section_type: 'menu_drinks',         section_name: 'Drinks' },
  happy_hour_items:  { section_type: 'happy_hour',          section_name: 'Happy Hour' },
  happy_hour:        { section_type: 'happy_hour',          section_name: 'Happy Hour' },
  specials:          { section_type: 'specials',            section_name: 'Specials' },
  tour_options:      { section_type: 'tour_options',        section_name: 'Options & Pricing' },
  pricing:           { section_type: 'tour_options',        section_name: 'Options & Pricing' },
  packages:          { section_type: 'packages',            section_name: 'Services & Pricing' },
  whats_included:    { section_type: 'whats_included',      section_name: "What's Included" },
  included:          { section_type: 'whats_included',      section_name: "What's Included" },
  highlights:        { section_type: 'highlights',          section_name: 'Highlights' },
  policies:          { section_type: 'policies',            section_name: 'Policies' },
  rules:             { section_type: 'policies',            section_name: 'Rules & Policies' },
  faq:               { section_type: 'faq',                 section_name: 'FAQ' },
  faqs:              { section_type: 'faq',                 section_name: 'FAQ' },
  room_types:        { section_type: 'room_types',          section_name: 'Rooms & Rates' },
  rooms:             { section_type: 'room_types',          section_name: 'Rooms & Rates' },
  amenities:         { section_type: 'amenities',           section_name: 'Amenities' },
  product_categories:{ section_type: 'product_categories',  section_name: 'What We Carry' },
  products:          { section_type: 'product_categories',  section_name: 'What We Carry' },
  service_areas:     { section_type: 'service_areas',       section_name: 'Service Areas' },
  rental_fleet:      { section_type: 'rental_fleet',        section_name: 'Our Fleet' },
  boat_types:        { section_type: 'rental_fleet',        section_name: 'Our Fleet' },
};

// How section_type renders on the frontend
// known = specific component; unknown types fall back to 'generic_list'
const SECTION_RENDER_TYPE = {
  menu_food:          'menu_grid',       // image + name + price grid
  menu_drinks:        'menu_grid',
  happy_hour:         'price_list',      // name + price + original price
  specials:           'specials_list',   // badge + description + days/time
  tour_options:       'price_table',     // name + duration + capacity + price per unit
  whats_included:     'checklist',       // icon + text rows
  highlights:         'bullet_list',     // simple bullet list
  policies:           'text_list',       // plain text rows
  faq:                'accordion',       // expand/collapse Q&A
  packages:           'price_table',
  service_areas:      'tag_cloud',
  room_types:         'price_table',
  amenities:          'icon_grid',       // icon + label grid
  product_categories: 'tag_cloud',
  rental_fleet:       'price_table',
};

function getRenderType(section_type) {
  return SECTION_RENDER_TYPE[section_type] || 'generic_list';
}

// Given an entity_type + upload payload, return the full list of sections to create.
// Merges: required templates + data-detected sections + any unknown keys as custom sections
function resolveSectionsForUpload(entityType, payload = {}) {
  const templates = SECTION_TEMPLATES[entityType] || [];
  const resolved = new Map(); // section_type → { section_type, section_name, items, sort_order }

  // Step 1: add required template sections regardless of payload
  templates
    .filter(t => t.required)
    .forEach((t, i) => {
      resolved.set(t.section_type, { ...t, items: [], sort_order: i });
    });

  // Step 2: add template sections that have matching data in payload
  templates
    .filter(t => !t.required)
    .forEach((t, i) => {
      const data = findPayloadDataForSection(t.section_type, payload);
      if (data && data.length > 0) {
        resolved.set(t.section_type, { ...t, items: data, sort_order: templates.indexOf(t) });
      }
    });

  // Step 3: scan payload for any keys that map to a section (catches extra data)
  Object.entries(PAYLOAD_KEY_TO_SECTION).forEach(([key, sectionDef]) => {
    if (payload[key] && Array.isArray(payload[key]) && payload[key].length > 0) {
      if (!resolved.has(sectionDef.section_type)) {
        resolved.set(sectionDef.section_type, {
          ...sectionDef,
          items: payload[key],
          sort_order: resolved.size,
        });
      } else {
        // merge items into existing section
        const existing = resolved.get(sectionDef.section_type);
        if (!existing.items.length) existing.items = payload[key];
      }
    }
  });

  // Step 4: any remaining array keys in payload not covered above → custom section
  const coveredKeys = new Set(Object.keys(PAYLOAD_KEY_TO_SECTION));
  const coreFields = new Set(['entity', 'tags', 'hours', 'photos', 'events', 'specials']);
  Object.entries(payload).forEach(([key, val]) => {
    if (!coveredKeys.has(key) && !coreFields.has(key) && Array.isArray(val) && val.length > 0) {
      const section_type = `custom_${key}`;
      const section_name = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      resolved.set(section_type, {
        section_type,
        section_name,
        items: val,
        sort_order: resolved.size,
      });
    }
  });

  return [...resolved.values()];
}

// Find items in the payload that belong to a given section_type
function findPayloadDataForSection(section_type, payload) {
  const matchingKeys = Object.entries(PAYLOAD_KEY_TO_SECTION)
    .filter(([, def]) => def.section_type === section_type)
    .map(([key]) => key);

  for (const key of matchingKeys) {
    if (payload[key] && Array.isArray(payload[key]) && payload[key].length > 0) {
      return payload[key];
    }
  }
  return [];
}

module.exports = {
  CARD_FIELDS,
  SECTION_TEMPLATES,
  PAYLOAD_KEY_TO_SECTION,
  SECTION_RENDER_TYPE,
  getRenderType,
  resolveSectionsForUpload,
};
