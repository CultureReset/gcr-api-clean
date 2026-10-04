#!/usr/bin/env node
// ============================================================
// Google push: queue per business, verified profiles only, the per-profile
// edit limit, Google's copy read back as a low-trust source (plan §9)
// ============================================================
//
//     npm run test:google-push
//
// A recording stand-in for Google's APIs; in-memory database.

const path = require('path');
const crypto = require('crypto');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    OAUTH_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    NEXTGENT_SERVICE_SECRET: 'svc-secret',
    GOOGLE_EDITS_PER_MINUTE: '2',
    GOOGLE_PUSH_MAX_ATTEMPTS: '2',
    DEFAULT_CURRENCY: 'usd',
    GOOGLE_GBP_INFO_URL: 'https://info.google.test/v1',
    GOOGLE_GBP_V4_URL: 'https://v4.google.test/v4',
    GOOGLE_GBP_VERIFICATIONS_URL: 'https://verify.google.test/v1',
    GOOGLE_TOKEN_URL: 'https://token.google.test/token',
});

let gbp;
const tokenRow = (slug, location, expires = Date.now() + 3600e3) => ({
    entity_slug: slug, provider: 'google_business', account_id: location,
    access_token: gbp.encryptToken('at-' + slug), refresh_token: gbp.encryptToken('rt-' + slug),
    expires_at: new Date(expires).toISOString(), extra: {},
});

const { T, db } = createMemDb({ tables: {
    entity: [{ slug: 'shop', name: 'The Shop' }, { slug: 'unverified', name: 'U' }],
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }, { company_id: 'co-2', entity_slug: 'unverified' }],
    entity_owners: [],
    oauth_tokens: [],
    google_fact_sources: [
        { table_name: 'entity_hours', kind: 'hours' }, { table_name: 'menu_items', kind: 'menus' },
        { table_name: 'hours_exceptions', kind: 'special_hours' }, { table_name: 'entity_social_posts', kind: 'posts' },
    ],
    google_attribute_map: [],
    google_push_queue: [],
    google_push_state: [],
    fact_source_ranks: [{ source: 'google', rank: 20 }],
    fact_observations: [],
    entity_hours: [
        { entity_slug: 'shop', day_of_week: 'Monday', opens_at: '09:00', closes_at: '17:00', is_closed: false },
        { entity_slug: 'shop', day_of_week: 5, opens_at: '6:00 pm', closes_at: '2:00 am', is_closed: false },
        { entity_slug: 'shop', day_of_week: 'Sunday', is_closed: true },
    ],
    hours_exceptions: [{ entity_slug: 'shop', date: '2099-12-25', closed: true }],
    menu_items: [{ entity_slug: 'shop', name: 'Taco', price: 3.5, category: 'Mains' }, { entity_slug: 'shop', name: 'Gone', is_active: false }],
    entity_social_posts: [],
    owner_notify_settings: [],
    owner_notifications: [],
} });
inject(path.join(ROOT, 'db.js'), db);
gbp = require(path.join(ROOT, 'lib/googleBusinessApi.js'));
T.oauth_tokens.push(tokenRow('shop', 'accounts/1/locations/11'), tokenRow('unverified', 'accounts/2/locations/22', Date.now() - 1000));
const emails = [];
inject(path.join(ROOT, 'utils/email.js'), { sendEmail: async (m) => { emails.push(m); return { success: true }; } });

const calls = [];
let googleHours = null; // what Google returns on read-back
gbp._setFetch(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : null, auth: init.headers?.Authorization });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (u.startsWith('https://token.google.test')) return json(400, { error: 'invalid_grant' });
    if (u.includes('VoiceOfMerchantState')) return json(200, { hasVoiceOfMerchant: u.includes('locations/11') });
    if (u.includes('readMask=') && (init.method || 'GET') === 'GET') return json(200, { regularHours: { periods: googleHours }, categories: { primaryCategory: { name: 'categories/gcid:x' } } });
    return json(200, {});
});

const push = require(path.join(ROOT, 'lib/googlePush.js'));
const { check, done } = checker();

