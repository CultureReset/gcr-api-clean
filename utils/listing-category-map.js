// ⚠️ MIRROR FILE — keep in sync with gcr-unified/src/categoryMap.js
//
// This is a verbatim copy of the frontend's SUBTYPE_TO_CATEGORY map, used so the
// new server-side paginated entities endpoint (GET /api/gcr/entities/paginated)
// can filter by the same listing-page categories (restaurants, things-to-do,
// nightlife, wellness, etc.) that CategoryListings.jsx already uses client-side.
//
// This is intentionally a separate concept from utils/entity-types.js's
// TYPE_TO_PAGE map, which is based on the clean entity_type enum and drives
// primary page assignment elsewhere in this codebase — do not merge them,
// they serve different purposes and aren't interchangeable.
//
// The `subtype_taxonomy` DB table (utils/taxonomy-cache.js) is now the
// canonical source — subtypeToCategory()/subtypesForCategory() check it
// first. This hardcoded map is kept only as a fallback for subtypes that
// haven't been backfilled into the taxonomy table yet, and to keep this
// module usable even if the DB is briefly unreachable. If you add/change a
// category mapping, prefer updating the subtype_taxonomy table (and mirror
// in categoryMap.js) over editing this fallback map.

const { loadTaxonomy } = require('./taxonomy-cache');

