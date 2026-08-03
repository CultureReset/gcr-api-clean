// ============================================================
// CAPABILITIES — a map over the real tables in sql/capability_tables.sql
// ============================================================
//
// A capability is a THING a business can have: units, boats, trips, gear,
// packages, spaces, plus one row of operating details. Not an industry.
//
//   ANY slug can have ANY capability.
//
// `entity.entity_type` / `entity_subtype` already say what a business is;
// nothing here re-states it and nothing here gates on it. A marina that runs
// charters, rents pontoons and has a restaurant uses `boats`, `trips`, `gear`
// and `spaces` — the same four tables a hotel would use for its own boat, its
// own sunset cruise, its own bikes and its own ballroom.
//
// This file stores nothing. It describes the columns so a form can be built
// and a search can pick a comparison, and scripts/check-capability-columns.mjs
// fails the build if it ever names a column the SQL does not create.
//
// ── Column descriptor ───────────────────────────────────────────────────
//
//   type    'int' | 'decimal' | 'text' | 'bool' | 'time'
//   search  'min' | 'max' | 'eq' | 'has' | null
//             min  at least this   (bedrooms >= 2)
//             max  at most this    (nightly_rate <= 400)
//             eq   exact match     (unit_number, boat_type)
//             has  must be true    (has_ac)
//             null stored and shown, never filtered on
//   group   which fieldset it belongs in
//   unit    shown after the value: ft, hours, people, $

const int = (label, extra = {}) => ({ label, type: 'int', ...extra });
const dec = (label, extra = {}) => ({ label, type: 'decimal', ...extra });
const txt = (label, extra = {}) => ({ label, type: 'text', ...extra });
const bool = (label, extra = {}) => ({ label, type: 'bool', search: 'has', ...extra });
const time = (label, extra = {}) => ({ label, type: 'time', ...extra });
// A `text` column with a known set of values. Still text in Postgres — the
// list is a hint for the form, not a constraint, so a business can enter
// something nobody thought of.
const pick = (label, suggestions, extra = {}) =>
    ({ label, type: 'text', suggestions, search: 'eq', ...extra });

