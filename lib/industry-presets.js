// lib/industry-presets.js
// Server-side twin of cybercheck-login/js/industry-map.js — bridges the three
// type vocabularies (entity.entity_type/subtype → dashboard preset id →
// module_catalog keys in entity_modules). Used by module auto-provisioning
// and the guided setup flow.

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
}

// entity_type/subtype → apps/_presets.json preset id
function presetIdFor(entityType, entitySubtype) {
  const t = norm(entityType);
  const sub = norm(entitySubtype);

  if (['restaurant', 'coffee', 'dessert', 'bakery', 'bar', 'cafe', 'food_truck'].includes(t)) return 'restaurant';
  if (['hotel', 'condo', 'vacation_rental'].includes(t)) return 'lodging';
  if (t === 'shopping' || t === 'retail') return 'shopping';
  if (t === 'park') return 'park';
  if (t === 'activity') {
    if (/boat_rental|jet_?ski|kayak|paddle|bike|golf_cart|scooter/.test(sub)) return 'rental';
    return 'charter'; // charters, dolphin cruises, tours, parasail, excursions
  }
  if (t === 'service') {
    if (/salon|barber|hair|nail|spa|massage|wellness/.test(sub)) return 'salon';
    if (/photo/.test(sub)) return 'photographer';
    if (/gym|fitness|yoga|pilates|class/.test(sub)) return 'fitness';
    if (/artist|musician|band|dj/.test(sub)) return 'creator';
    return 'service';
  }
  return 'blank';
}

// module_catalog keys every entity gets regardless of industry (matches the
// live distribution: 2,856 entities already carry these)
const CORE_MODULE_KEYS = ['core', 'hours', 'gallery', 'reviews', 'faqs', 'policies', 'team', 'announcements', 'blog'];

// preset id → industry-specific module_catalog keys (the entity_modules
// vocabulary — NOT the dashboard app ids; those install via /api/platform/state)
const MODULE_KEYS_BY_PRESET = {
  restaurant: ['menu', 'drinks', 'happy_hour', 'specials', 'events', 'booking', 'loyalty'],
  charter: ['activity', 'pricing', 'schedule', 'booking', 'services'],
  rental: ['activity', 'pricing', 'booking', 'services'],
  lodging: ['stay', 'rooms', 'amenities', 'pricing', 'booking'],
  salon: ['services', 'pricing', 'schedule', 'booking', 'loyalty'],
  photographer: ['services', 'pricing', 'booking'],
  fitness: ['services', 'schedule', 'booking'],
  creator: ['events', 'services'],
  service: ['services', 'pricing', 'booking'],
  shopping: ['shop', 'specials', 'events'],
  park: ['park', 'events'],
  blank: [],
};

function moduleKeysFor(entityType, entitySubtype) {
  const preset = presetIdFor(entityType, entitySubtype);
  return { preset, keys: [...CORE_MODULE_KEYS, ...(MODULE_KEYS_BY_PRESET[preset] || [])] };
}

module.exports = { presetIdFor, moduleKeysFor, CORE_MODULE_KEYS, MODULE_KEYS_BY_PRESET };
