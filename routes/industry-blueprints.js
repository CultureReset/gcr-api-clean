// ============================================================
// INDUSTRY BLUEPRINTS — a map over the real tables
// ============================================================
//
// The tables are in sql/industry_tables.sql: `stay_units` with a `bedrooms`
// integer, `charter_boats` with a `length_ft` numeric, `venue_spaces` with a
// `seated_capacity` integer. Real columns, real types, real indexes, real
// foreign keys. Nothing is stored as a key/value pair and nothing is stored
// as JSON.
//
// This file does NOT store anything. It describes those tables so that:
//
//   * the dashboard can build a form from them without a second, hand-kept
//     field list that drifts out of step with the schema,
//   * the match search knows which column to compare and whether the guest
//     means "at least" or "at most",
//   * a write can be checked against the columns that actually exist before
//     it reaches the database.
//
// So: schema in SQL, description here, and the two are checked against each
// other by scripts/check-blueprint-columns.mjs.
//
// ── Shape ───────────────────────────────────────────────────────────────
//
//   listing      the table keyed to the business itself. For a condo complex
//                that is the building — pool, lazy river, floors, front desk.
//   unit         the table keyed to each bookable child. For a condo that is
//                the unit — bedrooms, bathrooms, view. This is what guests
//                actually search, and it is why units are separate entities.
//   collections  one-to-many rows hanging off either: beds in a unit, trips a
//                charter runs, packages a photographer sells.
//   amenities    which join table connects this thing to the shared catalog.
//   tags         a controlled vocabulary join — species, activities — kept as
//                a catalog and a join rather than free text, so "who targets
//                red snapper" is an index lookup.
//
// ── Column descriptor ───────────────────────────────────────────────────
//
//   label     what a human sees
//   type      'int' | 'decimal' | 'text' | 'bool' | 'time' | 'enum'
//   search    'min' | 'max' | 'eq' | 'has' | 'any' | null
//               min  guest asks for at least this   (bedrooms >= 2)
//               max  guest asks for at most this    (nightly_rate <= 400)
//               eq   exact match
//               has  must be true                   (has_ac)
//               any  one of a list                  (view in (...))
//               null stored and shown, never filtered on
//   options   for enum
//   group     which fieldset it belongs in
//   unit      shown after the value: ft, hours, people, $

const int = (label, extra = {}) => ({ label, type: 'int', ...extra });
const dec = (label, extra = {}) => ({ label, type: 'decimal', ...extra });
const txt = (label, extra = {}) => ({ label, type: 'text', ...extra });
const bool = (label, extra = {}) => ({ label, type: 'bool', search: 'has', ...extra });
const time = (label, extra = {}) => ({ label, type: 'time', ...extra });
const en = (label, options, extra = {}) => ({ label, type: 'enum', options, search: 'any', ...extra });

const CANCELLATION = ['flexible', 'moderate', 'strict', 'non_refundable'];

/* ══ stays ═══════════════════════════════════════════════════════════════ */

const STAY_PROPERTY = {
    table: 'stay_properties',
    key: 'entity_slug',
    label: 'The property',
    // The operator fills the building in once — pool, lazy river, floors,
    // parking — and every unit inherits it. A unit owner adding their listing
    // is only ever asked about their own unit, which is why nothing here is
    // `required` and why the unit form does not nag about it.
    managedBy: 'operator',
    managedNote: 'Filled in once for the whole building. Unit owners never see this.',
    amenities: { join: 'stay_property_amenities', fk: 'property_id' },
    columns: {
        property_type: en('Property type', ['condo_complex', 'hotel', 'resort', 'house', 'duplex'], { group: 'The property' }),
        total_units: int('Units in the building', { group: 'The property' }),
        floors: int('Floors', { group: 'The property' }),
        year_built: int('Year built', { group: 'The property' }),
        renovated_year: int('Last renovated', { group: 'The property' }),

        beachfront: bool('Beachfront', { group: 'Location' }),
        distance_to_beach_ft: int('Distance to the beach', { search: 'max', group: 'Location', unit: 'ft' }),
        distance_to_airport_mi: dec('Distance to the airport', { search: 'max', group: 'Location', unit: 'mi' }),

        front_desk_24h: bool('Front desk 24/7', { group: 'Service' }),
        housekeeping_daily: bool('Daily housekeeping', { group: 'Service' }),
        security_onsite: bool('Security on site', { group: 'Service' }),
        gated: bool('Gated', { group: 'Service' }),

        check_in_time: time('Check-in', { group: 'Arrival' }),
        check_out_time: time('Check-out', { group: 'Arrival' }),
        parking_type: en('Parking', ['covered', 'surface', 'garage', 'street', 'none'], { group: 'Arrival' }),
        parking_spaces_per_unit: dec('Spaces per unit', { search: 'min', group: 'Arrival' }),
        parking_notes: txt('Parking notes', { group: 'Arrival' }),

        hoa_name: txt('HOA', { group: 'Management' }),
        management_company: txt('Management company', { group: 'Management' }),
    },
};

