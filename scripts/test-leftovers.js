#!/usr/bin/env node
// ============================================================
// Part-1 leftovers: forwarding address, our own phone codes, platform texts
// through lib/telephony, computers by business for Paperclip owners
// ============================================================
//
//     npm run test:leftovers
//
// In-memory database, a recording carrier. No credentials, no network.

const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: 'svc',
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    TELNYX_API_KEY: 'KEY_test',
    PLATFORM_NUMBER: '+15550000001',
    INTAKE_EMAIL_DOMAIN: 'intake.example.test',
    VERIFY_CODE_MESSAGE: 'Code {code}, {minutes} min',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.INTAKE_EMAIL_PREFIX;

const { T, db } = createMemDb({ tables: {
    phone_verification_codes: [],
    ghost_nodes: [
        { id: 'n-1', entity_slug: 'biz', name: 'Front desk', created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: '1' },
        { id: 'n-2', entity_slug: 'biz', name: 'Back office', created_by: null, created_at: '2' },
        { id: 'n-3', entity_slug: 'other', name: 'Not ours', created_by: null, created_at: '3' },
    ],
    tourist_profiles: [],
    business_staff: [],
    sms_opt_outs: [],
    sms_log: [],
} });
inject(path.join(ROOT, 'db.js'), db);

// Staff commands have their own tests; here they only need to say "not staff".
inject(path.join(ROOT, 'lib/staff-commands.js'), { handleStaffCommand: async () => null });

// The session decides who is calling; the test chooses per request.
let session = null;
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, res, next) => (session ? (Object.assign(req, session), next()) : res.status(401).json({ error: 'no' })),
});

const sent = [];
const telnyx = require(path.join(ROOT, 'lib/telephony/telnyx.js'));
telnyx._setFetch(async (url, init) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'msg-1' } }) };
});

const { check, done } = checker();

(async () => {
    console.log('\n── forwarding address, both directions ──');
    const fa = require(path.join(ROOT, 'lib/forwardingAddress.js'));
    const addr = fa.forwardingAddressFor('taco-shop');
    check('the address uses the configured domain', addr === 'gcr-taco-shop@intake.example.test', addr);
    check('and parses back to the slug', fa.slugFromAddress(`"Taco" <${addr}>, someone@else.test`) === 'taco-shop');
    check('an address on another domain is not ours', fa.slugFromAddress('gcr-taco-shop@elsewhere.test') === null);
    process.env.INTAKE_EMAIL_PREFIX = 'in+';
    check('the prefix is configuration', fa.forwardingAddressFor('x') === 'in+x@intake.example.test' && fa.slugFromAddress('in+x@intake.example.test') === 'x');
    delete process.env.INTAKE_EMAIL_PREFIX;
    delete process.env.INTAKE_EMAIL_DOMAIN;
    check('no domain, no address', fa.forwardingAddressFor('x') === null);
    process.env.INTAKE_EMAIL_DOMAIN = 'intake.example.test';
    const fs = require('fs');
    const leftovers = ['routes/email-parser.js', 'routes/admin-platform.js'].filter((f) => /@parse\.[a-z]/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no hard-coded parse address remains', !leftovers.length, leftovers.join(', '));

    console.log('\n── our own phone codes ──');
    const pv = require(path.join(ROOT, 'lib/phoneVerification.js'));
    const started = await pv.startVerification('(251) 555-0199', { purpose: 'tourist_sign_in' });
    const text = sent.at(-1)?.body?.text || '';
    const code = (text.match(/Code (\d+)/) || [])[1];
    check('a code is texted through the carrier from the platform number', started.sent && sent.at(-1).body.from === '+15550000001' && /^\d{6}$/.test(code || ''), text);
    check('only its hash is stored', T.phone_verification_codes.length === 1 && !JSON.stringify(T.phone_verification_codes).includes(code));
    const wrong = await pv.checkVerification('+12515550199', '000000', { purpose: 'tourist_sign_in' });
    check('a wrong code is refused', !wrong.ok);
    const otherPurpose = await pv.checkVerification('+12515550199', code, { purpose: 'other' });
    check('a code is bound to its purpose', !otherPurpose.ok);
    const right = await pv.checkVerification('2515550199', code, { purpose: 'tourist_sign_in' });
    check('the right code passes', right.ok && right.phone === '+12515550199');
    const reuse = await pv.checkVerification('2515550199', code, { purpose: 'tourist_sign_in' });
    check('and cannot be used twice', !reuse.ok);
    await pv.startVerification('2515550199', { purpose: 'tourist_sign_in' });
    for (let i = 0; i < 5; i += 1) await pv.checkVerification('2515550199', '111111', { purpose: 'tourist_sign_in' });
    const lastCode = (sent.at(-1).body.text.match(/Code (\d+)/) || [])[1];
    const locked = await pv.checkVerification('2515550199', lastCode, { purpose: 'tourist_sign_in' });
    check('too many tries locks the code', !locked.ok && /Too many/.test(locked.reason));
    const expired = await pv.checkVerification('2515550199', lastCode, { purpose: 'tourist_sign_in', now: new Date(Date.now() + 3600e3) });
    check('an expired code is refused', !expired.ok);

    console.log('\n── platform texts go through lib/telephony ──');
    const src = ['routes/sms.js', 'routes/tourist.js', 'routes/tourist-auth.js', 'routes/update-link.js']
        .filter((f) => /require\(['"]twilio['"]\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no route requires the Twilio SDK any more', !src.length, src.join(', '));
    const numbers = ['routes/sms.js', 'routes/tourist.js'].filter((f) => /\+1\d{10}/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('no hard-coded phone number in them', !numbers.length, numbers.join(', '));
    const { handlePlatformInbound } = require(path.join(ROOT, 'routes/sms.js'));
    const stop = await handlePlatformInbound({ from: '+12515550111', body: 'STOP' });
    check('STOP gets no reply from the handler', stop.reply === null);

    console.log('\n── computers: Paperclip owners see the business\'s ──');
    const app = express();
    app.use(express.json());
    app.use('/api/nodes', require(path.join(ROOT, 'routes/nodes.js')));
    const server = app.listen(0);
    const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/nodes`)).json();
    session = { entitySlug: 'biz', authVia: 'paperclip', ownerUserId: null, paperclip: { userId: 'user_2abc' } };
    const pc = await get();
    check('a Paperclip owner sees every computer of its business', pc.nodes?.length === 2, JSON.stringify(pc));
    check('and none of another business', !pc.nodes.some((n) => n.name === 'Not ours'));
    session = { entitySlug: 'biz', authVia: 'supabase', ownerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const sb = await get();
    check('a dashboard login still sees only the box it enrolled', sb.nodes?.length === 1 && sb.nodes[0].name === 'Front desk');
    server.close();

    done('leftovers');
})().catch((e) => { console.error(e); process.exit(1); });