const SUBTYPE_TO_CATEGORY = {
  // --- restaurants ---
  restaurant:'restaurants', restaurants:'restaurants',
  american_restaurant:'restaurants', seafood_restaurant:'restaurants', seafood:'restaurants',
  pizza_restaurant:'restaurants', bar:'restaurants', bar_grill:'restaurants',
  bar_and_grill:'restaurants', beach_bar:'restaurants', irish_pub:'restaurants', pub:'restaurants',
  hybrid_venue:'restaurants', casual_dining:'restaurants', southern:'restaurants',
  brunch_restaurant:'restaurants', breakfast_restaurant:'restaurants', steakhouse:'restaurants',
  hamburger_restaurant:'restaurants', sandwich_shop:'restaurants', diner:'restaurants',
  mexican_restaurant:'restaurants', chinese_restaurant:'restaurants', italian_restaurant:'restaurants',
  japanese_restaurant:'restaurants', thai_restaurant:'restaurants', indian_restaurant:'restaurants',
  pizza_delivery:'restaurants', food_truck:'restaurants', fast_food_restaurant:'restaurants',
  burger_restaurant:'restaurants', chicken_restaurant:'restaurants', ramen_restaurant:'restaurants',
  mediterranean_restaurant:'restaurants', greek_restaurant:'restaurants',
  catering:'restaurants',
  steak_house:'restaurants', steakhouse_restaurant:'restaurants',
  barbecue_restaurant:'restaurants', market_restaurant:'restaurants',
  sushi_restaurant:'restaurants', taco_restaurant:'restaurants', tex_mex_restaurant:'restaurants',
  takeout:'restaurants', meal_takeaway:'restaurants', deli:'restaurants', food:'restaurants',
  delivery:'restaurants', cocktail_bar:'restaurants',
  // --- coffee / sweets ---
  coffee_shop:'coffee', cafe:'coffee', bakery:'coffee', ice_cream:'coffee',
  ice_cream_shop:'coffee', donut_shop:'coffee', dessert_shop:'coffee', smoothie:'coffee',
  confectionery:'coffee', juice_shop:'coffee',
  dessert:'coffee', coffee:'coffee',
  // --- shopping ---
  boutique:'shopping', souvenir:'shopping', retail:'shopping', shopping:'shopping',
  surf_shop:'shopping', gift_shop:'shopping', clothing:'shopping', clothing_store:'shopping',
  art_gallery:'shopping', grocery_store:'shopping', liquor_store:'shopping',
  store:'shopping', book_store:'shopping', 'liquor-store':'shopping',
  pet_store:'shopping', gas_station:'shopping', convenience_store:'shopping', 'gas-station':'shopping',
  shopping_mall:'shopping', sporting_goods_store:'shopping', market:'shopping',
  furniture_store:'shopping', home_goods_store:'shopping', hardware_store:'shopping',
  pharmacy:'shopping', department_store:'shopping',
  shoe_store:'shopping', womens_clothing_store:'shopping', jewelry_store:'shopping',
  'jewelry-store':'shopping', thrift_store:'shopping', supermarket:'shopping',
  food_store:'shopping', flea_market:'shopping', cosmetics_store:'shopping',
  sportswear_store:'shopping', bicycle_store:'shopping', garden_center:'shopping',
  'health-food-store':'shopping', 'grocery-store':'shopping', 'clothing-store':'shopping',
  'marine-retail':'shopping', drugstore:'shopping', home_goods:'shopping',
  'mobile-phone-store':'shopping', 'retail-liquor-store':'shopping', 'art-gallery':'shopping',
  seafood_market:'shopping', optician:'shopping', florist:'shopping', florist_shop:'shopping',
  clothing_and_fabric_store:'shopping',
  // --- things-to-do ---
  rentals:'things-to-do', tour_agency:'things-to-do', venue:'things-to-do',
  sports_club:'things-to-do', movie_theater:'things-to-do',
  activity:'things-to-do', activities:'things-to-do',
  parasailing:'things-to-do', dolphin_cruise:'things-to-do', boat_rental:'things-to-do',
  boat_rentals:'things-to-do', fishing_charter:'things-to-do', tour:'things-to-do',
  attraction:'things-to-do', attractions:'things-to-do', tourist_attraction:'things-to-do',
  jet_ski:'things-to-do', watersports:'things-to-do',
  snorkeling:'things-to-do', kayak_rental:'things-to-do', marina:'things-to-do',
  golf_course:'things-to-do', sunset_cruise:'things-to-do', dolphin_tour:'things-to-do',
  glass_bottom_boat:'things-to-do', wildlife_tour:'things-to-do', charter:'things-to-do',
  'amusement-park':'things-to-do', amusement_park:'things-to-do', amusement_center:'things-to-do',
  'charter-fishing':'things-to-do', charter_fishing:'things-to-do',
  'jet-ski-rentals-tours':'things-to-do', 'marina-and-rentals':'things-to-do',
  'things-to-do':'things-to-do', video_arcade:'things-to-do',
  nature_preserve:'things-to-do', wildlife_refuge:'things-to-do',
  hiking:'things-to-do', hiking_area:'things-to-do', swimming_pool:'things-to-do',
  sports_activity_location:'things-to-do', sports_complex:'things-to-do', sports_school:'things-to-do',
  'golf-course':'things-to-do', 'golf-club':'things-to-do', miniature_golf_course:'things-to-do',
  bike_rental:'things-to-do', sailing_charter:'things-to-do', zoo:'things-to-do',
  bowling_alley:'things-to-do', aquarium:'things-to-do', water_park:'things-to-do',
  go_karting_venue:'things-to-do', adventure_sports_center:'things-to-do',
  performing_arts:'things-to-do', performing_arts_theater:'things-to-do', cinema:'things-to-do',
  historical_place:'things-to-do', 'park-facility-rental':'things-to-do', 'tour-operator':'things-to-do',
  boat_launch:'things-to-do', 'tourism-destination':'things-to-do',
  entertainment:'things-to-do', heliport:'things-to-do', fishing_pier:'things-to-do',
  observation_deck:'things-to-do', scenic_spot:'things-to-do', event_venue:'things-to-do', festival:'things-to-do',
  // --- public-spots ---
  historical_landmark:'public-spots', museum:'public-spots',
  park:'public-spots', beach:'public-spots', 'public-spots':'public-spots',
  marina_park:'public-spots', boat_dock:'public-spots',
  state_park:'public-spots', cultural_landmark:'public-spots',
  tourist_information_center:'public-spots', playground:'public-spots',
  beach_access:'public-spots', dog_park:'public-spots',
  attraction_museum_and_historical_site:'public-spots',
  visitor_center:'public-spots', scenic_point:'public-spots',
  // --- nightlife ---
  nightlife:'nightlife', night_club:'nightlife', sports_bar:'nightlife',
  rooftop_bar:'nightlife', lounge:'nightlife', lounge_bar:'nightlife',
  brewery:'nightlife', winery:'nightlife', distillery:'nightlife',
  'live-music-venue':'nightlife', live_music_venue:'nightlife',
  comedy_club:'nightlife', karaoke_bar:'nightlife', vineyard:'nightlife', wine_bar:'nightlife',
  // --- wellness ---
  spa:'wellness', massage:'wellness', massage_spa:'wellness', yoga_studio:'wellness',
  fitness_center:'wellness', gym:'wellness', wellness_center:'wellness',
  hair_salon:'wellness', nail_salon:'wellness', beauty_salon:'wellness',
  barber_shop:'wellness', salon:'wellness', salon_spa:'wellness', 'salon-spa':'wellness',
  skin_care_clinic:'wellness', hair_care:'wellness', 'beauty-wellness':'wellness',
  'spa-wellness':'wellness', 'medical-spa':'wellness', wellness:'wellness', fitness:'wellness',
  'beauty-salon':'wellness',
  // --- services ---
  services:'services', photographer:'services', transportation:'services', concierge:'services',
  service:'services', laundry:'services', car_wash:'services', 'car-wash':'services',
  car_rental:'services', 'car-rental':'services',
  real_estate_agency:'services', 'real-estate':'services', doctor:'services', medical_clinic:'services',
  taxi_service:'services', insurance_agency:'services', bank:'services', atm:'services',
  'financial-services':'services', financial_services:'services',
  catering_service:'services', 'catering-service':'services', consultant:'services', general_contractor:'services',
  educational_institution:'services', health:'services', transportation_service:'services',
  storage:'services', association_or_organization:'services',
  medical_practice:'services', medical:'services', unknown:'services',
  online_gambling:'services', 'online-gambling':'services',
  agency:'services', influencer:'services', parking:'services', parking_lot:'services',
  veterinary:'services', veterinary_care:'services', lawyer:'services', dentist:'services',
  chiropractor:'services', 'cleaning-services':'services', chauffeur_service:'services', car_repair:'services',
  finance:'services', financial:'services', healthcare:'services', pet_care:'services',
  corporate_office:'services', business_center:'services', manufacturer:'services',
  software:'services', 'software-platform':'services', supplier:'services',
  'postal-service':'services', 'government-services':'services', government:'services',
  'municipal-government':'services', local_government_office:'services',
  television_studio:'services', airport:'services', 'military-recreation':'services',
  laundromat:'services', 'real-estate-agent':'services',
  real_estate:'services', community_center:'services', 'apartment-community':'services',
  premise:'services', 'online-gaming':'services', banquet_hall:'services',
  bridge:'services', point_of_interest:'services', 'domain-for-sale':'services',
  travel_agency:'services',
  // --- shopping (additional) ---
  farmers_market:'shopping', cell_phone_store:'shopping', toy_store:'shopping',
  building_materials_store:'shopping',
  // --- staying ---
  hotel:'staying', resort:'staying', condo:'staying', vacation_rental:'staying',
  motel:'staying', bed_and_breakfast:'staying', rv_park:'staying',
  lodging:'staying', 'vacation-home':'staying', vacation_home:'staying',
  'vacation-rental':'staying', condominium_complex:'staying', resort_hotel:'staying',
  cabin:'staying', cottage:'staying', inn:'staying', lodge:'staying',
  campground:'staying', rv_resort:'staying', extended_stay_hotel:'staying',
  guest_house:'staying', apartment_complex:'staying', apartment_building:'staying',
  'condominium-association':'staying', 'vacation-rentals':'staying', 'vacation-rental-resort':'staying',
  'vacation-rental-marketplace':'staying', 'hotel-chain':'staying',
};

