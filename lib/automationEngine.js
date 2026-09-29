// ============================================================
// AUTOMATION ENGINE — the steps, the templating, the runner
// ============================================================
//
// An automation is data: a trigger, an ordered list of steps, and the settings
// a business may fill in. This file is the part that turns that data into
// work. Nothing in here knows about a specific automation; it knows about
// step TYPES, and the builder in the admin dashboard reads the catalogue below
// (GET /api/admin/automations/meta) to draw its palette and its forms — so a
// new step type is a new entry here and nothing else.
//
// ── Scoping ─────────────────────────────────────────────────────────────
//
// Every run is for one business. The data steps go through the same three
// guards the dashboard and the MCP server use (lib/businessTables.js): the
// table allow-list, the column filter, and a query that always carries the
// business's slug. A step cannot read or write another business's rows, no
// matter what its configuration says.
//
// ── Versions ────────────────────────────────────────────────────────────
//
// A business runs the snapshot it has installed (automation_versions), never
// the draft. Editing the draft changes nothing anywhere until it is published
// and pushed. The one exception is a test run from the builder, which runs the
// draft against one business with side effects switched off.
//
// ── Templates ───────────────────────────────────────────────────────────
//
// Any string in a step's configuration may carry {{ paths }} into the run
// context:
//
//     {{ business.name }}          the entity row
//     {{ config.reminder_phone }}  a setting the business filled in
//     {{ trigger.payload.x }}      what fired the run (webhook body, event data)
//     {{ steps.query.rows.0.name }} an earlier step's output, by its id
//     {{ now }}                    ISO timestamp
//
// A string that is exactly one {{ path }} resolves to the raw value, so an
// object or an array can be passed whole from one step to the next.

const vm = require('vm');
const crypto = require('crypto');
const supabase = require('../db');
const { allowTable, cleanBody, getSchema } = require('./businessTables');

/* ── templating ──────────────────────────────────────────────────────── */

const PATH = /\{\{\s*([A-Za-z0-9_$.\-]+)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*([A-Za-z0-9_$.\-]+)\s*\}\}\s*$/;

function getPath(obj, path) {
    let cur = obj;
    for (const part of String(path).split('.')) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

function render(template, ctx) {
    if (typeof template !== 'string') return template;
    const whole = template.match(WHOLE);
    if (whole) return getPath(ctx, whole[1]);
    return template.replace(PATH, (_, p) => {
        const v = getPath(ctx, p);
        if (v == null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
}

/** Apply render() to every string leaf of a value. */
function renderDeep(value, ctx) {
    if (typeof value === 'string') return render(value, ctx);
    if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, ctx);
        return out;
    }
    return value;
}

/** A step's config field may be a JSON string (typed in the builder) or a value. */
function asObject(value) {
    if (value == null || value === '') return {};
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return {}; }
    }
    return typeof value === 'object' ? value : {};
}

/* ── the step catalogue ──────────────────────────────────────────────────
 *
 * Each entry: how the builder draws it (label, description, category,
 * fields) and how it runs. `sideEffect` marks the ones a dry run must not
 * execute — they return what they WOULD have done instead.
 *
 * `fields` use the same descriptor shape the admin dashboard's SchemaForm
 * reads: { key, label, type, help, required, options, placeholder, default }.
 */

