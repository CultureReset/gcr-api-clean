// ============================================================
// INDUSTRY BLUEPRINTS — what each kind of business would store
// ============================================================
//
// The question this answers: if you rebuilt Airbnb, or FareHarbor, or Peek
// Pro from scratch, what would a listing actually hold? Not the booking
// engine — that already exists here — but the DESCRIPTION. The fields a guest
// searches on:
//
//   "a two bedroom two bath at Phoenix East on these dates"
//   "a charter for eight people, at least eight hours, a 45ft boat with AC
//    and a head"
//
// Neither question can be answered from `entity` as it stands, because those
// are attributes of a specific unit or a specific boat and nothing stores
// them. This file is that missing half.
//
// ── Why a blueprint and one table, rather than eight tables ─────────────
//
// A `condo_units` table, a `charter_boats` table, a `cruise_vessels` table
// and five more would each need a migration every time a field is added, and
// a bespoke search per vertical. What actually varies between industries is
// the FIELD LIST, not the shape of storage — every one of them is
// (this listing, this attribute, this value).
//
// So: the field list lives here as data, the values live in one
// `entity_attributes` table, and one search route serves every industry. A
// new field is an entry in this file. A new industry is an entry in this
// file. Neither is a migration.
//
// Nothing here is invented from nothing — the field lists follow what the
// real platforms collect, so a business that already fills in an Airbnb or
// FareHarbor listing can transcribe it without inventing answers.
//
// ── Field descriptor ────────────────────────────────────────────────────
//
//   key         stable identifier, snake_case; never renamed once shipped
//   label       what a human sees
//   type        'number' | 'text' | 'bool' | 'select' | 'multi' | 'time'
//   unit        'ft' | 'hours' | 'people' | … shown after the value
//   options     for select/multi
//   group       which section of the form it belongs in
//   search      how a guest filters on it:
//                 'min'    guest asks for at least this  (bedrooms >= 2)
//                 'max'    guest asks for at most this   (price <= 400)
//                 'eq'     exact match                   (unit_number)
//                 'has'    must be present/true          (has_ac)
//                 'any'    value must be one of a list   (species)
//                 null     stored and shown, not filtered on
//   applies     'listing' (the business) | 'unit' (each bookable thing)
//
// `applies: 'unit'` is the important one: bedrooms belong to condo 1204, not
// to the Phoenix West building, and boat length belongs to the boat, not to
// the charter company. Those are child entities, and that is why they get
// their own attribute rows.

const N = (key, label, extra = {}) => ({ key, label, type: 'number', ...extra });
const T = (key, label, extra = {}) => ({ key, label, type: 'text', ...extra });
const B = (key, label, extra = {}) => ({ key, label, type: 'bool', search: 'has', ...extra });
const S = (key, label, options, extra = {}) => ({ key, label, type: 'select', options, ...extra });
const M = (key, label, options, extra = {}) => ({ key, label, type: 'multi', options, search: 'any', ...extra });

/* ── shared vocabularies ─────────────────────────────────────────────── */

const CANCELLATION = ['flexible', 'moderate', 'strict', 'non_refundable'];
const BED_TYPES = ['king', 'queen', 'full', 'twin', 'bunk', 'sofa_bed', 'murphy'];

/* ── stays: condos, vacation rentals, hotels ─────────────────────────── */
//
// What Airbnb, VRBO and Booking.com collect. The unit-level fields are the
// ones a guest actually searches — "2 bed 2 bath, sleeps 8, gulf front".

