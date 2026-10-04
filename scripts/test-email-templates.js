#!/usr/bin/env node
// POST /api/nextgent/email — signed, templates from files, brand from env.
//     npm run test:email
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'svc';
Object.assign(process.env, { NEXTGENT_SERVICE_SECRET: SECRET, NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key', PLATFORM_NAME: 'BrandX', SUPABASE_URL: 'https://db.example.test', SUPABASE_KEY: 'k' });
const { db } = createMemDb({ tables: { company_links: [{ company_id: 'co-1', entity_slug: 'shop' }] } });
inject(path.join(ROOT, 'db.js'), db);
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true, id: 'e1' }; } });

const { check, done } = checker();
const app = express();
app.use(express.json({ verify: (req, _r, buf) => { req.rawBody = buf; } }));
app.use('/api/nextgent', require(path.join(ROOT, 'routes/nextgent.js')));
const server = app.listen(0, run);
async function post(body, sign = true) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'Content-Type': 'application/json' };
    if (sign) Object.assign(headers, require(path.join(ROOT, 'lib/serviceSigning.js')).signHeaders({ method: 'POST', url: '/api/nextgent/email', rawBody: raw }, { key: SECRET, now: Number(ts) * 1000 }));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/nextgent/email`, { method: 'POST', headers, body: raw });
    return { status: res.status, body: await res.json() };
}
const invite = { business_name: 'Tom & <Co>', inviter: 'Ana', role: 'manager', accept_link: 'https://app.example.test/accept?t=1' };

async function run() {
    try {
        check('unsigned is refused', (await post({ to: 'a@b.test', template: 'team-invite', data: invite }, false)).status === 401);
        const ok = await post({ companyId: 'co-1', to: 'New@Team.test', template: 'team-invite', data: invite });
        check('a team invite is sent through utils/email', ok.status === 200 && ok.body.sent && emails[0].to === 'new@team.test');
        check('subject from the template file with the brand from env', emails[0].subject === 'Ana invited you to Tom & <Co> on BrandX');
        check('data is escaped in the body, link kept', emails[0].html.includes('Tom &amp; &lt;Co&gt;') && emails[0].html.includes('href="https://app.example.test/accept?t=1"') && emails[0].html.includes('manager'));
        check('a missing field is refused', (await post({ to: 'a@b.test', template: 'team-invite', data: { ...invite, role: '' } })).status === 400);
        check('a non-http link is refused', (await post({ to: 'a@b.test', template: 'team-invite', data: { ...invite, accept_link: 'javascript:alert(1)' } })).status === 400);
        check('an unknown template is 404', (await post({ to: 'a@b.test', template: 'nope', data: {} })).status === 404);
        check('a path in the name is refused', (await post({ to: 'a@b.test', template: '../package', data: {} })).status === 400);
        check('an unlinked company is refused', (await post({ companyId: 'co-x', to: 'a@b.test', template: 'team-invite', data: invite })).status === 409);
        delete process.env.PLATFORM_NAME;
        check('no brand configured: refused, not invented', (await post({ to: 'a@b.test', template: 'team-invite', data: invite })).status === 503);
    } catch (e) { check('no exception', false, e.stack); }
    server.close();
    done('email');
}