const STAY_UNIT = {
    table: 'stay_units',
    key: 'entity_slug',
    label: 'Unit',
    parentFk: 'property_id',
    parentTable: 'stay_properties',
    amenities: { join: 'stay_unit_amenities', fk: 'unit_id' },
    collections: [{
        table: 'stay_unit_beds',
        fk: 'unit_id',
        label: 'Beds',
        // "Bedroom 1: one king" — a real row, because someone working out
        // where to put four kids is asking about exactly this.
        columns: {
            room_name: txt('Room'),
            room_type: en('Room type', ['bedroom', 'living', 'loft', 'den', 'bunk_room']),
            bed_type: en('Bed', ['king', 'queen', 'full', 'twin', 'bunk', 'sofa_bed', 'murphy'], { required: true }),
            quantity: int('How many'),
        },
    }],
    columns: {
        unit_number: txt('Unit number', { search: 'eq', group: 'Identity' }),
        floor: int('Floor', { search: 'min', group: 'Identity' }),
        unit_type: en('Unit type', ['condo', 'suite', 'studio', 'villa', 'room'], { group: 'Identity' }),

        bedrooms: int('Bedrooms', { search: 'min', group: 'Layout', required: true }),
        bathrooms: dec('Bathrooms', { search: 'min', group: 'Layout', step: 0.5, required: true }),
        half_baths: int('Half baths', { group: 'Layout' }),
        sleeps: int('Sleeps', { search: 'min', group: 'Layout', unit: 'people', required: true }),
        square_feet: int('Square feet', { search: 'min', group: 'Layout', unit: 'sq ft' }),

        view: en('View', ['gulf_front', 'gulf_view', 'side_gulf', 'bay', 'lagoon', 'pool', 'parking', 'none'], { group: 'The place' }),
        balcony: bool('Balcony', { group: 'The place' }),
        balcony_count: int('Balconies', { group: 'The place' }),
        ground_floor: bool('Ground floor', { group: 'The place' }),
        elevator_access: bool('Elevator access', { group: 'The place' }),
        wheelchair_accessible: bool('Wheelchair accessible', { group: 'The place' }),

        pet_friendly: bool('Pets allowed', { group: 'Rules' }),
        pet_fee: dec('Pet fee', { group: 'Rules', unit: '$' }),
        max_pets: int('Maximum pets', { search: 'min', group: 'Rules' }),
        smoking_allowed: bool('Smoking allowed', { group: 'Rules' }),
        events_allowed: bool('Events allowed', { group: 'Rules' }),
        min_nights: int('Minimum nights', { search: 'max', group: 'Rules', unit: 'nights' }),
        max_nights: int('Maximum nights', { group: 'Rules', unit: 'nights' }),
        max_guests: int('Maximum guests', { search: 'min', group: 'Rules', unit: 'people' }),
        min_age_to_book: int('Minimum age to book', { search: 'max', group: 'Rules' }),
        check_in_time: time('Check-in', { group: 'Rules' }),
        check_out_time: time('Check-out', { group: 'Rules' }),
        cancellation_policy: en('Cancellation', CANCELLATION, { group: 'Rules' }),

        nightly_rate: dec('Nightly rate', { search: 'max', group: 'Money', unit: '$' }),
        weekly_rate: dec('Weekly rate', { search: 'max', group: 'Money', unit: '$' }),
        monthly_rate: dec('Monthly rate', { group: 'Money', unit: '$' }),
        cleaning_fee: dec('Cleaning fee', { group: 'Money', unit: '$' }),
        pet_deposit: dec('Pet deposit', { group: 'Money', unit: '$' }),
        security_deposit: dec('Security deposit', { group: 'Money', unit: '$' }),
        tax_rate: dec('Tax rate', { group: 'Money', unit: '%' }),

        description: txt('Description', { group: 'Words', long: true }),
        house_rules: txt('House rules', { group: 'Words', long: true }),
    },
};

