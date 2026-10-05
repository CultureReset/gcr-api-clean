// ============================================================
// DATA CONTRACTS — the one registry of contract name → business table
// ============================================================
//
// A contract is the dotted name an app binds to (CONS §3–§5, DECISIONS #45):
// `menu.items`, `media.images`, `booking.records` … Each names ONE table of the
// business's data, an optional server-side filter (offerings kind=product), and
// the permission resource a token needs (`<resource>:read`, `<resource>:write`;
// an app's `access: read-write` is both — write never implies read).
//
// This file is pure: no database, no requires. Three readers share it, so the
// mapping exists once:
//
//   routes/platform.js        the legacy dashboard's dataKey dispatch
//                             (bookings, photos, specials … → the real table)
//   lib/businessTables.js     resolving `/api/business/<contract>` and the
//                             public read of an app's business source
//   routes/mcp.js             an installed app's actions, as tools
//
// Entry shape: { table, resource, filter?, fieldMap?, idColumn?, slugColumn?,
// columns?, readOnly?, dataKey? }
//   filter      columns every row of the contract carries — applied to reads,
//               stamped on inserts, so a contract never reaches another kind
//   fieldMap    contract field → table column, when an app's field names are
//               not the table's (DECISIONS #45: default is the column names)
//   idColumn    the row id (default `id`)
//   slugColumn  the business key (default `entity_slug`; `entity` is keyed by
//               `slug`)
//   columns     a RegExp a column must match to be part of the contract (a
//               view over a wide table — business.links is the link columns
//               of `entity`, read from the live schema, not a list of networks)
//   readOnly    reads only; the write goes through the table's own route
//   dataKey     the legacy dashboard's key for the same stream

/**
 * How the legacy dashboard keys the catalogue: dataKey → offerings.kind. One
 * `offerings` table; the kind is data. Lives here (not routes/platform.js) so
 * the contracts `products.<kind>` and the dashboard agree on the kinds.
 */
const OFFERING_KINDS = Object.freeze({
    services: 'service', fleet_items: 'fleet', properties: 'room', addons: 'addon',
    inventory: 'item', gift_cards: 'gift_card', memberships: 'membership', products: 'product',
});

/** Every booking-type dataKey the legacy dashboard writes to the one `bookings` table. */
const BOOKING_KEYS = Object.freeze(['bookings', 'charter_trips', 'boat_rentals', 'lodging_bookings', 'class_bookings',
    'photo_sessions', 'salon_bookings', 'reservations', 'tour_tickets', 'ride_requests', 'orders', 'appointments']);

const CONTRACTS = {
    // ── the business record (entity, keyed by slug) ──
    'business.profile': { table: 'entity', resource: 'business', slugColumn: 'slug', idColumn: 'slug', readOnly: true },
    // The link columns of entity, whatever the schema has (social_*, website_url).
    'business.links': { table: 'entity', resource: 'business', slugColumn: 'slug', idColumn: 'slug', readOnly: true, columns: /^(slug|social_\w+|website_url)$/ },

    // ── content streams, their real tables ──
    'menu.items': { table: 'menu_items', resource: 'menu', dataKey: 'menu_items' },
    'menu.sections': { table: 'menu_sections', resource: 'menu' },
    'media.images': { table: 'entity_photos', resource: 'business', dataKey: 'photos' },
    'reviews.items': { table: 'entity_reviews', resource: 'reviews', dataKey: 'reviews' },
    'events.items': { table: 'entity_events', resource: 'events', dataKey: 'events' },
    'specials.items': { table: 'entity_specials', resource: 'events', dataKey: 'specials' },
    'faqs.items': { table: 'faqs', resource: 'business', dataKey: 'faqs' },
    'coupons.items': { table: 'promos', resource: 'business', dataKey: 'coupons' },
    'waivers.items': { table: 'waivers', resource: 'bookings', dataKey: 'waivers' },

    // ── bookings and the calendar ──
    'booking.records': { table: 'bookings', resource: 'bookings', dataKey: 'bookings' },
    'availability.claims': { table: 'booking_calendar', resource: 'availability', dataKey: 'blocks' },
};

// products.<kind>: one contract per offerings kind, products.items = kind product.
for (const [dataKey, kind] of Object.entries(OFFERING_KINDS)) {
    CONTRACTS[`products.${kind}`] = { table: 'offerings', resource: 'business', filter: { kind }, dataKey };
}
CONTRACTS['products.items'] = CONTRACTS['products.product'];

Object.freeze(CONTRACTS);

const CONTRACT_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** Is this a contract name (dotted) rather than a raw table name? */
function isContractName(name) {
    return typeof name === 'string' && CONTRACT_NAME.test(name);
}

/** The registry entry for a contract, with defaults filled, or null. */
function contractFor(name) {
    if (!isContractName(name) || !Object.prototype.hasOwnProperty.call(CONTRACTS, name)) return null;
    const entry = CONTRACTS[name];
    return {
        contract: name,
        table: entry.table,
        resource: entry.resource,
        filter: entry.filter || {},
        fieldMap: entry.fieldMap || null,
        idColumn: entry.idColumn || 'id',
        slugColumn: entry.slugColumn || 'entity_slug',
        columns: entry.columns || null,
        readOnly: entry.readOnly === true,
    };
}

/** Every contract name. */
function contractNames() {
    return Object.keys(CONTRACTS);
}

/** The contract name a legacy dataKey maps to, or null (the generic store). */
function contractForDataKey(dataKey) {
    if (BOOKING_KEYS.includes(dataKey)) return 'booking.records';
    if (OFFERING_KINDS[dataKey]) return `products.${OFFERING_KINDS[dataKey]}`;
    const hit = Object.entries(CONTRACTS).find(([, e]) => e.dataKey === dataKey);
    return hit ? hit[0] : null;
}

/** The real table a legacy dataKey writes, or null when it lands in the generic section store. */
function tableForDataKey(dataKey) {
    const name = contractForDataKey(dataKey);
    return name ? CONTRACTS[name].table : null;
}

/** The contract whose table this is (the first declared), or null. */
function contractForTable(table) {
    const hit = Object.entries(CONTRACTS).find(([, e]) => e.table === table && !e.filter);
    return hit ? hit[0] : null;
}

/** A row as the contract names its fields (fieldMap applied), else the row itself. */
function toContractRow(entry, row) {
    if (!row || typeof row !== 'object' || !entry?.fieldMap) return row;
    const out = { ...row };
    for (const [field, column] of Object.entries(entry.fieldMap)) {
        if (column in out) { out[field] = out[column]; if (field !== column) delete out[column]; }
    }
    return out;
}

/** A body as the table names its columns (fieldMap reversed), else the body itself. */
function toTableRow(entry, body) {
    if (!body || typeof body !== 'object' || !entry?.fieldMap) return body;
    const out = { ...body };
    for (const [field, column] of Object.entries(entry.fieldMap)) {
        if (field in out) { out[column] = out[field]; if (field !== column) delete out[field]; }
    }
    return out;
}

module.exports = {
    CONTRACTS,
    OFFERING_KINDS,
    BOOKING_KEYS,
    isContractName,
    contractFor,
    contractNames,
    contractForDataKey,
    contractForTable,
    tableForDataKey,
    toContractRow,
    toTableRow,
};
