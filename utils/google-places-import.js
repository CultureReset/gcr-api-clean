// Converts a Google Places API response into a GCR entity upload payload
// Works with both Places API v1 (new) and Places API (legacy)

const { VALID_ENTITY_TYPES } = require('./entity-types');

// Maps Google primary_type → GCR entity_type
const GOOGLE_TYPE_MAP = {
  // Restaurants
  restaurant:               'restaurant',
  food:                     'restaurant',
  meal_delivery:            'restaurant',
  meal_takeaway:            'restaurant',
  bar:                      'restaurant',
  night_club:               'restaurant',
  bakery:                   'bakery',
  cafe:                     'coffee',
  coffee_shop:              'coffee',
  ice_cream_shop:           'dessert',
  dessert_shop:             'dessert',
  sandwich_shop:            'restaurant',
  pizza_restaurant:         'restaurant',
  seafood_restaurant:       'restaurant',
  steak_house:              'restaurant',
  sushi_restaurant:         'restaurant',
  mexican_restaurant:       'restaurant',
  american_restaurant:      'restaurant',
  bbq_restaurant:           'restaurant',
  breakfast_restaurant:     'restaurant',
  brunch_restaurant:        'restaurant',
  fast_food_restaurant:     'restaurant',
  hamburger_restaurant:     'restaurant',

  // Things To Do
  tourist_attraction:       'activity',
  amusement_park:           'activity',
  aquarium:                 'activity',
  bowling_alley:            'activity',
  casino:                   'activity',
  golf_course:              'activity',
  mini_golf:                'activity',
  marina:                   'activity',
  boat_rental:              'activity',
  fishing_charter:          'activity',
  water_park:               'activity',
  escape_room:              'activity',
  go_kart_track:            'activity',
  axe_throwing:             'activity',
  zip_line:                 'activity',
  kayak_rental:             'activity',
  parasailing:              'activity',
  scuba_diving:             'activity',
  surfing:                  'activity',
  museum:                   'activity',
  art_gallery:              'activity',
  movie_theater:            'activity',

  // Staying
  hotel:                    'hotel',
  motel:                    'hotel',
  resort_hotel:             'hotel',
  extended_stay_hotel:      'hotel',
  bed_and_breakfast:        'hotel',
  inn:                      'hotel',
  lodging:                  'hotel',
  campground:               'hotel',
  rv_park:                  'hotel',

  // Services
  beauty_salon:             'service',
  hair_salon:               'service',
  nail_salon:               'service',
  spa:                      'service',
  gym:                      'service',
  fitness_center:           'service',
  laundry:                  'service',
  car_rental:               'service',
  car_wash:                 'service',
  surf_school:              'service',

  // Shopping
  clothing_store:           'shopping',
  shoe_store:               'shopping',
  jewelry_store:            'shopping',
  gift_shop:                'shopping',
  souvenir_store:           'shopping',
  grocery_store:            'shopping',
  convenience_store:        'shopping',
  liquor_store:             'shopping',
  book_store:               'shopping',
  sporting_goods_store:     'shopping',
  surf_shop:                'shopping',
  department_store:         'shopping',
  shopping_mall:            'shopping',

  // Public Spots
  park:                     'park',
  beach:                    'park',
  national_park:            'park',
  state_park:               'park',
  pier:                     'park',
  boat_launch:              'park',
  nature_reserve:           'park',
  playground:               'park',
  public_beach:             'park',
};

