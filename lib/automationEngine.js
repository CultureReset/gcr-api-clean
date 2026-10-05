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
//
// ── Waiting, agents and messages (CONTRACT §9) ──────────────────────────
//
// `wait` saves the run where it stands in automation_waits (the step to resume
// at, the context so far, when it is due) and the run ends as `waiting`. The
// scheduled check (tick, below — hourly from vercel.json, or the always-on
// scheduler) picks up waits that are due and runs the rest. `agent` posts to
// the install's Paperclip routine webhook, signed hmac_sha256 the way
// Paperclip checks it. `message` is messages.send (lib/messages.js).
//
// A run that fails, or that holds something for the owner's OK, tells the
// owner (lib/notify.js).

const vm = require('vm');
const crypto = require('crypto');
const supabase = require('../db');
const { allowTable, cleanBody, getSchema } = require('./businessTables');
const { envInt, envStr } = require('./env');

/** The timezone a schedule or a booking's local time is read in when none is given. */
const defaultTimezone = () => envStr('DEFAULT_TIMEZONE', 'UTC');

// The engine's clock. Real time, except in tests.
let clock = () => new Date();

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

/**
 * The numbers that are the business's own, from its data: the listing's phone,
 * the owner's notification phone, and numbers bought for it. E.164.
 */
