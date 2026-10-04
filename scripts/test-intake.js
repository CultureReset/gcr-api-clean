#!/usr/bin/env node
// ============================================================
// Intake (forwarding confirmations, unknown senders, payments) and the
// owner app's /api/owner routes
// ============================================================
//
//     npm run test:intake
//
// The confirmation rules are read from sql/nextgent_intake.sql itself, so the
// seeded patterns are what is tested. In-memory database; no network.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    INTAKE_EMAIL_DOMAIN: 'intake.example.test',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    DEFAULT_TIMEZONE: 'UTC',
    DEFAULT_CURRENCY: 'usd',
});
delete process.env.INTAKE_EMAIL_PREFIX;
delete process.env.EMAIL_WEBHOOK_SECRET;

/* The seed rows, parsed out of the SQL file. */
function seededRules() {
    const sql = fs.readFileSync(path.join(ROOT, 'sql/nextgent_intake.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('insert into public.forwarding_confirmation_rules'), sql.indexOf('on conflict (provider)'));
    const values = block.slice(block.indexOf('values') + 6);
    const tuples = [];
    for (const t of values.split(/\)\s*,\s*\(/)) {
        const lits = [...t.matchAll(/'((?:[^']|'')*)'|\bnull\b/g)].map((m) => (m[1] === undefined ? null : m[1].replace(/''/g, "'")));
        const [provider, label, from_pattern, subject_pattern, code_pattern, link_pattern, mailbox_pattern] = lits;
        tuples.push({ provider, label, from_pattern, subject_pattern, code_pattern, link_pattern, mailbox_pattern, enabled: true });
    }
    return tuples;
}

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', email: 'owner@shop.test', phone: '+15550100000', description: 'old', is_active: true }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }],
    entity_owners: [],
    forwarding_confirmation_rules: seededRules(),
    forwarding_confirmations: [],
    intake_known_senders: [],
    email_parser_log: [],
    email_webhook_log: [],
    payments_detected: [],
    booking_calendar: [
        { id: 'b-1', entity_slug: 'shop', kind: 'booking', status: 'active', date: '2026-10-10', start_time: '9:30', title: 'Tour', party: 3, source: 'email:fareharbor', details: { customer_name: 'Ana', end_time: '11:00' } },
        { id: 'b-2', entity_slug: 'other', kind: 'booking', status: 'active', date: '2026-10-10', details: {} },
    ],
    business_availability: [],
    automations: [],
    owner_notify_settings: [],
    owner_notifications: [],
    message_threads: [],
    business_messages: [],
    message_consent: [],
    sms_log: [],
    song_requests: [], cooperative_contributions: [], goal_contributions: [],
} });
inject(path.join(ROOT, 'db.js'), db);
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true }; } });
let session = { entitySlug: 'shop', authVia: 'paperclip', paperclip: { userId: 'pc-1' } };
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, res, next) => (session ? (Object.assign(req, session), next()) : res.status(401).json({ error: 'no' })),
    businessOrAdminRequired: (q, r, n) => n(),
    assertSlug: () => true,
});
inject(path.join(ROOT, 'lib/exportBusiness.js'), { exportBusiness: async (slug) => ({ url: `https://files.example.test/${slug}.json`, expiresAt: 'later' }) });