const CAPABILITIES = {

    /* One row per business. Every column optional; fill in what applies. */
    operations: {
        table: 'entity_operations',
        key: 'entity_slug',
        single: true,
        label: 'How they operate',
        hint: 'Everything that is true of the business as a whole. Any business can use any of it.',
        columns: {
            departs_from: txt('Departs from / meet at', { group: 'Where' }),
            dock_number: txt('Dock or slip', { group: 'Where' }),
            meeting_instructions: txt('Meeting instructions', { group: 'Where', long: true }),

            crew_count: int('Crew', { group: 'Who runs it' }),
            captains: int('Captains', { group: 'Who runs it' }),
            guides: int('Guides', { group: 'Who runs it' }),
            licensed: bool('Licensed', { group: 'Who runs it' }),
            license_number: txt('Licence number', { group: 'Who runs it' }),
            insured: bool('Insured', { group: 'Who runs it' }),
            years_operating: int('Years operating', { search: 'min', group: 'Who runs it' }),

            min_age: int('Minimum age', { search: 'max', group: 'Who can book' }),
            max_age: int('Maximum age', { group: 'Who can book' }),
            min_weight_lb: int('Minimum weight', { group: 'Who can book', unit: 'lb' }),
            max_weight_lb: int('Maximum weight', { search: 'min', group: 'Who can book', unit: 'lb' }),
            license_required: bool('Licence required', { group: 'Who can book' }),
            id_required: bool('ID required', { group: 'Who can book' }),

            gear_included: bool('Gear included', { group: 'Included' }),
            instruction_included: bool('Instruction included', { group: 'Included' }),
            fuel_included: bool('Fuel included', { group: 'Included' }),
            bait_included: bool('Bait included', { group: 'Included' }),
            ice_included: bool('Ice included', { group: 'Included' }),
            cleaning_included: bool('Cleaning included', { group: 'Included' }),
            photos_included: bool('Photos included', { group: 'Included' }),
            linens_included: bool('Linens included', { group: 'Included' }),
            food_included: bool('Food included', { group: 'Included' }),

            pets_allowed: bool('Pets allowed', { group: 'Rules' }),
            smoking_allowed: bool('Smoking allowed', { group: 'Rules' }),
            alcohol_allowed: bool('Alcohol allowed', { group: 'Rules' }),
            byob_allowed: bool('BYOB allowed', { group: 'Rules' }),
            events_allowed: bool('Events allowed', { group: 'Rules' }),

            delivery_available: bool('Delivers', { group: 'Getting there' }),
            delivery_fee: dec('Delivery fee', { group: 'Getting there', unit: '$' }),
            travels_to_customer: bool('Travels to the customer', { group: 'Getting there' }),
            travel_radius_mi: int('Travel radius', { search: 'min', group: 'Getting there', unit: 'mi' }),
            travel_fee: dec('Travel fee', { group: 'Getting there', unit: '$' }),
            captain_available: bool('Captain available', { group: 'Getting there' }),
            captain_rate: dec('Captain rate', { group: 'Getting there', unit: '$' }),

            deposit_percent: dec('Deposit', { group: 'Money', unit: '%' }),
            deposit_amount: dec('Deposit amount', { group: 'Money', unit: '$' }),
            security_deposit: dec('Security deposit', { group: 'Money', unit: '$' }),
            cancellation_policy: pick('Cancellation', ['flexible', 'moderate', 'strict', 'non_refundable'], { group: 'Money' }),
            weather_policy: txt('Weather policy', { group: 'Money', long: true }),
            tax_rate: dec('Tax rate', { group: 'Money', unit: '%' }),

            check_in_time: time('Check-in', { group: 'Timing' }),
            check_out_time: time('Check-out', { group: 'Timing' }),
            turnaround_days: int('Turnaround', { search: 'max', group: 'Timing', unit: 'days' }),

            beachfront: bool('Beachfront', { group: 'The place' }),
            distance_to_beach_ft: int('Distance to the beach', { search: 'max', group: 'The place', unit: 'ft' }),
            floors: int('Floors', { group: 'The place' }),
            year_built: int('Year built', { group: 'The place' }),
            renovated_year: int('Last renovated', { group: 'The place' }),
            total_units: int('Units in the building', { group: 'The place' }),
            front_desk_24h: bool('Front desk 24/7', { group: 'The place' }),
            housekeeping_daily: bool('Daily housekeeping', { group: 'The place' }),
            security_onsite: bool('Security on site', { group: 'The place' }),
            gated: bool('Gated', { group: 'The place' }),
            elevator: bool('Elevator', { group: 'The place' }),
            wheelchair_accessible: bool('Wheelchair accessible', { group: 'The place' }),
            parking_type: pick('Parking', ['covered', 'surface', 'garage', 'street', 'valet', 'none'], { group: 'The place' }),
            parking_spaces: int('Parking spaces', { search: 'min', group: 'The place' }),
            parking_notes: txt('Parking notes', { group: 'The place' }),
            management_company: txt('Management company', { group: 'The place' }),
        },
    },

    /* Anything with bedrooms. */
    units: {
        table: 'units',
        key: 'entity_slug',
        label: 'Units',
        hint: 'A condo unit, a hotel room, a cabin, a whole house.',
        amenities: { join: 'unit_amenities', fk: 'unit_id' },
        children: [{
            table: 'unit_beds',
            fk: 'unit_id',
            label: 'Beds',
            columns: {
                room_name: txt('Room'),
                room_type: pick('Room type', ['bedroom', 'living', 'loft', 'den', 'bunk_room']),
                bed_type: pick('Bed', ['king', 'queen', 'full', 'twin', 'bunk', 'sofa_bed', 'murphy'], { required: true }),
                quantity: int('How many'),
            },
        }],
        columns: {
            name: txt('Name', { group: 'Identity' }),
            unit_number: txt('Unit number', { search: 'eq', group: 'Identity' }),
            unit_type: pick('Type', ['condo', 'suite', 'studio', 'villa', 'room', 'cabin', 'house'], { group: 'Identity' }),
            floor: int('Floor', { search: 'min', group: 'Identity' }),
            quantity: int('How many of this', { search: 'min', group: 'Identity' }),

            bedrooms: int('Bedrooms', { search: 'min', group: 'Layout', required: true }),
            bathrooms: dec('Bathrooms', { search: 'min', group: 'Layout', step: 0.5, required: true }),
            half_baths: int('Half baths', { group: 'Layout' }),
            sleeps: int('Sleeps', { search: 'min', group: 'Layout', unit: 'people', required: true }),
            square_feet: int('Square feet', { search: 'min', group: 'Layout', unit: 'sq ft' }),

            view: pick('View', ['gulf_front', 'gulf_view', 'side_gulf', 'bay', 'lagoon', 'pool', 'parking', 'none'], { group: 'The place' }),
            balcony: bool('Balcony', { group: 'The place' }),
            balcony_count: int('Balconies', { group: 'The place' }),
            ground_floor: bool('Ground floor', { group: 'The place' }),
            elevator_access: bool('Elevator access', { group: 'The place' }),
            wheelchair_accessible: bool('Wheelchair accessible', { group: 'The place' }),

            min_nights: int('Minimum nights', { search: 'max', group: 'Rules', unit: 'nights' }),
            max_nights: int('Maximum nights', { group: 'Rules', unit: 'nights' }),
            max_guests: int('Maximum guests', { search: 'min', group: 'Rules', unit: 'people' }),
            pet_friendly: bool('Pets allowed', { group: 'Rules' }),
            pet_fee: dec('Pet fee', { group: 'Rules', unit: '$' }),
            max_pets: int('Maximum pets', { search: 'min', group: 'Rules' }),

            nightly_rate: dec('Nightly', { search: 'max', group: 'Money', unit: '$' }),
            weekly_rate: dec('Weekly', { search: 'max', group: 'Money', unit: '$' }),
            monthly_rate: dec('Monthly', { group: 'Money', unit: '$' }),
            cleaning_fee: dec('Cleaning fee', { group: 'Money', unit: '$' }),

            description: txt('Description', { group: 'Words', long: true }),
            house_rules: txt('House rules', { group: 'Words', long: true }),
        },
    },

    /* Anything that floats and carries people. */
    boats: {
        table: 'boats',
        key: 'entity_slug',
        label: 'Boats',
        hint: 'A charter boat, a cruise catamaran, a rental pontoon, a jet ski.',
        amenities: { join: 'boat_amenities', fk: 'boat_id' },
        columns: {
            name: txt('Boat name', { group: 'Identity' }),
            boat_type: pick('Type', ['sportfish', 'center_console', 'pontoon', 'deck_boat', 'catamaran',
                'sailboat', 'yacht', 'jet_ski', 'kayak', 'paddleboard'], { group: 'Identity' }),
            make: txt('Make', { group: 'Identity' }),
            model: txt('Model', { group: 'Identity' }),
            year: int('Year', { search: 'min', group: 'Identity' }),
            quantity: int('How many of this', { search: 'min', group: 'Identity' }),

            length_ft: dec('Length', { search: 'min', group: 'The boat', unit: 'ft' }),
            beam_ft: dec('Beam', { group: 'The boat', unit: 'ft' }),
            max_passengers: int('Maximum passengers', { search: 'min', group: 'The boat', unit: 'people' }),
            max_anglers: int('Maximum anglers', { search: 'min', group: 'The boat', unit: 'people' }),
            engines: int('Engines', { group: 'The boat' }),
            engine_hp: int('Horsepower', { search: 'min', group: 'The boat', unit: 'hp' }),
            cruising_speed_kn: dec('Cruising speed', { search: 'min', group: 'The boat', unit: 'kn' }),
            fuel_capacity_gal: int('Fuel capacity', { group: 'The boat', unit: 'gal' }),
            max_range_mi: int('Range', { search: 'min', group: 'The boat', unit: 'mi' }),

            has_head: bool('Head (toilet)', { group: 'On board' }),
            has_ac: bool('Air conditioning', { group: 'On board' }),
            has_cabin: bool('Enclosed cabin', { group: 'On board' }),
            has_shade: bool('Shade / T-top', { group: 'On board' }),
            has_galley: bool('Galley', { group: 'On board' }),
            has_stereo: bool('Stereo', { group: 'On board' }),
            has_ladder: bool('Swim ladder', { group: 'On board' }),
            wheelchair_accessible: bool('Wheelchair accessible', { group: 'On board' }),
            has_livewell: bool('Livewell', { group: 'Fishing' }),
            has_fishfinder: bool('Fish finder / sonar', { group: 'Fishing' }),
            has_radar: bool('Radar', { group: 'Fishing' }),
            has_outriggers: bool('Outriggers', { group: 'Fishing' }),
            has_fighting_chair: bool('Fighting chair', { group: 'Fishing' }),

            hourly_rate: dec('Hourly', { search: 'max', group: 'Rented directly', unit: '$' }),
            half_day_rate: dec('Half day', { search: 'max', group: 'Rented directly', unit: '$' }),
            full_day_rate: dec('Full day', { search: 'max', group: 'Rented directly', unit: '$' }),
            weekly_rate: dec('Weekly', { group: 'Rented directly', unit: '$' }),
            notes: txt('Notes', { group: 'Rented directly', long: true }),
        },
    },

    /* Anything with a departure time and a duration. */
    trips: {
        table: 'trips',
        key: 'entity_slug',
        label: 'Trips',
        hint: 'An 8-hour offshore charter, a sunset cruise, a parasail flight, a kayak tour.',
        columns: {
            name: txt('Name', { group: 'The trip' }),
            trip_type: pick('Type', ['inshore', 'nearshore', 'offshore', 'deep_sea', 'bottom', 'trolling',
                'dolphin', 'sunset', 'sightseeing', 'dinner', 'party', 'eco',
                'parasail', 'snorkel', 'dive', 'kayak', 'walking'], { group: 'The trip' }),
            duration_hours: dec('Hours', { search: 'min', group: 'The trip', unit: 'hours' }),
            min_guests: int('Minimum guests', { group: 'The trip' }),
            max_guests: int('Maximum guests', { search: 'min', group: 'The trip', unit: 'people' }),
            departure_time: time('Departs', { group: 'The trip' }),
            return_time: time('Returns', { group: 'The trip' }),
            is_private: bool('Private', { group: 'The trip' }),
            narrated: bool('Narrated', { group: 'The trip' }),
            guarantee: txt('Guarantee', { group: 'The trip' }),

            price: dec('Price', { search: 'max', group: 'Money', unit: '$' }),
            price_unit: pick('Priced per', ['trip', 'person'], { group: 'Money' }),
            child_price: dec('Child price', { search: 'max', group: 'Money', unit: '$' }),
            extra_person_fee: dec('Extra person', { group: 'Money', unit: '$' }),
            notes: txt('Notes', { group: 'Money', long: true }),
        },
    },

    /* Anything you rent that is not a boat or a unit. */
    gear: {
        table: 'gear',
        key: 'entity_slug',
        label: 'Gear',
        hint: 'Golf carts, bikes, beach chairs, kayaks, coolers.',
        columns: {
            name: txt('Name', { group: 'The item' }),
            gear_type: pick('Type', ['golf_cart', 'bike', 'scooter', 'beach_chair', 'umbrella',
                'kayak', 'paddleboard', 'snorkel_set', 'fishing_rod', 'cooler', 'wagon'], { group: 'The item' }),
            make: txt('Make', { group: 'The item' }),
            model: txt('Model', { group: 'The item' }),
            year: int('Year', { group: 'The item' }),
            capacity: int('Capacity', { search: 'min', group: 'The item', unit: 'people' }),
            quantity: int('How many', { search: 'min', group: 'The item' }),
            hourly_rate: dec('Hourly', { search: 'max', group: 'Money', unit: '$' }),
            daily_rate: dec('Daily', { search: 'max', group: 'Money', unit: '$' }),
            weekly_rate: dec('Weekly', { group: 'Money', unit: '$' }),
            delivery_included: bool('Delivery included', { group: 'Money' }),
            notes: txt('Notes', { group: 'Money', long: true }),
        },
    },

    /* A priced thing with a duration but no departure. */
    packages: {
        table: 'packages',
        key: 'entity_slug',
        label: 'Packages',
        hint: 'A photo session, a spa treatment, a surf lesson, a guided walk.',
        columns: {
            name: txt('Name', { group: 'The package' }),
            package_type: pick('Type', ['family', 'engagement', 'wedding', 'maternity', 'newborn',
                'senior', 'headshot', 'event', 'real_estate', 'massage', 'facial', 'lesson'], { group: 'The package' }),
            length_minutes: int('Length', { search: 'min', group: 'The package', unit: 'minutes' }),
            max_people: int('Maximum people', { search: 'min', group: 'The package', unit: 'people' }),
            deliverables: int('Deliverables', { search: 'min', group: 'The package' }),
            turnaround_days: int('Turnaround', { search: 'max', group: 'The package', unit: 'days' }),
            outfit_changes: int('Outfit changes', { group: 'The package' }),
            locations_count: int('Locations', { group: 'The package' }),
            price: dec('Price', { search: 'max', group: 'Money', unit: '$' }),
            deposit: dec('Deposit', { group: 'Money', unit: '$' }),
            notes: txt('Notes', { group: 'Money', long: true }),
        },
    },

    /* Anything with a capacity you book by the hour or the day. */
    spaces: {
        table: 'spaces',
        key: 'entity_slug',
        label: 'Spaces',
        hint: 'A ballroom, a beach deck, a restaurant’s private dining room, a conference room.',
        amenities: { join: 'space_amenities', fk: 'space_id' },
        children: [{
            table: 'space_event_types',
            fk: 'space_id',
            label: 'Event types',
            noId: true,     // composite primary key, no id column
            columns: {
                event_type: pick('Event type',
                    ['wedding', 'reception', 'corporate', 'birthday', 'conference', 'concert', 'reunion'],
                    { required: true }),
            },
        }],
        columns: {
            name: txt('Name', { group: 'The space' }),
            space_type: pick('Type', ['ballroom', 'deck', 'lawn', 'beach', 'private_dining',
                'conference', 'whole_venue', 'patio'], { group: 'The space' }),
            standing_capacity: int('Standing capacity', { search: 'min', group: 'Size', unit: 'people' }),
            seated_capacity: int('Seated capacity', { search: 'min', group: 'Size', unit: 'people' }),
            square_feet: int('Square feet', { search: 'min', group: 'Size', unit: 'sq ft' }),
            outdoor: bool('Outdoor', { group: 'Size' }),
            beachfront: bool('Beachfront', { group: 'Size' }),
            catering_inhouse: bool('In-house catering', { group: 'Services' }),
            outside_catering: bool('Outside catering allowed', { group: 'Services' }),
            bar_service: bool('Bar service', { group: 'Services' }),
            av_equipment: bool('A/V equipment', { group: 'Services' }),
            tables_chairs: bool('Tables & chairs', { group: 'Services' }),
            dance_floor: bool('Dance floor', { group: 'Services' }),
            hourly_rate: dec('Hourly', { search: 'max', group: 'Money', unit: '$' }),
            day_rate: dec('Day rate', { search: 'max', group: 'Money', unit: '$' }),
            minimum_spend: dec('Minimum spend', { search: 'max', group: 'Money', unit: '$' }),
            notes: txt('Notes', { group: 'Money', long: true }),
        },
    },
};