/* ══ fishing charters ════════════════════════════════════════════════════ */

const CHARTER_OPERATOR = {
    table: 'charter_operators',
    key: 'entity_slug',
    label: 'The operation',
    tags: [{
        join: 'charter_species', fk: 'operator_id', catalogFk: 'species_id',
        catalog: 'fish_species', label: 'Target species',
    }],
    collections: [{
        table: 'charter_trips',
        fk: 'operator_id',
        label: 'Trips',
        // What a guest actually books. "8 hour offshore, up to 6, $1,800."
        columns: {
            name: txt('Trip name'),
            trip_type: en('Type', ['inshore', 'nearshore', 'offshore', 'deep_sea', 'bottom', 'trolling', 'shark', 'night']),
            duration_hours: dec('Hours', { search: 'min', unit: 'hours' }),
            min_anglers: int('Minimum anglers'),
            max_anglers: int('Maximum anglers', { search: 'min', unit: 'people' }),
            departure_time: time('Departs'),
            return_time: time('Returns'),
            price: dec('Price', { search: 'max', unit: '$' }),
            price_unit: en('Priced per', ['trip', 'person']),
            extra_person_fee: dec('Extra person', { unit: '$' }),
            is_private: bool('Private charter'),
        },
    }],
    columns: {
        marina: txt('Departs from', { group: 'Where' }),
        dock_number: txt('Dock / slip', { group: 'Where' }),

        captains: int('Captains', { group: 'Crew' }),
        deckhands: int('Deckhands', { group: 'Crew' }),
        years_operating: int('Years operating', { search: 'min', group: 'Crew' }),
        uscg_licensed: bool('USCG licensed', { group: 'Crew' }),
        insured: bool('Insured', { group: 'Crew' }),

        license_included: bool('Fishing licence included', { group: 'Included' }),
        gear_included: bool('Rods & tackle included', { group: 'Included' }),
        bait_included: bool('Bait included', { group: 'Included' }),
        ice_included: bool('Ice included', { group: 'Included' }),
        cleaning_included: bool('Fish cleaning included', { group: 'Included' }),
        cooler_provided: bool('Cooler provided', { group: 'Included' }),
        byob_allowed: bool('BYOB allowed', { group: 'Included' }),

        deposit_percent: dec('Deposit', { group: 'Money', unit: '%' }),
        cancellation_policy: en('Cancellation', CANCELLATION, { group: 'Money' }),
        weather_policy: txt('Weather policy', { group: 'Money', long: true }),
    },
};

const CHARTER_BOAT = {
    table: 'charter_boats',
    key: 'entity_slug',
    label: 'Boat',
    parentFk: 'operator_id',
    parentTable: 'charter_operators',
    amenities: { join: 'charter_boat_amenities', fk: 'boat_id' },
    columns: {
        boat_name: txt('Boat name', { group: 'Identity' }),
        make: txt('Make', { group: 'Identity' }),
        model: txt('Model', { group: 'Identity' }),
        year: int('Year', { search: 'min', group: 'Identity' }),

        length_ft: dec('Length', { search: 'min', group: 'The boat', unit: 'ft', required: true }),
        beam_ft: dec('Beam', { group: 'The boat', unit: 'ft' }),
        max_anglers: int('Maximum anglers', { search: 'min', group: 'The boat', unit: 'people', required: true }),
        crew_size: int('Crew', { group: 'The boat' }),
        engines: int('Engines', { group: 'The boat' }),
        engine_hp: int('Horsepower', { search: 'min', group: 'The boat', unit: 'hp' }),
        cruising_speed_kn: dec('Cruising speed', { search: 'min', group: 'The boat', unit: 'kn' }),
        fuel_capacity_gal: int('Fuel capacity', { group: 'The boat', unit: 'gal' }),
        max_range_mi: int('Range', { search: 'min', group: 'The boat', unit: 'mi' }),

        // The three questions every caller asks, in the order they ask them.
        has_head: bool('Head (toilet)', { group: 'Comfort' }),
        has_ac: bool('Air conditioning', { group: 'Comfort' }),
        has_cabin: bool('Enclosed cabin', { group: 'Comfort' }),
        has_shade: bool('Shade / T-top', { group: 'Comfort' }),
        has_galley: bool('Galley', { group: 'Comfort' }),
        wheelchair_accessible: bool('Wheelchair accessible', { group: 'Comfort' }),

        has_livewell: bool('Livewell', { group: 'Fishing' }),
        has_fishfinder: bool('Fish finder / sonar', { group: 'Fishing' }),
        has_radar: bool('Radar', { group: 'Fishing' }),
        has_outriggers: bool('Outriggers', { group: 'Fishing' }),
        has_fighting_chair: bool('Fighting chair', { group: 'Fishing' }),
    },
};