// The schema read (PATCH /owner/profile) goes through fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.test/rest/v1/')) {
        const def = (cols) => ({ properties: Object.fromEntries(cols.map((c) => [c, { type: 'string' }])) });
        return { ok: true, status: 200, json: async () => ({ definitions: {
            entity: def(['id', 'slug', 'name', 'description', 'phone', 'is_active', 'show_in_listings', 'google_verified', 'rating']),
            menu_items: def(['id', 'entity_slug', 'name']),
        } }) };
    }
    return realFetch(url, init);
};

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/email-parser', require(path.join(ROOT, 'routes/email-parser.js')));
app.use('/api/webhooks', require(path.join(ROOT, 'routes/email-webhook.js')));
app.use('/api/owner', require(path.join(ROOT, 'routes/owner.js')));
const server = app.listen(0, run);
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
async function call(method, p, body) {
    const res = await realFetch(url(p), { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const inbound = async (mail) => { await call('POST', '/api/email-parser/inbound', mail); await settle(); };
const ADDR = 'gcr-shop@intake.example.test';

async function run() {
    try {
        console.log('\n── forwarding confirmations ──');
        await inbound({
            from: 'Gmail Team <forwarding-noreply@google.com>', to: ADDR,
            subject: '(#612345678) Gmail Forwarding Confirmation - Receive Mail from ana.owner@gmail.com',
            text: 'ana.owner@gmail.com has requested to automatically forward mail to your email address gcr-shop@intake.example.test.\nConfirmation code: 612345678\n\nTo allow, click https://mail-settings.google.com/mail/vf-%5BANGjdJ_abc%5D-xyz\n',
        });
        const fwd = await call('GET', '/api/owner/intake/forwarding');
        check('the address comes from config', fwd.body.address === ADDR);
        check('the Gmail code is shown to the owner', fwd.body.confirmation?.provider === 'gmail' && fwd.body.confirmation.code === '612345678', JSON.stringify(fwd.body));
        check('with the link and the mailbox asking', /^https:\/\/mail-settings\.google\.com\//.test(fwd.body.confirmation.link) && fwd.body.confirmation.mailbox === 'ana.owner@gmail.com');
        check('a confirmation is not held as an unknown sender', !T.intake_known_senders.length && !T.owner_notifications.length);

        await call('POST', '/api/webhooks/email', {
            from: 'Microsoft account team <account-security-noreply@accountprotection.microsoft.com>', to: ADDR,
            subject: 'Verify your forwarding address', text: 'Use this security code: 482913 to confirm forwarding.',
        });
        const fwd2 = await call('GET', '/api/owner/intake/forwarding');
        check('an Outlook code through /api/webhooks/email too', fwd2.body.confirmation?.provider === 'outlook' && fwd2.body.confirmation.code === '482913', JSON.stringify(fwd2.body));

        console.log('\n── unknown senders wait for review ──');
        const booking = {
            from: 'FareHarbor <bookings@fareharbor.com>', to: ADDR, subject: 'New Booking: Dolphin Cruise',
            text: 'Date: 2026-10-20\nTime: 10:00 AM\nGuests: 4\nCustomer: Bob Smith\nBooking #AB12CD',
        };
        await inbound(booking);
        check('a first email from a sender is held, not read', T.email_parser_log.some((l) => l.intake_state === 'held') && !T.business_availability.length);
        check('the sender is recorded as pending', T.intake_known_senders[0]?.sender === 'bookings@fareharbor.com' && T.intake_known_senders[0].status === 'pending');
        check('the owner is told, by email', T.owner_notifications.some((n) => n.kind === 'unknown_sender') && emails.some((e) => /bookings@fareharbor\.com/.test(e.subject)));
        await inbound({ ...booking, text: `${booking.text}\n(again)` });
        check('the owner is told once per sender', T.owner_notifications.filter((n) => n.kind === 'unknown_sender').length === 1);
        const senders = await call('GET', '/api/owner/intake/senders');
        const approve = await call('POST', `/api/owner/intake/senders/${senders.body.senders[0].id}/approve`);
        check('approving processes what was held', approve.body.processed === 2 && T.email_parser_log.filter((l) => l.intake_state === 'held').length === 0, JSON.stringify(approve.body));
        check('and the booking lands on the calendar', T.booking_calendar.some((b) => b.entity_slug === 'shop' && b.date === '2026-10-20'));
        const before = T.email_parser_log.length;
        await inbound({ ...booking, text: `${booking.text}\nnew one`, subject: 'New Booking: Sunset Cruise' });
        check('an approved sender is read straight away', T.email_parser_log.length === before + 1 && T.email_parser_log.at(-1).intake_state !== 'held');

        console.log('\n── payments ──');
        const { recordPayment } = require(path.join(ROOT, 'lib/payments.js'));
        await recordPayment('shop', { amount: 25, currency: 'usd', payer: 'Bob', source: 'venmo', status: 'claimed', reference: 'v-1' });
        await recordPayment('shop', { amount: 25, currency: 'usd', payer: 'Bob', source: 'venmo', status: 'claimed', reference: 'v-1' });
        await recordPayment('shop', { amountCents: 9900, currency: 'usd', source: 'stripe', status: 'verified', reference: 'pi_1' });
        const pays = await call('GET', '/api/owner/payments');
        check('payments list claimed and verified, each once', pays.body.payments.length === 2 && pays.body.payments.some((p) => p.status === 'verified' && p.amount_cents === 9900)
            && pays.body.payments.some((p) => p.status === 'claimed' && p.amount_cents === 2500), JSON.stringify(pays.body));

        console.log('\n── held mail keeps its body: html-only and payments ──');
        await inbound({
            from: 'Peek Pro <bookings@peek.com>', to: ADDR, subject: 'New Booking: Kayak Tour',
            html: '<p>Date: 2026-10-22</p><p>Time: 2:00 PM</p><p>Guests: 2</p><p>Order #PK12345</p>',
        });
        const heldHtml = T.email_parser_log.find((l) => l.from_email === 'Peek Pro <bookings@peek.com>' && l.intake_state === 'held');
        check('an html-only email is held with its html kept', !!heldHtml?.raw_html && /2026-10-22/.test(heldHtml.raw_html), JSON.stringify(heldHtml));
        await call('POST', '/api/webhooks/email', {
            from: 'Venmo <notifications@venmo.com>', to: ADDR, subject: 'Bob Smith paid you $25.00',
            text: 'Payment from Bob Smith $25.00\nfor: Deposit', html: '',
        });
        const heldPay = T.email_webhook_log.find((l) => l.from_email === 'Venmo <notifications@venmo.com>' && l.status === 'needs_review');
        check('a payment email from an unknown sender is held with its body kept', !!heldPay?.raw_text && /25\.00/.test(heldPay.raw_text), JSON.stringify(heldPay));
        check('nothing is recorded as a payment until the sender is approved', !T.payments_detected.some((p) => p.source === 'venmo' && p.payer === 'Bob Smith'));
        const list = await call('GET', '/api/owner/intake/senders');
        const peek = list.body.senders.find((s) => s.sender === 'bookings@peek.com');
        const venmo = list.body.senders.find((s) => s.sender === 'notifications@venmo.com');
        const ap1 = await call('POST', `/api/owner/intake/senders/${peek.id}/approve`);
        check('the html-only email is read after approval, as the live path reads it', ap1.body.processed === 1
            && T.booking_calendar.some((b) => b.entity_slug === 'shop' && b.date === '2026-10-22'), JSON.stringify(ap1.body));
        const ap2 = await call('POST', `/api/owner/intake/senders/${venmo.id}/approve`);
        check('the held payment is recorded after approval', ap2.body.processed === 1
            && T.payments_detected.some((p) => p.source === 'venmo' && p.amount_cents === 2500 && p.payer === 'Bob Smith'), JSON.stringify(ap2.body));
        check('and its row is no longer waiting', heldPay && !T.email_webhook_log.some((l) => l.id === heldPay.id && l.status === 'needs_review'));
        const intakeSql = fs.readFileSync(path.join(ROOT, 'sql/nextgent_intake.sql'), 'utf8');
        check('known senders are seeded from parsed email history, not from a list',
            /insert into public\.intake_known_senders[\s\S]*?from public\.email_parser_log[\s\S]*?on conflict \(entity_slug, sender\) do nothing/i.test(intakeSql));
        check('held mail has a column for its html', /alter table public\.email_parser_log add column if not exists raw_html text/.test(intakeSql));

        console.log('\n── bookings and messages screens ──');
        const bk = await call('GET', '/api/owner/bookings?from=2026-10-01&to=2026-10-31');
        const b1 = bk.body.bookings.find((b) => b.id === 'b-1');
        check('bookings in the shape the app reads', b1 && b1.start === '2026-10-10T09:30' && b1.end === '2026-10-10T11:00' && b1.customer_name === 'Ana' && b1.party_size === 3);
        check('only this business\'s', !bk.body.bookings.some((b) => b.id === 'b-2'));
        const messages = require(path.join(ROOT, 'lib/messages.js'));
        await messages.recordInbound({ slug: 'shop', channel: 'email', from: 'guest@example.test', body: 'Do you have parking?' });
        const threads = await call('GET', '/api/owner/messages/threads');
        const th = threads.body.threads[0];
        check('threads in the app\'s shape, unread counted', th && th.contact === 'guest@example.test' && th.unread === 1 && th.handled_by === 'agent' && th.last_message === 'Do you have parking?', JSON.stringify(th));
        const one = await call('GET', `/api/owner/messages/threads/${th.id}`);
        check('a thread reads as messages', one.body.messages[0]?.text === 'Do you have parking?' && one.body.messages[0].direction === 'in');
        const reread = await call('GET', '/api/owner/messages/threads');
        check('reading it clears unread', reread.body.threads[0].unread === 0);
        const reply = await call('POST', `/api/owner/messages/threads/${th.id}/send`, { text: 'Yes, out back.' });
        check('the owner replies on the same channel', reply.status === 201 && reply.body.message.text === 'Yes, out back.' && emails.at(-1).to === 'guest@example.test');
        const take = await call('POST', `/api/owner/messages/threads/${th.id}/takeover`, { owner: true });
        check('take over', take.body.thread.handled_by === 'owner');

        console.log('\n── profile and export ──');
        const prof = await call('PATCH', '/api/owner/profile', { description: 'new words', is_active: false, google_verified: true, rating: 5, slug: 'hijack' });
        check('the owner changes their own description', prof.status === 200 && T.entity[0].description === 'new words', JSON.stringify(prof.body));
        check('governed columns are ignored, not written', T.entity[0].is_active === true && T.entity[0].slug === 'shop' && prof.body.ignored.sort().join(',') === 'google_verified,is_active,rating,slug');
        const nothing = await call('PATCH', '/api/owner/profile', { show_in_listings: true });
        check('a body with nothing changeable is refused', nothing.status === 400);
        const exp = await call('POST', '/api/owner/export');
        check('export returns a link for the session\'s business', exp.body.url === 'https://files.example.test/shop.json');
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('intake');
}
