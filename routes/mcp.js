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

const crypto = require('crypto');
const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const { getSchema, allowTable, cleanBody, textColumns } = require('../lib/businessTables');
const { createMcpRouter, content, toolError } = require('../lib/mcpServer');

const SERVER_INFO = { name: 'gcr-api-clean', title: 'Gulf Coast Radar — business', version: '1.0.0' };

const INSTRUCTIONS = [
    'You are connected to one business on the Gulf Coast Radar platform. Every tool acts on',
    'that business and no other — there is no way to name a different one.',
    '',
    'A "section" is one table of that business\'s data: menu_items, faqs, events, hours, and so',
    'on. The sections that exist differ per business, so call list_sections first, then',
    'describe_section before writing, so you use real column names.',
    '',
    'Never invent a figure. If a number is asked for, read it with read_section and report what',
    'came back. If a section holds no rows, say so rather than estimating.',
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

const TOKEN_PREFIX = 'gcr_mcp_';
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const missingTable = (error) =>
    /business_mcp_tokens/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);

async function authenticate(req) {
    const header = (req.headers.authorization || '').trim();
    if (!header) return { reason: 'No bearer token.' };
    // Hosts differ on whether they add the scheme themselves: some take a raw
    // token in their config and send it verbatim. Accepting a bare token costs
    // nothing and turns a silent 401 into a working connection.
    const raw = (/^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : header).trim();
    if (!raw) return { reason: 'No bearer token.' };

    if (raw.startsWith(TOKEN_PREFIX)) {
        const { data, error } = await supabase
            .from('business_mcp_tokens')
            .select('id, entity_slug, label, scope, revoked_at')
            .eq('token_hash', hashToken(raw))
            .maybeSingle();

        if (error) {
            if (missingTable(error)) {
                return { reason: 'MCP tokens are not set up on this database yet (business_mcp_tokens is missing).' };
            }
            return { reason: error.message };
        }
        if (!data) return { reason: 'That token is not valid.' };
        if (data.revoked_at) return { reason: 'That token has been revoked.' };

        // Best effort: a failed timestamp update must not fail the call.
        supabase
            .from('business_mcp_tokens')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', data.id)
            .then(() => {}, () => {});

        return { slug: data.entity_slug, scope: data.scope || 'read', via: 'token', label: data.label };
    }

    let userId;
    try {
        const { data, error } = await supabase.auth.getUser(raw);
        if (error || !data?.user) return { reason: 'That token is not valid.' };
        userId = data.user.id;
    } catch {
        return { reason: 'That token is not valid.' };
    }

    const { data: owned } = await supabase
        .from('entity_owners')
        .select('entity_slug')
        .eq('user_id', userId)
        .limit(1);
    if (!owned?.length) return { reason: 'This account is not linked to a business.' };

    return { slug: owned[0].entity_slug, scope: 'write', via: 'session', label: 'dashboard session' };
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

const WRITE_TOOLS = new Set(['create_row', 'update_row', 'delete_row']);

/** Tools this caller may actually see. A read token is not shown the writes. */
const toolsFor = (caller) => (caller.scope === 'write' ? TOOLS : TOOLS.filter((t) => !WRITE_TOOLS.has(t.name)));

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

/** Resolve a section name, or explain why it is not one. */
async function section(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A section name is required.');
    const table = await allowTable(name.trim());
    if (!table) throw new Error(`There is no section called "${name}". Call list_sections to see what this business has.`);
    return table;
}

async function runTool(name, args, caller) {
    const a = args && typeof args === 'object' ? args : {};

    if (WRITE_TOOLS.has(name) && caller.scope !== 'write') {
        return toolError('This connection is read-only. Ask the business owner for a token with write access.');
    }

    switch (name) {
        case 'whoami': {
            const { data: entity } = await supabase
                .from('entity')
                .select('name, entity_type')
                .eq('slug', caller.slug)
                .maybeSingle();
            const { tables } = await getSchema();
            return content({
                slug: caller.slug,
                name: entity?.name || null,
                industry: entity?.entity_type || null,
                can_write: caller.scope === 'write',
                connection: caller.label || caller.via,
                sections_available: tables.length,
            });
        }

        case 'list_sections': {
            const { tables } = await getSchema();
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
            const table = await section(a.section);
            const { columns } = await getSchema();
            return content({
                section: table,
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
            const table = await section(a.section);
            const limit = Math.min(Math.max(Number(a.limit) || 50, 1), ROW_LIMIT);
            const offset = Math.max(Number(a.offset) || 0, 0);

            const query = supabase
                .from(table)
                .select('*', { count: 'exact' })
                .eq('entity_slug', caller.slug)
                .range(offset, offset + limit - 1);

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

            return content({
                section: table,
                rows: data || [],
                returned: (data || []).length,
                total_matching: count ?? null,
                limit,
                offset,
            });
        }

        case 'create_row': {
            const table = await section(a.section);
            const values = await cleanBody(table, a.values);
            if (!Object.keys(values).length) {
                return toolError('No usable columns in values. Call describe_section to see what this section accepts.');
            }
            const { data, error } = await supabase
                .from(table)
                // The slug is ours, not the caller's — cleanBody has already
                // dropped any the model tried to send.
                .insert({ ...values, entity_slug: caller.slug })
                .select()
                .single();
            if (error) return toolError(`Could not add to ${table}: ${error.message}`);
            return content({ section: table, created: data });
        }

        case 'update_row': {
            const table = await section(a.section);
            if (a.id === undefined || a.id === null || a.id === '') return toolError('An id is required.');
            const values = await cleanBody(table, a.values);
            if (!Object.keys(values).length) {
                return toolError('Nothing to change. Call describe_section to see what this section accepts.');
            }
            const { data, error } = await supabase
                .from(table)
                .update(values)
                .eq('id', a.id)
                .eq('entity_slug', caller.slug) // never reachable outside this business
                .select();
            if (error) return toolError(`Could not update ${table}: ${error.message}`);
            if (!data?.length) return toolError(`No row ${a.id} in ${table} for this business.`);
            return content({ section: table, updated: data[0] });
        }

        case 'delete_row': {
            const table = await section(a.section);
            if (a.id === undefined || a.id === null || a.id === '') return toolError('An id is required.');
            const { data, error } = await supabase
                .from(table)
                .delete()
                .eq('id', a.id)
                .eq('entity_slug', caller.slug)
                .select('id');
            if (error) return toolError(`Could not delete from ${table}: ${error.message}`);
            if (!data?.length) return toolError(`No row ${a.id} in ${table} for this business.`);
            return content({ section: table, deleted: data[0].id });
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
        .select('id, label, scope, token_hint, created_at, last_used_at, revoked_at')
        .eq('entity_slug', req.entitySlug)
        .order('created_at', { ascending: false });
    if (error) {
        if (missingTable(error)) return res.status(503).json({ error: 'MCP tokens are not set up on this database yet.' });
        return res.status(500).json({ error: error.message });
    }
    res.json({ slug: req.entitySlug, tokens: data || [] });
});

router.post('/tokens', ownerRequired, async (req, res) => {
    const label = String(req.body?.label || req.body?.name || 'AI assistant').trim().slice(0, 80);
    const scope = req.body?.scope === 'write' ? 'write' : 'read';

    // 32 random bytes. Long enough that guessing is not a threat model, so the
    // stored hash can be a plain sha256 and the lookup stays one indexed read.
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

    const { data, error } = await supabase
        .from('business_mcp_tokens')
        .insert({
            entity_slug: req.entitySlug,
            label,
            scope,
            token_hash: hashToken(token),
            token_hint: token.slice(-6),
            created_by: req.ownerUserId,
        })
        .select('id, label, scope, token_hint, created_at')
        .single();
    if (error) {
        if (missingTable(error)) return res.status(503).json({ error: 'MCP tokens are not set up on this database yet.' });
        return res.status(500).json({ error: error.message });
    }

    // The only time the token itself exists outside the client's config.
    res.status(201).json({ ...data, token, note: 'Copy this now — it is not stored and cannot be shown again.' });
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
