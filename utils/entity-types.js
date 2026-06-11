// Valid entity_type values — primary page assignment
const VALID_ENTITY_TYPES = [
  'restaurant',      // Restaurants page
  'coffee',          // Coffee & Sweets page
  'dessert',         // Coffee & Sweets page
  'bakery',          // Coffee & Sweets page
  'activity',        // Things To Do page
  'service',         // Services page
  'shopping',        // Shopping page
  'hotel',           // Staying page
  'condo',           // Staying page
  'vacation-rental', // Staying page
  'park',            // Public Spots page
];

// Which page each entity_type appears on (primary)
const TYPE_TO_PAGE = {
  'restaurant':      'restaurants',
  'coffee':          'coffee-sweets',
  'dessert':         'coffee-sweets',
  'bakery':          'coffee-sweets',
  'activity':        'things-to-do',
  'service':         'services',
  'shopping':        'shopping',
  'hotel':           'staying',
  'condo':           'staying',
  'vacation-rental': 'staying',
  'park':            'public-spots',
};

// Common subtypes per type — used for filtering within a page
const SUBTYPES = {
  'restaurant':      ['seafood', 'bar-grill', 'pizza', 'mexican', 'american', 'italian', 'sushi', 'burger', 'wings', 'breakfast', 'southern', 'bbq', 'steakhouse', 'sports-bar', 'fine-dining', 'casual'],
  'coffee':          ['coffee-shop', 'cafe', 'juice-bar', 'smoothie'],
  'dessert':         ['ice-cream', 'candy', 'gelato', 'frozen-yogurt'],
  'bakery':          ['bakery', 'donuts', 'pastry'],
  'activity':        ['boat-tour', 'dolphin-tour', 'fishing', 'parasailing', 'kayak', 'paddleboard', 'jet-ski', 'water-sports', 'mini-golf', 'escape-room', 'axe-throwing', 'go-kart', 'amusement', 'attraction', 'museum', 'state-park'],
  'service':         ['salon', 'spa', 'surf-lessons', 'photography', 'real-estate', 'medical', 'rental', 'auto', 'cleaning'],
  'shopping':        ['boutique', 'gift-shop', 'surf-shop', 'souvenir', 'clothing', 'jewelry', 'art-gallery', 'grocery', 'pharmacy'],
  'hotel':           ['resort', 'beachfront', 'boutique-hotel', 'motel', 'inn'],
  'condo':           ['beachfront-condo', 'gulf-view', 'bay-view'],
  'vacation-rental': ['beach-house', 'beach-cottage', 'gulf-front'],
  'park':            ['beach', 'state-park', 'pier', 'nature-trail', 'boat-launch', 'public-beach-access'],
};

// Examples of businesses that legitimately appear on multiple pages:
//   entity_type: 'restaurant', also_appears_on: ['things-to-do']
//   entity_type: 'activity',   also_appears_on: ['restaurant']  (e.g. dinner cruise)
//   entity_type: 'shopping',   also_appears_on: ['coffee-sweets'] (e.g. gift shop with cafe)
//   entity_type: 'park',       also_appears_on: ['things-to-do']
const VALID_PAGES = [
  'restaurants',
  'coffee-sweets',
  'things-to-do',
  'services',
  'shopping',
  'staying',
  'public-spots',
];

function validateEntityType(type) {
  if (!type) return { valid: false, error: 'entity_type is required' };
  if (!VALID_ENTITY_TYPES.includes(type)) {
    return {
      valid: false,
      error: `Invalid entity_type "${type}". Must be one of: ${VALID_ENTITY_TYPES.join(', ')}`,
    };
  }
  return { valid: true };
}

function validateAlsoAppearsOn(pages) {
  if (!pages || !Array.isArray(pages)) return { valid: true };
  const bad = pages.filter(p => !VALID_PAGES.includes(p));
  if (bad.length) {
    return {
      valid: false,
      error: `Invalid page(s) in also_appears_on: ${bad.join(', ')}. Must be one of: ${VALID_PAGES.join(', ')}`,
    };
  }
  return { valid: true };
}

module.exports = { VALID_ENTITY_TYPES, VALID_PAGES, TYPE_TO_PAGE, SUBTYPES, validateEntityType, validateAlsoAppearsOn };
