// lib/menu-gcr.js
// Menu helpers used by dashboard.js to read/write GCR menu tables by entity UUID

const db = require('../db');

// List all menu items for an entity (food + drinks + happy hour)
async function listAllMenuItems(entityId) {
  const [foodRes, drinkRes, hhRes] = await Promise.all([
    db.from('menu_items').select('*, menu_sections(section_name)').eq('entity_id', entityId).order('sort_order'),
    db.from('drink_items').select('*, drink_sections(section_name)').eq('entity_id', entityId).order('sort_order'),
    db.from('happy_hour_items').select('*, happy_hour_sections(section_name)').eq('entity_id', entityId).order('sort_order'),
  ]);

  const food = (foodRes.data || []).map(i => ({ ...i, item_type: 'food', category: i.menu_sections?.section_name || null }));
  const drinks = (drinkRes.data || []).map(i => ({ ...i, item_type: 'drink', category: i.drink_sections?.section_name || null }));
  const hh = (hhRes.data || []).map(i => ({ ...i, item_type: 'happy_hour', category: i.happy_hour_sections?.section_name || null }));

  return [...food, ...drinks, ...hh];
}

// Create a menu item in the correct table based on item_type
async function createMenuItem(entityId, item) {
  const type = item.item_type || 'food';

  if (type === 'drink') {
    // Ensure drink section exists
    const secName = item.category || 'Drinks';
    let { data: sec } = await db.from('drink_sections').select('id').eq('entity_id', entityId).eq('section_name', secName).maybeSingle();
    if (!sec) {
      const ins = await db.from('drink_sections').insert({ entity_id: entityId, section_name: secName, entity_slug: item.entity_slug || null }).select('id').single();
      sec = ins.data;
    }
    const { data, error } = await db.from('drink_items').insert({
      entity_id: entityId,
      entity_slug: item.entity_slug || null,
      drink_section_id: sec?.id || null,
      item_name: item.name || item.item_name,
      description: item.description || null,
      price: item.price || null,
      tags: item.tags || [],
      is_available: true,
      sort_order: item.sort_order || 0,
    }).select().single();
    if (error) throw new Error(error.message);
    return { ...data, item_type: 'drink' };
  }

  if (type === 'happy_hour') {
    const secName = item.category || 'Happy Hour';
    let { data: sec } = await db.from('happy_hour_sections').select('id').eq('entity_id', entityId).maybeSingle();
    if (!sec) {
      const ins = await db.from('happy_hour_sections').insert({ entity_id: entityId, section_name: secName, entity_slug: item.entity_slug || null }).select('id').single();
      sec = ins.data;
    }
    const { data, error } = await db.from('happy_hour_items').insert({
      entity_id: entityId,
      entity_slug: item.entity_slug || null,
      hh_section_id: sec?.id || null,
      item_name: item.name || item.item_name,
      description: item.description || null,
      hh_price: item.price || null,
      is_available: true,
      sort_order: item.sort_order || 0,
    }).select().single();
    if (error) throw new Error(error.message);
    return { ...data, item_type: 'happy_hour' };
  }

  // Default: food
  const secName = item.category || 'Menu';
  let { data: sec } = await db.from('menu_sections').select('id').eq('entity_id', entityId).eq('section_name', secName).maybeSingle();
  if (!sec) {
    const ins = await db.from('menu_sections').insert({ entity_id: entityId, section_name: secName, entity_slug: item.entity_slug || null }).select('id').single();
    sec = ins.data;
  }
  const { data, error } = await db.from('menu_items').insert({
    entity_id: entityId,
    entity_slug: item.entity_slug || null,
    menu_section_id: sec?.id || null,
    item_name: item.name || item.item_name,
    description: item.description || null,
    price: item.price || null,
    tags: item.tags || [],
    is_available: true,
    sort_order: item.sort_order || 0,
  }).select().single();
  if (error) throw new Error(error.message);
  return { ...data, item_type: 'food' };
}

// Update a menu item — detects which table by looking it up
async function updateMenuItem(entityId, itemId, updates) {
  const name = updates.name || updates.item_name;
  const price = updates.price;
  const desc = updates.description;

  // Try each table
  for (const [table, priceCol] of [['menu_items', 'price'], ['drink_items', 'price'], ['happy_hour_items', 'hh_price']]) {
    const { data } = await db.from(table).select('id').eq('id', itemId).eq('entity_id', entityId).maybeSingle();
    if (data) {
      const patch = { updated_at: new Date().toISOString() };
      if (name !== undefined) patch.item_name = name;
      if (price !== undefined) patch[priceCol] = price;
      if (desc !== undefined) patch.description = desc;
      if (updates.sort_order !== undefined) patch.sort_order = updates.sort_order;
      if (updates.is_available !== undefined) patch.is_available = updates.is_available;
      const { data: updated, error } = await db.from(table).update(patch).eq('id', itemId).eq('entity_id', entityId).select().single();
      if (error) throw new Error(error.message);
      return updated;
    }
  }
  throw new Error('Menu item not found');
}

// Delete a menu item — tries all three tables
async function deleteMenuItem(entityId, itemId) {
  for (const table of ['menu_items', 'drink_items', 'happy_hour_items']) {
    const { data } = await db.from(table).select('id').eq('id', itemId).eq('entity_id', entityId).maybeSingle();
    if (data) {
      const { error } = await db.from(table).delete().eq('id', itemId).eq('entity_id', entityId);
      if (error) throw new Error(error.message);
      return true;
    }
  }
  throw new Error('Menu item not found');
}

module.exports = { listAllMenuItems, createMenuItem, updateMenuItem, deleteMenuItem };
