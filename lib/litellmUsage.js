// ============================================================
// LITELLM USAGE — a scheduled pull of AI spend per company (plan §15 step 11)
// ============================================================
//
// Besides the signed POST /api/nextgent/usage Paperclip sends, this pulls
// spend straight from LiteLLM (LITELLM_URL, LITELLM_MASTER_KEY):
//
//   1. /key/list (full objects) maps each key to its company through the
//      key's metadata.company_id, the way Paperclip and lib/litellm.js make
//      them.
//   2. /spend/logs for one UTC day lists each request's spend and key.
//   3. Spend is summed per company and recorded for that day as source
//      'litellm' (billingStripe.recordUsage), which replaces the day's figure
//      when pulled again — so pulling every hour bills each day once.
//
// The pushed figures (source as Paperclip sends it) and these are separate
// rows: a deployment should use one or the other for the same keys
// (LITELLM_USAGE_PULL switches this one on).

const supabase = require('../db');
const litellm = require('./litellm');
const billingStripe = require('./billingStripe');
const { envStr, envBool, envInt } = require('./env');

const SOURCE = 'litellm';
const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const ymd = (d) => d.toISOString().slice(0, 10);

/** key token (hashed, as spend logs show it) and alias -> company id. */
async function keyCompanies(master) {
    const map = new Map();
    const size = envInt('LITELLM_KEY_PAGE_SIZE', 100);
    for (let page = 1; page <= envInt('LITELLM_KEY_MAX_PAGES', 50); page += 1) {
        const data = await litellm.api(`/key/list?return_full_object=true&page=${page}&size=${size}`, { method: 'GET', key: master });
        const keys = data?.keys || data?.data || [];
        for (const k of keys) {
            const company = k?.metadata?.company_id;
            if (!company || typeof k !== 'object') continue;
            for (const id of [k.token, k.key_name, k.key_alias].filter(Boolean)) map.set(String(id), String(company));
        }
        const totalPages = Number(data?.total_pages) || (data?.total_count ? Math.ceil(Number(data.total_count) / size) : null);
        if (!keys.length || keys.length < size || (totalPages && page >= totalPages)) break;
    }
    return map;
}

function companyOfLog(log, keys) {
    const meta = log?.metadata || {};
    return meta.user_api_key_metadata?.company_id
        || meta.company_id
        || keys.get(String(log?.api_key || ''))
        || keys.get(String(meta.user_api_key_alias || ''))
        || null;
}

/**
 * Pull one UTC day (default: today so far, and yesterday to catch late
 * entries). Resolves a summary per day.
 */
async function pullUsage({ now = new Date(), days = 2 } = {}) {
    if (!envBool('LITELLM_USAGE_PULL')) return { skipped: 'LITELLM_USAGE_PULL is off' };
    const master = envStr('LITELLM_MASTER_KEY');
    if (!litellm.configured() || !master) return { skipped: 'LITELLM_URL and LITELLM_MASTER_KEY are required' };

    const keys = await keyCompanies(master);
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
        const start = dayStart(new Date(now.getTime() - i * 86400e3));
        const end = new Date(start.getTime() + 86400e3);
        const logs = await litellm.api(`/spend/logs?start_date=${ymd(start)}&end_date=${ymd(end)}`, { method: 'GET', key: master });
        const rows = Array.isArray(logs) ? logs : (logs?.data || []);
        const spend = new Map();
        for (const log of rows) {
            const company = companyOfLog(log, keys);
            const amount = Number(log?.spend);
            if (!company || !Number.isFinite(amount)) continue;
            spend.set(company, (spend.get(company) || 0) + amount);
        }
        let recorded = 0;
        for (const [companyId, usd] of spend) {
            const { data: link } = await supabase.from('company_links').select('entity_slug').eq('company_id', companyId).maybeSingle();
            if (!link?.entity_slug) continue;
            await billingStripe.recordUsage({
                slug: link.entity_slug, companyId, source: SOURCE,
                periodStart: start.toISOString(), periodEnd: end.toISOString(), spendUsd: Math.round(usd * 1e6) / 1e6, now,
            });
            recorded += 1;
        }
        out.push({ day: ymd(start), logs: rows.length, companies: recorded });
    }
    return { days: out };
}

module.exports = { pullUsage, SOURCE };
