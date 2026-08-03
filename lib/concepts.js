/**
 * Concept extraction — what a place actually offers.
 *
 * entity_subtype and entity_tags describe what a business *is*. They routinely
 * miss what it *sells*, and what it sells is usually the thing a visitor is
 * shopping for. A business subtyped `travel_agency` with an offer named
 * "Fort Morgan Parasailing & Banana Boat Experience" is a parasailing trip; no
 * tag on that row says so.
 *
 * Measured lift over subtype+tags alone, on live data:
 *
 *   pontoon      5 →  28   (5.6x)
 *   paddleboard  1 →   6
 *   dolphin     57 →  84   (+47%)
 *   jet ski     21 →  28   (+33%)
 *   kayak       38 →  50   (+32%)
 *   golf        60 →  73   (+22%)
 *
 * Fishing charters barely move (195 → 198) because they were already tagged
 * well. The detail tables matter most precisely where the tags are thinnest.
 *
 * This emits canonical tokens that match the keys in gcr-unified's
 * src/lib/facets.js vocabulary, so a concept found here lands in the same row
 * as one found via a tag. Keep the two in step when adding concepts.
 */

// offer_type is a classification in its own right, but only where the type is
// specific enough to mean one thing.
//
// Deliberately absent: `rental`, `service` and `activity`. They looked like the
// best signal here — `rental` alone covers 888 entities — but they're catch-all
// buckets. Mapping `rental` to a token swept parking spaces ("132 Gulf Ct
// Parking"), bare street addresses and boat slips into the beach-gear row.
// What discriminates within those types is the offer *name*, which the keyword
// pass below reads. `service` and `activity` are stopwords downstream anyway.
const OFFER_TYPE_TOKENS = {
  charter: 'fishingcharter',
  fishing_charter: 'fishingcharter',
  // Named boats sold as trips — "Outcast 8-Hour Bottom Fishing", "Southern Star".
  trip: 'fishingcharter',
  room: 'lodging',
  happy_hour_item: 'happyhour',
  admission: 'attraction',
  attraction: 'attraction',
  ticket: 'attraction',
};

