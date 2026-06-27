const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/links/menu?slug=...
// Gateway for all standalone QR pages — returns full entity data
// Used by: /menu/:slug, /artist/:slug/live, /loyalty/:slug, /links/:slug
router.get('/menu', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    // Use buildFullEntity directly from gcr.js — but we call DB directly here
    const { data: entity, error } = await db
      .from('entity')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (error || !entity) return res.status(404).json({ error: 'Not found' });

    // Pull all the data needed for a standalone QR menu page in parallel
    const [
      hours, photos, menuSections, drinkSections, hhSections,
      specials, events, pricing, faqs, loyaltyProgram,
      announcements, orderLinks, dailyFeatures, artist
    ] = await Promise.all([
      db.from('entity_hours').select('*').eq('entity_slug', slug).order('day_of_week'),
      db.from('entity_photos').select('*').eq('entity_slug', slug).order('sort_order').limit(20),
      db.from('menu_sections').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('drink_sections').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('happy_hour_sections').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('entity_specials').select('*').eq('entity_slug', slug).eq('is_active', true),
      db.from('entity_events').select('*, artist:artist_id(id, slug, name, genre, image_url, entity_slug)').eq('entity_slug', slug).eq('is_active', true).order('event_date').limit(10),
      db.from('pricing_items').select('*').eq('entity_slug', slug).order('sort_order'),
      db.from('faqs').select('*').eq('entity_slug', slug).order('sort_order').limit(20),
      db.from('loyalty_programs').select('program_name, keyword, sms_number').eq('entity_slug', slug).eq('active', true).maybeSingle(),
      db.from('announcements').select('*').eq('entity_slug', slug).eq('active', true),
      db.from('order_links').select('*').eq('entity_slug', slug),
      db.from('entity_daily_features').select('*').eq('entity_slug', slug).eq('is_active', true).order('sort_order'),
      db.from('artist_profiles').select('id, artist_name, slug, photo_url, cashtag, venmo, cashapp_handle, venmo_handle, request_enabled, shoutout_enabled, default_min_request_amount').eq('entity_slug', slug).maybeSingle(),
    ]);

    // Fetch menu items
    const menuIds = (menuSections.data || []).map(s => s.id);
    const drinkIds = (drinkSections.data || []).map(s => s.id);
    const hhIds = (hhSections.data || []).map(s => s.id);

    const [menuItems, drinkItems, hhItems] = await Promise.all([
      menuIds.length ? db.from('menu_items').select('*').in('section_id', menuIds).order('sort_order') : { data: [] },
      drinkIds.length ? db.from('drink_items').select('*').in('section_id', drinkIds).order('sort_order') : { data: [] },
      hhIds.length ? db.from('happy_hour_items').select('*').in('section_id', hhIds).order('sort_order') : { data: [] },
    ]);

    const nest = (secs, items) => (secs || []).map(s => ({
      ...s, items: (items || []).filter(i => i.section_id === s.id)
    }));

    res.json({
      ...entity,
      hours: hours.data || [],
      photos: photos.data || [],
      menu_sections: nest(menuSections.data, menuItems.data),
      drink_sections: nest(drinkSections.data, drinkItems.data),
      happy_hour_sections: nest(hhSections.data, hhItems.data),
      specials: specials.data || [],
      events: events.data || [],
      pricing: pricing.data || [],
      faqs: faqs.data || [],
      loyalty_program: (loyaltyProgram && loyaltyProgram.data) || null,
      announcements: announcements.data || [],
      order_links: orderLinks.data || [],
      daily_features: dailyFeatures.data || [],
      artist: (artist && artist.data) || null,
    });
  } catch (err) {
    console.error('Links menu error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
