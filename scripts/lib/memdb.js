// ============================================================
// An in-memory stand-in for ../db, for the tests in scripts/
// ============================================================
//
// Enough of the supabase-js query builder to run the routes against plain
// arrays: select / insert / upsert / update / delete, the filters the code
// uses, order, range, limit, single and maybeSingle. Rows live in `T`, keyed
// by table name, so a test can seed them and read them back.
//
//   const { T, db, inject } = require('./lib/memdb');
//   inject(path.join(ROOT, 'db.js'), db);
//
// `unique` names the columns that must be unique per table, so an insert can
// fail the way Postgres would.

const Module = require('module');

function createMemDb({ tables = {}, unique = {} } = {}) {
    const T = tables;
    let seq = 0;
    const like = (v, pat, flags = '') => new RegExp(`^${String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, flags).test(String(v ?? ''));
    const cmp = (a, b) => (a === b ? 0 : (a ?? '') > (b ?? '') ? 1 : -1);

    function orClause(expr) {
        const parts = [];
        let depth = 0, cur = '';
        for (const ch of expr) {
            if (ch === '(') depth += 1;
            if (ch === ')') depth -= 1;
            if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
        }
        if (cur) parts.push(cur);
        return (r) => parts.some((p) => {
            const [col, op, ...rest] = p.split('.');
            const val = rest.join('.');
            if (op === 'eq') return String(r[col]) === val;
            if (op === 'neq') return String(r[col]) !== val;
            if (op === 'is') return val === 'null' ? r[col] == null : String(r[col]) === val;
            if (op === 'like') return like(r[col], val);
            if (op === 'ilike') return like(r[col], val, 'i');
            if (op === 'lte') return String(r[col]) <= val;
            if (op === 'gte') return String(r[col]) >= val;
            if (op === 'lt') return String(r[col]) < val;
            if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(r[col]));
            return false;
        });
    }

    function table(name) {
        const st = { filters: [], verb: 'select', values: null, onConflict: null, range: null, limitN: null, orders: [], head: false };
        const rows = () => (T[name] ||= []);
        const match = (r) => st.filters.every((f) => f(r));
        function run() {
            const all = rows();
            if (st.verb === 'insert') {
                const list = Array.isArray(st.values) ? st.values : [st.values];
                for (const v of list) {
                    for (const cols of unique[name] || []) {
                        const keys = cols.split(',');
                        if (all.some((r) => keys.every((k) => r[k] != null && r[k] === v[k]))) {
                            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                        }
                    }
                }
                const made = list.map((v) => ({ id: v.id || `id-${++seq}`, created_at: new Date().toISOString(), ...v }));
                all.push(...made);
                return { data: made, error: null };
            }
            if (st.verb === 'upsert') {
                const keys = (st.onConflict || 'id').split(',');
                const list = Array.isArray(st.values) ? st.values : [st.values];
                const out = [];
                for (const v of list) {
                    const hit = all.find((r) => keys.every((k) => r[k] === v[k]));
                    if (hit) { Object.assign(hit, v); out.push(hit); continue; }
                    const made = { id: v.id || `id-${++seq}`, created_at: new Date().toISOString(), ...v };
                    all.push(made);
                    out.push(made);
                }
                return { data: out, error: null };
            }
            const hits = all.filter(match);
            if (st.verb === 'update') { hits.forEach((r) => Object.assign(r, st.values)); return { data: hits, error: null }; }
            if (st.verb === 'delete') { T[name] = all.filter((r) => !match(r)); return { data: hits, error: null }; }
            let out = hits.slice();
            for (const [col, asc] of st.orders.slice().reverse()) out.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
            if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
            if (st.limitN) out = out.slice(0, st.limitN);
            return { data: st.head ? null : out, error: null, count: hits.length };
        }
        const self = {
            select: (_cols, opts) => { if (opts?.head) st.head = true; return self; },
            insert: (v) => { st.verb = 'insert'; st.values = v; return self; },
            upsert: (v, o) => { st.verb = 'upsert'; st.values = v; st.onConflict = o?.onConflict; return self; },
            update: (v) => { st.verb = 'update'; st.values = v; return self; },
            delete: () => { st.verb = 'delete'; return self; },
            eq: (k, v) => { st.filters.push((r) => r[k] === v || (r[k] != null && v != null && String(r[k]) === String(v) && typeof r[k] !== typeof v && typeof v !== 'boolean')); return self; },
            neq: (k, v) => { st.filters.push((r) => r[k] !== v); return self; },
            is: (k, v) => { st.filters.push((r) => (r[k] ?? null) === v); return self; },
            gt: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) > String(v)); return self; },
            gte: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) >= String(v)); return self; },
            lt: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) < String(v)); return self; },
            lte: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) <= String(v)); return self; },
            in: (k, vs) => { st.filters.push((r) => vs.includes(r[k])); return self; },
            ilike: (k, v) => { st.filters.push((r) => like(r[k], v, 'i')); return self; },
            not: (k, op, v) => {
                if (op === 'is' && v === null) st.filters.push((r) => r[k] != null);
                else if (op === 'in') { const vs = String(v).replace(/^\(|\)$/g, '').split(','); st.filters.push((r) => !vs.includes(String(r[k]))); }
                else if (op === 'eq') st.filters.push((r) => r[k] !== v);
                return self;
            },
            or: (expr) => { st.filters.push(orClause(expr)); return self; },
            order: (col, o) => { st.orders.push([col, o?.ascending !== false]); return self; },
            range: (a, b) => { st.range = [a, b]; return self; },
            limit: (n) => { st.limitN = n; return self; },
            maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
            single: async () => { const r = run(); const row = Array.isArray(r.data) ? r.data[0] : r.data; return { data: row || null, error: r.error || (row ? null : { message: 'no rows' }) }; },
            then: (res, rej) => Promise.resolve(run()).then(res, rej),
            catch: (rej) => Promise.resolve(run()).then(undefined, rej),
        };
        return self;
    }

    const db = {
        from: table,
        rpc: async () => ({ data: null, error: { message: 'no rpc' } }),
        auth: { getUser: async () => ({ data: null, error: new Error('not a session') }) },
    };
    return { T, db };
}

/** Put a module into require's cache so the code under test gets the stub. */
function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full;
    m.loaded = true;
    m.exports = exports;
    require.cache[full] = m;
}

/** A tiny check/report pair every test here prints the same way. */
function checker() {
    const state = { pass: 0, fail: 0 };
    function check(label, cond, detail) {
        if (cond) { state.pass += 1; console.log(`  ok   ${label}`); } else { state.fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
    }
    function done(name) {
        console.log(`\n${name}: ${state.pass} passed, ${state.fail} failed`);
        process.exit(state.fail ? 1 : 0);
    }
    return { check, done, state };
}

module.exports = { createMemDb, inject, checker };