const STAY_UNIT_FIELDS = [
    N('bedrooms', 'Bedrooms', { search: 'min', group: 'Layout', required: true }),
    N('bathrooms', 'Bathrooms', { search: 'min', group: 'Layout', step: 0.5, required: true }),
    N('sleeps', 'Sleeps', { search: 'min', group: 'Layout', unit: 'people', required: true }),
    N('square_feet', 'Square feet', { search: 'min', group: 'Layout', unit: 'sq ft' }),
    T('unit_number', 'Unit number', { search: 'eq', group: 'Layout' }),
    N('floor', 'Floor', { search: 'min', group: 'Layout' }),
    M('bed_types', 'Beds', BED_TYPES, { group: 'Layout' }),

    S('view', 'View', ['gulf_front', 'gulf_view', 'side_gulf', 'bay', 'lagoon', 'pool', 'parking', 'none'],
        { search: 'any', group: 'The place' }),
    B('balcony', 'Balcony', { group: 'The place' }),
    B('elevator', 'Elevator', { group: 'The place' }),
    B('ground_floor', 'Ground floor', { group: 'The place' }),

    B('pet_friendly', 'Pets allowed', { group: 'Rules' }),
    B('smoking_allowed', 'Smoking allowed', { group: 'Rules' }),
    N('min_nights', 'Minimum nights', { search: 'max', group: 'Rules', unit: 'nights' }),
    N('max_guests', 'Maximum guests', { search: 'min', group: 'Rules', unit: 'people' }),
    T('check_in_time', 'Check-in', { type: 'time', group: 'Rules' }),
    T('check_out_time', 'Check-out', { type: 'time', group: 'Rules' }),
    S('cancellation', 'Cancellation', CANCELLATION, { group: 'Rules' }),

    N('nightly_rate', 'Nightly rate', { search: 'max', group: 'Money', unit: '$' }),
    N('cleaning_fee', 'Cleaning fee', { group: 'Money', unit: '$' }),
    N('deposit', 'Deposit', { group: 'Money', unit: '$' }),

    M('amenities', 'Amenities', [
        'wifi', 'air_conditioning', 'washer', 'dryer', 'dishwasher', 'full_kitchen',
        'kitchenette', 'coffee_maker', 'grill', 'private_pool', 'hot_tub', 'crib',
        'high_chair', 'beach_chairs', 'beach_service', 'linens', 'tv', 'workspace',
    ], { group: 'Amenities' }),
];

const STAY_LISTING_FIELDS = [
    N('total_units', 'Units in the building', { group: 'The property' }),
    N('floors', 'Floors', { group: 'The property' }),
    N('year_built', 'Year built', { group: 'The property' }),
    N('distance_to_beach', 'Distance to the beach', { search: 'max', group: 'The property', unit: 'ft' }),
    B('beachfront', 'Beachfront', { group: 'The property' }),

    M('property_amenities', 'Property amenities', [
        'outdoor_pool', 'indoor_pool', 'heated_pool', 'lazy_river', 'hot_tub',
        'fitness_center', 'sauna', 'tennis', 'pickleball', 'boat_slips', 'gated',
        'covered_parking', 'ev_charging', 'elevator', 'onsite_restaurant', 'bar',
        'beach_service', 'game_room', 'grills', 'conference_room',
    ], { group: 'Property amenities' }),

    B('front_desk_24h', 'Front desk 24/7', { group: 'Service' }),
    B('housekeeping_daily', 'Daily housekeeping', { group: 'Service' }),
    T('parking_notes', 'Parking', { group: 'Service' }),
];

/* ── fishing charters ────────────────────────────────────────────────── */
//
// FareHarbor and Peek Pro shape. Boat-level fields sit on the boat, because
// "a 45ft boat with AC and a head" is a question about a specific vessel and
// a marina may run six of them.

const CHARTER_UNIT_FIELDS = [
    N('boat_length', 'Boat length', { search: 'min', group: 'The boat', unit: 'ft', required: true }),
    T('boat_name', 'Boat name', { group: 'The boat' }),
    T('boat_make', 'Make & model', { group: 'The boat' }),
    N('boat_year', 'Year', { group: 'The boat' }),
    N('max_anglers', 'Maximum anglers', { search: 'min', group: 'The boat', unit: 'people', required: true }),
    N('cruising_speed', 'Cruising speed', { group: 'The boat', unit: 'kn' }),
    N('engines', 'Engines', { group: 'The boat' }),

    // The three questions every caller asks, in the order they ask them.
    B('has_head', 'Has a head (toilet)', { group: 'Comfort' }),
    B('has_ac', 'Air conditioning', { group: 'Comfort' }),
    B('has_cabin', 'Enclosed cabin', { group: 'Comfort' }),
    B('has_shade', 'Shade / T-top', { group: 'Comfort' }),
    B('has_livewell', 'Livewell', { group: 'Fishing' }),
    B('has_fishfinder', 'Fish finder / sonar', { group: 'Fishing' }),
    B('has_outriggers', 'Outriggers', { group: 'Fishing' }),
];