const STEP_TYPES = {
    'data.query': {
        label: 'Read this business\'s data',
        description: 'Rows from one of the business\'s own tables — menu items, events, bookings, anything keyed by its slug.',
        category: 'Data',
        icon: '🔎',
        sideEffect: false,
        fields: [
            { key: 'table', label: 'Table', type: 'text', required: true, placeholder: 'menu_items', help: 'Any slug-keyed table. Checked against the live schema at run time.' },
            { key: 'filter', label: 'Filter', type: 'json', placeholder: '{ "is_active": true }', help: 'Column = value pairs, all of which must match. Optional.' },
            { key: 'order_by', label: 'Order by', type: 'text', placeholder: 'created_at' },
            { key: 'descending', label: 'Newest first', type: 'boolean', default: true },
            { key: 'limit', label: 'Limit', type: 'number', default: 100 },
        ],
        async run({ config, slug }) {
            const table = await allowTable(String(config.table || ''));
            if (!table) throw new Error(`Not a business table: ${config.table}`);
            const { columns } = await getSchema();
            const known = new Set((columns[table] || []).map((c) => c.name));

            let q = supabase.from(table).select('*').eq('entity_slug', slug);
            for (const [col, val] of Object.entries(asObject(config.filter))) {
                if (!known.has(col) || col === 'entity_slug') continue;
                q = val === null ? q.is(col, null) : q.eq(col, val);
            }
            if (config.order_by && known.has(config.order_by)) {
                q = q.order(config.order_by, { ascending: config.descending === false });
            }
            q = q.limit(Math.min(Math.max(Number(config.limit) || 100, 1), 500));

            const { data, error } = await q;
            if (error) throw new Error(error.message);
            return { table, rows: data || [], count: (data || []).length };
        },
    },

    'data.insert': {
        label: 'Add a row',
        description: 'Insert one row into one of the business\'s tables. The slug is stamped by the server.',
        category: 'Data',
        icon: '➕',
        sideEffect: true,
        fields: [
            { key: 'table', label: 'Table', type: 'text', required: true, placeholder: 'entity_specials' },
            { key: 'values', label: 'Values', type: 'json', required: true, placeholder: '{ "title": "Tonight: {{ steps.pick.rows.0.item_name }}" }' },
        ],
        async run({ config, slug, dryRun }) {
            const table = await allowTable(String(config.table || ''));
            if (!table) throw new Error(`Not a business table: ${config.table}`);
            const values = await cleanBody(table, asObject(config.values));
            if (dryRun) return { dry_run: true, would_insert: { table, values } };
            const { data, error } = await supabase.from(table).insert({ ...values, entity_slug: slug }).select().single();
            if (error) throw new Error(error.message);
            return { table, row: data };
        },
    },

    'data.update': {
        label: 'Update a row',
        description: 'Change one of the business\'s rows by id. A row belonging to another business matches nothing.',
        category: 'Data',
        icon: '✏️',
        sideEffect: true,
        fields: [
            { key: 'table', label: 'Table', type: 'text', required: true },
            { key: 'id', label: 'Row id', type: 'text', required: true, placeholder: '{{ steps.query.rows.0.id }}' },
            { key: 'values', label: 'Values', type: 'json', required: true, placeholder: '{ "is_active": false }' },
        ],
        async run({ config, slug, dryRun }) {
            const table = await allowTable(String(config.table || ''));
            if (!table) throw new Error(`Not a business table: ${config.table}`);
            const values = await cleanBody(table, asObject(config.values));
            if (!Object.keys(values).length) throw new Error('Nothing to change');
            if (config.id == null || config.id === '') throw new Error('No row id');
            if (dryRun) return { dry_run: true, would_update: { table, id: config.id, values } };
            const { data, error } = await supabase
                .from(table).update(values).eq('id', config.id).eq('entity_slug', slug).select();
            if (error) throw new Error(error.message);
            if (!data?.length) throw new Error('That row is not there');
            return { table, row: data[0] };
        },
    },

    condition: {
        label: 'Only continue if…',
        description: 'Compare two values. When the check fails the run stops (or carries on, if you say so).',
        category: 'Logic',
        icon: '🔀',
        sideEffect: false,
        fields: [
            { key: 'left', label: 'Value', type: 'text', required: true, placeholder: '{{ steps.query.count }}' },
            { key: 'op', label: 'Check', type: 'select', required: true, default: 'gt',
              options: [
                  { value: 'eq', label: 'equals' }, { value: 'ne', label: 'does not equal' },
                  { value: 'gt', label: 'is greater than' }, { value: 'lt', label: 'is less than' },
                  { value: 'contains', label: 'contains' }, { value: 'empty', label: 'is empty' },
                  { value: 'not_empty', label: 'is not empty' }, { value: 'truthy', label: 'is true / set' },
              ] },
            { key: 'right', label: 'Compared to', type: 'text', placeholder: '0' },
            { key: 'on_fail', label: 'When it fails', type: 'select', default: 'stop',
              options: [{ value: 'stop', label: 'stop the run' }, { value: 'continue', label: 'carry on' }] },
        ],
        async run({ config }) {
            const passed = compare(config.left, config.op, config.right);
            return { passed, left: config.left, right: config.right };
        },
        stopsWhen: (out, config) => !out.passed && config.on_fail !== 'continue',
    },

    transform: {
        label: 'Set values',
        description: 'Build named values from templates, for later steps to use as {{ steps.<id>.<name> }}.',
        category: 'Logic',
        icon: '🧮',
        sideEffect: false,
        fields: [
            { key: 'assign', label: 'Values', type: 'json', required: true, placeholder: '{ "greeting": "Hi {{ business.name }}", "count": "{{ steps.query.count }}" }' },
        ],
        async run({ config }) {
            return asObject(config.assign);
        },
    },

    script: {
        label: 'Run a script',
        description: 'A short JavaScript function with everything from the run in scope. Synchronous; whatever it returns becomes this step\'s output.',
        category: 'Logic',
        icon: '📜',
        sideEffect: false,
        fields: [
            { key: 'code', label: 'Code', type: 'code', required: true, rows: 12,
              default: '// input, config, steps, business, trigger are in scope.\n// Return a value; later steps can read it as {{ steps.<id>.<key> }}.\nreturn { ok: true };',
              help: 'Plain JavaScript, no require, no network, no await. Two-second limit.' },
        ],
        async run({ raw, ctx, capture }) {
            return runScript(String(raw.code || ''), ctx, capture);
        },
    },

    'ai.prompt': {
        label: 'Ask the AI',
        description: 'Send a prompt to whichever model AI Config assigns to the task, and keep the answer.',
        category: 'AI',
        icon: '🤖',
        sideEffect: true,
        fields: [
            { key: 'prompt', label: 'Prompt', type: 'textarea', required: true, rows: 6, placeholder: 'Write a two-sentence special for {{ business.name }} featuring {{ steps.pick.rows.0.item_name }}.' },
            { key: 'system', label: 'Instructions', type: 'textarea', rows: 3, placeholder: 'You write short, upbeat copy for a Gulf Coast restaurant.' },
            { key: 'task', label: 'AI Config task', type: 'text', default: 'automation', help: 'Which provider/model row in AI Config to use.' },
            { key: 'max_tokens', label: 'Max tokens', type: 'number', default: 400 },
        ],
        async run({ config, dryRun }) {
            if (dryRun) return { dry_run: true, would_ask: { task: config.task || 'automation', prompt: config.prompt } };
            const { callAI } = require('../utils/ai-provider');
            const text = await callAI(config.task || 'automation', String(config.prompt || ''), {
                systemPrompt: config.system || undefined,
                maxTokens: Number(config.max_tokens) || 400,
            });
            return { text };
        },
    },

    'http.request': {
        label: 'Call a URL',
        description: 'POST or GET anything — Zapier, Make, Slack, your own server.',
        category: 'Connect',
        icon: '🌐',
        sideEffect: true,
        fields: [
            { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://hooks.zapier.com/…' },
            { key: 'method', label: 'Method', type: 'select', default: 'POST',
              options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }, { value: 'PUT', label: 'PUT' }, { value: 'PATCH', label: 'PATCH' }] },
            { key: 'headers', label: 'Headers', type: 'json', placeholder: '{ "Authorization": "Bearer …" }' },
            { key: 'body', label: 'Body', type: 'json', placeholder: '{ "business": "{{ business.name }}", "rows": "{{ steps.query.rows }}" }' },
        ],
        async run({ config, dryRun }) {
            const url = String(config.url || '');
            if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
            const method = String(config.method || 'POST').toUpperCase();
            const headers = { 'Content-Type': 'application/json', ...asObject(config.headers) };
            const body = method === 'GET' ? undefined : JSON.stringify(asObject(config.body));
            if (dryRun) return { dry_run: true, would_call: { method, url, body: asObject(config.body) } };

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                const res = await fetch(url, { method, headers, body, signal: controller.signal });
                const text = await res.text();
                let parsed = text;
                try { parsed = JSON.parse(text); } catch { /* keep text */ }
                return { status: res.status, ok: res.ok, body: truncate(parsed) };
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? 'timed out after 10s' : e.message);
            } finally {
                clearTimeout(timer);
            }
        },
    },

    'sms.send': {
        label: 'Send a text',
        description: 'An SMS through the platform\'s Twilio number.',
        category: 'Notify',
        icon: '💬',
        sideEffect: true,
        fields: [
            { key: 'to', label: 'To', type: 'text', required: true, default: '{{ business.phone }}', help: 'Defaults to the business\'s own number. Use {{ config.<key> }} for a number they set themselves.' },
            { key: 'body', label: 'Message', type: 'textarea', required: true, rows: 4 },
        ],
        async run({ config, dryRun }) {
            const to = String(config.to || '').trim();
            const body = String(config.body || '').trim();
            if (!to) throw new Error('No phone number');
            if (!body) throw new Error('Empty message');
            if (dryRun) return { dry_run: true, would_text: { to, body } };
            const { sendSms } = require('../utils/sms');
            return await sendSms(to, body, null, 'automation');
        },
    },

    'email.send': {
        label: 'Send an email',
        description: 'Through Brevo, from the platform address.',
        category: 'Notify',
        icon: '✉️',
        sideEffect: true,
        fields: [
            { key: 'to', label: 'To', type: 'text', required: true, default: '{{ business.email }}' },
            { key: 'subject', label: 'Subject', type: 'text', required: true },
            { key: 'html', label: 'Body (HTML allowed)', type: 'textarea', required: true, rows: 6 },
        ],
        async run({ config, dryRun }) {
            const to = String(config.to || '').trim();
            if (!to) throw new Error('No email address');
            if (dryRun) return { dry_run: true, would_email: { to, subject: config.subject } };
            const { sendEmail } = require('../utils/email');
            return await sendEmail({ to, subject: String(config.subject || ''), html: String(config.html || '') });
        },
    },

    notify: {
        label: 'Post a note on the dashboard',
        description: 'Leaves a message the business sees in this automation\'s run history — no text, no email.',
        category: 'Notify',
        icon: '📌',
        sideEffect: false,
        fields: [
            { key: 'title', label: 'Title', type: 'text', required: true },
            { key: 'message', label: 'Message', type: 'textarea', rows: 3 },
            { key: 'level', label: 'Tone', type: 'select', default: 'info',
              options: [{ value: 'info', label: 'info' }, { value: 'success', label: 'good news' }, { value: 'warning', label: 'needs attention' }] },
        ],
        async run({ config, ctx }) {
            const note = { title: String(config.title || ''), message: String(config.message || ''), level: config.level || 'info' };
            ctx.output.notices.push(note);
            return note;
        },
    },

    log: {
        label: 'Log a line',
        description: 'Writes a line into the run log. Handy while building.',
        category: 'Logic',
        icon: '📝',
        sideEffect: false,
        fields: [{ key: 'message', label: 'Message', type: 'text', required: true }],
        async run({ config }) {
            return { message: String(config.message || '') };
        },
    },
};

