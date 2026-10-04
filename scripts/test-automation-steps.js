#!/usr/bin/env node
// ============================================================
// Automations, part 2: wait, agent, message, business events (CONTRACT §9)
// ============================================================
//
//     npm run test:automation-steps
//
// The plan's own "done when": a completed booking leads, 24 hours later, to
// the Review Agent's routine being called and a review request going out by
// email. In-memory database, a recording Paperclip routine and email.

const path = require('path');
const crypto = require('crypto');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: 'svc',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    DEFAULT_TIMEZONE: 'America/Chicago',
});
delete process.env.BOOKING_DEFAULT_DURATION_MINUTES;

const secretBox = require(path.join(ROOT, 'lib/secretBox.js'));
const ROUTINE_SECRET = 'whsec_routine';

const DEF = {
    name: 'Ask for a review',
    trigger: { type: 'event', event: 'booking.completed' },
    config_schema: [],
    steps: [
        { id: 'pause', type: 'wait', config: { minutes: 1440 } },
        { id: 'hand', type: 'agent', config: { item_key: '{{ automation.key }}', instructions: 'Ask {{ trigger.payload.booking.customer_name }} for a review', payload: { booking: '{{ trigger.payload.booking }}' } } },
        { id: 'mail', type: 'message', config: { channel: 'email', to: '{{ trigger.payload.booking.customer_email }}', subject: 'How was it?', body: 'Thanks for visiting {{ business.name }}!' } },
    ],
};

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', email: 'owner@shop.test' }, { slug: 'other', name: 'Other' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    entity_owners: [],
    automations: [{ id: 'a-1', key: 'review-request', status: 'published', version: 1, trigger: DEF.trigger }],
    automation_versions: [{ automation_id: 'a-1', version: 1, definition: DEF }],
    entity_automations: [{ id: 'ea-1', entity_slug: 'shop', automation_id: 'a-1', version: 1, enabled: true, config: {} }],
    automation_runs: [],
    automation_waits: [],
    nextgent_installs: [
        { install_id: 'in-rev', company_id: 'co-1', entity_slug: 'shop', item_key: 'review-request', kind: 'automation', status: 'active',
          routine_webhook_url: 'https://paperclip.test/api/routine-triggers/public/abc/fire', routine_webhook_secret: secretBox.seal(ROUTINE_SECRET, 'routine-webhook-secret') },
        { install_id: 'in-foreign', company_id: 'co-2', entity_slug: 'other', item_key: 'review-request', kind: 'automation', status: 'active',
          routine_webhook_url: 'https://paperclip.test/x', routine_webhook_secret: secretBox.seal('other', 'routine-webhook-secret') },
    ],
    booking_calendar: [
        { id: 'b-1', entity_slug: 'shop', kind: 'booking', status: 'active', date: '2026-10-01', start_time: '10:00', details: { end_time: '12:00', customer_name: 'Ana', customer_email: 'ana@example.test' } },
        { id: 'b-2', entity_slug: 'shop', kind: 'booking', status: 'cancelled', date: '2026-10-01', details: {} },
        { id: 'b-3', entity_slug: 'shop', kind: 'booking', status: 'active', date: '2026-10-05', start_time: '10:00', details: {} },
        { id: 'b-4', entity_slug: 'shop', kind: 'block', status: 'active', date: '2026-09-01', details: {} },
    ],
    message_threads: [],
    business_messages: [],
    owner_notify_settings: [],
    owner_notifications: [],
} });
inject(path.join(ROOT, 'db.js'), db);
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true, id: 'em' }; } });

const engine = require(path.join(ROOT, 'lib/automationEngine.js'));
const events = require(path.join(ROOT, 'lib/businessEvents.js'));
const posts = [];
let routineStatus = 202;
engine._setRoutineFetch(async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body });
    return { ok: routineStatus < 300, status: routineStatus, text: async () => JSON.stringify(routineStatus < 300 ? { id: 'run-pc', status: 'issue_created', linkedIssueId: 'iss-1' } : { error: 'nope' }) };
});

const { check, done } = checker();