/**
 * Lists attached to the business itself. Catalog plus join, never free text,
 * so "who targets red snapper" is an index lookup.
 */
const ENTITY_LISTS = {
    amenities: { join: 'entity_amenities', catalog: 'amenities', catalogFk: 'amenity_id', label: 'Amenities' },
    species: { join: 'entity_species', catalog: 'species', catalogFk: 'species_id', label: 'Target species' },
    activities: { join: 'entity_activities', catalog: 'activities', catalogFk: 'activity_id', label: 'Activities' },
};

/**
 * Which capabilities are worth showing first for a given subtype.
 *
 * A SUGGESTION, never a restriction — every capability is offered to every
 * business. This only decides what is open when the page loads, so a fishing
 * charter is not scrolling past Packages to find Boats.
 */
const SUGGESTIONS = [
    { match: /charter|fishing|deep.?sea|offshore/i, capabilities: ['boats', 'trips', 'operations'] },
    { match: /cruise|dolphin|sunset|sightsee|tour/i, capabilities: ['boats', 'trips', 'operations'] },
    { match: /parasail|jet.?ski|wave.?runner|snorkel|scuba|dive|kayak|paddle|surf/i, capabilities: ['trips', 'gear', 'operations'] },
    { match: /rental|rent-|marina|pontoon|bike|golf.?cart/i, capabilities: ['boats', 'gear', 'operations'] },
    { match: /condo|hotel|resort|vacation|villa|cabin|lodge/i, capabilities: ['units', 'operations'] },
    { match: /photograph|photo|spa|salon|massage|lesson|instructor|guide/i, capabilities: ['packages', 'operations'] },
    { match: /venue|event|wedding|banquet|restaurant|bar|brewery/i, capabilities: ['spaces', 'operations'] },
];

