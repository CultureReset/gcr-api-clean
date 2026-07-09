// lib/menu-gcr.js
// Menu helpers used by dashboard.js to read/write the REAL GCR menu tables.
// Live schema (verified against the production DB):
//   menu_sections / drink_sections / happy_hour_sections: id, entity_slug, section_name, sort_order, is_active, ...
//   menu_items / drink_items / happy_hour_items: id, section_id, entity_slug, item_name, description, price, ...
// There is NO entity_id column and NO updated_at column on any of these —
// everything keys by entity_slug, and items attach to sections via section_id.

const db = require('../db');

const TABLES = {
  food: { items: 'menu_items', sections: 'menu_sections', defaultSection: 'Menu' },
  drink: { items: 'drink_items', sections: 'drink_sections', defaultSection: 'Drinks' },
  happy_hour: { items: 'happy_hour_items', sections: 'happy_hour_sections', defaultSection: 'Happy Hour' },
};

// List all menu items for an entity (food + drinks + happy hour), with the
// section name stitched in. Sections are fetched separately instead of via a
// PostgREST embed so this doesn't depend on FK metadata being present.
async function listAllMenuItems(entitySlug) {
  const out = [];
  for (const [type, t] of Object.entries(TABLES)) {
    const [secRes, itemRes] = await Promise.all([
      db.from(t.sections).select('id, section_name').eq('entity_slug', entitySlug),
      db.from(t.items).select('*').eq('entity_slug', entitySlug).order('sort_order'),
    ]);
    const secName = {};
    (secRes.data || []).forEach(s => { secName[s.id] = s.section_name; });
    (itemRes.data || []).forEach(i => {
      out.push({ ...i, item_type: type, category: secName[i.section_id] || null });
    });
  }
  return out;
}

// Find-or-create a section by name for this entity, return its id
async function ensureSection(entitySlug, type, name) {
  const t = TABLES[type];
  const secName = name || t.defaultSection;
  const { data: existing } = await db.from(t.sections)
    .select('id').eq('entity_slug', entitySlug).eq('section_name', secName).maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await db.from(t.sections)
    .insert({ entity_slug: entitySlug, section_name: secName })
    .select('id').single();
  if (error) throw new Error(error.message);
  return created.id;
}

// Create a menu item in the correct table based on item_type
async function createMenuItem(entitySlug, item) {
  const type = TABLES[item.item_type] ? item.item_type : 'food';
  const t = TABLES[type];
  const sectionId = await ensureSection(entitySlug, type, item.category);

  const row = {
    entity_slug: entitySlug,
    section_id: sectionId,
    item_name: item.name || item.item_name,
    description: item.description || null,
    price: item.price != null && item.price !== '' ? item.price : null,
    is_available: item.is_available !== false,
    sort_order: item.sort_order || 0,
  };
  if (type === 'food' && item.tags) row.tags = item.tags;
  if (item.image_url) row.image_url = item.image_url;

  const { data, error } = await db.from(t.items).insert(row).select().single();
  if (error) throw new Error(error.message);
  return { ...data, item_type: type };
}

// Update a menu item — detects which table by looking it up, scoped to the entity
async function updateMenuItem(entitySlug, itemId, updates) {
  const name = updates.name || updates.item_name;
  for (const [type, t] of Object.entries(TABLES)) {
    const { data } = await db.from(t.items)
      .select('id').eq('id', itemId).eq('entity_slug', entitySlug).maybeSingle();
    if (!data) continue;

    const patch = {};
    if (name !== undefined) patch.item_name = name;
    if (updates.price !== undefined) patch.price = updates.price;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.sort_order !== undefined) patch.sort_order = updates.sort_order;
    if (updates.is_available !== undefined) patch.is_available = updates.is_available;
    if (updates.image_url !== undefined) patch.image_url = updates.image_url;
    if (updates.category !== undefined) patch.section_id = await ensureSection(entitySlug, type, updates.category);

    const { data: updated, error } = await db.from(t.items)
      .update(patch).eq('id', itemId).eq('entity_slug', entitySlug).select().single();
    if (error) throw new Error(error.message);
    return { ...updated, item_type: type };
  }
  throw new Error('Menu item not found');
}

// Delete a menu item — tries all three tables, scoped to the entity
async function deleteMenuItem(entitySlug, itemId) {
  for (const t of Object.values(TABLES)) {
    const { data } = await db.from(t.items)
      .select('id').eq('id', itemId).eq('entity_slug', entitySlug).maybeSingle();
    if (data) {
      const { error } = await db.from(t.items)
        .delete().eq('id', itemId).eq('entity_slug', entitySlug);
      if (error) throw new Error(error.message);
      return true;
    }
  }
  throw new Error('Menu item not found');
}

// ── Sections as "categories" for the owner dashboard ──
// GCR's public menu reads menu_sections(entity_slug) → menu_items(section_id);
// the owner dashboard's "categories" concept maps onto menu_sections directly.
async function listCategories(entitySlug) {
  const { data, error } = await db.from('menu_sections')
    .select('id, section_name, sort_order, is_active')
    .eq('entity_slug', entitySlug)
    .order('sort_order');
  if (error) throw new Error(error.message);
  return (data || []).map(s => ({
    id: s.id,
    name: s.section_name,
    sort_order: s.sort_order,
    active: s.is_active !== false,
    menu_subcategories: [], // GCR menus have no subcategory level — items attach to sections
  }));
}

async function createCategory(entitySlug, body) {
  const { data, error } = await db.from('menu_sections')
    .insert({
      entity_slug: entitySlug,
      section_name: body.name || body.section_name || 'Menu',
      sort_order: body.sort_order || 0,
      is_active: body.active !== false,
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateCategory(entitySlug, id, body) {
  const patch = {};
  if (body.name !== undefined || body.section_name !== undefined) patch.section_name = body.name || body.section_name;
  if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
  if (body.active !== undefined) patch.is_active = body.active;
  const { data, error } = await db.from('menu_sections')
    .update(patch).eq('id', id).eq('entity_slug', entitySlug).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteCategory(entitySlug, id) {
  const { error } = await db.from('menu_sections')
    .delete().eq('id', id).eq('entity_slug', entitySlug);
  if (error) throw new Error(error.message);
  return true;
}

module.exports = {
  listAllMenuItems, createMenuItem, updateMenuItem, deleteMenuItem,
  listCategories, createCategory, updateCategory, deleteCategory,
};