const TRIGGER_TYPES = [
    { type: 'manual', label: 'Run by hand', description: 'From the business dashboard or the admin console.' },
    { type: 'schedule', label: 'On a schedule', description: 'Hourly, daily at a time, or weekly on a day. Checked once an hour.' },
    { type: 'event', label: 'When something happens', description: 'Fired by the platform — a new intake request, for instance.' },
    { type: 'webhook', label: 'When a URL is called', description: 'Each business gets its own URL; whatever is POSTed to it becomes the trigger payload.' },
];

/** Events the platform emits. Add a name here when a route starts emitting it. */
const EVENTS = [
    { name: 'intake.created', description: 'A business submitted its links through the intake form.' },
    { name: 'automation.installed', description: 'This automation was just pushed to the business.' },
];

const CONFIG_FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'tel', 'email'];

/* ── helpers ─────────────────────────────────────────────────────────── */

function compare(left, op, right) {
    const l = left, r = right;
    const num = (v) => (v === '' || v == null ? NaN : Number(v));
    switch (op) {
        case 'eq': return String(l ?? '') === String(r ?? '') || (Number.isFinite(num(l)) && num(l) === num(r));
        case 'ne': return !compare(l, 'eq', r);
        case 'gt': return num(l) > num(r);
        case 'lt': return num(l) < num(r);
        case 'contains': return String(l ?? '').toLowerCase().includes(String(r ?? '').toLowerCase());
        case 'empty': return l == null || l === '' || (Array.isArray(l) && !l.length);
        case 'not_empty': return !compare(l, 'empty', r);
        case 'truthy': return !!l && l !== 'false' && l !== '0';
        default: throw new Error(`Unknown check: ${op}`);
    }
}