/* ══ cruises ═════════════════════════════════════════════════════════════ */

const CRUISE_OPERATOR = {
    table: 'cruise_operators',
    key: 'entity_slug',
    label: 'The operation',
    collections: [{
        table: 'cruise_trips',
        fk: 'operator_id',
        label: 'Cruises',
        columns: {
            name: txt('Name'),
            cruise_type: en('Type', ['dolphin', 'sunset', 'sightseeing', 'dinner', 'party', 'private', 'fireworks', 'eco_tour']),
            duration_hours: dec('Hours', { search: 'min', unit: 'hours' }),
            departure_time: time('Departs'),
            max_passengers: int('Maximum passengers', { search: 'min', unit: 'people' }),
            adult_price: dec('Adult', { search: 'max', unit: '$' }),
            child_price: dec('Child', { search: 'max', unit: '$' }),
            narrated: bool('Narrated'),
            dolphin_guarantee: bool('Dolphin guarantee'),
        },
    }],
    columns: {
        departure_point: txt('Departs from', { group: 'Where' }),
        dock_number: txt('Dock', { group: 'Where' }),
        min_age: int('Minimum age', { search: 'max', group: 'Rules' }),
        alcohol_allowed: bool('Alcohol allowed', { group: 'Rules' }),
        byob_allowed: bool('BYOB allowed', { group: 'Rules' }),
        pets_allowed: bool('Pets allowed', { group: 'Rules' }),
        food_available: bool('Food available', { group: 'Rules' }),
        adult_price: dec('Adult price', { search: 'max', group: 'Money', unit: '$' }),
        child_price: dec('Child price', { search: 'max', group: 'Money', unit: '$' }),
        senior_price: dec('Senior price', { group: 'Money', unit: '$' }),
        infant_free_under: int('Infants free under', { group: 'Money' }),
        cancellation_policy: en('Cancellation', CANCELLATION, { group: 'Money' }),
    },
};

const CRUISE_VESSEL = {
    table: 'cruise_vessels',
    key: 'entity_slug',
    label: 'Vessel',
    parentFk: 'operator_id',
    parentTable: 'cruise_operators',
    columns: {
        vessel_name: txt('Vessel name', { group: 'Identity' }),
        vessel_type: en('Type', ['catamaran', 'pontoon', 'sailboat', 'yacht', 'speedboat'], { group: 'Identity' }),
        length_ft: dec('Length', { search: 'min', group: 'The vessel', unit: 'ft' }),
        passenger_capacity: int('Passenger capacity', { search: 'min', group: 'The vessel', unit: 'people', required: true }),
        decks: int('Decks', { group: 'The vessel' }),
        has_restroom: bool('Restroom on board', { group: 'Comfort' }),
        has_bar: bool('Bar on board', { group: 'Comfort' }),
        covered_seating: bool('Covered seating', { group: 'Comfort' }),
        has_sound_system: bool('Sound system', { group: 'Comfort' }),
        wheelchair_accessible: bool('Wheelchair accessible', { group: 'Comfort' }),
    },
};

/* ══ rentals ═════════════════════════════════════════════════════════════ */

const RENTAL_OPERATOR = {
    table: 'rental_operators',
    key: 'entity_slug',
    label: 'The operation',
    columns: {
        pickup_location: txt('Pick-up location', { group: 'Where' }),
        license_required: bool('Boating licence required', { group: 'Terms' }),
        min_age_to_rent: int('Minimum age to rent', { search: 'max', group: 'Terms' }),
        captain_available: bool('Captain available', { group: 'Terms' }),
        captain_rate: dec('Captain rate', { group: 'Terms', unit: '$' }),
        delivery_available: bool('Delivered to you', { group: 'Terms' }),
        delivery_fee: dec('Delivery fee', { group: 'Terms', unit: '$' }),
        fuel_included: bool('Fuel included', { group: 'Terms' }),
        security_deposit: dec('Security deposit', { group: 'Money', unit: '$' }),
        cancellation_policy: en('Cancellation', CANCELLATION, { group: 'Money' }),
    },
};