async function businessOwnNumbers(slug) {
    const { normalizePhone } = require('./telephony');
    const [{ data: entity }, { data: notify }, { data: numbers }] = await Promise.all([
        supabase.from('entity').select('phone').eq('slug', slug).maybeSingle(),
        supabase.from('owner_notify_settings').select('phone').eq('entity_slug', slug).maybeSingle(),
        supabase.from('business_phone_numbers').select('phone_number, status').eq('entity_slug', slug),
    ]);
    const out = new Set();
    for (const p of [entity?.phone, notify?.phone]) if (p) out.add(normalizePhone(p));
    for (const n of Array.isArray(numbers) ? numbers : []) if (n?.phone_number && n.status === 'active') out.add(normalizePhone(n.phone_number));
    out.delete(null);
    return out;
}

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
            await require('./googlePush').noteTableWrite(slug, table, data);
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
            await require('./googlePush').noteTableWrite(slug, table, data[0]);
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
        // Only platform admins write scripts; a business can switch one on.
        adminOnly: true,
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
            { key: 'system', label: 'Instructions', type: 'textarea', rows: 3, placeholder: 'You write short, upbeat copy for {{ business.name }}.' },
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
        // Calls any URL from this server, so only the operator's builder has it.
        adminOnly: true,
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
        label: 'Text the business',
        description: 'A text from the platform number to the business itself: its listed phone, the owner\'s notification phone, or a number it owns. To text a customer, use "Message a customer", which keeps the consent and registered-number rules.',
        category: 'Notify',
        icon: '💬',
        sideEffect: true,
        fields: [
            { key: 'to', label: 'To', type: 'text', required: true, default: '{{ business.phone }}', help: 'The business\'s own numbers only (its listed phone, the owner\'s notification phone, or a number it owns). Any other number is refused.' },
            { key: 'body', label: 'Message', type: 'textarea', required: true, rows: 4 },
        ],
        async run({ config, slug, dryRun }) {
            const to = String(config.to || '').trim();
            const body = String(config.body || '').trim();
            if (!to) throw new Error('No phone number');
            if (!body) throw new Error('Empty message');
            const own = await businessOwnNumbers(slug);
            const { normalizePhone } = require('./telephony');
            if (!own.has(normalizePhone(to))) {
                throw new Error('A text step only goes to the business\'s own numbers. To text a customer, use "Message a customer".');
            }
            if (dryRun) return { dry_run: true, would_text: { to, body } };
            const { sendSms } = require('../utils/sms');
            return await sendSms(to, body, slug, 'automation');
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

    wait: {
        label: 'Wait',
        description: 'Pause the run, then carry on with the next step. The wait is saved; the scheduled check picks it up when it is due.',
        category: 'Logic',
        icon: '⏳',
        sideEffect: false,
        fields: [
            { key: 'minutes', label: 'Minutes', type: 'number', required: true, default: 60, help: 'Checked by the scheduled run, so the run carries on at the first check after this.' },
        ],
        async run({ config, dryRun }) {
            const minutes = Number(config.minutes);
            if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Minutes must be a positive number');
            const maxMinutes = envInt('AUTOMATION_WAIT_MAX_MINUTES', 0);
            if (maxMinutes && minutes > maxMinutes) throw new Error(`A wait can be at most ${maxMinutes} minutes`);
            const dueAt = new Date(clock().getTime() + minutes * 60 * 1000).toISOString();
            if (dryRun) return { dry_run: true, would_wait: { minutes, due_at: dueAt } };
            return { minutes, due_at: dueAt };
        },
        // The runner sees this and saves the run instead of going on.
        pausesRun: true,
    },

    agent: {
        label: 'Give this to an agent',
        description: 'Hand the work to one of the business\'s agents through its Paperclip routine. The run is recorded in Paperclip as work for that agent.',
        category: 'Connect',
        icon: '🧑‍💼',
        sideEffect: true,
        fields: [
            { key: 'item_key', label: 'Agent install (store item)', type: 'text', default: '{{ automation.key }}', help: 'The store item whose install holds the routine webhook. Defaults to this automation\'s own install.' },
            { key: 'install_id', label: 'Install id', type: 'text', help: 'Optional. A specific install, instead of looking it up by item.' },
            { key: 'instructions', label: 'What to do', type: 'textarea', rows: 4, placeholder: 'Ask {{ trigger.payload.customer_name }} for a review.' },
            { key: 'payload', label: 'Details', type: 'json', placeholder: '{ "booking": "{{ trigger.payload }}" }' },
        ],
        async run({ config, slug, dryRun, ctx }) {
            const routine = await routineForStep(slug, config);
            const body = {
                source: 'automation',
                business: { slug, name: ctx.business?.name || null },
                automation: ctx.automation || null,
                run: { id: ctx.runId || null, step: ctx.stepId || null, at: new Date().toISOString() },
                trigger: ctx.trigger,
                instructions: config.instructions ? String(config.instructions) : null,
                payload: asObject(config.payload),
            };
            if (dryRun) return { dry_run: true, would_post: { install_id: routine.installId, body } };
            return postToRoutine(routine, body);
        },
    },

    message: {
        label: 'Message a customer',
        description: 'messages.send: an email, or a text from the business\'s registered number to a customer who agreed to texts.',
        category: 'Notify',
        icon: '📨',
        sideEffect: true,
        fields: [
            { key: 'channel', label: 'Channel', type: 'select', required: true, default: 'email',
              options: [{ value: 'email', label: 'email' }, { value: 'sms', label: 'text' }] },
            { key: 'to', label: 'To', type: 'text', required: true, placeholder: '{{ trigger.payload.customer_email }}' },
            { key: 'subject', label: 'Subject (email)', type: 'text' },
            { key: 'body', label: 'Message', type: 'textarea', required: true, rows: 4 },
            { key: 'require_approval', label: 'Owner approves first', type: 'boolean', default: false },
        ],
        async run({ config, slug, dryRun, ctx }) {
            if (dryRun) return { dry_run: true, would_message: { channel: config.channel, to: config.to } };
            const { sendMessage } = require('./messages');
            const truthy = config.require_approval === true || config.require_approval === 'true';
            const msg = await sendMessage({
                slug,
                channel: String(config.channel || ''),
                to: config.to,
                subject: config.subject,
                body: config.body,
                author: 'automation',
                requireApproval: truthy,
                runId: ctx.runId || null,
            });
            if (msg.status === 'blocked' || msg.status === 'failed') {
                throw new Error(`Message not sent (${msg.status_reason || msg.status})`);
            }
            return { message_id: msg.id, status: msg.status };
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

/**
 * Events the platform emits. Add a name here when a route starts emitting it.
 * Installed apps add their own: `<appKey>.<event>` for each events.emits
 * entry of an installed manifest (appEventsFor, DECISIONS #47) — the
 * registry of valid app events is the set of installed manifests, not a list.
 */
const EVENTS = [
    { name: 'intake.created', description: 'A business submitted its links through the intake form.' },
    { name: 'automation.installed', description: 'This automation was just pushed to the business.' },
    { name: 'booking.created', description: 'A booking arrived — forwarded email, the booking page, or entered by hand.' },
    { name: 'booking.changed', description: 'A booking\'s date, time or party changed.' },
    { name: 'booking.cancelled', description: 'A booking was cancelled.' },
    { name: 'booking.completed', description: 'A booking\'s end time passed and it was not cancelled (found by the scheduled check).' },
    { name: 'payment.received', description: 'A payment was detected — claimed from an email, or verified by the payment provider.' },
    { name: 'review.received', description: 'A customer left a review.' },
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

/* ── helpers for the agent step ──────────────────────────────────────── */

/**
 * The routine webhook an agent step posts to: the install named, or this
 * business's active automation install of the item named. The install must
 * belong to the business the run is for — a definition cannot point a run at
 * another business's agent.
 */
async function routineForStep(slug, config) {
    const { routineFor } = require('../routes/nextgent');
    let installId = config.install_id ? String(config.install_id).trim() : '';
    if (!installId) {
        const itemKey = String(config.item_key || '').trim();
        if (!itemKey) throw new Error('Name the agent install (item key or install id)');
        const { data } = await supabase.from('nextgent_installs').select('install_id')
            .eq('entity_slug', slug).eq('item_key', itemKey).eq('status', 'active')
            .not('routine_webhook_url', 'is', null).limit(1);
        installId = data?.[0]?.install_id || '';
        if (!installId) throw new Error(`No active install of ${itemKey} with an agent routine for this business`);
    }
    const routine = await routineFor(installId);
    if (!routine) throw new Error('That install has no routine webhook (or was removed)');
    if (routine.entitySlug !== slug) throw new Error('That install belongs to another business');
    return { ...routine, installId };
}

/**
 * Paperclip's hmac_sha256 webhook signing, exactly as its routine service
 * checks it: X-Paperclip-Timestamp is unix seconds, X-Paperclip-Signature is
 * "sha256=" + hex HMAC-SHA256(secret, `${timestamp}.` + rawBody).
 */
function paperclipRoutineHeaders(secret, rawBody, now = Date.now()) {
    // The same HMAC as CONTRACT §3 (lib/serviceSigning.js, one copy); only
    // the header names and the "sha256=" prefix are Paperclip's routine format.
    const { signature } = require('./serviceSigning');
    const timestamp = String(Math.floor(now / 1000));
    return { 'X-Paperclip-Timestamp': timestamp, 'X-Paperclip-Signature': `sha256=${signature(timestamp, rawBody, secret)}` };
}

let routineFetch = (...args) => fetch(...args);

async function postToRoutine(routine, body) {
    const raw = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), envInt('AUTOMATION_AGENT_TIMEOUT_MS', 10000));
    try {
        const res = await routineFetch(routine.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...paperclipRoutineHeaders(routine.webhookSecret, raw) },
            body: raw,
            signal: controller.signal,
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
        if (!res.ok) throw new Error(`The agent's routine answered ${res.status}${parsed?.error ? `: ${parsed.error}` : ''}`);
        return { accepted: true, status: res.status, install_id: routine.installId, run: parsed?.id || null, issue: parsed?.linkedIssueId || null, routine_status: parsed?.status || null };
    } catch (e) {
        throw new Error(e.name === 'AbortError' ? 'The agent\'s routine did not answer in time' : e.message);
    } finally {
        clearTimeout(timer);
    }
}

function timezones() {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return [defaultTimezone()]; }
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
 * @param {object} [opts.record]    { automationId, version, installId, automationKey } — when set, a row is written to automation_runs
 * @param {object} [opts.resume]    { runId, stepIndex, steps, stepsLog, now } — carry on a run a wait paused
 */
async function runDefinition({ definition, slug, business, trigger, config, dryRun = false, record = null, resume = null }) {
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
        steps: resume?.steps ? { ...resume.steps } : {},
        now: clock().toISOString(),
        output: { notices: [], logs: [] },
        automation: record ? { id: record.automationId, key: record.automationKey || null, version: record.version ?? null, name: definition?.name || null } : null,
        runId: resume?.runId || null,
    };

    // A recorded run gets its row first, so steps can name it (the agent
    // step sends it to Paperclip; a wait saves against it).
    if (record && !resume) {
        const { data: run } = await supabase.from('automation_runs').insert({
            automation_id: record.automationId,
            entity_slug: slug,
            version: record.version ?? null,
            trigger: trigger?.type || 'manual',
            status: 'running',
            dry_run: dryRun,
            started_at: new Date(startedAt).toISOString(),
            steps_log: [],
        }).select('id').single();
        ctx.runId = run?.id || null;
    }

    const stepsLog = Array.isArray(resume?.stepsLog) ? resume.stepsLog.slice() : [];
    let status = 'ok';
    let error = null;
    let waiting = null;

    for (let i = resume ? resume.stepIndex : 0; i < steps.length; i += 1) {
        const step = steps[i] || {};
        if (step.enabled === false) continue;
        const id = String(step.id || `step_${i + 1}`);
        const type = STEP_TYPES[step.type];
        const entry = { id, type: step.type, name: step.name || type?.label || step.type, status: 'ok', ms: 0 };
        const t0 = Date.now();
        ctx.stepId = id;

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
            if (type.pausesRun && !dryRun) {
                entry.status = 'waiting';
                entry.ms = Date.now() - t0;
                stepsLog.push(entry);
                waiting = { stepIndex: i + 1, dueAt: out.due_at };
                status = 'waiting';
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
    delete ctx.stepId;

    const result = {
        status,
        error,
        dry_run: dryRun,
        duration_ms: Date.now() - startedAt,
        steps_log: stepsLog,
        output: ctx.output,
    };

    if (waiting && !record) {
        // Unrecorded runs (tests from the builder) do not wait: there is
        // nothing to resume them against.
        result.status = 'ok';
        result.waited = waiting;
    }

    if (record) {
        const runId = ctx.runId;
        result.run_id = runId;
        await supabase.from('automation_runs').update({
            status,
            finished_at: status === 'waiting' ? null : new Date().toISOString(),
            duration_ms: result.duration_ms,
            steps_log: stepsLog,
            output: ctx.output,
            error,
        }).eq('id', runId);

        if (waiting) {
            const { error: waitError } = await supabase.from('automation_waits').insert({
                run_id: runId,
                automation_id: record.automationId,
                version: record.version ?? null,
                install_id: record.installId || null,
                entity_slug: slug,
                step_index: waiting.stepIndex,
                due_at: waiting.dueAt,
                state: 'waiting',
                context: { trigger: ctx.trigger, steps: ctx.steps, automation: ctx.automation },
            });
            if (waitError) {
                result.status = 'failed';
                result.error = `Could not save the wait: ${waitError.message}`;
                await supabase.from('automation_runs').update({ status: 'failed', error: result.error, finished_at: new Date().toISOString() }).eq('id', runId);
            }
        }

        if (record.installId && !dryRun) {
            await supabase.from('entity_automations')
                .update({ last_run_at: new Date().toISOString(), last_run_status: result.status })
                .eq('id', record.installId);
        }

        if (result.status === 'failed' && !dryRun) {
            const { notifyOwner } = require('./notify');
            await notifyOwner(slug, {
                kind: 'failed_action',
                title: `An automation did not finish: ${definition?.name || 'automation'}`,
                body: String(result.error || '').slice(0, 500),
                ref: runId ? `run:${runId}` : null,
                link: process.env.OWNER_AUTOMATIONS_PATH || null,
            });
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

const keyCache = new Map(); // automation id → key, per process

async function automationKey(automationId) {
    if (keyCache.has(automationId)) return keyCache.get(automationId);
    const { data } = await supabase.from('automations').select('key').eq('id', automationId).maybeSingle();
    const key = data?.key || null;
    if (key) keyCache.set(automationId, key);
    return key;
}

/** Run one install row at the version it carries. */
async function runInstall(install, trigger, { dryRun = false, resume = null } = {}) {
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
        resume,
        record: {
            automationId: install.automation_id,
            version: install.version,
            installId: install.id,
            automationKey: await automationKey(install.automation_id),
        },
    });
}

/* ── waits ───────────────────────────────────────────────────────────── */

/**
 * Carry on every wait that is due. Each is claimed (state waiting → running)
 * before it runs, so two checks running at once cannot both resume it. A wait
 * whose install was switched off or removed is cancelled, not run.
 */
async function resumeWaits({ now = new Date(), limit = envInt('AUTOMATION_RESUME_LIMIT', 100) } = {}) {
    const summary = { due: 0, resumed: 0, cancelled: 0, failed: 0 };
    const { data: due, error } = await supabase.from('automation_waits').select('*')
        .eq('state', 'waiting').lte('due_at', now.toISOString())
        .order('due_at', { ascending: true }).limit(limit);
    if (error) return { ...summary, error: error.message };

    for (const wait of due || []) {
        summary.due += 1;
        const { data: claimed } = await supabase.from('automation_waits')
            .update({ state: 'running', resumed_at: now.toISOString() })
            .eq('id', wait.id).eq('state', 'waiting').select('id');
        if (!claimed?.length) continue;

        const { data: install } = wait.install_id
            ? await supabase.from('entity_automations').select('*').eq('id', wait.install_id).maybeSingle()
            : { data: null };
        if (!install || !install.enabled || install.entity_slug !== wait.entity_slug) {
            await supabase.from('automation_waits').update({ state: 'cancelled' }).eq('id', wait.id);
            if (wait.run_id) {
                await supabase.from('automation_runs').update({ status: 'skipped', error: 'Switched off while waiting', finished_at: now.toISOString() }).eq('id', wait.run_id);
            }
            summary.cancelled += 1;
            continue;
        }

        const { data: run } = wait.run_id
            ? await supabase.from('automation_runs').select('steps_log').eq('id', wait.run_id).maybeSingle()
            : { data: null };
        const context = wait.context || {};
        // The wait resumes the version it started on, even if the business
        // has moved on since: a run is one version from start to end.
        const result = await runInstall({ ...install, version: wait.version ?? install.version }, context.trigger || { type: 'resume' }, {
            resume: { runId: wait.run_id, stepIndex: wait.step_index, steps: context.steps || {}, stepsLog: run?.steps_log || [] },
        });
        await supabase.from('automation_waits').update({ state: result.status === 'failed' ? 'failed' : 'done' }).eq('id', wait.id);
        if (result.status === 'failed') summary.failed += 1;
        else summary.resumed += 1;
    }
    return summary;
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
    const tz = trigger.timezone || defaultTimezone();
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
    // Business events the clock finds (booking.completed) and waits that are
    // due run first; then the scheduled automations.
    const { completeBookings } = require('./businessEvents');
    const bookings = await completeBookings({ now }).catch((e) => ({ error: e.message }));
    const waits = await resumeWaits({ now }).catch((e) => ({ error: e.message }));
    const scheduledSummary = await tickSchedules({ now, limit });
    return { ...scheduledSummary, waits, bookings };
}

async function tickSchedules({ now, limit }) {
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

/* ── the events a business's installed apps declare (DECISIONS #47) ──── */

/**
 * `<appKey>.<event>` for every events.emits entry of every enabled app
 * Paperclip has installed for this business (entity_modules rows managed by
 * Paperclip, lib/appInstances.js). Read live: install an app and its events
 * are here, remove it and they are gone. Never throws.
 */
async function appEventsFor(slug) {
    if (!slug) return [];
    try {
        const { MANAGED_BY } = require('./appInstances');
        const { declaredEvents } = require('./businessEvents');
        const { data, error } = await supabase.from('entity_modules').select('*').eq('entity_slug', slug).eq('managed_by', MANAGED_BY);
        if (error) return [];
        const out = [];
        for (const row of data || []) {
            if (row.enabled === false || row.managed_by !== MANAGED_BY) continue;
            const manifest = row.settings && typeof row.settings === 'object' ? row.settings.manifest : null;
            if (!manifest || row.settings.kind === 'layout') continue;
            for (const event of declaredEvents(manifest)) {
                out.push({ name: `${row.module_key}.${event}`, description: `Emitted by the ${manifest.name || row.module_key} app.`, app: row.module_key });
            }
        }
        return out;
    } catch (e) {
        console.error(`[automations] app events for ${slug}:`, e.message);
        return [];
    }
}

/** The platform's events plus this business's installed apps' events. */
async function knownEvents(slug) {
    return EVENTS.concat(await appEventsFor(slug));
}

/* ── validation, shared by create/update/publish ─────────────────────── */

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * `events`, when given, is the list an event trigger may name (knownEvents
 * for an owner's business). Without it the event name is not checked: the
 * admin builds for every business, and an app's event exists wherever that
 * app is installed.
 */
function validateDefinition(def, { forOwner = false, events = null } = {}) {
    const problems = [];
    if (!def.name || !String(def.name).trim()) problems.push('A name is required.');
    if (def.key && !KEY_PATTERN.test(def.key)) problems.push('Key must be lowercase letters, numbers and hyphens.');
    const trigger = def.trigger || {};
    if (!TRIGGER_TYPES.some((t) => t.type === trigger.type)) problems.push(`Unknown trigger type: ${trigger.type}`);
    if (trigger.type === 'schedule' && !['hour', 'day', 'week'].includes(trigger.every || 'day')) problems.push('Schedule must be hourly, daily or weekly.');
    if (trigger.type === 'event' && !trigger.event) problems.push('Pick an event to listen for.');
    if (trigger.type === 'event' && trigger.event && Array.isArray(events) && !events.some((e) => e.name === trigger.event)) {
        problems.push(`No installed app or platform event is called "${trigger.event}".`);
    }

    const steps = Array.isArray(def.steps) ? def.steps : [];
    const ids = new Set();
    steps.forEach((s, i) => {
        if (!STEP_TYPES[s?.type]) { problems.push(`Step ${i + 1}: unknown type "${s?.type}".`); return; }
        if (forOwner && STEP_TYPES[s.type].adminOnly) { problems.push(`Step ${i + 1}: "${STEP_TYPES[s.type].label}" is only available to the platform.`); return; }
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

/**
 * The catalogue as the builder reads it. forOwner leaves out the platform-only
 * steps; `events` (knownEvents for a business) replaces the platform list.
 */
function catalogue({ forOwner = false, events = null } = {}) {
    return {
        steps: Object.entries(STEP_TYPES).filter(([, s]) => !(forOwner && s.adminOnly)).map(([type, s]) => ({
            type, label: s.label, description: s.description, category: s.category, icon: s.icon,
            side_effect: !!s.sideEffect, fields: s.fields,
        })),
        triggers: TRIGGER_TYPES,
        events: Array.isArray(events) ? events : EVENTS,
        config_field_types: CONFIG_FIELD_TYPES,
        timezones: timezones(),
        default_timezone: defaultTimezone(),
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
    resumeWaits,
    paperclipRoutineHeaders,
    loadVersion,
    isDue,
    tick,
    emitEvent,
    appEventsFor,
    knownEvents,
    validateDefinition,
    catalogue,
    newHookToken,
    _definitionCache: definitionCache,
    _setRoutineFetch: (impl) => { routineFetch = impl; },
    _setClock: (fn) => { clock = fn; },
};
