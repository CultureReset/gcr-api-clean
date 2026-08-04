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
 * The slug-attached PUBLIC agent gets nearly all of that, and the one thing it
 * does not is not about the schema — it is about whose data is in a row. A
 * bookings row is keyed by the business's slug and is a record of a customer:
 * their name, their number, what they paid, what they signed. That URL takes no
 * password, so anyone who can type it would read them.
 *
 * The line is drawn from the schema itself, below. No list of table names: a
 * list is a guess, has to be maintained, and is wrong the moment a table is
 * added. The columns are already in the database and cannot drift from it.
 */

/**
 * The columns that mean "this row is about a person, not about the business".
 *
 * This is the rule, and it reads the schema rather than the table's name. A
 * table carrying somebody's email address, their user id, a card charge or a
 * signature is a record of a customer or a transaction, whatever it is called.
 * A table carrying item_name, price, description and day_of_week is business
 * information, whatever it is called.
 *
 * Deriving it this way matters. A list of table names is a guess that has to be
 * maintained, is wrong the moment a table is added, and is wrong silently in
 * both directions — a customer table quietly readable, or a business's own trip
 * list quietly missing from every answer it gives. The columns are already in
 * the database and cannot drift from it.
 *
 * `phone` is deliberately not here: entity.phone is the number a business wants
 * on a billboard. It is `customer_phone` and its siblings that are somebody
 * else's, and those match on the prefix below.
 */
const PERSONAL_COLUMN = new RegExp([
    'email',                                  // any email column at all
    '^user_id$', '^auth_user_id$', '^created_by$',
    '^(customer|guest|visitor|tourist|recipient|subscriber|lead)_',
    'password', 'token', 'secret', 'api_?key', 'credential',
    'stripe', 'payment', 'charge_id', 'amount_paid', 'card_', 'invoice',
    'signature', 'signed_at', 'signed_by',
    'ip_address', 'user_agent',
].join('|'), 'i');

/**
 * The few tables whose whole purpose is a transaction or a log, and which can
 * exist without a personal column on them — a bookings row that keys out to a
 * customers table, a message log that stores only ids.
 *
 * Short on purpose. Everything else is decided by PERSONAL_COLUMN above.
 */
const PRIVATE_TABLE = /booking|reserv|^orders?$|_orders?$|waiver|payment|invoice|checkout|oauth|token|_log$|log_|opt_in|opt_out|blast|signup|claim|intake|lead/i;

/**
 * Columns that must never leave this API on a public route, wherever they turn
 * up. The table rule above is the main defence; this is the second one, for a
 * reviewer's email address on an otherwise public table.
 */
const SENSITIVE_COLUMN = /email|phone_number|token|hash|secret|password|api_?key|ip_address|user_id|stripe|card|ssn|birth|dob|internal|private|_note$|admin/i;

/**
 * Why a table is not public, or null if it is.
 *
 * Returned rather than a boolean so /api/mcp/business/:slug/sections can say
 * which column made the decision. A boundary that cannot explain itself is one
 * nobody can correct.
 */
function whyPrivate(table, columns) {
    const personal = (columns || []).map((c) => c.name).find((n) => PERSONAL_COLUMN.test(n));
    if (personal) return `holds a "${personal}" column — these rows are about a person`;
    if (PRIVATE_TABLE.test(table)) return 'a transaction or log table';
    return null;
}

/* ── the switch ───────────────────────────────────────────────────────────
 *
 * Off by default: the public agent reads every table keyed by entity_slug, the
 * same set the owner's agent sees. That is the platform's design — a business
 * is a slug, the slug is what every table hangs off, and an agent that can only
 * reach a curated subset cannot answer an arbitrary question about an arbitrary
 * business.
 *
 * Setting PUBLIC_MCP_HIDE_PERSONAL=true re-applies whyPrivate() above, which
 * holds back the tables whose rows are records of a person rather than of the
 * business — bookings, customers, signed waivers — and strips personal columns
 * from whatever is left. It exists because /api/mcp/business/:slug takes no
 * password, so with the switch off, a booking's customer name and phone number
 * are readable by anyone who can type the URL. That is a decision about your
 * own customers' data, so it is a config value and not something this file
 * decides for you.
 *
 * Either way it is visible: GET /api/mcp/business/:slug/sections lists what is
 * readable and what is held back, with the reason.
 */
const HIDE_PERSONAL = String(process.env.PUBLIC_MCP_HIDE_PERSONAL || '').toLowerCase() === 'true';

/** The slug tables a public, unauthenticated caller may read. */
async function publicTables() {
    const { tables, columns } = await getSchema();
    if (!HIDE_PERSONAL) return tables;
    return tables.filter((t) => !whyPrivate(t, columns[t]));
}

/** Is this table readable without a credential? */
async function allowPublicTable(name) {
    const table = await allowTable(name);
    if (!table) return null;
    if (!HIDE_PERSONAL) return table;
    const { columns } = await getSchema();
    return whyPrivate(table, columns[table]) ? null : table;
}

/** Why this table is held back from a public caller, or null if it is not. */
async function publicReason(table, columns) {
    if (!HIDE_PERSONAL) return null;
    return whyPrivate(table, columns);
}

/** One row with the sensitive columns removed — only when the switch is on. */
function scrubRow(row) {
    if (!HIDE_PERSONAL) return row;
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
    PERSONAL_COLUMN,
    whyPrivate,
    publicReason,
    HIDE_PERSONAL,
    publicTables,
    allowPublicTable,
    scrubRow,
};