const RENTAL_ITEM = {
    table: 'rental_items',
    key: 'entity_slug',
    label: 'Rental item',
    parentFk: 'operator_id',
    parentTable: 'rental_operators',
    columns: {
        rental_type: en('Type', ['pontoon', 'deck_boat', 'center_console', 'jet_ski', 'kayak', 'paddleboard', 'golf_cart', 'bike'],
            { group: 'Identity', required: true }),
        name: txt('Name', { group: 'Identity' }),
        make: txt('Make', { group: 'Identity' }),
        model: txt('Model', { group: 'Identity' }),
        year: int('Year', { search: 'min', group: 'Identity' }),
        // Five identical pontoons is one row with quantity 5, not five rows.
        quantity: int('How many of these', { search: 'min', group: 'Identity' }),

        length_ft: dec('Length', { search: 'min', group: 'The item', unit: 'ft' }),
        capacity: int('Capacity', { search: 'min', group: 'The item', unit: 'people', required: true }),
        horsepower: int('Horsepower', { search: 'min', group: 'The item', unit: 'hp' }),
        has_bimini: bool('Bimini / shade', { group: 'The item' }),
        has_stereo: bool('Stereo', { group: 'The item' }),
        has_cooler: bool('Cooler', { group: 'The item' }),
        has_restroom: bool('Restroom', { group: 'The item' }),
        has_ladder: bool('Swim ladder', { group: 'The item' }),

        hourly_rate: dec('Hourly', { search: 'max', group: 'Money', unit: '$' }),
        half_day_rate: dec('Half day', { search: 'max', group: 'Money', unit: '$' }),
        full_day_rate: dec('Full day', { search: 'max', group: 'Money', unit: '$' }),
        weekly_rate: dec('Weekly', { group: 'Money', unit: '$' }),
    },
};

/* ══ watersports ═════════════════════════════════════════════════════════ */

const WATERSPORT_OPERATOR = {
    table: 'watersport_operators',
    key: 'entity_slug',
    label: 'The operation',
    tags: [{
        join: 'watersport_operator_activities', fk: 'operator_id', catalogFk: 'activity_id',
        catalog: 'watersport_activities', label: 'Activities',
    }],
    columns: {
        launch_location: txt('Launches from', { group: 'Where' }),
        max_flight_height_ft: int('Maximum flight height', { search: 'min', group: 'The flight', unit: 'ft' }),
        riders_per_flight: int('Riders per flight', { search: 'min', group: 'The flight', unit: 'people' }),
        min_weight_lb: int('Minimum weight', { group: 'Rules', unit: 'lb' }),
        max_weight_lb: int('Maximum weight', { search: 'min', group: 'Rules', unit: 'lb' }),
        min_age: int('Minimum age', { search: 'max', group: 'Rules' }),
        observers_allowed: bool('Observers can ride along', { group: 'Rules' }),
        observer_price: dec('Observer price', { group: 'Money', unit: '$' }),
        instruction_included: bool('Instruction included', { group: 'Included' }),
        gear_included: bool('Gear included', { group: 'Included' }),
        photos_included: bool('Photos included', { group: 'Included' }),
        photos_price: dec('Photos price', { group: 'Money', unit: '$' }),
        price_per_person: dec('Price per person', { search: 'max', group: 'Money', unit: '$' }),
        cancellation_policy: en('Cancellation', CANCELLATION, { group: 'Money' }),
    },
};

/* ══ sessions ════════════════════════════════════════════════════════════ */

