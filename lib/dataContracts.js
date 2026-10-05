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
//   offerings        the catalogue: `listings.items` whole, `products.<kind>`
//                    by kind (no listings table exists; DECISIONS #62)
//
// Entry shape: { table, resource, filter?, fieldMap?, idColumn?, slugColumn?,
// columns?, readOnly?, single?, derived?, orderBy?, scalar?, pivot?, defaults?, dataKey? }
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
//   single      one record per business (business.profile): read and PATCH
//               only — no POST (it exists once) and no DELETE; a PATCH needs no
//               id, and an id given must be this business's record
//   derived     field → (row) => value: read-only fields computed from the
//               stored row at read time (business.profile.address_display);
//               a write that carries one drops it, since it is not a column
//   orderBy     columns a read is ordered by, in turn, each only when live
//   scalar      the column a one-value contract reads as { value } (business.currency)
//   pivot       { key, value, columns: [[RegExp, replacement]] }: the record's
//               matching columns become rows { id, <key>, <value> }, the id
//               being the column name rewritten by the rule; a row write maps
//               back to that column (business.links)
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

/**
 * The address on one line (DECISIONS #100): the street lines, then
 * "city, state zip" — each part only when set, so a business with no
 * address_line_2 or no zip reads cleanly.
 */
function addressDisplay(row) {
    const cityLine = [row.city, [row.state, row.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const out = [row.address_line_1, row.address_line_2, cityLine].map((v) => (typeof v === 'string' ? v.trim() : v)).filter(Boolean).join(', ');
    return out || null;
}

const CONTRACTS = {
    // ── the business record (entity, keyed by slug) ──
    // One record per business, writable for the owner-editable columns (the
    // same rule as the read side: lib/businessTables.js ownerProfilePatch),
    // PATCH only (DECISIONS #96). address_display is computed, never stored.
    'business.profile': { table: 'entity', resource: 'business', slugColumn: 'slug', idColumn: 'slug', single: true, derived: { address_display: addressDisplay } },
    // The link columns of entity, whatever the schema has (social_*, website_url),
    // pivoted into rows { id, network, url } (DECISIONS #63): the row id is the
    // column name without social_ (website_url → "website"); a write maps back.
    'business.links': {
        table: 'entity', resource: 'business', slugColumn: 'slug', idColumn: 'slug', columns: /^(slug|social_\w+|website_url)$/,
        pivot: { key: 'network', value: 'url', columns: [[/^social_([a-z0-9_]+)$/, '$1'], [/^(website)_url$/, '$1']] },
    },
    // Set by the owner (PATCH /api/owner/profile); null reads as the API's DEFAULT_CURRENCY.
    // A scalar contract (DECISIONS #56): read as { value }.
    'business.currency': { table: 'entity', resource: 'business', slugColumn: 'slug', idColumn: 'slug', readOnly: true, columns: /^(slug|currency)$/, defaults: { currency: { env: 'DEFAULT_CURRENCY' } }, scalar: 'currency' },

    // ── content streams, their real tables ──
    // Read in the owner's order, then by id (sql/nextgent_menu_items_order.sql, DECISIONS #65).
    'menu.items': { table: 'menu_items', resource: 'menu', dataKey: 'menu_items', orderBy: ['sort_order', 'id'] },
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

// listings.items (DECISIONS #44, #62): the catalogue whole — every offering
// of the business, `kind` a normal column the app filters on, no fixed kind.
CONTRACTS['listings.items'] = { table: 'offerings', resource: 'business' };

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
        single: entry.single === true,
        derived: entry.derived || null,
        defaults: entry.defaults || null,
        scalar: entry.scalar || null,
        pivot: entry.pivot || null,
        orderBy: entry.orderBy || [],
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

/** The derived (read-only, computed) field names of an entry. */
function derivedFields(entry) {
    return Object.keys(entry?.derived || {});
}

/**
 * A row as the contract names its fields: fieldMap applied, a null column
 * with a declared default read from the environment at call time, and the
 * derived fields computed from the stored row.
 */
function toContractRow(entry, row) {
    if (!row || typeof row !== 'object' || (!entry?.fieldMap && !entry?.defaults && !entry?.derived)) return row;
    const out = { ...row };
    for (const [column, rule] of Object.entries(entry.defaults || {})) {
        if (out[column] == null && rule?.env) out[column] = process.env[rule.env] || null;
    }
    for (const [field, compute] of Object.entries(entry.derived || {})) {
        if (typeof compute === 'function') out[field] = compute(row);
    }
    for (const [field, column] of Object.entries(entry.fieldMap || {})) {
        if (column in out) { out[field] = out[column]; if (field !== column) delete out[column]; }
    }
    return out;
}

/** A body as the table names its columns (fieldMap reversed, derived fields dropped), else the body itself. */
function toTableRow(entry, body) {
    if (!body || typeof body !== 'object' || (!entry?.fieldMap && !entry?.derived)) return body;
    const out = { ...body };
    for (const field of derivedFields(entry)) delete out[field];
    for (const [field, column] of Object.entries(entry.fieldMap || {})) {
        if (field in out) { out[column] = out[field]; if (field !== column) delete out[field]; }
    }
    return out;
}

/** The pivot id a column yields under this entry's rules, or null when it is not a pivot column. */
function pivotIdFor(entry, column) {
    for (const [re, replacement] of entry?.pivot?.columns || []) {
        if (re.test(column)) return column.replace(re, replacement);
    }
    return null;
}

/** One stored record of a pivot contract as rows { id, <key>, <value> }, one per set column. */
function pivotRows(entry, row, columnNames) {
    if (!entry?.pivot || !row) return [];
    const out = [];
    for (const column of columnNames || Object.keys(row)) {
        const id = pivotIdFor(entry, column);
        if (id === null || row[column] === null || row[column] === undefined || row[column] === '') continue;
        out.push({ id, [entry.pivot.key]: id, [entry.pivot.value]: row[column] });
    }
    return out;
}

/** The live column a pivot row id names, or null (no such column, or not a pivot column). */
function pivotColumnFor(entry, id, columnNames) {
    if (!entry?.pivot || typeof id !== 'string' || !id) return null;
    return (columnNames || []).find((c) => pivotIdFor(entry, c) === id) || null;
}

module.exports = {
    CONTRACTS,
    pivotIdFor,
    pivotRows,
    pivotColumnFor,
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
    derivedFields,
    addressDisplay,
};