const CHARTER_LISTING_FIELDS = [
    M('trip_lengths', 'Trip lengths offered', [
        '2_hour', '4_hour', '6_hour', '8_hour', '10_hour', '12_hour', 'overnight', 'multi_day',
    ], { group: 'Trips', required: true }),
    M('trip_types', 'Trip types', [
        'inshore', 'nearshore', 'offshore', 'deep_sea', 'bottom_fishing', 'trolling',
        'fly_fishing', 'shark', 'night_fishing', 'family', 'tournament',
    ], { group: 'Trips' }),
    M('species', 'Target species', [
        'red_snapper', 'grouper', 'amberjack', 'king_mackerel', 'spanish_mackerel',
        'cobia', 'tuna', 'mahi', 'wahoo', 'marlin', 'sailfish', 'redfish',
        'speckled_trout', 'flounder', 'shark', 'triggerfish', 'tarpon',
    ], { group: 'Trips' }),
    M('seasons', 'Seasons', ['spring', 'summer', 'fall', 'winter', 'year_round'], { group: 'Trips' }),

    B('license_included', 'Fishing license included', { group: 'Included' }),
    B('gear_included', 'Rods & tackle included', { group: 'Included' }),
    B('bait_included', 'Bait included', { group: 'Included' }),
    B('cleaning_included', 'Fish cleaning included', { group: 'Included' }),
    B('ice_included', 'Ice included', { group: 'Included' }),
    B('byob_allowed', 'BYOB allowed', { group: 'Included' }),

    N('captains', 'Captains', { group: 'Crew' }),
    N('deckhands', 'Deckhands', { group: 'Crew' }),
    B('uscg_licensed', 'USCG licensed', { group: 'Crew' }),
    B('insured', 'Insured', { group: 'Crew' }),

    N('price_per_person', 'Price per person', { search: 'max', group: 'Money', unit: '$' }),
    N('private_charter_price', 'Private charter', { search: 'max', group: 'Money', unit: '$' }),
    N('deposit_percent', 'Deposit', { group: 'Money', unit: '%' }),
    S('cancellation', 'Cancellation', CANCELLATION, { group: 'Money' }),

    T('marina', 'Departs from', { group: 'Logistics' }),
    T('dock_number', 'Dock / slip', { group: 'Logistics' }),
    M('departure_times', 'Departure times', ['dawn', 'morning', 'midday', 'afternoon', 'sunset', 'night'],
        { group: 'Logistics' }),
];

/* ── cruises & tours ─────────────────────────────────────────────────── */

const CRUISE_UNIT_FIELDS = [
    N('vessel_length', 'Vessel length', { search: 'min', group: 'The vessel', unit: 'ft' }),
    T('vessel_name', 'Vessel name', { group: 'The vessel' }),
    N('passenger_capacity', 'Passenger capacity', { search: 'min', group: 'The vessel', unit: 'people', required: true }),
    B('has_restroom', 'Restroom on board', { group: 'The vessel' }),
    B('has_bar', 'Bar on board', { group: 'The vessel' }),
    B('covered_seating', 'Covered seating', { group: 'The vessel' }),
    B('wheelchair_accessible', 'Wheelchair accessible', { group: 'The vessel' }),
];

const CRUISE_LISTING_FIELDS = [
    M('cruise_types', 'Cruise types', [
        'dolphin', 'sunset', 'sightseeing', 'dinner', 'party', 'private', 'fireworks',
        'eco_tour', 'island_hop', 'snorkel_stop',
    ], { group: 'Cruises', required: true }),
    N('duration_hours', 'Duration', { search: 'min', group: 'Cruises', unit: 'hours', step: 0.5 }),
    M('departure_times', 'Departure times', ['morning', 'midday', 'afternoon', 'sunset', 'evening'],
        { group: 'Cruises' }),
    B('narrated', 'Narrated', { group: 'Cruises' }),
    B('dolphin_guarantee', 'Dolphin sighting guarantee', { group: 'Cruises' }),

    N('adult_price', 'Adult price', { search: 'max', group: 'Money', unit: '$' }),
    N('child_price', 'Child price', { search: 'max', group: 'Money', unit: '$' }),
    N('min_age', 'Minimum age', { search: 'max', group: 'Rules' }),
    B('alcohol_allowed', 'Alcohol allowed', { group: 'Rules' }),
    B('pets_allowed', 'Pets allowed', { group: 'Rules' }),
    T('departure_point', 'Departs from', { group: 'Logistics' }),
];

/* ── watersports & parasailing ───────────────────────────────────────── */

