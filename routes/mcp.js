// ============================================================
// MCP (BUSINESS) — the door one business's own AI knocks on
// ============================================================
//
// Model Context Protocol server for one business's own data. Point an MCP
// client at this URL with a token and it can read and edit that business's
// sections by name, in words, without anybody wiring up an integration per
// tool.
//
// The public directory lives at /api/mcp/public and has nothing to do with
// this: it is open, read-only, and covers every business. This one is scoped
// to exactly one business and can write.
//
// ── Why it lives here and not next to the database ──────────────────────
//
// The rule for this platform is that only gcr-api-clean talks to Postgres. An
// MCP server that held the Supabase service key and ran SQL would be a second
// thing touching the database, with its own idea of what a business is allowed
// to see. So this is not a database MCP server. It is an MCP wrapper over the
// same handlers the dashboard uses — same schema discovery, same table
// allow-list, same column filter, same slug scoping, all from
// lib/businessTables.js.
//
// The practical consequence: a bug fixed for the dashboard is fixed for the
// AI, and a table added to the database shows up in both without a deploy.
//
// ── What the assistant can and cannot do ────────────────────────────────
//
// It acts as exactly one business, decided by the token, never by anything in
// the request. There is no `slug` argument on any tool below and no way to add
// one — the same property that makes the dashboard safe. A read-scoped token
// gets the four read tools and is refused the three writes.
//
// ── The agent face of installed apps (DECISIONS #46) ────────────────────
//
// An app installed for the business may declare `actions` in its manifest:
// { id, summary, table | binding, kind: read | create | update } (a binding
// names a data contract through the manifest's `bindings`). Each one is
// offered here as a tool, app_<appKey>_<action>, and runs through the same
// code the app's own screens use — routes/app-data.js for the app's own
// table, the section tools below for a data contract (lib/dataContracts.js)
// — under the install's permissions and the caller's. There is no second MCP
// and, again, no slug argument: the install names the business.

const supabase = require('../db');
const { ownerRequired, resolveSessionSlug } = require('../middleware/ownerAuth');
const {
    getSchema, cleanBody, textColumns,
    canAny, mayUse, tablesFor, normalizePermissions, scopeForPermissions, permitsResource,
    sectionNamed, sectionPermitted, sectionSelect, applySection, sectionRow, sectionRows, sectionValues, sectionPatchValues, settleExclusive, appTables,
} = require('../lib/businessTables');
const dataContracts = require('../lib/dataContracts');
const appInstances = require('../lib/appInstances');
const messages = require('../lib/messages');
const { resolveRecipient } = require('../lib/recipientRef');
const businessEvents = require('../lib/businessEvents');
const googlePush = require('../lib/googlePush');
const { createMcpRouter, content, toolError } = require('../lib/mcpServer');
const { TOKEN_PREFIX, mintToken, lookupToken, missingTable } = require('../lib/businessTokens');

// The platform's name is configuration (PLATFORM_NAME), not code.
const SERVER_INFO = {
    name: 'gcr-api-clean',
    title: process.env.PLATFORM_NAME ? `${process.env.PLATFORM_NAME} — business` : 'Business data',
    version: '1.0.0',
};

const INSTRUCTIONS = [
    'You are connected to one business on this platform. Every tool acts on',
    'that business and no other — there is no way to name a different one.',
    '',
    'A "section" is one table of that business\'s data: menu_items, faqs, events, hours, and so',
    'on. The sections that exist differ per business, so call list_sections first, then',
    'describe_section before writing, so you use real column names.',
    '',
    'Never invent a figure. If a number is asked for, read it with read_section and report what',
    'came back. If a section holds no rows, say so rather than estimating.',
    '',
    'send_message (when you have it) reaches a real customer. Texts go only from the business\'s',
    'registered number and only to customers who agreed to receive them; a refused message comes',
    'back with status blocked and the reason. Say so rather than retrying.',
].join('\n');

