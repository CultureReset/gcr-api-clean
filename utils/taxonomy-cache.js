const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// In-memory cache of subtype_taxonomy, refreshed periodically rather than
// queried per-request — this table changes rarely (admin edits/backfills),
// so a 5-minute staleness window is an acceptable tradeoff against hitting
// the DB on every /entities/paginated or /page-rails request.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;
let cachedAt = 0;

async function loadTaxonomy() {
  const now = Date.now();
  if (cache && (now - cachedAt) < CACHE_TTL_MS) return cache;

  const { data, error } = await db
    .from('subtype_taxonomy')
    .select('subtype_key, display_name, entity_type, listing_category');

  if (error || !data) return cache || { bySubtype: {}, byCategory: {} };

  const bySubtype = {};
  const byCategory = {};
  data.forEach(row => {
    bySubtype[row.subtype_key] = row.listing_category;
    if (!byCategory[row.listing_category]) byCategory[row.listing_category] = [];
    byCategory[row.listing_category].push(row.subtype_key);
  });

  cache = { bySubtype, byCategory, rows: data };
  cachedAt = now;
  return cache;
}

module.exports = { loadTaxonomy };