const SCRIPT_TIMEOUT_MS = 2000;

/**
 * Run admin-authored JavaScript in a vm context with only the run in scope.
 *
 * This is a guard against mistakes — an infinite loop, a typo that reaches
 * for `process` — not against a hostile author. Only platform admins can
 * write a script; businesses can only switch one on.
 */
function runScript(code, ctx, capture) {
    const logs = [];
    const sandbox = {
        __args: {
            input: ctx.trigger?.payload ?? null,
            config: ctx.config,
            steps: ctx.steps,
            business: ctx.business,
            trigger: ctx.trigger,
            now: ctx.now,
        },
        console: { log: (...a) => logs.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')) },
        JSON, Math,
    };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const wrapped = `(function () {
        const __fn = function (input, config, steps, business, trigger, now) {\n${code}\n};
        return __fn(__args.input, __args.config, __args.steps, __args.business, __args.trigger, __args.now);
    })()`;
    let result;
    try {
        result = new vm.Script(wrapped, { filename: 'automation-step.js' }).runInContext(context, { timeout: SCRIPT_TIMEOUT_MS });
    } catch (e) {
        throw new Error(`Script error: ${e.message}`);
    }
    if (capture && logs.length) capture(logs);
    // Copy out of the vm realm so the value is plain data.
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
}

/** Keep run logs a sensible size — a 500-row query result is not worth storing whole. */
function truncate(value, budget = 8000) {
    try {
        const text = JSON.stringify(value);
        if (!text || text.length <= budget) return value;
        return { truncated: true, preview: text.slice(0, budget) };
    } catch {
        return String(value);
    }
}

/** Merge the config_schema defaults with what the business chose. */
function resolveConfig(schema, chosen) {
    const out = {};
    for (const field of Array.isArray(schema) ? schema : []) {
        if (!field?.key) continue;
        out[field.key] = field.default ?? (field.type === 'boolean' ? false : '');
    }
    for (const [k, v] of Object.entries(chosen || {})) {
        if (k in out) out[k] = v;
    }
    return out;
}

/* ── the runner ──────────────────────────────────────────────────────── */

/**
 * Execute one definition for one business.
 *
 * @param {object} opts
 * @param {object} opts.definition  { steps, config_schema, name, … } — a version snapshot or the draft
 * @param {string} opts.slug
 * @param {object} [opts.business]  the entity row; loaded if absent
 * @param {object} opts.trigger     { type, payload }
 * @param {object} [opts.config]    the business's chosen settings
 * @param {boolean} [opts.dryRun]   side-effecting steps report instead of acting
 * @param {object} [opts.record]    { automationId, version, installId } — when set, a row is written to automation_runs
 */
async function runDefinition({ definition, slug, business, trigger, config, dryRun = false, record = null }) {
    const startedAt = Date.now();
    const steps = Array.isArray(definition?.steps) ? definition.steps : [];

    if (!business) {
        const { data } = await supabase.from('entity').select('*').eq('slug', slug).maybeSingle();
        business = data || { slug };
    }

    const ctx = {
        business,
        config: resolveConfig(definition?.config_schema, config),
        trigger: { type: trigger?.type || 'manual', payload: trigger?.payload ?? null },
        steps: {},
        now: new Date().toISOString(),
        output: { notices: [], logs: [] },
    };

    const stepsLog = [];
    let status = 'ok';
    let error = null;

    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i] || {};
        if (step.enabled === false) continue;
        const id = String(step.id || `step_${i + 1}`);
        const type = STEP_TYPES[step.type];
        const entry = { id, type: step.type, name: step.name || type?.label || step.type, status: 'ok', ms: 0 };
        const t0 = Date.now();

        try {
            if (!type) throw new Error(`Unknown step type: ${step.type}`);
            const rendered = renderDeep(step.config || {}, ctx);
            const out = await type.run({
                config: rendered,
                raw: step.config || {},
                ctx,
                slug,
                dryRun,
                capture: (lines) => ctx.output.logs.push(...lines.map((l) => `[${id}] ${l}`)),
            });
            ctx.steps[id] = out;
            entry.output = truncate(out);
            if (dryRun && type.sideEffect) entry.status = 'dry_run';
            if (typeof type.stopsWhen === 'function' && type.stopsWhen(out, rendered)) {
                entry.status = 'stopped';
                entry.ms = Date.now() - t0;
                stepsLog.push(entry);
                status = 'skipped';
                break;
            }
        } catch (e) {
            entry.status = 'failed';
            entry.error = e.message;
            entry.ms = Date.now() - t0;
            stepsLog.push(entry);
            if (step.continue_on_error) continue;
            status = 'failed';
            error = `${entry.name}: ${e.message}`;
            break;
        }
        entry.ms = Date.now() - t0;
        stepsLog.push(entry);
    }

    const result = {
        status,
        error,
        dry_run: dryRun,
        duration_ms: Date.now() - startedAt,
        steps_log: stepsLog,
        output: ctx.output,
    };

    if (record) {
        const { data: run } = await supabase.from('automation_runs').insert({
            automation_id: record.automationId,
            entity_slug: slug,
            version: record.version ?? null,
            trigger: trigger?.type || 'manual',
            status,
            dry_run: dryRun,
            started_at: new Date(startedAt).toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: result.duration_ms,
            steps_log: stepsLog,
            output: ctx.output,
            error,
        }).select('id').single();
        result.run_id = run?.id || null;

        if (record.installId && !dryRun) {
            await supabase.from('entity_automations')
                .update({ last_run_at: new Date().toISOString(), last_run_status: status })
                .eq('id', record.installId);
        }
    }

    return result;
}