function googleTypeToGcr(googleTypes = []) {
  for (const t of googleTypes) {
    const mapped = GOOGLE_TYPE_MAP[t];
    if (mapped && VALID_ENTITY_TYPES.includes(mapped)) return mapped;
  }
  return null; // unknown — needs manual categorization
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Convert Google Places API response → GCR upload payload
function googlePlaceToEntity(place) {
  const types = place.types || place.primaryTypeDisplayName?.text ? [place.primaryType, ...(place.types || [])] : (place.types || []);
  const entityType = googleTypeToGcr(types);

  // Build slug from name + city to avoid collisions
  const city = place.addressComponents?.find(c => c.types?.includes('locality'))?.longText || '';
  const slug = slugify(`${place.displayName?.text || place.name} ${city}`).slice(0, 80);

  // Extract address parts
  const addressComponents = place.addressComponents || [];
  const getComponent = (type) => addressComponents.find(c => c.types?.includes(type))?.longText || '';

  // Build hours array if available
  const hours = [];
  if (place.regularOpeningHours?.periods) {
    const dayMap = {};
    for (const period of place.regularOpeningHours.periods) {
      const day = period.open?.day ?? null;
      if (day === null) continue;
      dayMap[day] = {
        entity_slug: slug,
        day_of_week: day,
        opens_at: period.open ? `${String(period.open.hour).padStart(2,'0')}:${String(period.open.minute||0).padStart(2,'0')}` : null,
        closes_at: period.close ? `${String(period.close.hour).padStart(2,'0')}:${String(period.close.minute||0).padStart(2,'0')}` : null,
        is_closed: false,
      };
    }
    hours.push(...Object.values(dayMap));
  }

  // Build photos array (Google photo references — need separate fetch for actual URLs)
  const photos = (place.photos || []).slice(0, 20).map((p, i) => ({
    url: p.googleMapsUri || p.name || '',
    google_photo_ref: p.name || null,
    is_cover: i === 0,
    sort_order: i,
    caption: p.authorAttributions?.[0]?.displayName || null,
  }));

  const entity = {
    slug,
    name: place.displayName?.text || place.name,
    entity_type: entityType,
    entity_subtype: place.primaryType || null,
    description: place.editorialSummary?.text || place.generativeSummary?.overview?.text || null,
    phone: place.nationalPhoneNumber || place.formattedPhoneNumber || null,
    international_phone: place.internationalPhoneNumber || null,
    website_url: place.websiteUri || place.website || null,
    address_line_1: getComponent('route') ? `${getComponent('street_number')} ${getComponent('route')}`.trim() : place.formattedAddress || null,
    city: getComponent('locality') || getComponent('sublocality') || null,
    state: getComponent('administrative_area_level_1') || null,
    zip: getComponent('postal_code') || null,
    formatted_address: place.formattedAddress || null,
    latitude: place.location?.latitude || null,
    longitude: place.location?.longitude || null,
    rating: place.rating || null,
    review_count: place.userRatingCount || place.user_ratings_total || 0,
    price_range: place.priceLevel ? '$'.repeat(place.priceLevel) : null,
    google_place_id: place.id || place.place_id || null,
    google_maps_uri: place.googleMapsUri || null,
    business_status: place.businessStatus || 'OPERATIONAL',
    primary_type: place.primaryType || null,
    plus_code: place.plusCode?.globalCode || null,
    editorial_summary: place.editorialSummary?.text || null,

    // Accessibility
    wheelchair_accessible_entrance: place.accessibilityOptions?.wheelchairAccessibleEntrance ?? null,
    wheelchair_accessible_parking: place.accessibilityOptions?.wheelchairAccessibleParking ?? null,
    wheelchair_accessible_restroom: place.accessibilityOptions?.wheelchairAccessibleRestroom ?? null,
    wheelchair_accessible_seating: place.accessibilityOptions?.wheelchairAccessibleSeating ?? null,

    // Payment
    accepts_credit_cards: place.paymentOptions?.acceptsCreditCards ?? null,
    accepts_debit_cards: place.paymentOptions?.acceptsDebitCards ?? null,
    accepts_nfc: place.paymentOptions?.acceptsNfc ?? null,
    accepts_cash_only: place.paymentOptions?.acceptsCashOnly ?? null,

    // Parking
    parking_type: place.parkingOptions ? Object.entries(place.parkingOptions).find(([,v]) => v)?.[0]?.replace('free','free').replace('paid','paid') || null : null,

    // Restaurant-specific
    serves_breakfast: place.servesBrunch || place.servesBreakfast || false,
    serves_brunch: place.servesBrunch || false,
    serves_lunch: place.servesLunch || false,
    serves_dinner: place.servesDinner || false,
    dine_in: place.dineIn ?? true,
    takeout: place.takeout ?? false,
    delivery: place.delivery ?? false,
    serves_beer: place.servesBeer ?? false,
    serves_wine: place.servesWine ?? false,
    serves_cocktails: place.servesCocktails ?? false,
    outdoor_seating: place.outdoorSeating ?? false,
    reservable: place.reservable ?? false,
    live_music: place.liveMusic ?? false,
    good_for_groups: place.goodForGroups ?? false,
    good_for_kids: place.goodForChildren ?? false,

    // Raw data preserved — nothing lost
    google_places_data: place,

    is_active: place.businessStatus !== 'CLOSED_PERMANENTLY',
  };

  return {
    entity,
    hours,
    photos: photos.filter(p => p.url),
  };
}

// Convert array of Google Places results
function googlePlacesToEntities(places) {
  return places.map(p => {
    try {
      return googlePlaceToEntity(p);
    } catch (err) {
      return { error: err.message, place_id: p.id || p.place_id, name: p.displayName?.text || p.name };
    }
  });
}

module.exports = { googlePlaceToEntity, googlePlacesToEntities, googleTypeToGcr, slugify };
