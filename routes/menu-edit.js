const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY || process.env.GCR_SUPABASE_KEY
);

// Simple passcode validation
const PASSCODE = '1234'; // TODO: make this configurable per entity

function validatePasscode(req, res, next) {
  const passcode = req.headers['x-link-passcode'];
  if (passcode !== PASSCODE) {
    return res.status(401).json({ error: 'Invalid passcode' });
  }
  next();
}

// GET /update/:id/data - Load menu data for entity
router.get('/:id/data', validatePasscode, async (req, res) => {
  try {
    const { id } = req.params;

    // Get entity
    const { data: entity, error: entErr } = await db
      .from('entity')
      .select('*')
      .eq('id', id)
      .single();

    if (entErr || !entity) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Get LIVE menu sections (menu_sections, drink_sections, happy_hour_sections)
    const [
      { data: menuSecs },
      { data: drinkSecs },
      { data: hhSecs },
      { data: menuItems },
      { data: drinkItems },
      { data: hhItems }
    ] = await Promise.all([
      db.from('menu_sections').select('*').eq('entity_slug', entity.slug),
      db.from('drink_sections').select('*').eq('entity_slug', entity.slug),
      db.from('happy_hour_sections').select('*').eq('entity_slug', entity.slug),
      db.from('menu_items').select('*').eq('entity_slug', entity.slug),
      db.from('drink_items').select('*').eq('entity_slug', entity.slug),
      db.from('happy_hour_items').select('*').eq('entity_slug', entity.slug)
    ]);

    res.json({
      entity,
      sections: {
        menu: (menuSecs || []).map(s => ({ ...s, type: 'menu' })),
        drinks: (drinkSecs || []).map(s => ({ ...s, type: 'drink' })),
        happy_hour: (hhSecs || []).map(s => ({ ...s, type: 'happy_hour' }))
      },
      items: {
        menu: menuItems || [],
        drinks: drinkItems || [],
        happy_hour: hhItems || []
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /update/:id/menu-items - Add menu item to LIVE tables
router.post('/:id/menu-items', validatePasscode, async (req, res) => {
  try {
    const { id } = req.params;
    const { section_id, section_type, name, description, price } = req.body;

    // resolve the entity's slug — every menu table keys on entity_slug
    const { data: ent } = await db.from('entity').select('slug').eq('id', id).single();
    if (!ent) return res.status(404).json({ error: 'Business not found' });

    // Determine which table to write to based on section_type
    const table =
      section_type === 'drink' ? 'drink_items' :
      section_type === 'happy_hour' ? 'happy_hour_items' :
      'menu_items';

    const itemData = {
      entity_slug: ent.slug,
      section_id: section_id,     // uniform link column across all three tables
      item_name: name,
      description: description || null,
      price: price ? parseFloat(price) : null,
    };

    const { data, error } = await db.from(table).insert(itemData).select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /update/:id/menu-items/:itemId - Update menu item in LIVE tables
router.put('/:id/menu-items/:itemId', validatePasscode, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { section_type, name, description, price } = req.body;

    // Determine which table based on section_type
    const table =
      section_type === 'drink' ? 'drink_items' :
      section_type === 'happy_hour' ? 'happy_hour_items' :
      'menu_items';

    const updateData = {
      item_name: name,
      description: description || null,
      price: price ? parseFloat(price) : null,
      price_text: price ? '$' + price : null,
    };

    const { data, error } = await db
      .from(table)
      .update(updateData)
      .eq('id', itemId)
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, item: data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /update/:id/menu-items/:itemId - Delete menu item from LIVE tables
router.delete('/:id/menu-items/:itemId', validatePasscode, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { section_type } = req.body;

    // Determine which table based on section_type
    const table =
      section_type === 'drink' ? 'drink_items' :
      section_type === 'happy_hour' ? 'happy_hour_items' :
      'menu_items';

    const { error } = await db
      .from(table)
      .delete()
      .eq('id', itemId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /update/:id/menu-sections - Add section to LIVE tables
router.post('/:id/menu-sections', validatePasscode, async (req, res) => {
  try {
    const { id } = req.params;
    const { section_name, section_type } = req.body;

    // resolve the entity's slug — every menu table keys on entity_slug
    const { data: ent } = await db.from('entity').select('slug').eq('id', id).single();
    if (!ent) return res.status(404).json({ error: 'Business not found' });

    // Determine which table based on section_type
    const table =
      section_type === 'drink' ? 'drink_sections' :
      section_type === 'happy_hour' ? 'happy_hour_sections' :
      'menu_sections';

    const { data, error } = await db
      .from(table)
      .insert({
        entity_slug: ent.slug,
        section_name: section_name,
        sort_order: 0,
      })
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, section: data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /update/:id/menu-sections/:sectionId - Delete section from LIVE tables
router.delete('/:id/menu-sections/:sectionId', validatePasscode, async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { section_type } = req.body;

    // Determine which table based on section_type
    const itemsTable =
      section_type === 'drink' ? 'drink_items' :
      section_type === 'happy_hour' ? 'happy_hour_items' :
      'menu_items';

    const sectionsTable =
      section_type === 'drink' ? 'drink_sections' :
      section_type === 'happy_hour' ? 'happy_hour_sections' :
      'menu_sections';

    // Delete items first
    const itemIdField =
      section_type === 'drink' ? 'drink_section_id' :
      section_type === 'happy_hour' ? 'hh_section_id' :
      'menu_section_id';

    await db.from(itemsTable).delete().eq(itemIdField, sectionId);

    // Delete section
    const { error } = await db
      .from(sectionsTable)
      .delete()
      .eq('id', sectionId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
