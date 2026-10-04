#!/usr/bin/env node
// ============================================================
// LiteLLM spend pulled per company into the usage credits
// ============================================================
//
//     npm run test:litellm-usage

const path = require('path');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    LITELLM_URL: 'https://litellm.test',
    LITELLM_MASTER_KEY: 'sk-master',
    LITELLM_USAGE_PULL: 'true',
    USAGE_CREDITS_PER_USD: '100',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.STRIPE_USAGE_METER_EVENT;

const { T, db } = createMemDb({ tables: {
    company_links: [{ company_id: 'co-1', entity_slug: 'shop' }, { company_id: 'co-2', entity_slug: 'bar' }],
    billing_usage_credits: [],
    billing_usage: [],
    billing_subscription: [],
    billing_plan: [{ key: 'base', is_default: true }],
    billing_plan_limit: [],
} });
inject(path.join(ROOT, 'db.js'), db);

const seen = [];
require(path.join(ROOT, 'lib/litellm.js'))._setFetch(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    const json = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    if (String(url).includes('/key/list')) return json({ keys: [
        { token: 'hash-a', metadata: { company_id: 'co-1' } },
        { token: 'hash-b', metadata: { company_id: 'co-2' } },
        { token: 'hash-x', metadata: {} },
    ], total_pages: 1 });
    if (String(url).includes('/spend/logs')) return json([
        { api_key: 'hash-a', spend: 0.25 },
        { api_key: 'hash-a', spend: 0.5 },
        { api_key: 'hash-b', spend: 1 },
        { api_key: 'hash-x', spend: 9 },
        { api_key: 'unknown', spend: 3, metadata: { user_api_key_metadata: { company_id: 'co-1' } } },
    ]);
    return json({});
});

const { check, done } = checker();
(async () => {
    try {
        const { pullUsage } = require(path.join(ROOT, 'lib/litellmUsage.js'));
        const now = new Date('2026-10-04T15:00:00Z');
        const out = await pullUsage({ now, days: 1 });
        check('asked LiteLLM with the master key', seen.every((s) => s.auth === 'Bearer sk-master') && seen.some((s) => s.url.includes('start_date=2026-10-04&end_date=2026-10-05')));
        const shop = T.billing_usage_credits.find((r) => r.company_id === 'co-1');
        check('spend summed per company by key metadata', shop && shop.spend_usd === 3.75 && shop.credits === 375 && shop.source === 'litellm', JSON.stringify(T.billing_usage_credits));
        check('the second company too; a key with no company is not billed', T.billing_usage_credits.some((r) => r.company_id === 'co-2' && r.spend_usd === 1) && T.billing_usage_credits.length === 2);
        check('the period is the UTC day', shop.period_start === '2026-10-04T00:00:00.000Z' && shop.period_end === '2026-10-05T00:00:00.000Z' && out.days[0].companies === 2);
        await pullUsage({ now, days: 1 });
        check('pulling the same day again replaces it, not adds', T.billing_usage_credits.length === 2);
        process.env.LITELLM_USAGE_PULL = 'false';
        check('off unless switched on', (await pullUsage({ now })).skipped);
    } catch (e) {
        check('no exception', false, e.stack);
    }
    done('litellm-usage');
})();