const WATERSPORT_LISTING_FIELDS = [
    M('activities', 'Activities', [
        'parasailing', 'jet_ski', 'wave_runner', 'banana_boat', 'tubing', 'kayak',
        'paddleboard', 'snorkel', 'scuba', 'wakeboard', 'water_ski', 'flyboard',
    ], { group: 'Activities', required: true }),
    N('max_flight_height', 'Maximum flight height', { search: 'min', group: 'Activities', unit: 'ft' }),
    N('riders_per_flight', 'Riders per flight', { search: 'min', group: 'Activities', unit: 'people' }),
    N('min_weight', 'Minimum weight', { group: 'Rules', unit: 'lb' }),
    N('max_weight', 'Maximum weight', { search: 'min', group: 'Rules', unit: 'lb' }),
    N('min_age', 'Minimum age', { search: 'max', group: 'Rules' }),
    B('instruction_included', 'Instruction included', { group: 'Included' }),
    B('gear_included', 'Gear included', { group: 'Included' }),
    B('photos_included', 'Photos included', { group: 'Included' }),
    B('observers_allowed', 'Observers can ride along', { group: 'Rules' }),
    N('price_per_person', 'Price per person', { search: 'max', group: 'Money', unit: '$' }),
];

/* ── boat & gear rentals ─────────────────────────────────────────────── */

const RENTAL_UNIT_FIELDS = [
    S('rental_type', 'Type', ['pontoon', 'deck_boat', 'center_console', 'jet_ski', 'kayak',
        'paddleboard', 'golf_cart', 'bike', 'beach_gear'], { search: 'any', group: 'The item', required: true }),
    T('model', 'Make & model', { group: 'The item' }),
    N('year', 'Year', { group: 'The item' }),
    N('length', 'Length', { search: 'min', group: 'The item', unit: 'ft' }),
    N('capacity', 'Capacity', { search: 'min', group: 'The item', unit: 'people', required: true }),
    N('horsepower', 'Horsepower', { search: 'min', group: 'The item', unit: 'hp' }),
    B('has_bimini', 'Bimini / shade', { group: 'The item' }),
    B('has_stereo', 'Stereo', { group: 'The item' }),
    B('has_cooler', 'Cooler included', { group: 'The item' }),
    B('has_restroom', 'Restroom', { group: 'The item' }),
];

const RENTAL_LISTING_FIELDS = [
    M('rental_periods', 'Rental periods', ['hourly', 'half_day', 'full_day', 'multi_day', 'weekly'],
        { group: 'Terms', required: true }),
    B('license_required', 'Boating licence required', { group: 'Terms' }),
    N('min_age', 'Minimum age to rent', { search: 'max', group: 'Terms' }),
    B('captain_available', 'Captain available', { group: 'Terms' }),
    B('delivery_available', 'Delivered to you', { group: 'Terms' }),
    B('fuel_included', 'Fuel included', { group: 'Terms' }),
    N('security_deposit', 'Security deposit', { group: 'Money', unit: '$' }),
    N('half_day_price', 'Half day', { search: 'max', group: 'Money', unit: '$' }),
    N('full_day_price', 'Full day', { search: 'max', group: 'Money', unit: '$' }),
    T('pickup_location', 'Pick-up location', { group: 'Logistics' }),
];

/* ── photographers & sessions ────────────────────────────────────────── */

const SESSION_LISTING_FIELDS = [
    M('session_types', 'Session types', [
        'family', 'engagement', 'wedding', 'elopement', 'maternity', 'newborn',
        'senior', 'headshot', 'event', 'real_estate', 'drone', 'product',
    ], { group: 'Sessions', required: true }),
    N('session_length', 'Session length', { search: 'min', group: 'Sessions', unit: 'minutes' }),
    N('edited_images', 'Edited images included', { search: 'min', group: 'Sessions' }),
    N('turnaround_days', 'Turnaround', { search: 'max', group: 'Sessions', unit: 'days' }),
    N('max_people', 'Maximum people', { search: 'min', group: 'Sessions', unit: 'people' }),

    M('locations', 'Locations', ['beach', 'studio', 'venue', 'home', 'travel'], { search: 'any', group: 'Where' }),
    B('travels_to_you', 'Travels to you', { group: 'Where' }),
    N('travel_radius', 'Travel radius', { search: 'min', group: 'Where', unit: 'miles' }),

    B('prints_available', 'Prints available', { group: 'Included' }),
    B('digital_included', 'Digital files included', { group: 'Included' }),
    B('raw_available', 'RAW files available', { group: 'Included' }),
    B('second_shooter', 'Second shooter available', { group: 'Included' }),

    N('session_price', 'Session price', { search: 'max', group: 'Money', unit: '$' }),
    N('deposit', 'Deposit', { group: 'Money', unit: '$' }),
];

/* ── venues & events ─────────────────────────────────────────────────── */

