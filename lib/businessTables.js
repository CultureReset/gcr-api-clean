// ============================================================
// BUSINESS TABLES — the live schema, the allow-list, the column filter
// ============================================================
//
// Lifted out of routes/business-data.js so the MCP server can use the same
// three guards the dashboard does. There must only ever be one copy of this:
// the column filter is the thing standing between a caller and reassigning its
// own row to another business's slug, and two copies of a security check drift
// until one of them has a hole in it.
//
// Nothing here carries a list of tables. PostgREST publishes an OpenAPI
// document describing every table it can see, and the service key sees all of
// them. Any table with an entity_slug column is a business section by
// definition — add a table to the database and it appears, drop one and it
// disappears, with no deploy in between.

const SUPABASE_URL = process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const SCHEMA_TTL_MS = 5 * 60 * 1000;
let schemaCache = null; // { tables, columns, at }
let schemaPromise = null; // in-flight read, so a cold start fans in to one

/** Columns a business must never set by hand: identity, ownership, bookkeeping. */
const SYSTEM_COLUMNS = new Set([
    'id',
    'entity_slug',
    'entity_id',
    'site_id',
    'created_at',
    'updated_at',
    'search_vector',
    'embedding',
]);

async function readSchema() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            Accept: 'application/openapi+json',
        },
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Schema read failed (${res.status})`);
    const spec = await res.json();

    const defs = spec.definitions || spec.components?.schemas || {};
    const columns = {};
    const tables = [];

    for (const [name, def] of Object.entries(defs)) {
        const props = def?.properties;
        if (!props || !Object.prototype.hasOwnProperty.call(props, 'entity_slug')) continue;
        tables.push(name);
        columns[name] = Object.entries(props).map(([col, spec]) => ({
            name: col,
            type: spec.type || 'string',
            format: spec.format || '',
            enum: spec.enum || null,
            // PostgREST describes generated and identity columns in prose.
            readOnly: /generated|identity/i.test(spec.description || ''),
            editable: !SYSTEM_COLUMNS.has(col) && !/generated|identity/i.test(spec.description || ''),
        }));
    }

    tables.sort();
    return { tables, columns, at: Date.now() };
}

/** The live slug-table schema, at most five minutes old. */
async function getSchema() {
    if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache;
    if (!schemaPromise) {
        schemaPromise = readSchema()
            .then((fresh) => {
                schemaCache = fresh;
                return fresh;
            })
            .finally(() => {
                schemaPromise = null;
            });
    }
    try {
        return await schemaPromise;
    } catch (err) {
        // A stale schema beats no dashboard at all — the table list barely
        // moves, and the next request tries again.
        if (schemaCache) return schemaCache;
        throw err;
    }
}

/**
 * Resolve a table name against the live allow-list.
 *
 * Returns the table name only if the database actually has a slug-scoped table
 * by that name. Anything else — a typo, a table in another schema, a probe for
 * auth.users — comes back null and the caller refuses.
 */
async function allowTable(name) {
    const { tables } = await getSchema();
    return tables.includes(name) ? name : null;
}

/**
 * Everything a business is allowed to send for this table, and nothing else.
 *
 * Two passes: drop the system columns, then drop anything the table does not
 * actually have. The second pass turns what would be a confusing PostgREST
 * error into a field that is quietly ignored.
 */
async function cleanBody(table, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    const { columns } = await getSchema();
    const known = new Set((columns[table] || []).map((c) => c.name));

    const out = {};
    for (const [key, value] of Object.entries(body)) {
        if (SYSTEM_COLUMNS.has(key)) continue;
        if (known.size && !known.has(key)) continue;
        // An empty input means "no value", not an empty string.
        out[key] = value === '' ? null : value;
    }
    return out;
}

/* ── the public boundary ──────────────────────────────────────────────────
 *
 * Every table in this database is keyed by entity_slug, and a business may use
 * any of them. For the owner's own agent that is the whole story: they see
 * every table that has rows for them, no list anywhere, and a table added
 * tomorrow appears on its own.
 *
 * The slug-attached PUBLIC agent cannot have that, and the reason is not the
 * schema — it is whose data is in it. bookings, customers, signed_waivers,
 * business_leads, sms_log, entity_owners, oauth_tokens and forty more are all
 * keyed by the business's slug and none of them are the business's own
 * information. They are other people's: names, phone numbers, what they paid,
 * what they signed. A URL anyone can type must not reach those.
 *
 * So the public side draws one line, by what a table holds rather than by a
 * hand-kept list of the ones that are fine. Anything matching below is out, and
 * a table added tomorrow is out until somebody decides otherwise — which is the
 * safe direction for the default to fail in.
 */

const PRIVATE_TABLE = new RegExp([
    // people who are not the business
    'customer', 'guest', 'tourist', 'visitor', 'lead', 'contact', 'subscriber', 'member',
    // money and commitments
    'booking', 'reserv', 'order', 'payment', 'invoice', 'transaction', 'checkout', 'cart',
    'waiver', 'signature', 'coupon_claim', 'redemption', 'loyalty', 'refund_request',
    // credentials and ownership
    'token', 'secret', 'credential', 'password', 'oauth', 'api_key', 'session',
    '_owner', '^owner', 'admin', 'claim', 'signup', 'invite',
    // anything sent to a person
    'message', 'sms', 'email', 'notification', 'webhook', 'inbox', 'blast', 'campaign', 'opt_in', 'opt_out',
    // what the platform watches
    'analytic', 'tracking', 'audit', 'funnel', 'impression', 'click', 'scan', 'view_log', '_log$', 'event_log',
    // work in progress, not published
    'draft', 'pending', 'queue', 'intake', 'import', 'staging',
].join('|'), 'i');

/**
 * Columns that must never leave this API on a public route, wherever they turn
 * up. The table filter above is the main defence; this is the second one, for
 * the row that carries a reviewer's email on an otherwise public table.
 */
const SENSITIVE_COLUMN = /email|phone_number|token|hash|secret|password|api_?key|ip_address|user_id|stripe|card|ssn|birth|dob|internal|private|_note$|admin/i;

/** The slug tables a public, unauthenticated caller may read. */
async function publicTables() {
    const { tables } = await getSchema();
    return tables.filter((t) => !PRIVATE_TABLE.test(t));
}

/** Is this table readable without a credential? */
async function allowPublicTable(name) {
    const table = await allowTable(name);
    if (!table || PRIVATE_TABLE.test(table)) return null;
    return table;
}

/** One row with the sensitive columns removed. */
function scrubRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        if (SENSITIVE_COLUMN.test(key)) continue;
        out[key] = value;
    }
    return out;
}

/** The text columns of a table, for building a search across it. */
async function textColumns(table) {
    const { columns } = await getSchema();
    return (columns[table] || [])
        .filter((c) => c.type === 'string' && !SYSTEM_COLUMNS.has(c.name) && !/^(.*_)?url$/.test(c.name))
        .map((c) => c.name);
}

module.exports = {
    SYSTEM_COLUMNS,
    getSchema,
    allowTable,
    cleanBody,
    textColumns,
    PRIVATE_TABLE,
    publicTables,
    allowPublicTable,
    scrubRow,
};
