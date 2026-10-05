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
// Canonical tables (SPEC §12.6, DECISIONS #44, #53):
//   faqs             canonical FAQ table (`faqs.items`); `entity_faqs`
//                    (routes/faqs.js) is legacy and retires after parity
//   bookings         canonical booking record (`booking.records`);
//                    `booking_calendar` mirrors each as a claim; `entity_bookings`
//                    (routes/bookings.js) is legacy and retires after parity
//   entity_leads     enquiries (`leads.items`), per business
//   entity_customers the customer record (`customers.items`), per business
//                    (DECISIONS #49) — sql/nextgent_business_contacts.sql
//   entity.currency  the business's currency (`business.currency`) —
//                    sql/nextgent_business_currency.sql
//
// Entry shape: { table, resource, filter?, fieldMap?, idColumn?, slugColumn?,
// columns?, readOnly?, scalar?, defaults?, dataKey? }
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
//   scalar      the column a one-value contract reads as { value } (business.currency)
//   defaults    column → { env }: a null column reads as that environment
//               value (business.currency → DEFAULT_CURRENCY); nothing here
//               decides a value for every business
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
    // Set by the owner (PATCH /api/owner/profile); null reads as the API's DEFAULT_CURRENCY.
    // A scalar contract (DECISIONS #56): read as { value }.
    'business.currency': { table: 'entity', resource: 'business', slugColumn: 'slug', idColumn: 'slug', readOnly: true, columns: /^(slug|currency)$/, defaults: { currency: { env: 'DEFAULT_CURRENCY' } }, scalar: 'currency' },

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

    // ── people (DECISIONS #44, #49, #59: per business, on the `contacts`
    // resource — not `business`, which every app that reads the menu or the
    // hours holds). The raw table names take the same resource through the
    // registry (lib/businessTables.js resourceForTable). They are records of
    // people (whyPrivate), so they never reach a public page.
    'leads.items': { table: 'entity_leads', resource: 'contacts' },
    'customers.items': { table: 'entity_customers', resource: 'contacts' },
};

// products.<kind>: one contract per offerings kind, products.items = kind product.
for (const [dataKey, kind] of Object.entries(OFFERING_KINDS)) {
    CONTRACTS[`products.${kind}`] = { table: 'offerings', resource: 'business', filter: { kind }, dataKey };
}
CONTRACTS['products.items'] = CONTRACTS['products.product'];

Object.freeze(CONTRACTS);

// Segments are [a-z][a-z0-9_-]* (DECISIONS #54: dashes, since app keys carry them).
const CONTRACT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;

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
        defaults: entry.defaults || null,
        scalar: entry.scalar || null,
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

/**
 * A row as the contract names its fields: fieldMap applied, and a null column
 * with a declared default read from the environment at call time.
 */
function toContractRow(entry, row) {
    if (!row || typeof row !== 'object' || (!entry?.fieldMap && !entry?.defaults)) return row;
    const out = { ...row };
    for (const [column, rule] of Object.entries(entry.defaults || {})) {
        if (out[column] == null && rule?.env) out[column] = process.env[rule.env] || null;
    }
    for (const [field, column] of Object.entries(entry.fieldMap || {})) {
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