const SESSION_PROVIDER = {
    table: 'session_providers',
    key: 'entity_slug',
    label: 'The provider',
    collections: [{
        table: 'session_packages',
        fk: 'provider_id',
        label: 'Packages',
        columns: {
            name: txt('Package'),
            session_type: en('Type', ['family', 'engagement', 'wedding', 'elopement', 'maternity', 'newborn', 'senior', 'headshot', 'event', 'real_estate']),
            length_minutes: int('Length', { search: 'min', unit: 'minutes' }),
            edited_images: int('Edited images', { search: 'min' }),
            turnaround_days: int('Turnaround', { search: 'max', unit: 'days' }),
            max_people: int('Maximum people', { search: 'min', unit: 'people' }),
            outfit_changes: int('Outfit changes'),
            locations_count: int('Locations'),
            price: dec('Price', { search: 'max', unit: '$' }),
        },
    }],
    columns: {
        travels_to_you: bool('Travels to you', { group: 'Where' }),
        travel_radius_mi: int('Travel radius', { search: 'min', group: 'Where', unit: 'mi' }),
        travel_fee: dec('Travel fee', { group: 'Where', unit: '$' }),
        studio_available: bool('Studio available', { group: 'Where' }),
        prints_available: bool('Prints available', { group: 'Included' }),
        digital_included: bool('Digital files included', { group: 'Included' }),
        raw_available: bool('RAW files available', { group: 'Included' }),
        second_shooter: bool('Second shooter available', { group: 'Included' }),
        drone_licensed: bool('Drone licensed', { group: 'Included' }),
        deposit: dec('Deposit', { group: 'Money', unit: '$' }),
        cancellation_policy: en('Cancellation', CANCELLATION, { group: 'Money' }),
    },
};

/* ══ venues ══════════════════════════════════════════════════════════════ */

const VENUE_SPACE = {
    table: 'venue_spaces',
    key: 'venue_entity_slug',
    // A venue's spaces are a list on the venue itself rather than separate
    // entities, because a ballroom is not a listing anyone links to.
    multiple: true,
    label: 'Spaces',
    amenities: { join: 'venue_space_amenities', fk: 'space_id' },
    columns: {
        name: txt('Space name', { group: 'Identity' }),
        space_type: en('Type', ['ballroom', 'deck', 'lawn', 'beach', 'private_room', 'whole_venue'], { group: 'Identity' }),
        standing_capacity: int('Standing capacity', { search: 'min', group: 'Size', unit: 'people' }),
        seated_capacity: int('Seated capacity', { search: 'min', group: 'Size', unit: 'people', required: true }),
        square_feet: int('Square feet', { search: 'min', group: 'Size', unit: 'sq ft' }),
        outdoor: bool('Outdoor', { group: 'Size' }),
        beachfront: bool('Beachfront', { group: 'Size' }),
        catering_inhouse: bool('In-house catering', { group: 'Services' }),
        outside_catering: bool('Outside catering allowed', { group: 'Services' }),
        bar_service: bool('Bar service', { group: 'Services' }),
        av_equipment: bool('A/V equipment', { group: 'Services' }),
        tables_chairs: bool('Tables & chairs', { group: 'Services' }),
        dance_floor: bool('Dance floor', { group: 'Services' }),
        parking_spaces: int('Parking spaces', { search: 'min', group: 'Services' }),
        hourly_rate: dec('Hourly rate', { search: 'max', group: 'Money', unit: '$' }),
        day_rate: dec('Day rate', { search: 'max', group: 'Money', unit: '$' }),
        minimum_spend: dec('Minimum spend', { search: 'max', group: 'Money', unit: '$' }),
    },
};

/* ══ the registry ════════════════════════════════════════════════════════ */

const SCHEMAS = {
    condo: { listing: STAY_PROPERTY, unit: STAY_UNIT, unit_label: 'Unit' },
    hotel: { listing: STAY_PROPERTY, unit: STAY_UNIT, unit_label: 'Room type' },
    charter: { listing: CHARTER_OPERATOR, unit: CHARTER_BOAT, unit_label: 'Boat' },
    cruise: { listing: CRUISE_OPERATOR, unit: CRUISE_VESSEL, unit_label: 'Vessel' },
    rental: { listing: RENTAL_OPERATOR, unit: RENTAL_ITEM, unit_label: 'Rental item' },
    watersport: { listing: WATERSPORT_OPERATOR, unit: null, unit_label: null },
    session: { listing: SESSION_PROVIDER, unit: null, unit_label: null },
    venue: { listing: VENUE_SPACE, unit: null, unit_label: 'Space' },
    other: { listing: null, unit: null, unit_label: null },
};

function schemaFor(vertical) {
    return SCHEMAS[vertical] || SCHEMAS.other;
}