const VENUE_LISTING_FIELDS = [
    N('standing_capacity', 'Standing capacity', { search: 'min', group: 'Space', unit: 'people' }),
    N('seated_capacity', 'Seated capacity', { search: 'min', group: 'Space', unit: 'people', required: true }),
    N('square_feet', 'Square feet', { search: 'min', group: 'Space', unit: 'sq ft' }),
    B('outdoor_space', 'Outdoor space', { group: 'Space' }),
    B('beachfront', 'Beachfront', { group: 'Space' }),
    M('event_types', 'Event types', ['wedding', 'reception', 'corporate', 'birthday', 'reunion',
        'conference', 'concert', 'fundraiser'], { search: 'any', group: 'Events' }),
    B('catering_inhouse', 'In-house catering', { group: 'Services' }),
    B('outside_catering', 'Outside catering allowed', { group: 'Services' }),
    B('bar_service', 'Bar service', { group: 'Services' }),
    B('av_equipment', 'A/V equipment', { group: 'Services' }),
    B('tables_chairs', 'Tables & chairs included', { group: 'Services' }),
    N('parking_spaces', 'Parking spaces', { search: 'min', group: 'Logistics' }),
    N('hourly_rate', 'Hourly rate', { search: 'max', group: 'Money', unit: '$' }),
    N('day_rate', 'Day rate', { search: 'max', group: 'Money', unit: '$' }),
];

/* ── the registry ────────────────────────────────────────────────────── */

const BLUEPRINTS = {
    condo: { listing: STAY_LISTING_FIELDS, unit: STAY_UNIT_FIELDS, unit_label: 'Unit' },
    hotel: { listing: STAY_LISTING_FIELDS, unit: STAY_UNIT_FIELDS, unit_label: 'Room type' },
    charter: { listing: CHARTER_LISTING_FIELDS, unit: CHARTER_UNIT_FIELDS, unit_label: 'Boat' },
    cruise: { listing: CRUISE_LISTING_FIELDS, unit: CRUISE_UNIT_FIELDS, unit_label: 'Vessel' },
    watersport: { listing: WATERSPORT_LISTING_FIELDS, unit: [], unit_label: 'Equipment' },
    rental: { listing: RENTAL_LISTING_FIELDS, unit: RENTAL_UNIT_FIELDS, unit_label: 'Rental item' },
    session: { listing: SESSION_LISTING_FIELDS, unit: [], unit_label: 'Package' },
    venue: { listing: VENUE_LISTING_FIELDS, unit: [], unit_label: 'Space' },
    other: { listing: [], unit: [], unit_label: 'Item' },
};

/** Every field for one industry, listing and unit together, each tagged. */
function fieldsFor(vertical) {
    const bp = BLUEPRINTS[vertical] || BLUEPRINTS.other;
    return [
        ...bp.listing.map((f) => ({ ...f, applies: 'listing' })),
        ...bp.unit.map((f) => ({ ...f, applies: 'unit' })),
    ];
}

/** One field by key, so a write can be validated against its type. */
function fieldFor(vertical, key) {
    return fieldsFor(vertical).find((f) => f.key === key) || null;
}

/**
 * Coerce a submitted value to the field's type, or return `{ error }`.
 *
 * Returning the coerced value rather than trusting the client matters for
 * search: `bedrooms` has to land in the numeric column or a `>= 2` filter
 * silently matches nothing.
 */
function coerce(field, raw) {
    if (raw === null || raw === undefined || raw === '') return { value: null, cleared: true };

    switch (field.type) {
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) return { error: `${field.label} must be a number` };
            return { value: n, column: 'value_num' };
        }
        case 'bool': {
            const v = raw === true || raw === 'true' || raw === 1 || raw === '1';
            return { value: v, column: 'value_bool' };
        }
        case 'select': {
            const v = String(raw);
            if (field.options && !field.options.includes(v)) {
                return { error: `${field.label}: "${v}" is not one of ${field.options.join(', ')}` };
            }
            return { value: v, column: 'value_text' };
        }
        case 'multi': {
            const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
            if (field.options) {
                const bad = list.filter((v) => !field.options.includes(v));
                if (bad.length) return { error: `${field.label}: unknown ${bad.join(', ')}` };
            }
            return { value: list, column: 'value_list' };
        }
        default:
            return { value: String(raw).slice(0, 2000), column: 'value_text' };
    }
}

/** The subset a guest can filter on, which is what the match route exposes. */
function searchableFor(vertical) {
    return fieldsFor(vertical).filter((f) => f.search);
}

module.exports = {
    BLUEPRINTS,
    fieldsFor,
    fieldFor,
    searchableFor,
    coerce,
};
