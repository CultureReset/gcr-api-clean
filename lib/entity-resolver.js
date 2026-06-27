// lib/entity-resolver.js
// Resolves the GCR entity UUID for the currently authenticated user.
// Checks entity_owners table first, then falls back to entity.legacy_site_id

const db = require('../db');

async function resolveEntityId(req) {
  try {
    // 1. Try entity_owners: user_id → entity_id
    if (req.userId) {
      const { data: owner } = await db
        .from('entity_owners')
        .select('entity_id')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (owner && owner.entity_id) return owner.entity_id;
    }

    // 2. Try entity.legacy_site_id matching site_id from JWT
    if (req.siteId) {
      const { data: entity } = await db
        .from('entity')
        .select('id')
        .eq('legacy_site_id', req.siteId)
        .maybeSingle();
      if (entity && entity.id) return entity.id;
    }

    return null;
  } catch (e) {
    console.error('resolveEntityId error:', e.message);
    return null;
  }
}

module.exports = { resolveEntityId };