(async () => {
    try {
        console.log('\n── queueing ──');
        await push.noteTableWrite('shop', 'entity_hours');
        await push.noteTableWrite('shop', 'entity_hours');
        await push.noteTableWrite('shop', 'menu_items');
        await push.noteTableWrite('shop', 'faqs');
        await push.noteTableWrite('nobody', 'entity_hours');
        check('ten edits to the hours are one pending push', T.google_push_queue.filter((r) => r.kind === 'hours').length === 1);
        check('a table no fact maps to queues nothing', !T.google_push_queue.some((r) => r.kind === 'faqs'));
        check('a business without Google queues nothing', !T.google_push_queue.some((r) => r.entity_slug === 'nobody'));
        await push.noteTableWrite('shop', 'hours_exceptions');
        await push.noteTableWrite('shop', 'entity_social_posts', { id: 'p1', body: 'Live music tonight', url: 'https://shop.example.test/events' });

        console.log('\n── draining under the edit limit ──');
        const now = new Date();
        const first = await push.drain({ now });
        check('two edits per minute: two pushed, the rest wait', first.pushed === 2 && T.google_push_queue.filter((r) => r.status === 'pending').length === 2, JSON.stringify(first));
        const hoursCall = calls.find((c) => c.method === 'PATCH' && c.url.includes('updateMask=regularHours'));
        check('hours go to the v1 location with the right mask', hoursCall?.url === 'https://info.google.test/v1/locations/11?updateMask=regularHours' && hoursCall.auth === 'Bearer at-shop');
        const periods = hoursCall.body.regularHours.periods;
        check('days by name or number, closed days left out, overnight carried to the next day',
            periods.length === 2 && periods[1].openDay === 'FRIDAY' && periods[1].closeDay === 'SATURDAY' && periods[1].openTime.hours === 18 && periods[1].closeTime.hours === 2, JSON.stringify(periods));
        const menuCall = calls.find((c) => c.url.endsWith('/foodMenus'));
        check('menus go to v4 with prices in the configured currency, inactive items out',
            menuCall?.url === 'https://v4.google.test/v4/accounts/1/locations/11/foodMenus' && menuCall.body.menus[0].sections[0].items.length === 1
            && menuCall.body.menus[0].sections[0].items[0].attributes.price.currencyCode === 'USD' && menuCall.body.menus[0].sections[0].items[0].attributes.price.nanos === 500000000);
        const again = await push.drain({ now: new Date(now.getTime() + 10e3) });
        check('still inside the minute: nothing more', again.pushed === 0 && again.deferred === 2);
        const later = await push.drain({ now: new Date(now.getTime() + 61e3) });
        check('next minute: the rest go', later.pushed === 2 && !T.google_push_queue.some((r) => r.status === 'pending'), JSON.stringify(later));
        const post = calls.find((c) => c.url.endsWith('/localPosts'));
        check('a post is published with its text and link', post?.body.summary === 'Live music tonight' && post.body.callToAction.url === 'https://shop.example.test/events');
        const special = calls.find((c) => c.url.includes('updateMask=specialHours'));
        check('special hours: a closed day', special?.body.specialHours.specialHourPeriods[0].closed === true && special.body.specialHours.specialHourPeriods[0].startDate.month === 12);

        console.log('\n── Google\'s copy, read back ──');
        const obs = T.fact_observations.filter((o) => o.fact === 'hours');
        check('Google\'s copy is kept as a low-trust observation', obs.length > 0 && obs[0].source === 'google' && obs[0].trust_rank === 20);
        check('it differs (Google returned nothing): the owner is asked to review', obs[0].differs_from_ours === true && T.owner_notifications.some((n) => n.kind === 'review'));
        googleHours = periods;
        await push.noteTableWrite('shop', 'entity_hours');
        await push.drain({ now: new Date(now.getTime() + 200e3) });
        const lastHours = T.fact_observations.filter((o) => o.fact === 'hours').at(-1);
        check('when Google matches, no review', lastHours.differs_from_ours === false && lastHours.review_status === null);

        console.log('\n── verified profiles only; token trouble ──');
        await push.enqueue('unverified', 'hours');
        const u = await push.drain({ now: new Date(now.getTime() + 300e3) });
        const row = T.google_push_queue.find((r) => r.entity_slug === 'unverified');
        check('an expired token Google will not refresh: reconnect needed, nothing pushed', row.status === 'pending' && T.oauth_tokens[1].extra.reconnect_needed === true, JSON.stringify({ u, row }));
        T.oauth_tokens[1].expires_at = new Date(Date.now() + 3600e3).toISOString();
        await push.drain({ now: new Date(now.getTime() + 400e3) });
        check('an unverified profile is never pushed to', T.google_push_queue.find((r) => r.entity_slug === 'unverified').status === 'blocked'
            && !calls.some((c) => c.method === 'PATCH' && c.url.includes('locations/22')));

        console.log('\n── status for the owner ──');
        const st = await push.status('shop');
        check('connected, verified, last push and the limit are visible', st.connected && st.verified === true && st.last_push_at && st.edits_per_minute === 2 && st.queue.length >= 5, JSON.stringify(st).slice(0, 300));
        delete process.env.GOOGLE_EDITS_PER_MINUTE;
        check('without a configured limit, nothing is pushed', (await push.drain()).skipped);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    done('google-push');
})();
