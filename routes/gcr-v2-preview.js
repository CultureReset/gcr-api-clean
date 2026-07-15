// ─────────────────────────────────────────────────────────────────────────
// GCR v2 preview route — proves the API can read the new modular v2 schema.
//
// This is ADDITIVE ONLY. It does not touch /api/gcr/entity/:slug or any
// other live route. Nothing on the live site changes because this file
// exists. It's here so the new v2 tables can be read through real API code
// and verified, before any decision is made to switch the live route over.
//
// Mounted at GET /api/gcr/v2-preview/entity/:slug
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const dbv2 = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY,
  { db: { schema: 'v2' } }
);

router.get('/entity/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: entity, error: entityErr } = await dbv2
      .from('entities')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (entityErr) throw entityErr;
    if (!entity) return res.status(404).json({ error: 'Not found in v2', slug });

    const entityId = entity.id;

    const [
      locations, contacts, links, social, tags,
      hourSets, hourPeriods,
      media, menus, menuSections, menuItems,
      reviews, events, specials,
      contentBlocks, contentItems, faqs, policies,
      people, offerings, offeringPrices, resources,
      resourceRates, resourceFees,
      relationsAsParent, relationsAsChild,
      fishSpecies,
    ] = await Promise.all([
      dbv2.from('entity_locations').select('*').eq('entity_id', entityId),
      dbv2.from('entity_contacts').select('*').eq('entity_id', entityId),
      dbv2.from('entity_links').select('*').eq('entity_id', entityId),
      dbv2.from('entity_social_profiles').select('*').eq('entity_id', entityId),
      dbv2.from('entity_tags').select('tag_name, tag_category').eq('entity_id', entityId),
      dbv2.from('entity_hour_sets').select('*').eq('entity_id', entityId),
      dbv2.from('entity_hour_periods').select('*, entity_hour_sets!inner(entity_id)').eq('entity_hour_sets.entity_id', entityId),
      dbv2.from('entity_media').select('*, media_assets(*)').eq('entity_id', entityId).order('sort_order'),
      dbv2.from('menus').select('*').eq('entity_id', entityId),
      dbv2.from('menu_sections').select('*, menus!inner(entity_id, menu_type)').eq('menus.entity_id', entityId),
      dbv2.from('menu_items').select('*').eq('entity_id', entityId).order('sort_order'),
      dbv2.from('entity_reviews').select('*').eq('entity_id', entityId).order('created_at', { ascending: false }),
      dbv2.from('entity_events').select('*').eq('entity_id', entityId).order('event_date'),
      dbv2.from('entity_specials').select('*').eq('entity_id', entityId),
      dbv2.from('content_blocks').select('*').eq('entity_id', entityId).order('sort_order'),
      dbv2.from('content_block_items').select('*').eq('entity_id', entityId).order('sort_order'),
      dbv2.from('entity_faqs').select('*').eq('entity_id', entityId).order('sort_order'),
      dbv2.from('entity_policies').select('*').eq('entity_id', entityId),
      dbv2.from('entity_people').select('*, people(*)').eq('entity_id', entityId),
      dbv2.from('offerings').select('*').eq('entity_id', entityId),
      dbv2.from('offering_prices').select('*, offerings!inner(entity_id)').eq('offerings.entity_id', entityId),
      dbv2.from('resources').select('*').eq('entity_id', entityId),
      dbv2.from('resource_rates').select('*, resources!inner(entity_id)').eq('resources.entity_id', entityId),
      dbv2.from('resource_fees').select('*, resources!inner(entity_id)').eq('resources.entity_id', entityId),
      dbv2.from('entity_relations').select('*, entities!entity_relations_child_entity_id_fkey(slug, name)').eq('parent_entity_id', entityId),
      dbv2.from('entity_relations').select('*, entities!entity_relations_parent_entity_id_fkey(slug, name)').eq('child_entity_id', entityId),
      dbv2.from('fish_species').select('*').eq('entity_id', entityId),
    ]);

    // nest content_block_items under their block
    const blocks = (contentBlocks.data || []).map(b => ({
      ...b,
      items: (contentItems.data || []).filter(i => i.content_block_id === b.id),
    }));

    // group menu items under their section, sections under their menu
    const sections = (menuSections.data || []).map(s => ({
      ...s,
      items: (menuItems.data || []).filter(i => i.section_id === s.id),
    }));
    const menusOut = (menus.data || []).map(m => ({
      ...m,
      sections: sections.filter(s => s.menu_id === m.id),
    }));

    res.json({
      _source: 'v2 schema (preview route — not the live production path)',
      entity,
      locations: locations.data || [],
      contacts: contacts.data || [],
      links: links.data || [],
      social: social.data || [],
      tags: tags.data || [],
      hours: { sets: hourSets.data || [], periods: hourPeriods.data || [] },
      photos: media.data || [],
      menus: menusOut,
      reviews: reviews.data || [],
      events: events.data || [],
      specials: specials.data || [],
      sections: blocks,
      faqs: faqs.data || [],
      policies: policies.data || [],
      team: people.data || [],
      offerings: (offerings.data || []).map(o => ({
        ...o,
        prices: (offeringPrices.data || []).filter(p => p.offering_id === o.id),
      })),
      resources: (resources.data || []).map(r => ({
        ...r,
        rates: (resourceRates.data || []).filter(x => x.resource_id === r.id),
        fees: (resourceFees.data || []).filter(x => x.resource_id === r.id),
      })),
      children: (relationsAsParent.data || []).map(r => r.entities),
      parent: (relationsAsChild.data || [])[0]?.entities || null,
      fish_species: fishSpecies.data || [],
    });
  } catch (err) {
    console.error('[v2-preview] error:', err);
    res.status(500).json({ error: err.message || 'v2 preview failed' });
  }
});

module.exports = router;
