// lib/find-existing-entity.js
// Shared duplicate-prevention check for every code path that writes new
// `entity` rows (deep-crawl, CSV import, self-serve signup, etc.).
//
// Root cause this fixes: each of those paths used to check "does this exact
// slug/name string already exist?" before creating a row. Any naming
// variation across sources ("The Hangout" vs "The Hangout Gulf Shores" vs
// "The Hangout Restaurant", "Doc's Seafood Shack & Oyster Bar" vs "... and
// Oyster Bar") defeated that check and silently created a duplicate row for
// the same real business.
//
// Only matches on identifiers that are safe to auto-act on — an exact
// google_place_id or an exact phone number. Fuzzy name similarity is NOT
// used to auto-merge here: it's too easy for two different real businesses
// to have superficially similar names ("Action Charter Service" vs "Dottie
// Jo Charter Service"), and a wrong auto-merge silently misattributes data
// to the wrong live business page — worse than the duplicate it would
// "fix". Use possibleFuzzyDuplicate() below to surface a fuzzy near-miss as
// an advisory warning for a human to review, never to auto-merge.

async function findExistingEntity(db, { phone, google_place_id } = {}) {
  if (!phone && !google_place_id) return null;
  const { data, error } = await db.rpc('find_existing_entity', {
    p_phone: phone || null,
    p_google_place_id: google_place_id || null,
  });
  if (error) {
    console.error('findExistingEntity RPC error:', error.message);
    return null;
  }
  return data && data.length ? data[0] : null;
}

async function possibleFuzzyDuplicate(db, name, threshold = 0.45) {
  if (!name) return null;
  const { data, error } = await db.rpc('fuzzy_entity_search', { search_term: name, match_limit: 1 });
  if (error || !data || !data.length) return null;
  return data[0].similarity >= threshold ? data[0] : null;
}

module.exports = { findExistingEntity, possibleFuzzyDuplicate };
