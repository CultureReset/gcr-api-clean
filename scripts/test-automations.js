// ============================================================
// AUTOMATIONS — engine and scoping tests
// ============================================================
//
//     npm run test:automations
//
// Boots lib/automationEngine.js and routes/automations.js against a recording
// stub of ../db, so the templating, the step runner, the script sandbox, the
// schedule check and — the part that matters — the slug scoping can be
// checked with no credentials, no network and no database.
//
// The stub records every query the engine builds rather than running it, so
// the assertions read "the insert carried the session's slug" rather than
// "the insert returned something".

const path = require('path');
const Module = require('module');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const calls = [];

function builder(table, verb) {
    const rec = { table, verb, eq: {}, in: {}, args: [] };
    calls.push(rec);
    const self = {
        select: (...a) => { rec.args.push(['select', ...a]); return self; },
        insert: (v) => { rec.insert = v; return self; },
        upsert: (v) => { rec.upsert = v; return self; },
        update: (v) => { rec.update = v; return self; },
        delete: () => self,
        eq: (k, v) => { rec.eq[k] = v; return self; },
        neq: () => self,
        is: (k, v) => { rec.eq[k] = v; return self; },
        in: (k, v) => { rec.in[k] = v; return self; },
        not: () => self,
        order: (...a) => { rec.order = a; return self; },
        range: (...a) => { rec.range = a; return self; },
        limit: (n) => { rec.limit = n; return self; },
        maybeSingle: () => Promise.resolve(result(rec)),
        single: () => Promise.resolve(result(rec)),
        then: (res, rej) => Promise.resolve(result(rec)).then(res, rej),
    };
    return self;
}

const DEFINITION = {
    name: 'Nightly special',
    trigger: { type: 'schedule', every: 'day', at: '09:00' },
    config_schema: [{ key: 'reminder_phone', label: 'Phone', type: 'tel', default: '' }],
    steps: [
        { id: 'pick', type: 'data.query', config: { table: 'menu_items', filter: '{"is_active": true}', limit: 5 } },
        { id: 'gate', type: 'condition', config: { left: '{{ steps.pick.count }}', op: 'gt', right: '0' } },
        { id: 'post', type: 'data.insert', config: { table: 'entity_specials', values: '{"title": "Tonight: {{ steps.pick.rows.0.item_name }}"}' } },
        { id: 'text', type: 'sms.send', config: { to: '{{ config.reminder_phone }}', body: 'Posted {{ steps.post.row.title }} for {{ business.name }}' } },
    ],
};

const INSTALL = {
    id: 'inst-1', entity_slug: 'flora-bama', automation_id: 'auto-1', version: 2, enabled: true,
    config: { reminder_phone: '251-555-0100' }, hook_token: 'a'.repeat(48), last_run_at: null,
};

function result(rec) {
    if (rec.table === 'entity' && rec.range) return { data: [{ slug: 'flora-bama', entity_type: 'restaurant' }], error: null };
    if (rec.table === 'entity') return { data: { slug: 'flora-bama', name: 'Flora-Bama', phone: '555-0100', email: 'fb@example.com' }, error: null };
    if (rec.table === 'menu_items') return { data: [{ id: 1, item_name: 'Bushwacker', is_active: true }], error: null };
    if (rec.table === 'entity_specials') return { data: { id: 77, ...rec.insert }, error: null };
    if (rec.table === 'automation_runs') return { data: rec.insert ? { id: 'run-1' } : [], error: null };
    if (rec.table === 'automation_versions') return { data: { definition: DEFINITION }, error: null };
    if (rec.table === 'entity_automations') {
        if (rec.update) return { data: { ...INSTALL, ...rec.update }, error: null };
        if (rec.eq.hook_token) return { data: rec.eq.hook_token === INSTALL.hook_token ? INSTALL : null, error: null };
        if (rec.eq.entity_slug === 'flora-bama') return { data: rec.verb === 'select' && rec.eq.automation_id ? INSTALL : [INSTALL], error: null };
        return { data: null, error: null };
    }
    if (rec.table === 'automations') return { data: [{ id: 'auto-1', name: 'Nightly special', icon: '⚡', version: 2, status: 'published', trigger: DEFINITION.trigger }], error: null };
    return { data: [], error: null, count: 0 };
}