/* ── versions and installs ───────────────────────────────────────────── */

const definitionCache = new Map(); // `${id}@${version}` → snapshot, per process

async function loadVersion(automationId, version) {
    const key = `${automationId}@${version}`;
    if (definitionCache.has(key)) return definitionCache.get(key);
    const { data } = await supabase
        .from('automation_versions')
        .select('definition')
        .eq('automation_id', automationId)
        .eq('version', version)
        .maybeSingle();
    const def = data?.definition || null;
    if (def) definitionCache.set(key, def);
    return def;
}

/** Run one install row at the version it carries. */
async function runInstall(install, trigger, { dryRun = false } = {}) {
    const definition = await loadVersion(install.automation_id, install.version);
    if (!definition) {
        return { status: 'failed', error: `Version ${install.version} of this automation is missing`, steps_log: [] };
    }
    return runDefinition({
        definition,
        slug: install.entity_slug,
        trigger,
        config: install.config,
        dryRun,
        record: { automationId: install.automation_id, version: install.version, installId: install.id },
    });
}

/* ── schedules ───────────────────────────────────────────────────────── */

function localParts(date, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return { hour: Number(parts.hour) % 24, dow, dayKey: `${parts.year}-${parts.month}-${parts.day}` };
}

/**
 * Is a schedule trigger due right now, given when it last ran?
 *
 * The tick runs hourly, so "at 09:00" means "in the 9 o'clock hour, once
 * that day". Minutes are ignored on purpose; promising them would be a lie.
 */