/* ── who is calling ───────────────────────────────────────────────────────
 *
 * Two kinds of bearer token, because they are used at different times.
 *
 *   gcr_mcp_…   a long-lived key belonging to one business. This is what goes
 *               into an MCP client's config, where it is pasted once and left
 *               alone, so it cannot be an hour-long session token.
 *
 *   a session   the same Supabase access token the dashboard holds, so this
 *               can be tried from a signed-in browser or curl before anybody
 *               mints anything.
 *
 * Only the hash of the long-lived token is stored. The token itself is shown
 * once, at creation, and is not recoverable afterwards — if it is lost the
 * answer is to revoke it and mint another.
 */

async function authenticate(req) {
    const header = (req.headers.authorization || '').trim();
    if (!header) return { reason: 'No bearer token.' };
    // Hosts differ on whether they add the scheme themselves: some take a raw
    // token in their config and send it verbatim. Accepting a bare token costs
    // nothing and turns a silent 401 into a working connection.
    const raw = (/^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : header).trim();
    if (!raw) return { reason: 'No bearer token.' };

    if (raw.startsWith(TOKEN_PREFIX)) {
        const found = await lookupToken(raw);
        if (found.reason) return { reason: found.reason };
        // permissions null = a legacy token, governed by scope alone.
        return withApps({
            slug: found.slug,
            scope: found.scope,
            permissions: found.permissions,
            installId: found.installId,
            via: 'token',
            label: found.label,
        });
    }

    // A dashboard session: a Supabase access token or a Paperclip business
    // token, resolved by the same code the dashboard's guards use.
    const session = await resolveSessionSlug(raw);
    if (session.reason) return { reason: session.reason };
    return withApps({ slug: session.slug, scope: 'write', permissions: null, via: session.via, label: 'dashboard session', session: true });
}

/** The caller, with the actions of its business's installed apps attached (tool listing is synchronous). */
async function withApps(caller) {
    return { ...caller, apps: await installedActions(caller.slug) };
}

/* ── installed apps' declared actions ─────────────────────────────────── */

