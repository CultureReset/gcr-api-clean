#!/usr/bin/env node
// ============================================================
// Paperclip sign-in and service signing (CONTRACT §1, §3)
// ============================================================
//
//     npm run test:paperclip-auth
//
// Real keys, real signatures, a stubbed JWKS fetch and a stubbed database.
// No credentials, no network.

const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const ISSUER = 'https://paperclip.test';
process.env.PAPERCLIP_ISSUER = ISSUER;
process.env.PAPERCLIP_JWKS_URL = 'https://paperclip.test/.well-known/jwks.json';
process.env.PAPERCLIP_JWKS_MIN_REFETCH_SECONDS = '0';
process.env.NEXTGENT_SERVICE_SECRET = 'test-service-secret';

/* ── a tiny database stub: tables are arrays of rows ──────────────────── */
const tables = {
    company_links: [{ company_id: 'co-1', entity_slug: 'biz-one' }],
    platform_admins: [{ user_id: null, paperclip_user_id: 'pc-admin' }],
    entity_owners: [],
};
function query(table) {
    const filters = [];
    const self = {
        select: () => self,
        eq: (k, v) => { filters.push([k, v]); return self; },
        limit: () => self,
        maybeSingle: async () => {
            const rows = (tables[table] || []).filter((r) => filters.every(([k, v]) => r[k] === v));
            return { data: rows[0] || null, error: null };
        },
        then: (res, rej) => Promise.resolve({
            data: (tables[table] || []).filter((r) => filters.every(([k, v]) => r[k] === v)), error: null,
        }).then(res, rej),
    };
    return self;
}
const dbStub = {
    from: (t) => query(t),
    auth: { getUser: async () => ({ data: null, error: new Error('not a supabase token') }) },
};
function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}
inject(path.join(ROOT, 'db.js'), dbStub);

const paperclip = require(path.join(ROOT, 'lib/paperclipAuth.js'));
const signing = require(path.join(ROOT, 'lib/serviceSigning.js'));
const { ownerRequired, paperclipRequired } = require(path.join(ROOT, 'middleware/ownerAuth.js'));

/* ── keys and a JWKS endpoint ─────────────────────────────────────────── */
const ed = crypto.generateKeyPairSync('ed25519');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed2 = crypto.generateKeyPairSync('ed25519');
const jwk = (pub, kid, extra = {}) => ({ ...pub.export({ format: 'jwk' }), kid, ...extra });
let published = [jwk(ed.publicKey, 'ed-1'), jwk(rsa.publicKey, 'rsa-1', { alg: 'RS256' })];
let jwksFetches = 0;
paperclip._setFetch(async () => {
    jwksFetches += 1;
    return { ok: true, status: 200, json: async () => ({ keys: published }) };
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign({ alg = 'EdDSA', kid = 'ed-1', key = ed.privateKey, claims = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: ISSUER, aud: 'gcr-api-clean', sub: 'pc-user', company_id: 'co-1', role: 'owner',
        iat: now, exp: now + 300, ...claims,
    };
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64(payload);
    const data = Buffer.from(`${head}.${body}`);
    const sig = alg === 'EdDSA' ? crypto.sign(null, data, key) : crypto.sign('sha256', data, key);
    return `${head}.${body}.${sig.toString('base64url')}`;
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}
async function rejects(label, promise, re) {
    try { await promise; check(label, false, 'did not throw'); }
    catch (e) { check(label, !re || re.test(e.message), e.message); }
}

/** Run a middleware against a fake request; resolve to { next, status, body, req }. */
function run(mw, { token, query = {}, body = {}, params = {} } = {}) {
    return new Promise((resolve) => {
        const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, query, body, params };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ next: false, status: this.statusCode, body: b, req }); return this; },
        };
        mw(req, res, () => resolve({ next: true, req }));
    });
}