function suggestedFor(entity) {
    const haystack = `${entity?.entity_type || ''} ${entity?.entity_subtype || ''}`;
    for (const rule of SUGGESTIONS) {
        if (rule.match.test(haystack)) return rule.capabilities;
    }
    return ['operations'];
}

/** Columns as a list, each carrying its own name — what a form iterates. */
function columnList(capability) {
    if (!capability) return [];
    return Object.entries(capability.columns).map(([name, def]) => ({ name, ...def }));
}

/**
 * Every searchable column, tagged with the capability it belongs to.
 *
 * The capability qualifies the name, so `max_guests` on a trip and
 * `max_guests` on a unit are two different filters rather than one ambiguous
 * one. The wire name is `capability.column`.
 */
function searchable() {
    const out = [];
    for (const [key, capability] of Object.entries(CAPABILITIES)) {
        for (const column of columnList(capability)) {
            if (column.search) {
                out.push({ ...column, id: `${key}.${column.name}`, capability: key, table: capability.table });
            }
        }
        for (const child of capability.children || []) {
            for (const [name, def] of Object.entries(child.columns)) {
                if (def.search) {
                    out.push({ name, ...def, id: `${key}.${child.table}.${name}`, capability: key, table: child.table, fk: child.fk });
                }
            }
        }
        if (capability.amenities) {
            out.push({
                name: 'amenities', label: `${capability.label} amenities`, type: 'catalog',
                search: 'any', catalog: 'amenities',
                id: `${key}.amenities`, capability: key,
                table: capability.amenities.join, fk: capability.amenities.fk,
            });
        }
    }
    for (const [key, list] of Object.entries(ENTITY_LISTS)) {
        out.push({
            name: key, label: list.label, type: 'catalog', search: 'any',
            catalog: list.catalog, id: `entity.${key}`, capability: 'entity',
            table: list.join, catalogFk: list.catalogFk,
        });
    }
    return out;
}

function fieldById(id) {
    return searchable().find((f) => f.id === id) || null;
}

/** Coerce one value to its column's type, or return `{ error }`. */
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
        default:
            // `suggestions` are a hint for the form, deliberately not enforced:
            // a business that calls its boat something nobody listed should be
            // able to say so.
            return { value: String(raw).slice(0, 5000) };
    }
}

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
    CAPABILITIES,
    ENTITY_LISTS,
    suggestedFor,
    columnList,
    searchable,
    fieldById,
    coerce,
    coerceRow,
};
