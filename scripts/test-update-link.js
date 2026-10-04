#!/usr/bin/env node
// ============================================================
// Update links: the texted link validates, its passcode is random, guessed
// at most a few times and compared in constant time
// ============================================================
//
//     npm run test:update-link
//
// In-memory database, a recording carrier. No credentials, no network.

const path = require('path');
const fs = require('fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    JWT_SECRET: 'console-secret',
    TELNYX_API_KEY: 'KEY_test',
    PLATFORM_NUMBER: '+15550000001',
    LINKS_BASE_URL: 'https://links.example.test',
    UPDATE_LINK_PASSCODE_ATTEMPTS: '3',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.TELEPHONY_PROVIDER;
delete process.env.OWNER_RELAY_MODE;

const today = new Date().toISOString().split('T')[0];
const { T, db } = createMemDb({ tables: {
    update_links: [
        // A link minted before passcodes were persisted: it has none.
        { id: 'l-old', entity_id: 'e-3', link_type: 'full', link_date: today, token: 'old-token', passcode: null, expires_at: new Date(Date.now() + 3600e3).toISOString() },
    ],
    entity: [{ id: 'e-1', slug: 'shop', name: 'The Shop' }, { id: 'e-2', slug: 'cafe', name: 'The Cafe' }, { id: 'e-3', slug: 'bar', name: 'The Bar' }],
    businesses: [], entity_owners: [], menu_sections: [], menu_items: [], sms_log: [], sms_opt_outs: [],
} });
inject(path.join(ROOT, 'db.js'), db);

const carrier = [];
require(path.join(ROOT, 'lib/telephony/telnyx.js'))._setFetch(async (url, init) => {
    carrier.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'msg-1' } }) };
});

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/update', require(path.join(ROOT, 'routes/update-link.js')));
app.use('/update', require(path.join(ROOT, 'routes/update-link.js')));
const server = app.listen(0, run);
const admin = jwt.sign({ userId: 'op-1', role: 'admin' }, process.env.JWT_SECRET);
async function call(method, p, body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
        method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const asAdmin = (method, p, body) => call(method, p, body, { authorization: `Bearer ${admin}` });

async function run() {
    try {
        console.log('\n── the texted link ──');
        const sent = await asAdmin('POST', '/api/update/send-sms', { entity_id: 'e-1', phone: '251-555-0100' });
        check('the link is texted', sent.status === 200 && sent.body.success === true, JSON.stringify(sent.body));
        const link = T.update_links.find((l) => l.entity_id === 'e-1');
        check('the link row has a six-digit passcode', /^\d{6}$/.test(link?.passcode || ''), JSON.stringify(link));
        const text = carrier.at(-1)?.body?.text || '';
        check('the text is the one that existed before the consent work', /^Hi! Here's your daily update link for The Shop:\n\n/.test(text) && /Expires tonight\.$/.test(text), text);
        check('its URL carries the passcode the editor validates with', text.includes(`?token=${link?.token}&passcode=${link?.passcode}`), text);
        check('and the console is told the passcode too', !!sent.body.passcode && sent.body.passcode === link?.passcode, JSON.stringify(sent.body));

        console.log('\n── validating ──');
        const ok = await call('GET', `/update/${link.token}/catch?passcode=${link.passcode}`);
        check('the link validates with its passcode in the URL', ok.status === 200, JSON.stringify(ok));
        const viaHeader = await call('GET', `/update/${link.token}/catch`, null, { 'x-link-passcode': link.passcode });
        check('or in the header the editor sends', viaHeader.status === 200, JSON.stringify(viaHeader));
        const none = await call('GET', `/update/${link.token}/catch`);
        check('without one it is refused', none.status === 401 && none.body.requires_passcode === true);
        const wrong = String((Number(link.passcode) + 1) % 1000000).padStart(6, '0');
        const miss = await call('GET', `/update/${link.token}/catch?passcode=${wrong}`);
        check('a wrong passcode is refused and counted', miss.status === 401 && link.passcode_attempts === 2, JSON.stringify({ status: miss.status, attempts: link.passcode_attempts }));
        await call('GET', `/update/${link.token}/catch?passcode=${wrong}`);
        const locked = await call('GET', `/update/${link.token}/catch?passcode=${wrong}`);
        check('after UPDATE_LINK_PASSCODE_ATTEMPTS wrong tries the link is locked', locked.status === 401 && locked.body.locked === true, JSON.stringify(locked.body));
        const late = await call('GET', `/update/${link.token}/catch?passcode=${link.passcode}`);
        check('and the right passcode no longer opens it', late.status === 401 && late.body.locked === true, JSON.stringify(late.body));
        const right = await call('GET', `/update/${link.token}/catch?passcode=${link.passcode}`);
        check('a right passcode on a locked link is not a new try', right.status === 401 && link.passcode_attempts === 3);

        console.log('\n── minting ──');
        const gen = await asAdmin('POST', '/api/update/generate', { entity_id: 'e-2' });
        check('/generate mints a six-digit passcode too', gen.status === 200 && /^\d{6}$/.test(gen.body.passcode || ''), JSON.stringify(gen.body));
        carrier.length = 0;
        const resend = await asAdmin('POST', '/api/update/send-sms', { entity_id: 'e-3', phone: '251-555-0101' });
        const old = T.update_links.find((l) => l.id === 'l-old');
        check('texting an older link without a passcode gives it one first', resend.body.success === true && /^\d{6}$/.test(old.passcode || '') && (carrier.at(-1)?.body?.text || '').includes(`passcode=${old.passcode}`), JSON.stringify({ old, text: carrier.at(-1)?.body?.text }));
        const src = fs.readFileSync(path.join(ROOT, 'routes/update-link.js'), 'utf8');
        check('passcodes come from crypto, not Math.random', !/Math\.random/.test(src) && /crypto\.randomInt/.test(src));
        check('and are compared in constant time', /timingSafeEqual/.test(src));
        const codes = new Set(Array.from({ length: 50 }, () => require(path.join(ROOT, 'routes/update-link.js'))._makePasscode()));
        check('fifty passcodes are not all the same', codes.size > 1 && [...codes].every((c) => /^\d{6}$/.test(c)));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('update-link');
}
