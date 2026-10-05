#!/usr/bin/env node
// ============================================================
// Owner app routes: automation builder palette and drafts, plan checkout,
// computer pairing (device flow) and remote view
// ============================================================
//
//     npm run test:owner-app
//
// In-memory database, a recording Stripe. No credentials, no network.

const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    NEXTGENT_SERVICE_SECRET: 'svc',
    NEXTGENT_SECRETS_KEY: 'box-key', NEXTGENT_SESSION_SECRET: 'session-key', VERIFY_CODE_SECRET: 'code-key',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
    OWNER_APP_URL: 'https://app.example.test',
    OWNER_BILLING_PATH: '/billing',
    NODE_REMOTE_URL_TEMPLATE: 'https://view.example.test/{node}#{token}',
    NODE_PAIR_URL: 'https://app.example.test/pair',
});

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop', email: 'o@shop.test' }],
    owner_automation_drafts: [],
    // An installed app (lib/appInstances.js projection) declaring the events it emits.
    entity_modules: [
        { id: 1, entity_slug: 'shop', module_key: 'song-requests', managed_by: 'paperclip', install_id: 'in-1', enabled: true, settings: { manifest: { name: 'Song Requests', events: { emits: ['requests.submitted'] } } } },
        { id: 2, entity_slug: 'shop', module_key: 'gone-app', managed_by: 'paperclip', install_id: 'in-2', enabled: false, settings: { manifest: { name: 'Gone', events: { emits: ['things.happened'] } } } },
        { id: 3, entity_slug: 'other', module_key: 'theirs', managed_by: 'paperclip', install_id: 'in-3', enabled: true, settings: { manifest: { name: 'Theirs', events: { emits: ['stuff.done'] } } } },
    ],
    billing_plan: [{ key: 'base', is_default: true, is_public: true }, { key: 'growth', name: 'Growth', stripe_price_id: 'price_growth', is_public: true }, { key: 'hidden', is_public: false, stripe_price_id: 'p' }],
    billing_subscription: [],
    ghost_nodes: [],
    ghost_node_requests: [],
    node_pairings: [],
    node_remote_sessions: [],
} });
inject(path.join(ROOT, 'db.js'), db);
let session = { entitySlug: 'shop', authVia: 'paperclip', paperclip: { userId: 'pc-1', companyId: 'co-1' }, ownerUserId: null };
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, res, next) => (session ? (Object.assign(req, session), next()) : res.status(401).json({ error: 'no' })),
    sessionRequired: (req, res, next) => next(),
});

