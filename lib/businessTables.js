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

/**
 * Tables that carry entity_slug but are NOT a business's own content: the
 * platform writes them on the business's behalf, through their own routes
 * (routes/automations.js, routes/store.js, routes/billing.js). Holding them back here — the one copy of the
 * allow-list — keeps them out of the dashboard's sections, the Add catalogue,
 * the generic writer and the MCP tools all at once. Without this a business
 * could insert an entity_automations row naming any automation id, or edit
 * its own run history.
 */
const PLATFORM_TABLES = new Set([
    'entity_automations',
    'automation_runs',
    // A business must not choose its own plan, grant itself an app, or edit
    // what it has installed except through the store's own checks.
    'billing_subscription',
    'billing_usage',
    'store_grants',
    'store_installs',
    // Credentials and device rows. Each carries entity_slug, so without this
    // a business could insert a token row with a hash it chose and sign in
    // with it, bypassing the issuing routes and their permission checks.
    'business_mcp_tokens',
    'ghost_mcp_tokens',
    'ghost_nodes',
    'ghost_node_requests',
    // NEXT GENT platform rows (sql/nextgent_*.sql): the link, installs, claim
    // codes, notifications and billing charges are written by their routes.
    'company_links',
    'nextgent_installs',
    'claim_codes',
    'owner_notify_settings',
    'owner_notifications',
    'billing_item_charges',
    'billing_usage_credits',
    // NEXT GENT part 2: messages, numbers, waits, intake, Google push, calls.
    // Each has its own route and rules (consent, registration, review).
    'message_threads',
    'business_messages',
    'message_consent',
    'business_phone_numbers',
    'automation_waits',
    'intake_known_senders',
    'forwarding_confirmations',
    'google_push_queue',
    'google_push_state',
    'fact_observations',
    'live_conversations',
    'payments_detected',
    'owner_automation_drafts',
    'node_pairings',
    'node_remote_sessions',
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
        if (PLATFORM_TABLES.has(name)) continue;
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
    // The business's own record (entity) is keyed by slug, not entity_slug, so
    // it is not a section; its columns are kept for PATCH /api/owner/profile.
    const entityColumns = Object.entries(defs.entity?.properties || {}).map(([col, spec]) => ({
        name: col,
        type: spec.type || 'string',
        readOnly: /generated|identity/i.test(spec.description || ''),
    }));
    return { tables, columns, entityColumns, at: Date.now() };
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

/* ── permissions: resource:action on business tokens (CONTRACT §6) ──────
 *
 * A business token either carries a permissions list or it does not.
 *
 *   permissions NULL   legacy token: `scope` decides, as it always has — read
 *                      reaches every section, write needs scope 'write'.
 *   permissions [...]  each entry is resource:action. A section is reachable
 *                      only if the token holds that section's resource with
 *                      the action asked for. Nothing else is implied: write
 *                      does not imply read, so an install asks for both.
 *
 * Which resource a section belongs to is decided here and nowhere else. The
 * groups are the contract's; the tables in each group are matched by name,
 * first rule wins, and BUSINESS_RESOURCE_TABLES (JSON, table -> resource) can
 * pin any table explicitly. A table no rule claims is part of `business` —
 * unless it holds records of people (whyPrivate above), in which case no
 * permissioned token reaches it at all. Failing closed is the point: a new
 * customer table must not become readable by every app with business:read.
 */

const RESOURCES = Object.freeze(['business', 'menu', 'availability', 'bookings', 'events', 'reviews', 'transactions', 'messages']);
const ACTIONS = Object.freeze(['read', 'write', 'send']);

const RESOURCE_RULES = [
    ['messages', /message|sms|conversation|inbox|chat/i],
    ['transactions', /payment|transaction|invoice|payout|charge|receipt|order/i],
    ['bookings', /booking|reserv|appointment|waitlist/i],
    ['availability', /availab|capacity|blackout|closure|inventory|slot/i],
    ['menu', /menu|dish|drink|food/i],
    ['reviews', /review|rating|testimonial/i],
    ['events', /event|happy_hour|special|live_music|show/i],
    ['business', /entity|hours|contact|location|address|photo|image|gallery|polic|faq|amenit|social|staff|team|service|about|link/i],
];

let overrideCache = { raw: undefined, map: {} };
function resourceOverrides() {
    const raw = process.env.BUSINESS_RESOURCE_TABLES || '';
    if (overrideCache.raw === raw) return overrideCache.map;
    let map = {};
    try {
        const parsed = raw ? JSON.parse(raw) : {};
        for (const [table, resource] of Object.entries(parsed || {})) {
            if (RESOURCES.includes(resource)) map[table] = resource;
        }
    } catch {
        console.warn('[businessTables] BUSINESS_RESOURCE_TABLES is not valid JSON; ignored.');
        map = {};
    }
    overrideCache = { raw, map };
    return map;
}

/** The resource a section belongs to, or null when no permissioned token may reach it. */
function resourceForTable(table, columns) {
    const pinned = resourceOverrides()[table];
    if (pinned) return pinned;
    for (const [resource, re] of RESOURCE_RULES) {
        if (re.test(table)) return resource;
    }
    return whyPrivate(table, columns) ? null : 'business';
}

const PERMISSION_RE = new RegExp(`^(${RESOURCES.join('|')}):(${ACTIONS.join('|')})$`);

function isValidPermission(p) {
    return typeof p === 'string' && PERMISSION_RE.test(p);
}

/**
 * Validate a permissions list from a request. Returns the de-duplicated list,
 * or throws (err.status 400) naming the first bad entry.
 */
function normalizePermissions(list) {
    if (list === null || list === undefined) return null;
    if (!Array.isArray(list)) throw Object.assign(new Error('permissions must be an array of resource:action strings.'), { status: 400 });
    const out = [];
    for (const p of list) {
        if (!isValidPermission(p)) throw Object.assign(new Error(`Unknown permission: ${p}`), { status: 400 });
        if (!out.includes(p)) out.push(p);
    }
    return out;
}

/** The legacy scope column a permissions list implies (the column only knows read/write). */
function scopeForPermissions(perms) {
    return (perms || []).some((p) => /:(write|send)$/.test(p)) ? 'write' : 'read';
}

/**
 * May this caller do `action` on this section?
 *
 * caller is { scope, permissions } — a token row, or a dashboard session
 * (scope 'write', permissions null).
 */
function permits(caller, table, columns, action) {
    if (!caller || !ACTIONS.includes(action)) return false;
    if (caller.permissions === null || caller.permissions === undefined) {
        return action === 'read' ? true : caller.scope === 'write';
    }
    const resource = resourceForTable(table, columns);
    if (!resource) return false;
    return caller.permissions.includes(`${resource}:${action}`);
}

/** Does the caller hold any permission for this action at all? Used to hide tools. */
function canAny(caller, action) {
    if (!caller) return false;
    if (caller.permissions === null || caller.permissions === undefined) {
        return action === 'read' ? true : caller.scope === 'write';
    }
    return caller.permissions.some((p) => p.endsWith(`:${action}`));
}

/**
 * May this caller use a capability that is not a table — messages:send is
 * the one today. A token needs the exact resource:action. A legacy token
 * (permissions NULL) never may: sending to customers is newer than scope, and
 * a key minted for reading sections must not start texting. The owner's own
 * session (caller.session) may.
 */
function mayUse(caller, resource, action) {
    if (!caller || !RESOURCES.includes(resource) || !ACTIONS.includes(action)) return false;
    if (caller.permissions === null || caller.permissions === undefined) return caller.session === true;
    return caller.permissions.includes(`${resource}:${action}`);
}

/**
 * The entity columns an owner may set on their own business record. Every
 * column the live table has, less identity and bookkeeping (SYSTEM_COLUMNS,
 * slug), generated ones, and the columns the platform governs: listing and
 * publication switches, verification, ownership, billing and ratings, matched
 * by name (OWNER_PROFILE_LOCKED_COLUMNS adds more, comma-separated).
 */
const GOVERNED_COLUMN = /^(slug|is_active|show_in_listings|listed_on_\w+|parent_entity_slug)$|verif|claim|owner|stripe|plan|billing|rating|review_count|status$|_score$|^source|imported|crawl/i;

async function ownerEditableEntityColumns() {
    const { entityColumns } = await getSchema();
    const extra = new Set(String(process.env.OWNER_PROFILE_LOCKED_COLUMNS || '').split(',').map((c) => c.trim()).filter(Boolean));
    return (entityColumns || [])
        .filter((c) => !c.readOnly && !SYSTEM_COLUMNS.has(c.name) && !GOVERNED_COLUMN.test(c.name) && !extra.has(c.name))
        .map((c) => c.name);
}

/** allowTable, plus the caller's permission for this action. Null when refused. */
async function allowTableFor(caller, name, action) {
    const table = await allowTable(name);
    if (!table) return null;
    const { columns } = await getSchema();
    return permits(caller, table, columns[table], action) ? table : null;
}

/** The sections this caller may perform `action` on. */
async function tablesFor(caller, action = 'read') {
    const { tables, columns } = await getSchema();
    return tables.filter((t) => permits(caller, t, columns[t], action));
}

module.exports = {
    SYSTEM_COLUMNS,
    PLATFORM_TABLES,
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
    RESOURCES,
    ACTIONS,
    resourceForTable,
    isValidPermission,
    normalizePermissions,
    scopeForPermissions,
    permits,
    canAny,
    mayUse,
    ownerEditableEntityColumns,
    allowTableFor,
    tablesFor,
};
