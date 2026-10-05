#!/usr/bin/env node
// ============================================================
// EVENT OUTBOX — one signed event per occurrence, ids only (DECISIONS #87)
// ============================================================
//
//     npm run test:event-outbox
//
// lib/businessEvents.js emit → local fan-out (unchanged) AND an outbox row
// (business_event_outbox) that lib/eventOutbox.js posts to Paperclip as
// POST /api/nextgent/events { companyId, event, eventId, occurredAt, ref },
// retrying from the scheduler and the cron. `ref` is ids and a non-PII
// summary: this file asserts that no emitted ref carries a customer's name,
// email or phone, for every event the platform fires.
//
// In-memory database, a recording post, no network.

const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: 'svc',
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    PAPERCLIP_API_URL: 'https://paperclip.test',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    CRON_SECRET: 'cron-secret',
    DEFAULT_TIMEZONE: 'America/Chicago',
    EVENT_OUTBOX_BACKOFF_SECONDS: '60',
    EVENT_OUTBOX_MAX_ATTEMPTS: '3',
});
delete process.env.EVENTS_TO_PAPERCLIP;

const LOG_DEF = (event) => ({ name: event, trigger: { type: 'event', event }, steps: [{ id: 'l', type: 'log', config: { message: '{{ trigger.payload.event }}' } }] });

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', timezone: 'America/Chicago' }, { slug: 'lonely', name: 'No Company' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    automations: [{ id: 'a-1', key: 'on-booking', status: 'published', version: 1, trigger: { type: 'event', event: 'booking.created' } }],
    automation_versions: [{ automation_id: 'a-1', version: 1, definition: LOG_DEF('booking.created') }],
    entity_automations: [{ id: 'ea-1', entity_slug: 'shop', automation_id: 'a-1', version: 1, enabled: true, config: {} }],
    automation_runs: [],
    automation_waits: [],
    business_event_outbox: [],
    scheduler_state: [{ key: 'booking_complete_watermark', value: '2026-09-01T00:00:00.000Z' }],
    booking_calendar: [
        { id: 'b-done', entity_slug: 'shop', kind: 'booking', status: 'active', date: '2026-10-01', start_time: '10:00', details: { end_time: '12:00', customer_name: 'Ana', customer_email: 'ana@example.test', customer_phone: '+15550001111' } },
    ],
    owner_notify_settings: [],
    owner_notifications: [],
} });
inject(path.join(ROOT, 'db.js'), db);

const outbox = require(path.join(ROOT, 'lib/eventOutbox.js'));
const events = require(path.join(ROOT, 'lib/businessEvents.js'));
const engine = require(path.join(ROOT, 'lib/automationEngine.js'));

const posts = [];
let postStatus = 202;
outbox._setPost(async (p, body) => {
    posts.push({ path: p, body });
    if (postStatus >= 400) { const e = new Error(`Paperclip ${p} answered ${postStatus}`); e.status = postStatus; throw e; }
    return { accepted: true };
});

const PII_KEY = /name|email|phone|address|customer|guest|details|record\b|body|text|notes|message|title/i;
const EMAIL = /@/;
const PHONEISH = /^\+?\d[\d\s().-]{6,}$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/; // a date is a summary, not a number
function piiIn(value, trail = 'ref') {
    const found = [];
    if (Array.isArray(value)) value.forEach((v, i) => found.push(...piiIn(v, `${trail}[${i}]`)));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (PII_KEY.test(k)) found.push(`${trail}.${k} (key)`);
            found.push(...piiIn(v, `${trail}.${k}`));
        }
    } else if (typeof value === 'string' && (EMAIL.test(value) || (PHONEISH.test(value) && !DATEISH.test(value)))) found.push(`${trail} = ${value}`);
    return found;
}

const BOOKING = { id: 'b-1', kind: 'booking', status: 'active', date: '2026-11-01', start_time: '19:00', party: 2, source: 'booking_page',
    details: { customer_name: 'Ana Lopez', customer_email: 'ana@example.test', customer_phone: '+1 555 000 1111', notes: 'window seat' } };

const { check, done } = checker();