/** Columns as a list, each carrying its own name — what a form iterates. */
function columnList(spec) {
    if (!spec) return [];
    return Object.entries(spec.columns).map(([name, def]) => ({ name, ...def }));
}

/**
 * Every searchable column across a vertical, tagged with where it lives.
 *
 * A name can legitimately exist on two tables — `max_anglers` is on both
 * `charter_boats` (how many the boat holds) and `charter_trips` (how many this
 * trip takes). Left alone, which one a filter hits would depend on the order
 * of this loop, which is exactly the kind of thing that works until someone
 * reorders the file. So duplicates are collapsed to the FIRST occurrence and
 * the others are recorded on `also_on`, making the choice explicit and stable
 * and letting the UI say where the number comes from.
 *
 * First means listing-level, then its collections, then unit-level — the order
 * below. For `max_anglers` that resolves to the trip, which is the right one:
 * "a charter for eight" is a question about the trip you can book, and the
 * boat's capacity is only the ceiling above it.
 */
function searchableFor(vertical) {
    const schema = schemaFor(vertical);
    const out = [];
    for (const level of ['listing', 'unit']) {
        const spec = schema[level];
        if (!spec) continue;
        for (const col of columnList(spec)) {
            if (col.search) out.push({ ...col, level, table: spec.table });
        }
        for (const coll of spec.collections || []) {
            for (const [name, def] of Object.entries(coll.columns)) {
                if (def.search) out.push({ name, ...def, level: 'collection', table: coll.table, fk: coll.fk });
            }
        }
        for (const tag of spec.tags || []) {
            out.push({
                name: tag.catalog, label: tag.label, type: 'tags', search: 'any',
                level, table: tag.join, catalog: tag.catalog, fk: tag.fk, catalogFk: tag.catalogFk,
            });
        }
        if (spec.amenities) {
            out.push({
                name: `${level}_amenities`, label: level === 'unit' ? 'Unit amenities' : 'Amenities',
                type: 'amenities', search: 'any', level, table: spec.amenities.join, fk: spec.amenities.fk,
            });
        }
    }

    const byName = new Map();
    for (const field of out) {
        const existing = byName.get(field.name);
        if (!existing) byName.set(field.name, { ...field });
        else (existing.also_on ||= []).push({ table: field.table, level: field.level });
    }
    return [...byName.values()];
}

/**
 * Coerce one submitted value to its column's type, or return `{ error }`.
 *
 * Done server-side and not trusted from the client, because a `bedrooms`
 * arriving as the string "2" would be stored fine by Postgres but a `view`
 * arriving as an unlisted string would sit in the table forever matching
 * nothing anyone can search for.
 */
function coerce(column, raw) {
    if (raw === null || raw === undefined || raw === '') return { value: null };

    switch (column.type) {
        case 'int': {
            const n = parseInt(raw, 10);
            if (!Number.isFinite(n)) return { error: `${column.label} must be a whole number` };
            return { value: n };
        }
        case 'decimal': {
            const n = Number(raw);
            if (!Number.isFinite(n)) return { error: `${column.label} must be a number` };
            return { value: n };
        }
        case 'bool':
            return { value: raw === true || raw === 'true' || raw === 1 || raw === '1' };
        case 'time': {
            const s = String(raw);
            if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return { error: `${column.label} must be a time like 16:00` };
            return { value: s.length === 5 ? `${s}:00` : s };
        }
        case 'enum': {
            const s = String(raw);
            if (column.options && !column.options.includes(s)) {
                return { error: `${column.label}: "${s}" is not one of ${column.options.join(', ')}` };
            }
            return { value: s };
        }
        default:
            return { value: String(raw).slice(0, 5000) };
    }
}

/** Validate and coerce a whole patch against a table spec. */
function coerceRow(spec, patch) {
    const row = {};
    const errors = [];
    for (const [name, raw] of Object.entries(patch || {})) {
        const column = spec.columns[name];
        if (!column) { errors.push(`Unknown field "${name}" on ${spec.table}`); continue; }
        const result = coerce({ ...column, name }, raw);
        if (result.error) { errors.push(result.error); continue; }
        row[name] = result.value;
    }
    return { row, errors };
}

module.exports = {
    SCHEMAS,
    schemaFor,
    columnList,
    searchableFor,
    coerce,
    coerceRow,
};
