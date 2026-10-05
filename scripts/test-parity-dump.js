#!/usr/bin/env node
// ============================================================
// PARITY DUMP — the shape is stable and documented (DECISIONS #91)
// ============================================================
//
//     npm run test:parity-dump
//
// Runs scripts/parity-dump.js on the fixtures in scripts/parity twice and
// checks: same bytes both times, the documented shape (version, engine,
// definition, trigger with ref, result with ordered steps), no volatile
// field anywhere, keys sorted, and a failing definition still dumps (exit 0,
// status failed) so the two engines can be compared on failures too.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/parity-dump.js');
const FIX = path.join(ROOT, 'scripts/parity');
const { check, done } = checker();

function dump(args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const VOLATILE = /"(ms|duration_ms|run_id|at|now|due_at|expires_at|created_at|updated_at|timestamp|nonce|X-Paperclip-[A-Za-z]+)":/;
function sortedKeys(v) {
    if (Array.isArray(v)) return v.every(sortedKeys);
    if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        return keys.join('\n') === keys.slice().sort().join('\n') && keys.every((k) => sortedKeys(v[k]));
    }
    return true;
}

const args = [path.join(FIX, 'review-request.definition.json'), path.join(FIX, 'booking-completed.event.json'), '--seed', path.join(FIX, 'seed.json')];
const first = dump(args);
const second = dump([...args]);
check('the dump exits 0 and prints JSON', first.code === 0 && first.out.trim().startsWith('{'), first.err.slice(0, 400));
check('two runs print the same bytes', first.out === second.out && first.out.length > 100);
let d = null;
try { d = JSON.parse(first.out); } catch (e) { check('parses', false, e.message); }
if (d) {
    check('shape version 1, engine gcr', d.parity === 1 && d.engine === 'gcr');
    check('definition name and trigger as given', d.definition.name === 'Ask for a review' && d.definition.trigger.type === 'event' && d.definition.trigger.event === 'booking.completed');
    check('trigger: type, event and the non-PII ref', d.trigger.type === 'event' && d.trigger.event === 'booking.completed' && d.trigger.ref.booking_id === 'b-1' && !('payload' in d.trigger) && !JSON.stringify(d.trigger).includes('ana@'), JSON.stringify(d.trigger));
    check('result: status ok, dry_run, no error, output notices/logs', d.result.status === 'ok' && d.result.dry_run === true && d.result.error === null && Array.isArray(d.result.output.logs) && Array.isArray(d.result.output.notices));
    const ids = d.result.steps.map((s) => s.id).join(',');
    check('every step, in order, with id/type/name/status/output', ids === 'recent,gate,shape,pause,hand,mail,note' && d.result.steps.every((s) => ['id', 'name', 'output', 'status', 'type'].every((k) => k in s)), ids);
    check('a data step read only this business\'s rows, in the order asked', d.result.steps[0].output.rows.map((r) => r.id).join(',') === '1,3' && d.result.steps[0].output.count === 2, JSON.stringify(d.result.steps[0].output));
    check('side-effecting steps are dry_run with would_*', d.result.steps[4].status === 'dry_run' && d.result.steps[4].output.would_post && d.result.steps[5].status === 'dry_run' && d.result.steps[5].output.would_message);
    check('the agent step\'s posted trigger is ids only', d.result.steps[4].output.would_post.body.trigger.ref.booking_id === 'b-1' && !('payload' in d.result.steps[4].output.would_post.body.trigger));
    check('the install\'s chosen config reached the template', d.result.steps[3].output.would_wait.minutes === 60, JSON.stringify(d.result.steps[3].output));
    check('no volatile field anywhere', !VOLATILE.test(first.out), (first.out.match(VOLATILE) || [])[0]);
    check('keys sorted at every depth', sortedKeys(d));
}

// A definition that fails still dumps, with the failure where it happened.
const tmp = path.join(os.tmpdir(), `parity-bad-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify({ name: 'Bad', trigger: { type: 'manual' }, steps: [{ id: 'q', type: 'data.query', config: { table: 'auth.users' } }, { id: 'l', type: 'log', config: { message: 'never' } }] }));
const bad = dump([tmp, path.join(FIX, 'booking-completed.event.json'), '--seed', path.join(FIX, 'seed.json')]);
fs.unlinkSync(tmp);
let b = null;
try { b = JSON.parse(bad.out); } catch { /* checked below */ }
check('a failing run still dumps (exit 0) as status failed, the failed step carrying its error, later steps absent',
    bad.code === 0 && b && b.result.status === 'failed' && b.result.steps.length === 1 && b.result.steps[0].status === 'failed' && /auth\.users/.test(b.result.steps[0].error) && /auth\.users/.test(b.result.error), bad.out.slice(0, 300) || bad.err.slice(0, 300));
check('bad arguments exit 2', dump([]).code === 2);
check('the shape is documented in the script header', /The shape \(version 1\)/.test(fs.readFileSync(SCRIPT, 'utf8')));

done('parity-dump');