const LODGING_TYPES = new Set(['hotel', 'condo', 'motel', 'lodging', 'resort', 'cabin', 'cottage', 'inn', 'lodge']);

async function subtypeToCategory(entity) {
  const sub = (entity.entity_subtype || '').toLowerCase();
  const type = (entity.entity_type || '').toLowerCase();
  const subUnder = sub.replace(/-/g, '_');
  if (LODGING_TYPES.has(type)) return 'staying';
  const { bySubtype } = await loadTaxonomy();
  return bySubtype[subUnder] || bySubtype[sub]
    || SUBTYPE_TO_CATEGORY[sub] || SUBTYPE_TO_CATEGORY[subUnder] || SUBTYPE_TO_CATEGORY[type] || null;
}

// All subtype keys belonging to a given listing-page category — used to build
// a SQL .in() filter instead of fetching everything and filtering in JS.
// Merges the taxonomy table (canonical) with the hardcoded map (fallback,
// covers any subtype not yet backfilled into subtype_taxonomy).
async function subtypesForCategory(category) {
  const { byCategory } = await loadTaxonomy();
  const fromTaxonomy = byCategory[category] || [];
  const fromFallback = Object.keys(SUBTYPE_TO_CATEGORY).filter(k => SUBTYPE_TO_CATEGORY[k] === category);
  return [...new Set([...fromTaxonomy, ...fromFallback])];
}

module.exports = { SUBTYPE_TO_CATEGORY, LODGING_TYPES, subtypeToCategory, subtypesForCategory };