function isDue(trigger, now = new Date(), lastRunAt = null) {
    if (!trigger || trigger.type !== 'schedule') return false;
    const tz = trigger.timezone || 'America/Chicago';
    const last = lastRunAt ? new Date(lastRunAt) : null;
    const every = trigger.every || 'day';
    const atHour = Number(String(trigger.at || '09:00').split(':')[0]) || 0;
    const local = localParts(now, tz);

    if (every === 'hour') return !last || now - last >= 50 * 60 * 1000;
    if (local.hour !== atHour) return false;
    if (every === 'day') return !last || localParts(last, tz).dayKey !== local.dayKey;
    if (every === 'week') {
        const wanted = Number(trigger.day_of_week ?? 1);
        return local.dow === wanted && (!last || now - last >= 6 * 24 * 60 * 60 * 1000);
    }
    return false;
}

/* ── the two ways the platform fires runs ────────────────────────────── */

/**
 * Every enabled install of every published automation whose trigger is a
 * schedule, run if due. Bounded per tick so a bad definition cannot run away.
 */
async function tick({ now = new Date(), limit = Number(process.env.AUTOMATION_TICK_LIMIT) || 200 } = {}) {
    const { data: automations } = await supabase
        .from('automations')
        .select('id, trigger, version')
        .eq('status', 'published')
        .neq('version', 0);
    const scheduled = (automations || []).filter((a) => a.trigger?.type === 'schedule');
    const summary = { checked: 0, due: 0, ran: 0, ok: 0, failed: 0, skipped: 0, remaining: 0, automations: scheduled.length };
    if (!scheduled.length) return summary;

    let ran = 0;
    for (const auto of scheduled) {
        const { data: installs } = await supabase
            .from('entity_automations')
            .select('*')
            .eq('automation_id', auto.id)
            .eq('enabled', true)
            .order('last_run_at', { ascending: true, nullsFirst: true })
            .limit(2000);

        for (const install of installs || []) {
            summary.checked += 1;
            // The install's own version decides what runs; the draft's trigger
            // is only used to know this automation is a scheduled one.
            const def = await loadVersion(install.automation_id, install.version);
            if (!isDue(def?.trigger || auto.trigger, now, install.last_run_at)) continue;
            summary.due += 1;
            if (ran >= limit) { summary.remaining += 1; continue; }
            ran += 1;
            const result = await runInstall(install, { type: 'schedule', payload: { at: now.toISOString() } });
            summary.ran += 1;
            summary[result.status === 'ok' ? 'ok' : result.status === 'failed' ? 'failed' : 'skipped'] += 1;
        }
    }
    return summary;
}