(async () => {
    try {
        console.log('\n── catalogue ──');
        const cat = engine.catalogue();
        for (const t of ['wait', 'agent', 'message']) check(`step type ${t} is in the builder's palette`, cat.steps.some((s) => s.type === t));
        for (const e of ['booking.created', 'booking.changed', 'booking.cancelled', 'booking.completed', 'payment.received', 'review.received', 'intake.created']) {
            check(`event ${e} is listed`, cat.events.some((x) => x.name === e));
        }
        check('timezones come from the runtime, default from env', cat.timezones.length > 5 && cat.default_timezone === 'America/Chicago');

        console.log('\n── the completion job starts from when it was first enabled, not from history ──');
        const at = new Date('2026-10-01T18:30:00Z'); // 13:30 in Chicago, after the 12:00 end
        engine._setClock(() => at);
        T.scheduler_state = [];
        const first = await engine.tick({ now: at });
        check('a first run completes nothing that ended before it', T.booking_calendar.find((b) => b.id === 'b-1').status === 'active'
            && !T.automation_runs.length && first.bookings.completed === 0, JSON.stringify(first.bookings));
        const mark = T.scheduler_state.find((r) => r.key === 'booking_complete_watermark');
        check('and keeps its own first-run time as the watermark', mark?.value === at.toISOString(), JSON.stringify(T.scheduler_state));
        await engine.tick({ now: at });
        check('the watermark is not moved by a later run', T.scheduler_state.length === 1 && T.scheduler_state[0].value === at.toISOString());
        // From here on, the job was enabled before these bookings ended.
        mark.value = '2026-09-30T00:00:00.000Z';

        console.log('\n── booking.completed from the scheduled check ──');
        const summary = await engine.tick({ now: at });
        check('the finished booking is completed', T.booking_calendar.find((b) => b.id === 'b-1').status === 'completed', JSON.stringify(summary.bookings));
        check('cancelled, future and block rows are left alone', T.booking_calendar.find((b) => b.id === 'b-2').status === 'cancelled'
            && T.booking_calendar.find((b) => b.id === 'b-3').status === 'active' && T.booking_calendar.find((b) => b.id === 'b-4').status === 'active');
        const run = T.automation_runs[0];
        check('booking.completed ran the automation listening for it', run && run.status === 'waiting', JSON.stringify(run));
        const wait = T.automation_waits[0];
        check('the wait is saved with the step to resume at, 24 h out', wait && wait.state === 'waiting' && wait.step_index === 1
            && Math.abs(new Date(wait.due_at) - at - 24 * 3600e3) < 120e3, JSON.stringify(wait));
        check('nothing was posted or emailed yet', !posts.length && !emails.length);
        await engine.tick({ now: at });
        check('a second check does not complete it twice', T.automation_runs.length === 1);

        console.log('\n── 24 hours later ──');
        await engine.resumeWaits({ now: new Date(at.getTime() + 3600e3) });
        check('not before it is due', T.automation_waits[0].state === 'waiting' && !posts.length);
        const later = new Date(at.getTime() + 24 * 3600e3 + 5 * 60e3);
        const resumed = await engine.resumeWaits({ now: later });
        check('due: the run carries on', resumed.resumed === 1 && T.automation_waits[0].state === 'done', JSON.stringify(resumed));
        const p = posts[0];
        check('the Review Agent\'s routine webhook was called', p && p.url === 'https://paperclip.test/api/routine-triggers/public/abc/fire');
        const ts = p.headers['X-Paperclip-Timestamp'];
        const expected = 'sha256=' + crypto.createHmac('sha256', ROUTINE_SECRET).update(`${ts}.`).update(p.body).digest('hex');
        check('signed hmac_sha256 exactly as Paperclip checks it', p.headers['X-Paperclip-Signature'] === expected && /^\d+$/.test(ts));
        const sent = JSON.parse(p.body);
        check('with the booking and the instructions', sent.payload.booking.customer_email === 'ana@example.test' && sent.instructions === 'Ask Ana for a review' && sent.business.slug === 'shop');
        check('and the review request went out by email', emails[0]?.to === 'ana@example.test' && /The Shop/.test(emails[0].html));
        check('the same run row finished ok, its log in one piece', T.automation_runs.length === 1 && T.automation_runs[0].status === 'ok'
            && T.automation_runs[0].steps_log.map((x) => x.id).join(',') === 'pause,hand,mail', JSON.stringify(T.automation_runs[0]));
        check('a resumed wait does not run again', (await engine.resumeWaits({ now: later })).due === 0);

        console.log('\n── scoping and failure ──');
        const foreign = await engine.runDefinition({
            definition: { name: 'x', steps: [{ id: 'a', type: 'agent', config: { install_id: 'in-foreign' } }] },
            slug: 'shop', trigger: { type: 'manual' },
            record: { automationId: 'a-1', version: 1, installId: 'ea-1' },
        });
        check('an agent step cannot use another business\'s install', foreign.status === 'failed' && /another business/.test(foreign.error));
        check('a failed run tells the owner', T.owner_notifications.some((n) => n.kind === 'failed_action'));
        routineStatus = 500;
        const down = await engine.runDefinition({
            definition: { name: 'y', steps: [{ id: 'a', type: 'agent', config: { install_id: 'in-rev' } }] },
            slug: 'shop', trigger: { type: 'manual' },
        });
        check('a routine that refuses fails the step', down.status === 'failed' && /500/.test(down.error));
        const dry = await engine.runDefinition({
            definition: { name: 'z', steps: [{ id: 'w', type: 'wait', config: { minutes: 5 } }, { id: 'm', type: 'message', config: { channel: 'sms', to: '+15550001111', body: 'x' } }] },
            slug: 'shop', trigger: { type: 'test' }, dryRun: true,
        });
        check('a dry run neither waits nor sends', dry.status === 'ok' && dry.steps_log.length === 2 && T.automation_waits.length === 1);
        const blocked = await engine.runDefinition({
            definition: { name: 'b', steps: [{ id: 'm', type: 'message', config: { channel: 'sms', to: '+15550001111', body: 'x' } }] },
            slug: 'shop', trigger: { type: 'manual' },
        });
        check('a text with no registered number fails the step with the reason', blocked.status === 'failed' && /no_registered_number/.test(blocked.error));

        console.log('\n── booking events from saved rows ──');
        T.automations.push({ id: 'a-2', key: 'on-booking', status: 'published', version: 1, trigger: { type: 'event', event: 'booking.created' } },
            { id: 'a-3', key: 'on-cancel', status: 'published', version: 1, trigger: { type: 'event', event: 'booking.cancelled' } },
            { id: 'a-4', key: 'on-change', status: 'published', version: 1, trigger: { type: 'event', event: 'booking.changed' } });
        for (const id of ['a-2', 'a-3', 'a-4']) {
            T.automation_versions.push({ automation_id: id, version: 1, definition: { name: id, trigger: T.automations.find((a) => a.id === id).trigger, steps: [{ id: 'l', type: 'log', config: { message: '{{ trigger.payload.event }}' } }] } });
            T.entity_automations.push({ id: `ea-${id}`, entity_slug: 'shop', automation_id: id, version: 1, enabled: true, config: {} });
        }
        const before = T.automation_runs.length;
        const row = { id: 'b-9', kind: 'booking', status: 'active', date: '2026-11-01', party: 2 };
        await events.bookingSaved('shop', null, row);
        await events.bookingSaved('shop', row, { ...row, party: 4 });
        await events.bookingSaved('shop', { ...row, party: 4 }, { ...row, party: 4, status: 'cancelled' });
        await events.bookingSaved('shop', row, { ...row });
        const fired = T.automation_runs.slice(before).map((r) => r.automation_id).join(',');
        check('created, changed, cancelled each fire once; an unchanged save fires nothing', fired === 'a-2,a-4,a-3', fired);
        await events.bookingSaved('shop', null, { kind: 'block', status: 'active', date: '2026-11-02' });
        check('a blocked date is not a booking', T.automation_runs.length === before + 3);

        console.log('\n── when a booking ends ──');
        const end = events.bookingEnd({ date: '2026-07-01', start_time: '9:00 PM' }, 'America/New_York');
        check('no end time: the end of its day, in the business\'s zone', end.toISOString() === '2026-07-02T04:00:00.000Z', end.toISOString());
        const end2 = events.bookingEnd({ date: '2026-07-01', details: { end_time: '3:15 pm' } }, 'America/Los_Angeles');
        check('an end time is read in the business\'s zone', end2.toISOString() === '2026-07-01T22:15:00.000Z', end2.toISOString());
    } catch (e) {
        check('no exception', false, e.stack);
    }
    done('automation-steps');
})();