const dbStub = {
    from: (t) => ({
        select: (...a) => builder(t, 'select').select(...a),
        insert: (v) => builder(t, 'insert').insert(v),
        upsert: (v, o) => builder(t, 'upsert').upsert(v, o),
        update: (v) => builder(t, 'update').update(v),
        delete: () => builder(t, 'delete').delete(),
    }),
    auth: {
        getUser: async (token) => (token === 'owner-token'
            ? { data: { user: { id: 'user-1', email: 'o@example.com' } }, error: null }
            : { data: null, error: new Error('no') }),
    },
};

const smsCalls = [];
const schemaStub = {
    SYSTEM_COLUMNS: new Set(['id', 'entity_slug', 'created_at']),
    PLATFORM_TABLES: new Set(['entity_automations', 'automation_runs']),
    getSchema: async () => ({
        tables: ['menu_items', 'entity_specials'],
        columns: {
            menu_items: [{ name: 'id' }, { name: 'entity_slug' }, { name: 'item_name' }, { name: 'is_active' }],
            entity_specials: [{ name: 'id' }, { name: 'entity_slug' }, { name: 'title' }],
        },
        at: Date.now(),
    }),
    allowTable: async (n) => (['menu_items', 'entity_specials'].includes(n) ? n : null),
    cleanBody: async (t, body) => {
        const out = {};
        for (const [k, v] of Object.entries(body || {})) {
            if (['id', 'entity_slug', 'created_at'].includes(k)) continue;
            out[k] = v;
        }
        return out;
    },
};

function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.join(ROOT, 'db.js'), dbStub);
inject(path.join(ROOT, 'lib/businessTables.js'), schemaStub);
inject(path.join(ROOT, 'utils/sms.js'), { sendSms: async (to, body) => { smsCalls.push({ to, body }); return { success: true, sid: 'SM1' }; } });
inject(path.join(ROOT, 'middleware/auth.js'), { adminRequired: (req, res, next) => (req.headers.authorization === 'Bearer admin' ? next() : res.status(401).json({ error: 'no' })), authRequired: (r, s, n) => n() });

