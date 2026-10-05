#!/usr/bin/env node
// ============================================================
// PARITY DUMP — the gcr engine's dry run of one definition, as stable JSON (DECISIONS #91)
// ============================================================
//
//     node scripts/parity-dump.js <definition.json> <event.json> [--seed seed.json] [--slug shop] [--out file]
//     npm run parity:dump -- scripts/parity/review-request.definition.json scripts/parity/booking-completed.event.json --seed scripts/parity/seed.json
//
// The cut-over from this engine to Paperclip's step runner is proved, not
// scheduled: the same definition and the same event run through both engines
// in dry-run and the step logs must match. This script is gcr's half.
// Paperclip's `parity-dump.mjs` prints the same shape from its runner, and a
// diff of the two files is the proof. No database, no network: the engine
// runs against an in-memory database seeded from the seed file
// (scripts/lib/memdb.js), the schema read answers from the seed's tables, and
// every side-effecting step reports what it WOULD do.
//
// ── Inputs ──────────────────────────────────────────────────────────────
//
//   definition.json   an automation definition: { name, trigger, config_schema, steps }
//                     (the shape automation_versions.definition holds)
//   event.json        the trigger: { type, payload } — for an event trigger the
//                     payload carries `event` and the event's data, exactly as
//                     lib/businessEvents.js emits it
//   seed.json         optional: { slug, config, tables: { <table>: [rows] } }
//                     `slug` is the business run for (default the first
//                     entity row's slug, else "shop"); `config` the install's
//                     chosen settings; `tables` the rows the data steps read.
//                     A nextgent_installs row may carry
//                     routine_webhook_secret_plain, sealed at load so the agent
//                     step can resolve its routine.
//
// ── The shape (version 1) ───────────────────────────────────────────────
//
//   {
//     "parity": 1,                      the shape version
//     "engine": "gcr",                  who produced it ("paperclip" for the other half)
//     "definition": {
//       "name": "...",
//       "trigger": { "type": "event", "event": "booking.completed" }   (as given; schedule/webhook fields kept)
//     },
//     "trigger": {
//       "type": "event",
//       "event": "booking.completed",   null when not an event trigger
//       "ref": { ... }                  the ids and non-PII summary (lib/eventOutbox.js refFor)
//     },
//     "result": {
//       "status": "ok" | "skipped" | "waiting" | "failed",
//       "error": null | "step name: message",
//       "dry_run": true,
//       "waited": null | { "stepIndex": n },          an unrecorded run that reached a wait
//       "steps": [                                     one per step that ran, in order
//         { "id": "...", "type": "...", "name": "...", "status": "ok" | "dry_run" | "stopped" | "waiting" | "failed",
//           "output": <the step's output, volatile fields removed>, "error": "..." (failed only) }
//       ],
//       "output": { "notices": [...], "logs": [...] }
//     }
//   }
//
// Stable means: object keys sorted at every depth; these volatile fields
// removed wherever they appear — ms, duration_ms, run_id, at, now, due_at,
// expires_at, created_at, updated_at, timestamp, nonce and any X-Paperclip
// signature header. Arrays keep their order (a step log is ordered; rows come
// back in the order asked for). Two runs of the same inputs print the same
// bytes; the two engines must too.
//
// Exit code 0 when the dump was printed, whatever the run's status (a
// "failed" run is a legitimate result to compare); 2 for bad arguments.

const path = require('path');
const fs = require('fs');
const { createMemDb, inject } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SHAPE_VERSION = 1;
const VOLATILE = new Set(['ms', 'duration_ms', 'run_id', 'at', 'now', 'due_at', 'expires_at', 'created_at', 'updated_at', 'timestamp', 'nonce']);
const VOLATILE_PATTERN = /^x-paperclip-(timestamp|signature)$/i;

function usage(message) {
    if (message) console.error(message);
    console.error('usage: node scripts/parity-dump.js <definition.json> <event.json> [--seed seed.json] [--slug slug] [--out file]');
    process.exit(2);
}

function parseArgs(argv) {
    const out = { files: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--seed' || a === '--slug' || a === '--out') { out[a.slice(2)] = argv[++i]; continue; }
        if (a.startsWith('--')) usage(`Unknown option ${a}`);
        out.files.push(a);
    }
    if (out.files.length !== 2) usage();
    return out;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    } catch (e) {
        return usage(`Could not read ${file}: ${e.message}`);
    }
}

