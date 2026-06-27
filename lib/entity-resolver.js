// lib/entity-resolver.js
// Resolves the GCR entity for the currently authenticated user.
// Returns { id, slug } — both are needed throughout dashboard.js
// Check order:
//   1. entity_owners table (user_id → entity_id + entity_slug)
//   2. users.entity_id / users.entity_slug (quick lookup columns)
//   3. entity.legacy_site_id matching site_id from JWT

const db = require('../db');

async function resolveEntityId(req) {
  const result = await resolveEntity(req);
  return result ? result.id : null;
}

async function resolveEntity(req) {
  try {
    // 1. Try entity_owners table
    if (req.userId) {
      const { data: owner } = await db
        .from('entity_owners')
        .select('entity_id, entity_slug')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (owner && owner.entity_id) {
        return { id: owner.entity_id, slug: owner.entity_slug };
      }
    }

    // 2. Try users.entity_id / users.entity_slug
    if (req.userId) {
      const { data: user } = await db
        .from('users')
        .select('entity_id, entity_slug')
        .eq('id', req.userId)
        .maybeSingle();
      if (user && user.entity_id) {
        return { id: user.entity_id, slug: user.entity_slug };
      }
      if (user && user.entity_slug) {
        // Have slug but not id — look up id
        const { data: entity } = await db
          .from('entity')
          .select('id, slug')
          .eq('slug', user.entity_slug)
          .maybeSingle();
        if (entity) return { id: entity.id, slug: entity.slug };
      }
    }

    // 3. Try entity.legacy_site_id matching site_id from JWT
    if (req.siteId) {
      const { data: entity } = await db
        .from('entity')
        .select('id, slug')
        .eq('legacy_site_id', req.siteId)
        .maybeSingle();
      if (entity && entity.id) return { id: entity.id, slug: entity.slug };
    }

    return null;
  } catch (e) {
    console.error('resolveEntity error:', e.message);
    return null;
  }
}

module.exports = { resolveEntityId, resolveEntity };