/**
 * Fire every install of every automation listening for `event` on this slug.
 * Called by other routes — intake, bookings — after they have saved their own
 * work. Never throws: a failed automation must not fail the thing that fired it.
 */
async function emitEvent(event, slug, payload) {
    if (!slug || !event) return { ran: 0 };
    try {
        const { data: automations } = await supabase
            .from('automations').select('id, trigger').eq('status', 'published').neq('version', 0);
        const listening = (automations || []).filter((a) => a.trigger?.type === 'event' && a.trigger?.event === event);
        if (!listening.length) return { ran: 0 };

        const { data: installs } = await supabase
            .from('entity_automations')
            .select('*')
            .eq('entity_slug', slug)
            .eq('enabled', true)
            .in('automation_id', listening.map((a) => a.id));

        let ran = 0;
        for (const install of installs || []) {
            await runInstall(install, { type: 'event', payload: { event, ...(payload || {}) } });
            ran += 1;
        }
        return { ran };
    } catch (e) {
        console.error(`[automations] emit ${event} for ${slug} failed:`, e.message);
        return { ran: 0, error: e.message };
    }
}

/* ── validation, shared by create/update/publish ─────────────────────── */

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

function validateDefinition(def) {
    const problems = [];
    if (!def.name || !String(def.name).trim()) problems.push('A name is required.');
    if (def.key && !KEY_PATTERN.test(def.key)) problems.push('Key must be lowercase letters, numbers and hyphens.');
    const trigger = def.trigger || {};
    if (!TRIGGER_TYPES.some((t) => t.type === trigger.type)) problems.push(`Unknown trigger type: ${trigger.type}`);
    if (trigger.type === 'schedule' && !['hour', 'day', 'week'].includes(trigger.every || 'day')) problems.push('Schedule must be hourly, daily or weekly.');
    if (trigger.type === 'event' && !trigger.event) problems.push('Pick an event to listen for.');

    const steps = Array.isArray(def.steps) ? def.steps : [];
    const ids = new Set();
    steps.forEach((s, i) => {
        if (!STEP_TYPES[s?.type]) { problems.push(`Step ${i + 1}: unknown type "${s?.type}".`); return; }
        const id = String(s.id || '');
        if (!/^[a-z0-9_]{1,40}$/i.test(id)) problems.push(`Step ${i + 1}: needs an id (letters, numbers, underscores).`);
        if (ids.has(id)) problems.push(`Step ${i + 1}: id "${id}" is used twice.`);
        ids.add(id);
        for (const f of STEP_TYPES[s.type].fields) {
            const v = s.config?.[f.key];
            if (f.required && (v == null || v === '')) problems.push(`Step "${s.name || id}": ${f.label} is required.`);
        }
    });

    const schema = Array.isArray(def.config_schema) ? def.config_schema : [];
    const keys = new Set();
    schema.forEach((f, i) => {
        if (!/^[a-z0-9_]{1,40}$/.test(String(f?.key || ''))) problems.push(`Setting ${i + 1}: key must be lowercase letters, numbers, underscores.`);
        if (keys.has(f?.key)) problems.push(`Setting "${f.key}" is defined twice.`);
        keys.add(f?.key);
        if (!CONFIG_FIELD_TYPES.includes(f?.type || 'text')) problems.push(`Setting "${f?.key}": unknown type "${f?.type}".`);
    });
    return problems;
}

/** The catalogue as the builder reads it. */
function catalogue() {
    return {
        steps: Object.entries(STEP_TYPES).map(([type, s]) => ({
            type, label: s.label, description: s.description, category: s.category, icon: s.icon,
            side_effect: !!s.sideEffect, fields: s.fields,
        })),
        triggers: TRIGGER_TYPES,
        events: EVENTS,
        config_field_types: CONFIG_FIELD_TYPES,
        timezones: ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC'],
    };
}

const newHookToken = () => crypto.randomBytes(24).toString('hex');

module.exports = {
    STEP_TYPES,
    TRIGGER_TYPES,
    EVENTS,
    render,
    renderDeep,
    getPath,
    compare,
    runScript,
    resolveConfig,
    runDefinition,
    runInstall,
    loadVersion,
    isDue,
    tick,
    emitEvent,
    validateDefinition,
    catalogue,
    newHookToken,
    _definitionCache: definitionCache,
};