const engine = require(path.join(ROOT, 'lib/automationEngine.js'));

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
    if (ok) { passed += 1; console.log(`  ok    ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
    console.log('\nTemplating');
    const ctx = { business: { name: 'Flora-Bama' }, steps: { q: { rows: [{ id: 9 }], count: 1 } }, config: { n: 3 } };
    check('inline path', engine.render('Hi {{ business.name }}!', ctx) === 'Hi Flora-Bama!');
    check('whole-value template returns the raw value', Array.isArray(engine.render('{{ steps.q.rows }}', ctx)));
    check('array index path (whole value stays a number)', engine.render('{{steps.q.rows.0.id}}', ctx) === 9);
    check('array index path inline', engine.render('#{{steps.q.rows.0.id}}', ctx) === '#9');
    check('missing path renders empty', engine.render('[{{ nope.x }}]', ctx) === '[]');
    check('objects render as JSON inline', engine.render('row: {{ steps.q.rows.0 }}', ctx) === 'row: {"id":9}');
    check('renderDeep walks objects and arrays', engine.renderDeep({ a: ['{{ config.n }}'], b: { c: '{{ business.name }}' } }, ctx).b.c === 'Flora-Bama');

    console.log('\nConditions');
    check('gt on numeric strings', engine.compare('3', 'gt', '2'));
    check('eq numeric vs string', engine.compare(3, 'eq', '3'));
    check('contains is case-insensitive', engine.compare('Bushwacker', 'contains', 'wack'));
    check('empty array is empty', engine.compare([], 'empty'));
    check('truthy rejects "false"', !engine.compare('false', 'truthy'));

    console.log('\nScript sandbox');
    const out = engine.runScript('return { n: steps.q.count * 2, name: business.name.toUpperCase() }', ctx);
    check('script sees the run and returns plain data', out.n === 2 && out.name === 'FLORA-BAMA');
    let blocked = false;
    try { engine.runScript('return process.env', ctx); } catch (e) { blocked = /process is not defined/.test(e.message); }
    check('process is not in scope', blocked);
    let timedOut = false;
    try { engine.runScript('while (true) {}', ctx); } catch (e) { timedOut = /timed out|Script execution/i.test(e.message); }
    check('an infinite loop is cut off', timedOut);
    let noRequire = false;
    try { engine.runScript('return require("fs")', ctx); } catch (e) { noRequire = /require is not defined/.test(e.message); }
    check('require is not in scope', noRequire);

    console.log('\nSchedules');
    const chicago9 = new Date('2026-09-14T14:30:00Z'); // 09:30 Central, a Monday
    const chicago10 = new Date('2026-09-14T15:30:00Z');
    check('daily at 09:00 is due in the 9 o\'clock hour', engine.isDue({ type: 'schedule', every: 'day', at: '09:00' }, chicago9, null));
    check('…and not in the 10 o\'clock hour', !engine.isDue({ type: 'schedule', every: 'day', at: '09:00' }, chicago10, null));
    check('…and not twice the same day', !engine.isDue({ type: 'schedule', every: 'day', at: '09:00' }, chicago9, '2026-09-14T14:05:00Z'));
    check('…but again the next day', engine.isDue({ type: 'schedule', every: 'day', at: '09:00' }, new Date('2026-09-15T14:30:00Z'), '2026-09-14T14:05:00Z'));
    check('hourly runs when 50 min have passed', engine.isDue({ type: 'schedule', every: 'hour' }, chicago10, chicago9.toISOString()));
    check('weekly on Monday at 9 is due', engine.isDue({ type: 'schedule', every: 'week', day_of_week: 1, at: '09:00' }, chicago9, null));
    check('weekly on Tuesday is not', !engine.isDue({ type: 'schedule', every: 'week', day_of_week: 2, at: '09:00' }, chicago9, null));
    check('manual triggers are never due', !engine.isDue({ type: 'manual' }, chicago9, null));

    console.log('\nValidation');
    check('a good definition has no problems', engine.validateDefinition(DEFINITION).length === 0, JSON.stringify(engine.validateDefinition(DEFINITION)));
    check('an unknown step type is caught', engine.validateDefinition({ ...DEFINITION, steps: [{ id: 'x', type: 'nope', config: {} }] }).some((p) => /unknown type/.test(p)));
    check('a duplicate step id is caught', engine.validateDefinition({ ...DEFINITION, steps: [DEFINITION.steps[0], DEFINITION.steps[0]] }).some((p) => /used twice/.test(p)));
    check('a required step field is caught', engine.validateDefinition({ ...DEFINITION, steps: [{ id: 'q', type: 'data.query', config: {} }] }).some((p) => /Table is required/.test(p)));
    check('a bad key is caught', engine.validateDefinition({ ...DEFINITION, key: 'Not Valid' }).some((p) => /Key must/.test(p)));

    console.log('\nRunner — a real run is scoped to the business and records itself');
    calls.length = 0; smsCalls.length = 0;
    const run = await engine.runDefinition({
        definition: DEFINITION, slug: 'flora-bama', trigger: { type: 'manual' },
        config: INSTALL.config, record: { automationId: 'auto-1', version: 2, installId: 'inst-1' },
    });
    check('run finished ok', run.status === 'ok', run.error);
    check('four steps logged', run.steps_log.length === 4);
    const q = calls.find((c) => c.table === 'menu_items');
    check('query filtered on the business slug', q && q.eq.entity_slug === 'flora-bama');
    check('query applied the JSON filter', q && q.eq.is_active === true);
    const ins = calls.find((c) => c.table === 'entity_specials' && c.insert);
    check('insert stamped the business slug', ins && ins.insert.entity_slug === 'flora-bama');
    check('insert rendered the template from the earlier step', ins && ins.insert.title === 'Tonight: Bushwacker');
    check('sms went to the business\'s own setting', smsCalls.length === 1 && smsCalls[0].to === '251-555-0100');
    check('sms body used the inserted row', smsCalls[0]?.body === 'Posted Tonight: Bushwacker for Flora-Bama');
    const rec = calls.find((c) => c.table === 'automation_runs' && c.insert);
    check('a run row was written with the step log', rec && rec.insert.status === 'ok' && rec.insert.steps_log.length === 4);
    const touched = calls.find((c) => c.table === 'entity_automations' && c.update);
    check('the install\'s last_run was updated', touched && touched.update.last_run_status === 'ok' && touched.eq.id === 'inst-1');

    console.log('\nRunner — a dry run reads but never writes or sends');
    calls.length = 0; smsCalls.length = 0;
    const dry = await engine.runDefinition({ definition: DEFINITION, slug: 'flora-bama', trigger: { type: 'test' }, config: INSTALL.config, dryRun: true });
    check('dry run still completes', dry.status === 'ok', dry.error);
    check('no insert was built', !calls.some((c) => c.table === 'entity_specials' && c.insert));
    check('no text was sent', smsCalls.length === 0);
    check('side-effect steps are marked dry_run', dry.steps_log.filter((s) => s.status === 'dry_run').length === 2);
    check('the would-insert is visible in the log', dry.steps_log[2].output.would_insert.values.title === 'Tonight: Bushwacker');

    console.log('\nRunner — a failed condition stops the run as skipped');
    const gated = await engine.runDefinition({
        definition: { ...DEFINITION, steps: [{ id: 'gate', type: 'condition', config: { left: '0', op: 'gt', right: '1' } }, DEFINITION.steps[3]] },
        slug: 'flora-bama', trigger: { type: 'manual' }, config: INSTALL.config, dryRun: true,
    });
    check('status is skipped', gated.status === 'skipped');
    check('nothing after the gate ran', gated.steps_log.length === 1 && gated.steps_log[0].status === 'stopped');

    console.log('\nRunner — a table outside the allow-list is refused');
    const bad = await engine.runDefinition({
        definition: { ...DEFINITION, steps: [{ id: 'q', type: 'data.query', config: { table: 'auth.users' } }] },
        slug: 'flora-bama', trigger: { type: 'manual' }, config: {}, dryRun: true,
    });
    check('run failed', bad.status === 'failed' && /Not a business table/.test(bad.error));
    check('no query reached the stub', !calls.some((c) => c.table === 'auth.users'));

    console.log('\nOwner router — the slug comes from the session, never the request');
    const routes = require(path.join(ROOT, 'routes/automations.js'));
    const app = express();
    app.use(express.json());
    app.use('/api/business/automations', routes.ownerRouter);
    app.use('/api/automations', routes.publicRouter);
    app.use('/api/admin/automations', routes);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const ownerCalls = [];
    // ownerAuth is real: the stub's entity_owners answers below.
    const realResult = result;
    // eslint-disable-next-line no-func-assign
    result = (rec) => {
        if (rec.table === 'entity_owners') return { data: [{ entity_slug: 'flora-bama', role: 'owner' }], error: null };
        return realResult(rec);
    };

    calls.length = 0;
    let res = await fetch(`${base}/api/business/automations?slug=someone-else`, { headers: { Authorization: 'Bearer owner-token' } });
    let body = await res.json();
    check('list answers 200', res.status === 200, JSON.stringify(body));
    const listCall = calls.find((c) => c.table === 'entity_automations');
    check('list filtered on the session\'s slug, ignoring ?slug=', listCall && listCall.eq.entity_slug === 'flora-bama');
    check('list carries the installed version and its settings', body.automations?.[0]?.version === 2 && body.automations[0].config.reminder_phone === '251-555-0100');
    check('list never exposes the hook token', JSON.stringify(body).includes('hook_token') === false);

    calls.length = 0;
    res = await fetch(`${base}/api/business/automations/auto-1`, {
        method: 'PATCH', headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, config: { reminder_phone: '251-555-0200', not_a_setting: 'x' }, entity_slug: 'someone-else' }),
    });
    body = await res.json();
    check('patch answers 200', res.status === 200, JSON.stringify(body));
    const lookup = calls.find((c) => c.table === 'entity_automations' && c.verb === 'select');
    check('patch looked the install up by the session\'s slug', lookup && lookup.eq.entity_slug === 'flora-bama');
    const upd = calls.find((c) => c.table === 'entity_automations' && c.update);
    check('patch kept only keys the version declares', upd && upd.update.config.reminder_phone === '251-555-0200' && !('not_a_setting' in upd.update.config));
    check('patch cannot move the row to another slug', upd && !('entity_slug' in upd.update));

    res = await fetch(`${base}/api/business/automations`, { headers: { Authorization: 'Bearer nope' } });
    check('a bad session is refused', res.status === 401);

    console.log('\nPublic hook — the token is the credential');
    calls.length = 0; smsCalls.length = 0;
    res = await fetch(`${base}/api/automations/hook/${'a'.repeat(48)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 1 }) });
    body = await res.json();
    check('unknown trigger type for this install is refused (it is a schedule)', res.status === 400, JSON.stringify(body));
    res = await fetch(`${base}/api/automations/hook/${'b'.repeat(48)}`, { method: 'POST' });
    check('an unknown token is a 404', res.status === 404);
    res = await fetch(`${base}/api/automations/hook/short`, { method: 'POST' });
    check('a malformed token is a 404', res.status === 404);

    console.log('\nAdmin router');
    res = await fetch(`${base}/api/admin/automations/meta`);
    check('meta needs an admin', res.status === 401);
    res = await fetch(`${base}/api/admin/automations/meta`, { headers: { Authorization: 'Bearer admin' } });
    body = await res.json();
    check('meta lists the step palette with fields', Array.isArray(body.steps) && body.steps.every((s) => s.type && Array.isArray(s.fields)));
    check('meta lists triggers and events', body.triggers?.length === 4 && body.events?.length >= 1);

    server.close();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
