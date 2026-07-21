// ─── Industry table contract ─────────────────────────────────────────────────
// The DB table `industry_table_contract` is the router: for every
// industry_code it lists which tables that type of business reads/writes
// (industry_code '*' = the universal spine every business gets). Every
// industry also has one direct facts table named `industry_<code>` whose
// row is keyed by entity_slug.
//
// This module is the single place the API resolves that contract, so routes
// and the AI never have to hardcode per-type table lists again.

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { rows: null, at: 0 };

async function loadContract(db) {
  const now = Date.now();
  if (_cache.rows && now - _cache.at < CACHE_TTL_MS) return _cache.rows;
  const { data, error } = await db
    .from('industry_table_contract')
    .select('industry_code,table_name,table_role,required,module_key,read_order,write_allowed,question_intents')
    .eq('status', 'active')
    .order('read_order');
  if (error) {
    // Contract table unreachable — fall back to empty so callers degrade
    // gracefully instead of 500ing the whole entity payload.
    console.error('[industry-contract] load failed:', error.message);
    return _cache.rows || [];
  }
  _cache = { rows: data || [], at: now };
  return _cache.rows;
}

// Full table list for one industry: universal spine ('*') + industry-specific.
async function getContractForIndustry(db, industryCode) {
  const rows = await loadContract(db);
  return rows
    .filter(r => r.industry_code === '*' || r.industry_code === industryCode)
    .sort((a, b) => a.read_order - b.read_order);
}

// The industry facts row (industry_<code> keyed by entity_slug).
// Returns null when the industry has no direct table (e.g. 'other') or the
// business has no row yet — never throws, a missing table must not take
// down the entity payload.
async function getIndustryFacts(db, entity) {
  const code = entity && entity.industry_code;
  if (!code || code === 'other') return null;
  const table = `industry_${code}`;
  try {
    const { data, error } = await db.from(table).select('*').eq('entity_slug', entity.slug).maybeSingle();
    if (error) return null;
    return data || null;
  } catch (e) {
    return null;
  }
}

module.exports = { loadContract, getContractForIndustry, getIndustryFacts };