/** Sorted keys, volatile fields removed, at every depth. */
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            if (VOLATILE.has(key) || VOLATILE_PATTERN.test(key)) continue;
            out[key] = stable(value[key]);
        }
        return out;
    }
    return value === undefined ? null : value;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const definition = readJson(args.files[0]);
    const event = readJson(args.files[1]);
    const seed = args.seed ? readJson(args.seed) : {};
    const tables = seed.tables && typeof seed.tables === 'object' ? seed.tables : {};
    const slug = args.slug || seed.slug || tables.entity?.[0]?.slug || 'shop';

    // The engine's environment: fixed, so a dump never depends on the shell it ran in.
    Object.assign(process.env, {
        NEXTGENT_SERVICE_SECRET: process.env.NEXTGENT_SERVICE_SECRET || 'parity',
        NEXTGENT_SECRETS_KEY: process.env.NEXTGENT_SECRETS_KEY || 'parity-box-key',
        NEXTGENT_SESSION_SECRET: process.env.NEXTGENT_SESSION_SECRET || 'parity-session',
        VERIFY_CODE_SECRET: process.env.VERIFY_CODE_SECRET || 'parity-code',
        SUPABASE_URL: 'https://db.parity.test',
        SUPABASE_KEY: 'parity',
        DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'UTC',
    });
    delete process.env.EVENTS_TO_PAPERCLIP;

    // A routine secret given in the clear is sealed the way the install route stores it.
    const secretBox = require(path.join(ROOT, 'lib/secretBox.js'));
    for (const row of tables.nextgent_installs || []) {
        if (row.routine_webhook_secret_plain && !row.routine_webhook_secret) {
            row.routine_webhook_secret = secretBox.seal(String(row.routine_webhook_secret_plain), 'routine-webhook-secret');
        }
    }

    const { db } = createMemDb({ tables });
    inject(path.join(ROOT, 'db.js'), db);

    // The schema read (lib/businessTables.js) goes to Supabase's OpenAPI document; answer it from the seed.
    const definitions = {};
    for (const [table, rows] of Object.entries(tables)) {
        const cols = new Set(['id']);
        for (const r of Array.isArray(rows) ? rows : []) for (const k of Object.keys(r || {})) cols.add(k);
        definitions[table] = { properties: Object.fromEntries([...cols].map((c) => [c, { type: 'string' }])) };
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith(process.env.SUPABASE_URL)) return { ok: true, status: 200, json: async () => ({ definitions }) };
        return realFetch(url, init);
    };

    const engine = require(path.join(ROOT, 'lib/automationEngine.js'));
    const { refFor } = require(path.join(ROOT, 'lib/eventOutbox.js'));
    // A dry run posts nothing; the clock is fixed so a wait's due time cannot differ between runs anyway.
    engine._setClock(() => new Date('2026-01-01T00:00:00.000Z'));
    engine._setRoutineFetch(async () => { throw new Error('parity dump: nothing is posted in a dry run'); });

    const trigger = { type: event?.type || 'manual', payload: event?.payload ?? null };
    const result = await engine.runDefinition({ definition, slug, trigger, config: seed.config || {}, dryRun: true });

    const eventName = typeof trigger.payload?.event === 'string' ? trigger.payload.event : (definition?.trigger?.type === 'event' ? definition.trigger.event || null : null);
    const dump = stable({
        parity: SHAPE_VERSION,
        engine: 'gcr',
        definition: { name: definition?.name || null, trigger: definition?.trigger || null },
        trigger: { type: trigger.type, event: eventName, ref: refFor(eventName, trigger.payload) },
        result: {
            status: result.status,
            error: result.error ?? null,
            dry_run: true,
            waited: result.waited ? { stepIndex: result.waited.stepIndex } : null,
            steps: (result.steps_log || []).map((s) => ({ id: s.id, type: s.type, name: s.name, status: s.status, output: s.output ?? null, ...(s.error ? { error: s.error } : {}) })),
            output: result.output || { notices: [], logs: [] },
        },
    });

    const text = `${JSON.stringify(dump, null, 2)}\n`;
    if (args.out) fs.writeFileSync(path.resolve(args.out), text);
    else process.stdout.write(text);
}

main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
});