(async () => {
    console.log('\n── service signing ──');
    const raw = JSON.stringify({ companyId: 'co-1' });
    const URL_ = 'https://gcr.test/api/nextgent/link';
    const sig = (opts = {}) => signing.signHeaders({ method: 'POST', url: URL_, rawBody: raw }, opts);
    const reqOf = (headers, { body = raw, method = 'POST', url = '/api/nextgent/link' } = {}) =>
        ({ headers, rawBody: body === undefined ? undefined : Buffer.from(body), method, originalUrl: url });
    const headers = sig();
    check('a correctly signed request passes', signing.verifyRequest(reqOf(headers)) === null);
    check('headers: unix-second timestamp, a nonce of at least 16 random bytes as hex, a hex HMAC-SHA256',
        /^\d+$/.test(headers['x-nextgent-timestamp']) && /^[0-9a-f]{32,}$/.test(headers['x-nextgent-nonce']) && /^[0-9a-f]{64}$/.test(headers['x-nextgent-signature']),
        JSON.stringify(headers));
    check('the same request a second time is a replay', /replay/i.test(signing.verifyRequest(reqOf(headers)) || ''), String(signing.verifyRequest(reqOf(headers))));
    check('two signatures of one request never share a nonce', sig()['x-nextgent-nonce'] !== sig()['x-nextgent-nonce']);
    check('a changed body fails', /Bad signature/.test(signing.verifyRequest(reqOf(sig(), { body: raw + ' ' }))));
    check('the signature binds the method', /Bad signature/.test(signing.verifyRequest(reqOf(sig(), { method: 'DELETE' }))));
    check('and the path', /Bad signature/.test(signing.verifyRequest(reqOf(sig(), { url: '/api/nextgent/installs/x' }))));
    const q = signing.signHeaders({ method: 'GET', url: 'https://gcr.test/api/nextgent/entitlement?companyId=co-1&itemKey=a', rawBody: '' });
    check('a GET with a query passes with that query', signing.verifyRequest(reqOf(q, { body: '', method: 'GET', url: '/api/nextgent/entitlement?companyId=co-1&itemKey=a' })) === null);
    const q2 = signing.signHeaders({ method: 'GET', url: 'https://gcr.test/api/nextgent/entitlement?companyId=co-1&itemKey=a', rawBody: '' });
    check('and the query is bound', /Bad signature/.test(signing.verifyRequest(reqOf(q2, { body: '', method: 'GET', url: '/api/nextgent/entitlement?companyId=co-2&itemKey=a' }))));
    const old = sig({ now: Date.now() - 301 * 1000 });
    check('older than 300 s fails', /too old/.test(signing.verifyRequest(reqOf(old))));
    const future = sig({ now: Date.now() + 301 * 1000 });
    check('more than 300 s in the future fails', /too old/.test(signing.verifyRequest(reqOf(future))));
    check('no headers fails', /Missing/.test(signing.verifyRequest(reqOf({}))));
    check('a signature without a nonce fails', /Missing/.test(signing.verifyRequest(reqOf((() => { const h = sig(); delete h['x-nextgent-nonce']; return h; })()))));
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    check('signed string is `${ts}\\n${nonce}\\n${METHOD}\\n${path}\\n${query}\\n${sha256hex(body)}`',
        signing.requestSignature({ timestamp: '100', nonce: 'ab', method: 'get', pathname: '/p', query: 'a=1', rawBody: 'x' }, 'k')
            === crypto.createHmac('sha256', 'k').update(`100\nab\nGET\n/p\na=1\n${sha('x')}`).digest('hex'));
    check('an empty body hashes as the empty string', signing.requestSignature({ timestamp: '1', nonce: 'n', method: 'GET', pathname: '/p', query: '', rawBody: '' }, 'k')
        === crypto.createHmac('sha256', 'k').update(`1\nn\nGET\n/p\n\n${sha('')}`).digest('hex'));
    check('the Paperclip routine webhook format (`${ts}.${body}`) is still available for the agent step',
        signing.signature('100', 'x', 'k') === crypto.createHmac('sha256', 'k').update('100.x').digest('hex'));

    console.log('\n── one secret per purpose ──');
    const fs = require('fs');
    const secrets = require(path.join(ROOT, 'lib/requiredSecrets.js'));
    const throwsFor = (env) => { try { secrets.assertSecrets(env); return null; } catch (e) { return e.message; } };
    const all = { NEXTGENT_SERVICE_SECRET: 'a', NEXTGENT_SECRETS_KEY: 'b', NEXTGENT_SESSION_SECRET: 'c', VERIFY_CODE_SECRET: 'd' };
    check('production refuses to start when a secret is missing, naming it', /NEXTGENT_SECRETS_KEY/.test(throwsFor({ NODE_ENV: 'production', NEXTGENT_SERVICE_SECRET: 'a' }) || ''));
    check('a Vercel production deploy too', /NEXTGENT_SESSION_SECRET/.test(throwsFor({ VERCEL_ENV: 'production', ...all, NEXTGENT_SESSION_SECRET: '' }) || ''));
    check('with every secret set it starts', throwsFor({ NODE_ENV: 'production', ...all }) === null);
    check('development starts without them', throwsFor({ NODE_ENV: 'development' }) === null);
    for (const f of ['lib/secretBox.js', 'lib/businessTokens.js', 'lib/phoneVerification.js']) {
        check(`${f} never derives from NEXTGENT_SERVICE_SECRET`, !/NEXTGENT_SERVICE_SECRET/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    }
    const box = require(path.join(ROOT, 'lib/secretBox.js'));
    delete process.env.NEXTGENT_SECRETS_KEY;
    check('secretBox refuses to seal without its own key', (() => { try { box.seal('x'); return false; } catch (e) { return /NEXTGENT_SECRETS_KEY/.test(e.message); } })());
    process.env.NEXTGENT_SECRETS_KEY = 'box-key';
    check('and seals with it', box.open(box.seal('hello')) === 'hello');
    const tokens = require(path.join(ROOT, 'lib/businessTokens.js'));
    delete process.env.NEXTGENT_SESSION_SECRET;
    check('an install session token needs its own secret', (() => { try { tokens.mintInstallSession({ installId: 'in-1' }); return false; } catch (e) { return /NEXTGENT_SESSION_SECRET/.test(e.message); } })());
    process.env.NEXTGENT_SESSION_SECRET = 'session-one';
    const minted = tokens.mintInstallSession({ installId: 'in-1' }).token;
    process.env.NEXTGENT_SESSION_SECRET = 'session-two';
    tables.nextgent_installs = [{ install_id: 'in-1', company_id: null, entity_slug: 'biz-one', item_key: 'x', permissions: [], status: 'active' }];
    check('a token minted under another session secret is refused', /not valid/.test((await tokens.lookupToken(minted)).reason || ''));
    process.env.NEXTGENT_SESSION_SECRET = 'session-one';
    check('and accepted under its own', (await tokens.lookupToken(minted)).slug === 'biz-one');

    console.log('\n── token verification ──');
    const good = await paperclip.verifyToken(sign());
    check('an EdDSA token verifies', good.company_id === 'co-1');
    const rs = await paperclip.verifyToken(sign({ alg: 'RS256', kid: 'rsa-1', key: rsa.privateKey }));
    check('an RS256 token verifies', rs.sub === 'pc-user');
    check('it is recognised as Paperclip by its issuer', paperclip.isPaperclipToken(sign()));
    check('another issuer is not Paperclip', !paperclip.isPaperclipToken(sign({ claims: { iss: 'https://supabase.test' } })));
    await rejects('wrong audience', paperclip.verifyToken(sign({ claims: { aud: 'someone-else' } })), /not meant/);
    await rejects('expired', paperclip.verifyToken(sign({ claims: { iat: 1000, exp: 1200 } })), /expired/);
    const now = Math.floor(Date.now() / 1000);
    await rejects('a lifetime over 300 s', paperclip.verifyToken(sign({ claims: { iat: now, exp: now + 3600 } })), /too long/);
    await rejects('an unknown role', paperclip.verifyToken(sign({ claims: { role: 'superuser' } })), /role/);
    await rejects('no company', paperclip.verifyToken(sign({ claims: { company_id: '' } })), /company/);
    await rejects('a forged signature', paperclip.verifyToken(sign({ key: ed2.privateKey })), /not valid/);
    await rejects('alg none', paperclip.verifyToken(`${b64({ alg: 'none', kid: 'ed-1' })}.${b64({ iss: ISSUER })}.`), /not valid/);
    await rejects('an RS256 header on an Ed25519 key', paperclip.verifyToken(sign({ alg: 'RS256', kid: 'ed-1', key: rsa.privateKey })), /not valid/);

    const before = jwksFetches;
    published = [...published, jwk(ed2.publicKey, 'ed-2')];
    const rotated = await paperclip.verifyToken(sign({ kid: 'ed-2', key: ed2.privateKey }));
    check('an unknown kid refetches the JWKS (rotation)', rotated.sub === 'pc-user' && jwksFetches === before + 1,
        `fetches ${before} -> ${jwksFetches}`);
    const cached = jwksFetches;
    await paperclip.verifyToken(sign());
    check('a known kid is served from the cache', jwksFetches === cached);

    console.log('\n── ownerRequired, Paperclip path ──');
    const owner = await run(ownerRequired, { token: sign() });
    check('a linked company resolves to its business', owner.next && owner.req.entitySlug === 'biz-one');
    check('and the request is marked as Paperclip', owner.req.authVia === 'paperclip' && owner.req.paperclip.companyId === 'co-1');

    const named = await run(ownerRequired, { token: sign(), query: { slug: 'someone-else' } });
    check('an owner naming another slug still gets their own', named.req.entitySlug === 'biz-one');

    const unlinked = await run(ownerRequired, { token: sign({ claims: { company_id: 'co-unlinked' } }) });
    check('an unlinked company is refused', !unlinked.next && unlinked.status === 403, JSON.stringify(unlinked.body));

    const admin = await run(ownerRequired, {
        token: sign({ claims: { sub: 'pc-admin', role: 'instance_admin', company_id: 'co-unlinked' } }),
        query: { slug: 'any-biz' },
    });
    check('a listed instance admin acts on the slug they name', admin.next && admin.req.entitySlug === 'any-biz' && admin.req.actingAsAdmin);

    const fake = await run(ownerRequired, {
        token: sign({ claims: { sub: 'pc-nobody', role: 'instance_admin' } }),
        query: { slug: 'any-biz' },
    });
    check('instance_admin not in platform_admins gets only its own link', fake.next && fake.req.entitySlug === 'biz-one' && !fake.req.actingAsAdmin);

    const bad = await run(ownerRequired, { token: sign({ claims: { aud: 'nope' } }) });
    check('a bad Paperclip token is 401, not passed to Supabase', !bad.next && bad.status === 401);

    console.log('\n── paperclipRequired (the claim routes) ──');
    const claimer = await run(paperclipRequired, { token: sign({ claims: { company_id: 'co-unlinked' } }) });
    check('an unlinked company may reach the claim routes', claimer.next && claimer.req.entitySlug === null);
    const notPc = await run(paperclipRequired, { token: 'some-supabase-token' });
    check('a non-Paperclip token may not', !notPc.next && notPc.status === 401);

    console.log('\n── instance-admin token on the admin gates (CONTRACT §12) ──');
    const { adminRequired, authRequired } = require(path.join(ROOT, 'middleware/auth.js'));
    const adminTok = (claims = {}) => {
        const t = sign({ claims: { sub: 'pc-admin', role: 'instance_admin', ...claims } });
        return t;
    };
    const noCompany = (() => {
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: 'EdDSA', kid: 'ed-1', typ: 'JWT' });
        const body = b64({ iss: ISSUER, aud: 'gcr-api-clean', sub: 'pc-admin', role: 'instance_admin', iat: now, exp: now + 300 });
        return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), ed.privateKey).toString('base64url')}`;
    })();
    const verifiedNoCo = await paperclip.verifyToken(noCompany).catch((e) => e);
    check('an instance_admin token may name no company', verifiedNoCo.role === 'instance_admin' && !verifiedNoCo.company_id);
    await rejects('an owner token with no company is still refused', paperclip.verifyToken((() => {
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: 'EdDSA', kid: 'ed-1', typ: 'JWT' });
        const body = b64({ iss: ISSUER, aud: 'gcr-api-clean', sub: 'pc-user', role: 'owner', iat: now, exp: now + 300 });
        return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), ed.privateKey).toString('base64url')}`;
    })()), /company/);
    const gate = await run(adminRequired, { token: noCompany });
    check('adminRequired accepts a listed instance admin with no company', gate.next && gate.req.role === 'admin' && gate.req.authVia === 'paperclip');
    const gate2 = await run(adminRequired, { token: adminTok() });
    check('and with a company', gate2.next && gate2.req.role === 'admin');
    const notListed = await run(adminRequired, { token: sign({ claims: { sub: 'pc-nobody', role: 'instance_admin' } }) });
    check('an instance_admin not in platform_admins is 403', !notListed.next && notListed.status === 403);
    const ownerTok = await run(adminRequired, { token: sign() });
    check('a company owner token is 403 on an admin gate', !ownerTok.next && ownerTok.status === 403);
    const badSig = await run(adminRequired, { token: noCompany.slice(0, -4) + 'AAAA' });
    check('a forged admin token is 401', !badSig.next && badSig.status === 401);
    const plain = await run(authRequired, { token: noCompany });
    check('authRequired gives a listed admin role admin', plain.next && plain.req.role === 'admin');
    const adminOwner = await run(ownerRequired, { token: noCompany, query: { slug: 'any-biz' } });
    check('ownerRequired: a company-less admin acts on the slug it names', adminOwner.next && adminOwner.req.entitySlug === 'any-biz' && adminOwner.req.actingAsAdmin);
    const adminNoSlug = await run(ownerRequired, { token: noCompany });
    check('and without a slug it is refused, not given a business', !adminNoSlug.next && adminNoSlug.status === 403);

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