const ACTION_ID = /^[a-z][a-z0-9_]*$/;
const ACTION_KINDS = Object.freeze(['read', 'create', 'update']);
const toolSafe = (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * The contract an action reaches: through a binding of the manifest
 * ({ binding }, the engine's shape — a write needs access read-write), or
 * named outright ({ contract }). Null when it names neither usable thing.
 */
function actionContract(manifest, a) {
    if (typeof a.binding === 'string') {
        const b = manifest?.bindings?.[a.binding];
        if (!b || typeof b.contract !== 'string') return null;
        if (a.kind !== 'read' && b.access !== 'read-write') return null;
        return b.contract;
    }
    return typeof a.contract === 'string' && a.contract ? a.contract : null;
}

/** Does this manifest entry describe an action this server can offer? */
function usableAction(manifest, a) {
    if (!a || typeof a !== 'object' || !ACTION_ID.test(String(a.id || '')) || !ACTION_KINDS.includes(a.kind)) return false;
    if (typeof a.summary !== 'string' || !a.summary.trim()) return false;
    const hasTable = typeof a.table === 'string' && !!a.table;
    const hasBinding = typeof a.binding === 'string' || typeof a.contract === 'string';
    if (hasTable === hasBinding) return false; // exactly one
    if (hasTable) return Object.prototype.hasOwnProperty.call(appTables(manifest), a.table);
    const contract = actionContract(manifest, a);
    return contract !== null && dataContracts.contractFor(contract) !== null;
}

/**
 * Every usable action of every enabled app Paperclip has installed for this
 * business, with the install it belongs to and that install's permissions.
 * Read live per call; never throws (no apps table yet = no app tools).
 */
async function installedActions(slug) {
    if (!slug) return [];
    try {
        const apps = await appInstances.listForSlug(slug);
        const live = apps.filter((a) => a.enabled && a.manifest && Array.isArray(a.manifest.actions) && a.manifest.actions.length);
        if (!live.length) return [];
        const { data: installs } = await supabase.from('nextgent_installs')
            .select('install_id, entity_slug, permissions, status')
            .in('install_id', live.map((a) => a.installId));
        const byInstall = Object.fromEntries((installs || []).map((i) => [i.install_id, i]));
        const out = [];
        for (const app of live) {
            const install = byInstall[app.installId];
            if (!install || install.status !== 'active' || install.entity_slug !== slug) continue;
            const permissions = Array.isArray(install.permissions) ? install.permissions : [];
            for (const action of app.manifest.actions) {
                if (!usableAction(app.manifest, action)) continue;
                out.push({
                    name: `app_${toolSafe(app.appKey)}_${action.id}`,
                    installId: app.installId,
                    appKey: app.appKey,
                    appName: app.manifest.name || app.appKey,
                    permissions,
                    action: { id: action.id, summary: action.summary.trim(), kind: action.kind, table: action.table || null, contract: action.table ? null : actionContract(app.manifest, action) },
                });
            }
        }
        return out;
    } catch (e) {
        console.error(`[mcp] installed actions for ${slug}:`, e.message);
        return [];
    }
}

const ACTION_INPUTS = {
    read: {
        type: 'object',
        properties: {
            search: { type: 'string', description: 'Match this text in the records\' text columns (a business section only).' },
            limit: { type: 'integer', description: 'Rows to return, 1-500. Default 50.' },
            offset: { type: 'integer', description: 'Rows to skip, for paging. Default 0.' },
        },
        additionalProperties: false,
    },
    create: {
        type: 'object',
        properties: { values: { type: 'object', description: 'Field name to value, as the app declares its fields. The business and the install are stamped for you.' } },
        required: ['values'],
        additionalProperties: false,
    },
    update: {
        type: 'object',
        properties: {
            id: { type: ['string', 'integer'], description: 'The record\'s id, as the read action returned it.' },
            values: { type: 'object', description: 'Field name to new value. Only the fields you name change.' },
        },
        required: ['id', 'values'],
        additionalProperties: false,
    },
};

/** The MCP tool for one installed app's action. */
function appTool(entry) {
    const { action } = entry;
    const target = action.table ? `the app's ${action.table} records` : `the business's ${action.contract}`;
    return {
        name: entry.name,
        title: `${entry.appName}: ${action.id.replace(/_/g, ' ')}`,
        description: `${action.summary} — an action of the ${entry.appName} app installed for this business, on ${target}.`,
        inputSchema: ACTION_INPUTS[action.kind],
        annotations: action.kind === 'read'
            ? { readOnlyHint: true, openWorldHint: false }
            : { readOnlyHint: false, destructiveHint: action.kind === 'update', idempotentHint: action.kind === 'update', openWorldHint: false },
    };
}

/**
 * The app tools this caller may see: a write action only when the caller may
 * write at all; a contract action only when both the install (what the owner
 * approved for the app) and the caller hold the contract's resource for it.
 */
function appToolsFor(caller) {
    const entries = Array.isArray(caller?.apps) ? caller.apps : [];
    return entries.filter((e) => {
        const act = e.action.kind === 'read' ? 'read' : 'write';
        if (act === 'write' && !canAny(caller, 'write')) return false;
        if (!e.action.contract) return true;
        const resource = dataContracts.contractFor(e.action.contract)?.resource;
        const installCaller = { scope: scopeForPermissions(e.permissions), permissions: e.permissions };
        return permitsResource(installCaller, resource, act) && permitsResource(caller, resource, act);
    });
}

/* ── the tools ────────────────────────────────────────────────────────────
 *
 * Deliberately seven, not seventy. A model does better choosing between a few
 * general tools and a section name it looked up than between a hundred
 * near-identical ones, and this way a new table needs no new tool.
 */

const TOOLS = [
    {
        name: 'whoami',
        title: 'Which business am I connected to',
        description:
            'The business this connection acts as, and whether it may write. Call this first if you are unsure who you are working for.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'list_sections',
        title: 'List the business\'s sections',
        description:
            'Every section (table) this business has data in, with a row count for each. Start here — section names differ per business, and guessing one wastes a turn.',
        inputSchema: {
            type: 'object',
            properties: {
                include_empty: {
                    type: 'boolean',
                    description: 'Also list sections that exist but hold no rows for this business. Default false.',
                },
            },
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'describe_section',
        title: 'Describe a section\'s columns',
        description:
            'The columns of one section: name, type, and whether it can be edited. Call this before create_row or update_row so the values you send use real column names.',
        inputSchema: {
            type: 'object',
            properties: { section: { type: 'string', description: 'Section name, e.g. menu_items.' } },
            required: ['section'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'read_section',
        title: 'Read rows from a section',
        description:
            'Rows from one section, newest first where the section records a time. Optionally filtered by a search across its text columns. Returns the real stored rows — quote figures from here rather than estimating.',
        inputSchema: {
            type: 'object',
            properties: {
                section: { type: 'string', description: 'Section name, e.g. menu_items.' },
                search: { type: 'string', description: 'Match this text in any of the section\'s text columns.' },
                limit: { type: 'integer', description: 'Rows to return, 1-500. Default 50.' },
                offset: { type: 'integer', description: 'Rows to skip, for paging. Default 0.' },
            },
            required: ['section'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'create_row',
        title: 'Add a row to a section',
        description:
            'Add one row. The business is stamped on it automatically; do not put a slug or an id in values. Call describe_section first.',
        inputSchema: {
            type: 'object',
            properties: {
                section: { type: 'string', description: 'Section name, e.g. menu_items.' },
                values: { type: 'object', description: 'Column name to value. Unknown columns are ignored.' },
            },
            required: ['section', 'values'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
        name: 'update_row',
        title: 'Change a row in a section',
        description:
            'Change the given columns of one row, found by its id. Only columns you name are touched; the rest are left alone.',
        inputSchema: {
            type: 'object',
            properties: {
                section: { type: 'string', description: 'Section name, e.g. menu_items.' },
                id: { type: ['string', 'integer'], description: 'The row\'s id, as returned by read_section.' },
                values: { type: 'object', description: 'Column name to new value.' },
            },
            required: ['section', 'id', 'values'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'delete_row',
        title: 'Delete a row from a section',
        description:
            'Permanently remove one row by its id. There is no undo — confirm with the person before calling this.',
        inputSchema: {
            type: 'object',
            properties: {
                section: { type: 'string', description: 'Section name, e.g. menu_items.' },
                id: { type: ['string', 'integer'], description: 'The row\'s id, as returned by read_section.' },
            },
            required: ['section', 'id'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
];

/**
 * messages.send (CONTRACT §6): one message to one customer, behind the
 * messages:send permission. The rules live in lib/messages.js.
 *
 * The recipient is `to` (an address) or `to_ref` (the record the address is
 * on: { contract: 'booking.records', id } or { customer_id }), resolved inside
 * gcr by lib/recipientRef.js within this business only, so a caller that
 * holds ids — Paperclip's routines hold nothing else (DECISIONS #87) — can
 * message a customer without the address ever passing through it. The result
 * never carries the address either way.
 */
const SEND_TOOL = {
    name: 'send_message',
    title: 'messages.send — message a customer',
    description:
        'Send one email or text to one customer of this business. Name the customer by address (to) or by the record the address is on (to_ref: a booking or a customer id; the address is looked up here and never returned). Texts go only from the business\'s registered number and only to customers who agreed to texts; otherwise the message is recorded as blocked with the reason. Set require_approval to have the owner OK it first.',
    inputSchema: {
        type: 'object',
        properties: {
            channel: { type: 'string', enum: messages.CHANNELS, description: 'email or sms.' },
            to: { type: 'string', description: 'The customer\'s email address or phone number. Give this or to_ref, not both.' },
            to_ref: {
                type: 'object',
                description: 'The record the address is on, instead of the address: { contract: "booking.records", id } for a booking, or { customer_id } for a customer record. Resolved within this business; the address is never returned.',
                properties: {
                    contract: { type: 'string', description: 'A data contract name, e.g. booking.records.' },
                    id: { type: ['string', 'number'], description: 'The row id within that contract.' },
                    customer_id: { type: ['string', 'number'], description: 'Shorthand for { contract: "customers.items", id }.' },
                },
                additionalProperties: false,
            },
            subject: { type: 'string', description: 'Email subject. Ignored for texts.' },
            body: { type: 'string', description: 'The message itself, plain text.' },
            require_approval: { type: 'boolean', description: 'Hold it for the owner to approve. Default false.' },
        },
        required: ['channel', 'body'],
        additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const WRITE_TOOLS = new Set(['create_row', 'update_row', 'delete_row']);

// Tables whose change is an event (booking.changed / cancelled need the row as
// it was) — the same set routes/business-data.js reads a `before` for.
const EVENTFUL_ON_CHANGE = new Set(['bookings', 'booking_calendar']);

/**
 * Tools this caller may actually see. A token that may not write anything is
 * not shown the writes; send_message only with messages:send. Which sections
 * each tool reaches is decided per call by lib/businessTables.js (permits),
 * the same check routes/business-data.js uses.
 */
const toolsFor = (caller) => {
    const tools = canAny(caller, 'write') ? TOOLS.slice() : TOOLS.filter((t) => !WRITE_TOOLS.has(t.name));
    if (mayUse(caller, 'messages', 'send')) tools.push(SEND_TOOL);
    for (const entry of appToolsFor(caller)) tools.push(appTool(entry));
    return tools;
};

/* ── running a tool ───────────────────────────────────────────────────── */

const ROW_LIMIT = 500;
const COUNT_CONCURRENCY = 24;

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            await worker(items[index]);
        }
    });
    await Promise.all(runners);
}

/**
 * Resolve a section name — a table, or a data contract such as menu.items —
 * and check this caller may `action` it, or explain why not. The check is
 * lib/businessTables.js sectionPermitted() — one copy, the same the dashboard
 * runs. Returns the section descriptor (table, filter, business key).
 */
async function section(name, caller, action) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A section name is required.');
    const found = await sectionNamed(name.trim());
    if (!found) throw new Error(`There is no section called "${name}". Call list_sections to see what this business has.`);
    const actions = Array.isArray(action) ? action : [action];
    let allowed = false;
    for (const act of actions) if (await sectionPermitted(caller, found, act)) allowed = true;
    if (!allowed) {
        const resource = found.resource || 'this data';
        throw new Error(`This connection is not allowed to ${actions[0]} ${resource}. Ask the business owner to approve it.`);
    }
    return found;
}

/** What a section result names: the table, and the contract when one was asked for. */
const named = (sec) => ({ section: sec.table, ...(sec.contract ? { contract: sec.contract } : {}) });

/**
 * Run one installed app's action (appToolsFor decided the caller may see it).
 * A table action is the app's own records through routes/app-data.js; a
 * contract action is the section tool of the same kind, on the contract.
 */
async function runAppAction(entry, a, caller) {
    const { action } = entry;
    if (action.contract) {
        const inner = action.kind === 'read'
            ? await runTool('read_section', { section: action.contract, search: a.search, limit: a.limit, offset: a.offset }, caller)
            : action.kind === 'create'
                ? await runTool('create_row', { section: action.contract, values: a.values }, caller)
                : await runTool('update_row', { section: action.contract, id: a.id, values: a.values }, caller);
        if (!inner || inner.isError) return inner;
        return content({ app: entry.appKey, action: action.id, ...(inner.structuredContent || {}) });
    }

    const live = await appInstances.liveInstance(entry.installId);
    if (!live || live.install.entity_slug !== caller.slug) return toolError(`The ${entry.appName} app is not installed for this business any more.`);
    const { install, instance } = live;
    const appData = require('./app-data'); // the same operations the app's own screens use
    try {
        if (action.kind === 'read') {
            const page = await appData.listAppRecords({ install, table: action.table, limit: Number(a.limit) || 50, offset: a.offset });
            return content({ app: entry.appKey, action: action.id, table: action.table, ...page });
        }
        if (action.kind === 'create') {
            const made = await appData.createAppRecord({ install, instance, table: action.table, body: a.values, source: 'owner' });
            return content({ app: entry.appKey, action: action.id, table: action.table, created: appInstances.rowShape ? require('../lib/businessTables').appRecordRow(made) : made });
        }
        if (a.id === undefined || a.id === null || a.id === '') return toolError('An id is required.');
        const row = await appData.updateAppRecord({ install, instance, table: action.table, id: a.id, body: a.values });
        return content({ app: entry.appKey, action: action.id, table: action.table, updated: require('../lib/businessTables').appRecordRow(row) });
    } catch (err) {
        if (err.errors) {
            const fields = Object.entries(err.errors).map(([k, v]) => `${k} ${v}`).join('; ');
            return toolError(`${err.message} ${fields}`);
        }
        return toolError(err.message || 'That did not work.');
    }
}

async function runTool(name, args, caller) {
    const a = args && typeof args === 'object' ? args : {};

    if (WRITE_TOOLS.has(name) && !canAny(caller, 'write')) {
        return toolError('This connection is read-only. Ask the business owner for a token with write access.');
    }

    if (name.startsWith('app_')) {
        const entry = appToolsFor(caller).find((e) => e.name === name);
        return entry ? runAppAction(entry, a, caller) : null;
    }

    switch (name) {
        case 'whoami': {
            const { data: entity } = await supabase
                .from('entity')
                .select('name, entity_type')
                .eq('slug', caller.slug)
                .maybeSingle();
            const tables = await tablesFor(caller, 'read');
            return content({
                slug: caller.slug,
                name: entity?.name || null,
                industry: entity?.entity_type || null,
                can_write: canAny(caller, 'write'),
                permissions: caller.permissions ?? undefined,
                connection: caller.label || caller.via,
                sections_available: tables.length,
            });
        }

        case 'list_sections': {
            const tables = await tablesFor(caller, 'read');
            const found = [];
            await mapLimit(tables, COUNT_CONCURRENCY, async (table) => {
                // head:true asks Postgres for the count without shipping rows.
                const { count, error } = await supabase
                    .from(table)
                    .select('id', { count: 'exact', head: true })
                    .eq('entity_slug', caller.slug);
                // A section that cannot be counted must not take the list with it.
                if (error) return;
                if (count || a.include_empty) found.push({ section: table, rows: count || 0 });
            });
            found.sort((x, y) => y.rows - x.rows || x.section.localeCompare(y.section));
            return content({ business: caller.slug, sections: found, total_sections: found.length });
        }

        case 'describe_section': {
            const sec = await section(a.section, caller, ['read', 'write']);
            const { table } = sec;
            const { columns } = await getSchema();
            return content({
                ...named(sec),
                columns: (columns[table] || []).map((c) => ({
                    name: c.name,
                    type: c.type,
                    format: c.format || undefined,
                    values: c.enum || undefined,
                    editable: c.editable,
                })),
                note: 'Columns with editable false are set by the platform and are ignored if you send them.',
            });
        }

        case 'read_section': {
            const sec = await section(a.section, caller, 'read');
            const { table } = sec;
            const limit = Math.min(Math.max(Number(a.limit) || 50, 1), ROW_LIMIT);
            const offset = Math.max(Number(a.offset) || 0, 0);

            // The business key is the token's; a contract's filter rides along.
            const query = applySection(
                supabase.from(table).select(await sectionSelect(sec), { count: 'exact' }),
                sec, caller.slug,
            ).range(offset, offset + limit - 1);

            const term = typeof a.search === 'string' ? a.search.trim() : '';
            if (term) {
                // PostgREST's or() is a comma-separated list wrapped in its own
                // punctuation, so the characters that would end a clause early
                // are stripped rather than escaped.
                const safe = term.replace(/[,()*%\\]/g, ' ').trim();
                const cols = await textColumns(table);
                if (safe && cols.length) query.or(cols.map((c) => `${c}.ilike.%${safe}%`).join(','));
            }

            const { columns } = await getSchema();
            const hasCreatedAt = (columns[table] || []).some((c) => c.name === 'created_at');
            if (hasCreatedAt) query.order('created_at', { ascending: false });

            const { data, error, count } = await query;
            if (error) return toolError(`Could not read ${table}: ${error.message}`);

            const rows = await sectionRows(sec, data);
            return content({
                ...named(sec),
                rows,
                returned: rows.length,
                total_matching: count ?? null,
                limit,
                offset,
            });
        }

        case 'create_row': {
            const sec = await section(a.section, caller, 'write');
            const { table } = sec;
            if (sec.single) return toolError(`${sec.contract} is this business's one record: update_row changes it, nothing creates it.`);
            if (sec.pivot) return toolError(`${sec.contract} is edited one link at a time through the business data routes, not here.`);
            const values = await cleanBody(table, sectionValues(sec, a.values));
            if (!Object.keys(values).length) {
                return toolError('No usable columns in values. Call describe_section to see what this section accepts.');
            }
            const { data, error } = await supabase
                .from(table)
                // The slug is ours, not the caller's — cleanBody has already
                // dropped any the model tried to send. A contract's filter
                // columns are stamped last, whatever the values said.
                .insert({ ...values, ...sectionValues(sec, {}), [sec.slugColumn]: caller.slug })
                .select()
                .single();
            if (error) return toolError(`Could not add to ${table}: ${error.message}`);
            await settleExclusive(supabase, sec, caller.slug, data); // one cover per business (DECISIONS #97)
            await googlePush.noteTableWrite(caller.slug, table, data);
            // The same events a write through /api/business fires (lib/businessEvents.js; review 01 M12). Never fails the write.
            await businessEvents.sectionWritten(caller.slug, table, null, data);
            return content({ ...named(sec), created: sectionRow(sec, data) });
        }

        case 'update_row': {
            const sec = await section(a.section, caller, 'write');
            const { table } = sec;
            if (sec.pivot) return toolError(`${sec.contract} is edited one link at a time through the business data routes, not here.`);
            if (!sec.single && (a.id === undefined || a.id === null || a.id === '')) return toolError('An id is required.');
            // The business record's columns are the owner's rule (DECISIONS #96): a governed column is refused by name.
            const { values, refused } = await sectionPatchValues(sec, a.values);
            if (refused.length) return toolError(`${sec.contract} does not let a business change ${refused.join(', ')}.`);
            if (!Object.keys(values).length) {
                return toolError('Nothing to change. Call describe_section to see what this section accepts.');
            }
            let before = null;
            if (EVENTFUL_ON_CHANGE.has(table)) {
                const { data: was } = await applySection(
                    supabase.from(table).select('*').eq(sec.idColumn, a.id), sec, caller.slug,
                ).maybeSingle();
                before = was ? { ...was } : null; // a snapshot, not a reference the update could move
            }
            const byId = (q) => (sec.single && (a.id === undefined || a.id === null || a.id === '') ? q : q.eq(sec.idColumn, a.id));
            const { data, error } = await applySection(
                byId(supabase.from(table).update(values)),
                sec, caller.slug, // never reachable outside this business, or outside the contract
            ).select(await sectionSelect(sec));
            if (error) return toolError(`Could not update ${table}: ${error.message}`);
            if (!data?.length) return toolError(`No row ${a.id} in ${table} for this business.`);
            await settleExclusive(supabase, sec, caller.slug, data[0]);
            await googlePush.noteTableWrite(caller.slug, table, data[0]);
            await businessEvents.sectionWritten(caller.slug, table, before, data[0]);
            return content({ ...named(sec), updated: sectionRow(sec, data[0]) });
        }

        case 'delete_row': {
            const sec = await section(a.section, caller, 'write');
            const { table } = sec;
            if (sec.single) return toolError(`${sec.contract} is this business's one record and cannot be deleted.`);
            if (sec.pivot) return toolError(`${sec.contract} is edited one link at a time through the business data routes, not here.`);
            if (a.id === undefined || a.id === null || a.id === '') return toolError('An id is required.');
            const { data, error } = await applySection(
                supabase.from(table).delete().eq(sec.idColumn, a.id),
                sec, caller.slug,
            ).select(sec.idColumn);
            if (error) return toolError(`Could not delete from ${table}: ${error.message}`);
            if (!data?.length) return toolError(`No row ${a.id} in ${table} for this business.`);
            await googlePush.noteTableWrite(caller.slug, table, null);
            return content({ ...named(sec), deleted: data[0][sec.idColumn] });
        }

        case 'send_message': {
            if (!mayUse(caller, 'messages', 'send')) {
                return toolError('This connection is not allowed to send messages. Ask the business owner to approve messages:send.');
            }
            const hasTo = typeof a.to === 'string' && a.to.trim() !== '';
            const hasRef = a.to_ref !== undefined && a.to_ref !== null;
            if (hasTo === hasRef) return toolError('Name the recipient once: to (an address) or to_ref (the record it is on), not both and not neither.');
            let to = a.to;
            if (hasRef) {
                // Resolved here, within this business; the address is used
                // for the send and never written into the result.
                const found = await resolveRecipient(caller.slug, a.channel, a.to_ref);
                if (!found.address) return toolError(`No ${a.channel === 'sms' ? 'phone number' : 'email address'} for that reference (${found.reason}).`);
                to = found.address;
            }
            const sent = await messages.sendMessage({
                slug: caller.slug,
                channel: a.channel,
                to,
                subject: a.subject,
                body: a.body,
                requireApproval: a.require_approval === true,
                author: caller.session ? 'owner' : 'agent',
                installId: caller.installId || null,
            });
            return content({
                message_id: sent.id,
                status: sent.status,
                reason: sent.status_reason || undefined,
                note: sent.status === 'sent' ? undefined : 'Not delivered yet — the status says why. Do not tell the customer it was sent.',
            });
        }

        default:
            return null; // unknown tool — the transport turns this into an error
    }
}

const router = createMcpRouter({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    tools: toolsFor,
    runTool,
    authenticate,
});

/* ── tokens ───────────────────────────────────────────────────────────────
 *
 * A business mints its own. ownerRequired resolves which business from the
 * session, so these routes cannot mint a token for anybody else.
 */

router.get('/tokens', ownerRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('business_mcp_tokens')
        .select('*')
        .eq('entity_slug', req.entitySlug)
        .order('created_at', { ascending: false });
    if (error) {
        if (missingTable(error)) return res.status(503).json({ error: 'MCP tokens are not set up on this database yet.' });
        return res.status(500).json({ error: error.message });
    }
    // select('*') so the permission columns show when sql/nextgent_link.sql is
    // applied; the hash never leaves this API.
    const tokens = (data || []).map(({ token_hash, ...row }) => row);
    res.json({ slug: req.entitySlug, tokens });
});

router.post('/tokens', ownerRequired, async (req, res) => {
    const label = String(req.body?.label || req.body?.name || 'AI assistant').trim().slice(0, 80);

    // Optional resource:action list (CONTRACT §6). Without it the token is a
    // legacy one, governed by scope alone.
    let permissions = null;
    try {
        permissions = normalizePermissions(req.body?.permissions);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    const scope = permissions ? scopeForPermissions(permissions) : (req.body?.scope === 'write' ? 'write' : 'read');

    try {
        const { row, token } = await mintToken({
            slug: req.entitySlug,
            label,
            scope,
            permissions,
            companyId: req.paperclip?.companyId ?? null,
            createdBy: req.ownerUserId || null,
        });
        // The only time the token itself exists outside the client's config.
        res.status(201).json({ ...row, token, note: 'Copy this now — it is not stored and cannot be shown again.' });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.status === 503 ? 'MCP tokens are not set up on this database yet.' : err.message });
    }
});

router.delete('/tokens/:id', ownerRequired, async (req, res) => {
    const { data, error } = await supabase
        .from('business_mcp_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('entity_slug', req.entitySlug) // a business can only revoke its own
        .select('id');
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) return res.status(404).json({ error: 'No such token.' });
    res.json({ revoked: data[0].id });
});

module.exports = router;
// The live call and text handlers (routes/telephony-live.js) run the same tools.
module.exports.runTool = runTool;
module.exports.toolsFor = toolsFor;
module.exports.INSTRUCTIONS = INSTRUCTIONS;