// Phrase → canonical token. Matched as substrings against lowercased offer
// names and descriptions, so "Hourly Jet Ski Rentals departing from Happy
// Harbor Marina" yields jetski (and rentals, from its offer_type).
const KEYWORDS = [
  // On the water
  ['parasail',            'parasail'],
  ['para sail',           'parasail'],
  ['jet ski',             'jetski'],
  ['jetski',              'jetski'],
  ['waverunner',          'jetski'],
  ['wave runner',         'jetski'],
  ['kayak',               'kayak'],
  ['paddle board',        'paddleboard'],
  ['paddleboard',         'paddleboard'],
  ['stand up paddle',     'paddleboard'],
  ['canoe',               'canoe'],
  ['pontoon',             'pontoon'],
  ['tritoon',             'pontoon'],
  ['boat rental',         'boatrental'],
  ['banana boat',         'watersport'],
  ['snorkel',             'watersport'],
  ['scuba',               'watersport'],
  ['dolphin',             'dolphin'],
  ['sunset cruise',       'sunsetcruise'],
  ['sunset sail',         'sailing'],
  ['sailing',             'sailing'],
  ['catamaran',           'sailing'],
  ['glass bottom',        'boattour'],
  ['boat tour',           'boattour'],
  ['fishing charter',     'fishingcharter'],
  ['charter fishing',     'fishingcharter'],
  ['deep sea fishing',    'fishingcharter'],
  ['offshore fishing',    'fishingcharter'],
  ['inshore fishing',     'fishingcharter'],
  ['bottom fishing',      'fishingcharter'],
  ['boat slip',           'marina'],
  ['wet slip',            'marina'],
  ['multi-day slip',      'marina'],

  // Land activities
  ['helicopter',          'helicopter'],
  ['parasail',            'parasail'],
  ['golf',                'golf'],
  ['mini golf',           'minigolf'],
  ['laser tag',           'amusement'],
  ['ferris wheel',        'amusement'],
  ['go kart',             'amusement'],
  ['zip line',            'amusement'],
  ['escape room',         'amusement'],
  ['museum',              'museum'],
  ['aquarium',            'aquarium'],
  ['waterpark',           'waterpark'],
  ['water park',          'waterpark'],

  // Gear & getting around
  ['beach chair',         'beachrental'],
  ['beach umbrella',      'beachrental'],
  ['beach equipment',     'beachrental'],
  ['beach vacation equipment', 'beachrental'],
  ['bike rental',         'bikerental'],
  ['bicycle rental',      'bikerental'],
  ['golf cart',           'golfcartrental'],
  ['shuttle',             'shuttle'],
  ['airport transfer',    'shuttle'],
  ['limo',                'limo'],

  // Personal services
  ['massage',             'massage'],
  ['facial',              'spa'],
  ['body scrub',          'spa'],
  ['manicure',            'nailsalon'],
  ['pedicure',            'nailsalon'],
  ['haircut',             'hairsalon'],
  ['coloring & styling',  'hairsalon'],
  ['blowout',             'hairsalon'],
  ['photography',         'photographer'],
  ['photo session',       'photographer'],
  ['portrait',            'photographer'],

  // Food — menu item names classify cuisine far more reliably than a subtype
  // of "restaurant", which is what 42% of them carry.
  ['shrimp',              'seafood'],
  ['oyster',              'seafood'],
  ['grouper',             'seafood'],
  ['snapper',             'seafood'],
  ['crab',                'seafood'],
  ['lobster',             'seafood'],
  ['mahi',                'seafood'],
  ['fish taco',           'seafood'],
  ['fish sandwich',       'seafood'],
  ['fresh catch',         'seafood'],
  ['seafood',             'seafood'],
  ['pizza',               'pizza'],
  ['burger',              'burger'],
  ['taco',                'mexican'],
  ['burrito',             'mexican'],
  ['quesadilla',          'mexican'],
  ['enchilada',           'mexican'],
  ['sushi',               'sushi'],
  ['sashimi',             'sushi'],
  ['ramen',               'asian'],
  ['pad thai',            'asian'],
  ['lo mein',             'asian'],
  ['barbecue',            'bbq'],
  ['bbq',                 'bbq'],
  ['brisket',             'bbq'],
  ['pulled pork',         'bbq'],
  ['gumbo',               'southern'],
  ['jambalaya',           'southern'],
  ['po boy',              'southern'],
  ['grits',               'southern'],
  ['pancake',             'breakfast'],
  ['omelet',              'breakfast'],
  ['french toast',        'breakfast'],
  ['biscuit',             'breakfast'],
  ['bagel',               'breakfast'],
  ['eggs benedict',       'brunch'],
  ['mimosa',              'brunch'],
  ['steak',               'steakhouse'],
  ['ribeye',              'steakhouse'],
  ['filet mignon',        'steakhouse'],
  ['wings',               'wings'],
  ['ice cream',           'icecream'],
  ['gelato',              'icecream'],
  ['cupcake',             'dessert'],
  ['cheesecake',          'dessert'],
  ['espresso',            'coffee'],
  ['latte',               'coffee'],
  ['cappuccino',          'coffee'],
  ['draft beer',          'beer'],
  ['ipa',                 'beer'],
  ['margarita',           'cocktails'],
  ['daiquiri',            'cocktails'],
  ['cabernet',            'wine'],
  ['pinot noir',          'wine'],
  ['chardonnay',          'wine'],
];

// Scanning every menu item of a 500-item menu adds nothing over the first
// several dozen — the cuisine signal saturates almost immediately — and this
// runs on every listing-page request.
const MAX_OFFERS_PER_ENTITY = 60;

/**
 * @param {Array} offers rows of { entity_slug, name, description, offer_type }
 * @returns {Object} entity_slug → string[] of canonical concept tokens
 */
function conceptsFromOffers(offers) {
  const byEntity = new Map();

  for (const o of offers || []) {
    const slug = o.entity_slug;
    if (!slug) continue;
    let bucket = byEntity.get(slug);
    if (!bucket) { bucket = { set: new Set(), seen: 0 }; byEntity.set(slug, bucket); }
    if (bucket.seen >= MAX_OFFERS_PER_ENTITY) continue;
    bucket.seen++;

    const typeToken = OFFER_TYPE_TOKENS[o.offer_type];
    if (typeToken) bucket.set.add(typeToken);

    const haystack = `${o.name || ''} ${o.description || ''}`.toLowerCase();
    if (!haystack.trim()) continue;
    for (const [phrase, token] of KEYWORDS) {
      if (haystack.includes(phrase)) bucket.set.add(token);
    }
  }

  const out = {};
  for (const [slug, bucket] of byEntity) {
    // Most `rental` rows are parking spaces and bare addresses that match no
    // keyword. Skip them rather than shipping an empty array per entity.
    if (bucket.set.size) out[slug] = Array.from(bucket.set);
  }
  return out;
}

module.exports = { conceptsFromOffers, KEYWORDS, OFFER_TYPE_TOKENS };