(async () => {
    try {
        console.log('\n── off by default: local fan-out only ──');
        const off = await events.bookingSaved('shop', null, BOOKING);
        check('the local fan-out ran the automation listening', T.automation_runs.length === 1 && off.ran === 1, JSON.stringify(off));
        check('and every emit carries an event id and a time', /^[0-9a-f-]{36}$/.test(off.eventId) && !Number.isNaN(Date.parse(off.occurredAt)), JSON.stringify(off));
        check('EVENTS_TO_PAPERCLIP unset: no outbox row, nothing posted', T.business_event_outbox.length === 0 && posts.length === 0);

        console.log('\n── on: the outbox row and the signed post ──');
        process.env.EVENTS_TO_PAPERCLIP = 'true';
        const on = await events.bookingSaved('shop', null, BOOKING);
        check('the local fan-out is unchanged', T.automation_runs.length === 2 && on.ran === 1);
        const row = T.business_event_outbox[0];
        check('one outbox row, keyed by the event id, for the linked company', row && row.id === on.eventId && row.company_id === 'co-1' && row.entity_slug === 'shop' && row.event === 'booking.created', JSON.stringify(row));
        check('sent at once when Paperclip answers', row.status === 'sent' && row.attempts === 1 && row.sent_at && !row.last_error, JSON.stringify(row));
        const p = posts[0];
        check('POST /api/nextgent/events', p && p.path === '/api/nextgent/events');
        check('the body is { companyId, event, eventId, occurredAt, ref } and nothing else',
            p && Object.keys(p.body).sort().join(',') === 'companyId,event,eventId,occurredAt,ref'
            && p.body.companyId === 'co-1' && p.body.event === 'booking.created' && p.body.eventId === on.eventId && p.body.occurredAt === on.occurredAt, JSON.stringify(p?.body));
        check('ref carries the booking id and the non-PII summary', p.body.ref.booking_id === 'b-1' && p.body.ref.date === '2026-11-01' && p.body.ref.start_time === '19:00'
            && p.body.ref.party === 2 && p.body.ref.status === 'active' && p.body.ref.source === 'booking_page', JSON.stringify(p.body.ref));
        check('ref carries no customer name, email, phone or details', piiIn(p.body.ref).length === 0, piiIn(p.body.ref).join('; '));
        check('the row holds the same ref', JSON.stringify(row.ref) === JSON.stringify(p.body.ref));

        console.log('\n── a business with no company ──');
        posts.length = 0;
        const lonely = await events.bookingSaved('lonely', null, BOOKING);
        check('no company: no outbox row, nothing posted, the local fan-out still answers', T.business_event_outbox.length === 1 && posts.length === 0 && lonely.ran === 0, JSON.stringify(lonely));

        console.log('\n── Paperclip down: the row waits and is retried ──');
        postStatus = 503;
        const at = new Date('2026-10-05T12:00:00Z');
        outbox._setClock(() => at);
        const down = await events.bookingSaved('shop', BOOKING, { ...BOOKING, party: 4 });
        const waiting = T.business_event_outbox.find((r) => r.id === down.eventId);
        check('the emit still answers (never fails the thing that fired it)', down.ran === 0 && !down.error, JSON.stringify(down));
        check('the row is pending with the attempt and the error recorded', waiting.status === 'pending' && waiting.attempts === 1 && /503/.test(waiting.last_error), JSON.stringify(waiting));
        check('and a next attempt time after the backoff', new Date(waiting.next_attempt_at).getTime() === at.getTime() + 60e3, waiting.next_attempt_at);
        posts.length = 0;
        const early = await outbox.drain({ now: new Date(at.getTime() + 30e3) });
        check('a drain before it is due sends nothing', early.due === 0 && posts.length === 0, JSON.stringify(early));
        const secondTry = await outbox.drain({ now: new Date(at.getTime() + 61e3) });
        check('a drain when due tries again; the backoff doubles', secondTry.due === 1 && secondTry.failed === 1 && waiting.attempts === 2
            && new Date(waiting.next_attempt_at).getTime() === at.getTime() + 61e3 + 120e3, JSON.stringify({ secondTry, waiting }));
        postStatus = 202;
        posts.length = 0;
        const later = new Date(at.getTime() + 61e3 + 121e3);
        const third = await outbox.drain({ now: later });
        check('when Paperclip is back the row is sent, same event id, same ref', third.sent === 1 && waiting.status === 'sent' && posts[0].body.eventId === down.eventId
            && posts[0].body.ref.booking_id === 'b-1' && posts[0].body.ref.changed.join(',') === 'party', JSON.stringify({ third, body: posts[0].body }));
        check('a sent row is not sent again', (await outbox.drain({ now: later })).due === 0);

        console.log('\n── a row that never gets through is parked, not retried forever ──');
        postStatus = 500;
        const dead = await events.reviewReceived('shop', { review_id: 'r-1', rating: 5, reviewer_name: 'Ana', text: 'Great, call me on 555-000-1111' });
        const deadRow = T.business_event_outbox.find((r) => r.id === dead.eventId);
        await outbox.drain({ now: new Date(later.getTime() + 3600e3) });
        await outbox.drain({ now: new Date(later.getTime() + 7200e3) });
        check('after EVENT_OUTBOX_MAX_ATTEMPTS the row is dead with its last error', deadRow.status === 'dead' && deadRow.attempts === 3 && /500/.test(deadRow.last_error), JSON.stringify(deadRow));
        check('a dead row is left alone by the drain', (await outbox.drain({ now: new Date(later.getTime() + 36000e3) })).due === 0);
        postStatus = 202;

        console.log('\n── every event the platform fires: ids only ──');
        posts.length = 0;
        await events.bookingSaved('shop', BOOKING, { ...BOOKING, status: 'cancelled' });
        await events.paymentReceived('shop', { id: 'p-1', source: 'stripe', reference: 'pi_1', amount_cents: 4200, currency: 'usd', status: 'verified', payer_name: 'Ana', payer_email: 'ana@example.test' });
        await events.reviewReceived('shop', { id: 'r-2', reviewer_name: 'Ana', rating: 4, title: 'Nice', text: 'ana@example.test' });
        await events.appRecordCreated('shop', { appKey: 'enquiry-form', installId: 'in-1', table: 'enquiries', source: null,
            manifest: { id: 'enquiry-form', events: { emits: ['enquiry-form.submitted'] } },
            record: { id: 'rec-9', name: 'Ana', email: 'ana@example.test', phone: '+15550001111', message: 'Hi' } });
        await events.intakeCreated('shop', { id: 'req-1', entity_slug: 'shop', business_name: 'The Shop', contact_name: 'Ana', contact_email: 'ana@example.test', contact_phone: '5550001111', links: ['https://x.test'] });
        engine._setClock(() => new Date('2026-10-01T18:30:00Z'));
        await events.completeBookings({ now: new Date('2026-10-01T18:30:00Z') });
        const names = posts.map((x) => x.body.event);
        check('cancelled, payment, review, app, intake and completed each went out once',
            ['booking.cancelled', 'payment.received', 'review.received', 'enquiry-form.submitted', 'intake.created', 'booking.completed'].every((e) => names.filter((n) => n === e).length === 1), names.join(','));
        const leaks = posts.flatMap((x) => piiIn(x.body.ref, `${x.body.event}.ref`));
        check('no ref anywhere carries a PII key or an email/phone-looking value', leaks.length === 0, leaks.join('; '));
        const byEvent = Object.fromEntries(posts.map((x) => [x.body.event, x.body.ref]));
        check('payment.received: payment id, amount, currency, source, status', byEvent['payment.received'].payment_id === 'p-1' && byEvent['payment.received'].amount_cents === 4200
            && byEvent['payment.received'].currency === 'usd' && byEvent['payment.received'].source === 'stripe', JSON.stringify(byEvent['payment.received']));
        check('review.received: review id and rating', byEvent['review.received'].review_id === 'r-2' && byEvent['review.received'].rating === 4, JSON.stringify(byEvent['review.received']));
        check('an app event: app, install, table, record id', byEvent['enquiry-form.submitted'].app === 'enquiry-form' && byEvent['enquiry-form.submitted'].install_id === 'in-1'
            && byEvent['enquiry-form.submitted'].table === 'enquiries' && byEvent['enquiry-form.submitted'].record_id === 'rec-9', JSON.stringify(byEvent['enquiry-form.submitted']));
        check('intake.created: the request id', byEvent['intake.created'].request_id === 'req-1' && Object.keys(byEvent['intake.created']).length === 1, JSON.stringify(byEvent['intake.created']));
        check('booking.completed: the booking id, its status and when it ended', byEvent['booking.completed'].booking_id === 'b-done' && byEvent['booking.completed'].status === 'completed'
            && byEvent['booking.completed'].ended_at === '2026-10-01T17:00:00.000Z', JSON.stringify(byEvent['booking.completed']));
        const strange = outbox.refFor('x.y', { booking: { booking_id: 'b', date: 'ana@example.test', party: '+1 555 000 1111', status: { nested: 'no' } } });
        check('refFor drops a value that looks like an address even under an allowed key', JSON.stringify(strange) === '{"booking_id":"b"}', JSON.stringify(strange));

        console.log('\n── the cron route ──');
        const { publicRouter } = require(path.join(ROOT, 'routes/automations.js'));
        const app = express();
        app.use(express.json());
        app.use('/api/automations', publicRouter);
        const server = app.listen(0);
        const base = `http://127.0.0.1:${server.address().port}`;
        const noSecret = await fetch(`${base}/api/automations/cron/outbox`);
        check('/api/automations/cron/outbox needs CRON_SECRET', noSecret.status === 401);
        const cron = await fetch(`${base}/api/automations/cron/outbox`, { headers: { Authorization: 'Bearer cron-secret' } });
        const cronBody = await cron.json();
        check('and drains the outbox', cron.status === 200 && typeof cronBody.due === 'number' && typeof cronBody.sent === 'number', JSON.stringify(cronBody));
        server.close();

        console.log('\n── the scheduler knows the job ──');
        const { JOBS } = require(path.join(ROOT, 'lib/scheduler.js'));
        check('event-outbox is a scheduler job', JOBS.some((j) => j.name === 'event-outbox'));
        const vercel = require(path.join(ROOT, 'vercel.json'));
        check('and a vercel cron', vercel.crons.some((c) => c.path === '/api/automations/cron/outbox'));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    done('event-outbox');
})();