const stripeCalls = [];
require(path.join(ROOT, 'lib/billingStripe.js'))._setStripe({
    customers: { create: async (a) => { stripeCalls.push(['customers.create', a]); return { id: 'cus_1' }; } },
    checkout: { sessions: { create: async (a) => { stripeCalls.push(['checkout', a]); return { url: 'https://checkout.stripe.test/s/1' }; } } },
    billingPortal: { sessions: { create: async (a) => { stripeCalls.push(['portal', a]); return { url: 'https://billing.stripe.test/p/1' }; } } },
});

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/business/automations', require(path.join(ROOT, 'routes/automations.js')).ownerRouter);
app.use('/api/billing', require(path.join(ROOT, 'routes/billing.js')));
app.use('/api/nodes', require(path.join(ROOT, 'routes/nodes.js')));
const server = app.listen(0, run);
async function call(method, p, body) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function run() {
    try {
        console.log('\n── automation builder for owners ──');
        const engine = require(path.join(ROOT, 'lib/automationEngine.js'));
        const meta = await call('GET', '/api/business/automations/meta');
        const types = meta.body.steps.map((s) => s.type);
        check('the palette is the engine\'s own registry', types.includes('wait') && types.includes('message') && types.length === Object.values(engine.STEP_TYPES).filter((s) => !s.adminOnly).length);
        check('platform-only steps are left out', !types.includes('script') && !types.includes('http.request'));
        check('triggers and events come with it', meta.body.triggers.length > 0 && meta.body.events.some((e) => e.name === 'booking.completed'));
        const appEvent = meta.body.events.find((e) => e.name === 'song-requests.requests.submitted');
        check('the events of this business\'s installed apps are listed, namespaced by app key (DECISIONS #47)', !!appEvent && appEvent.app === 'song-requests' && /Song Requests/.test(appEvent.description), JSON.stringify(meta.body.events));
        check('a disabled install\'s events are not, nor another business\'s', !meta.body.events.some((e) => e.name === 'gone-app.things.happened' || e.name === 'theirs.stuff.done'));
        const onApp = await call('POST', '/api/business/automations/drafts', { name: 'Thank the requester', trigger: { type: 'event', event: 'song-requests.requests.submitted' }, steps: [] });
        check('a draft may listen for an installed app\'s event', onApp.status === 201 && onApp.body.problems.length === 0, JSON.stringify(onApp.body));
        const onNothing = await call('POST', '/api/business/automations/drafts', { name: 'Listen to the void', trigger: { type: 'event', event: 'nobody.installed.this' }, steps: [] });
        check('an event no installed app declares is a problem', onNothing.body.problems.some((p) => /event/i.test(p)), JSON.stringify(onNothing.body));
        const saved = await call('POST', '/api/business/automations/drafts', {
            name: 'Thank-you note', trigger: { type: 'event', event: 'booking.completed' },
            steps: [{ id: 'w', type: 'wait', config: { minutes: 60 } }, { id: 'm', type: 'message', config: { channel: 'email', to: '{{ trigger.payload.booking.customer_email }}', body: 'Thanks!' } }],
        });
        check('a draft is saved for the session\'s business', saved.status === 201 && saved.body.draft.entity_slug === 'shop' && saved.body.problems.length === 0, JSON.stringify(saved.body));
        const sneaky = await call('POST', '/api/business/automations/drafts', { name: 'x', steps: [{ id: 's', type: 'script', config: { code: 'return 1' } }] });
        check('a platform-only step is reported as a problem', sneaky.body.problems.some((p) => /only available to the platform/.test(p)));
        const upd = await call('POST', '/api/business/automations/drafts', { id: saved.body.draft.id, name: 'Thank-you note v2', steps: [] });
        check('a draft can be updated by id', upd.status === 200 && upd.body.draft.name === 'Thank-you note v2');
        const list = await call('GET', '/api/business/automations/drafts');
        check('drafts list', list.body.drafts.length === 4, String(list.body.drafts.length));
        session = { ...session, entitySlug: 'other' };
        const foreign = await call('POST', '/api/business/automations/drafts', { id: saved.body.draft.id, name: 'mine now' });
        check('another business cannot change it', foreign.status === 404);
        session = { ...session, entitySlug: 'shop' };

        console.log('\n── plan checkout ──');
        const co = await call('POST', '/api/billing/checkout', { plan: 'growth' });
        const sess = stripeCalls.find((c) => c[0] === 'checkout')?.[1];
        check('a Stripe Checkout link for the plan', co.status === 200 && co.body.url === 'https://checkout.stripe.test/s/1' && co.body.mode === 'checkout');
        check('priced from the plan row, back to the owner app', sess.line_items[0].price === 'price_growth' && sess.success_url === 'https://app.example.test/billing?checkout=success' && sess.subscription_data.metadata.plan_key === 'growth');
        check('a hidden plan cannot be bought', (await call('POST', '/api/billing/checkout', { plan: 'hidden' })).status === 404);
        T.billing_subscription[0].stripe_subscription_id = 'sub_1';
        T.billing_subscription[0].status = 'active';
        const portal = await call('POST', '/api/billing/checkout', { plan: 'growth' });
        check('a business that subscribes already gets the billing portal', portal.body.mode === 'portal' && portal.body.url === 'https://billing.stripe.test/p/1');

        console.log('\n── pairing a computer (device flow) ──');
        const start = await call('POST', '/api/nodes/pair/start', { name: 'Front TV' });
        check('the computer gets a short code to show and a device code to keep', start.status === 201 && /^[A-Z0-9]{8}$/.test(start.body.user_code) && start.body.device_code.length > 30);
        check('and the link to show as a QR', start.body.verification_uri_complete === `https://app.example.test/pair?code=${start.body.user_code}`);
        check('only hashes are stored', !JSON.stringify(T.node_pairings).includes(start.body.user_code) && !JSON.stringify(T.node_pairings).includes(start.body.device_code));
        const early = await call('POST', '/api/nodes/pair/poll', { device_code: start.body.device_code });
        check('polling before the owner confirms: pending', early.status === 202 && early.body.status === 'pending');
        const wrong = await call('POST', '/api/nodes/pair', { code: 'ZZZZZZZZ' });
        check('a wrong code is refused', wrong.status === 404);
        const paired = await call('POST', '/api/nodes/pair', { code: start.body.user_code.toLowerCase().replace(/(.{4})/, '$1-'), entity_slug: 'someone-else' });
        check('the owner confirms; the node is the session\'s business', paired.status === 201 && T.ghost_nodes[0].entity_slug === 'shop' && paired.body.node.name === 'Front TV', JSON.stringify(paired.body));
        const got = await call('POST', '/api/nodes/pair/poll', { device_code: start.body.device_code });
        check('the computer collects its own node token', got.status === 200 && /^gcr_node_/.test(got.body.token) && got.body.node.id === T.ghost_nodes[0].id);
        check('the token is erased once collected', T.node_pairings[0].token_sealed === null && T.node_pairings[0].status === 'collected');
        check('it cannot be collected twice', (await call('POST', '/api/nodes/pair/poll', { device_code: start.body.device_code })).status === 410);
        check('and the code cannot be used again', (await call('POST', '/api/nodes/pair', { code: start.body.user_code })).status === 404);
        const crypto = require('crypto');
        check('the token works as this node\'s', T.ghost_nodes[0].token_hash === crypto.createHash('sha256').update(got.body.token).digest('hex'));
        const mine = await call('GET', '/api/nodes');
        check('a Paperclip owner sees the paired computer', mine.body.nodes.length === 1);

        console.log('\n── remote view ──');
        const remote = await call('GET', `/api/nodes/${T.ghost_nodes[0].id}/remote`);
        check('a viewer link from the configured template', remote.status === 200 && remote.body.url.startsWith(`https://view.example.test/${T.ghost_nodes[0].id}#`));
        const token = decodeURIComponent(remote.body.url.split('#')[1]);
        const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
        check('the computer is asked to open the session, told only the token\'s hash',
            T.ghost_node_requests.some((r) => r.path === '/remote/session' && r.body.token_hash === sha(token) && !('token' in r.body)));
        const ok = await call('POST', '/api/nodes/remote/verify', { token });
        check('the viewer can check the token', ok.status === 200 && ok.body.valid && ok.body.node_id === T.ghost_nodes[0].id);
        check('a made-up token is not valid', (await call('POST', '/api/nodes/remote/verify', { token: 'nope' })).status === 401);
        session = { ...session, entitySlug: 'other' };
        check('another business gets no link to it', (await call('GET', `/api/nodes/${T.ghost_nodes[0].id}/remote`)).status === 404);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('owner-app');
}
