// Universal upload processor
// Takes a raw business payload, figures out what sections/data it has,
// and writes everything to the DB correctly separated by type.

const { validateEntityType, validateAlsoAppearsOn } = require('./entity-types');
const { resolveSectionsForUpload, getRenderType } = require('./type-config');

async function processBusiness(db, payload) {
  const { entity, tags, hours, photos, events, specials } = payload;

  if (!entity?.slug || !entity?.name) {
    return { success: false, error: 'slug and name required' };
  }

  // Validate entity_type
  const typeCheck = validateEntityType(entity.entity_type);
  if (!typeCheck.valid) return { success: false, error: typeCheck.error };

  if (entity.also_appears_on) {
    const pagesCheck = validateAlsoAppearsOn(entity.also_appears_on);
    if (!pagesCheck.valid) return { success: false, error: pagesCheck.error };
  }

  const slug = entity.slug;
  const errors = [];

  // ── 1. Upsert core entity record ────────────────────────────────────────────
  const { error: entityError } = await db
    .from('entity')
    .upsert({ ...entity, updated_at: new Date().toISOString() }, { onConflict: 'slug' });
  if (entityError) return { success: false, error: entityError.message };

  // ── 2. Hours ─────────────────────────────────────────────────────────────────
  if (hours?.length) {
    await db.from('entity_hours').delete().eq('entity_slug', slug);
    const { error } = await db.from('entity_hours').insert(
      hours.map(h => ({
        entity_slug: slug,
        day_of_week: h.day_of_week,
        opens_at: h.opens_at || null,
        closes_at: h.closes_at || null,
        is_closed: !!h.is_closed,
      }))
    );
    if (error) errors.push(`hours: ${error.message}`);
  }

  // ── 3. Tags ──────────────────────────────────────────────────────────────────
  if (tags?.length) {
    await db.from('entity_tags').delete().eq('entity_slug', slug);
    const { error } = await db.from('entity_tags').insert(
      tags.map(t => ({
        entity_slug: slug,
        tag_name: t.tag_name || t,
        tag_category: t.tag_category || null,
      }))
    );
    if (error) errors.push(`tags: ${error.message}`);
  }

  // ── 4. Photos ────────────────────────────────────────────────────────────────
  if (photos?.length) {
    await db.from('entity_photos').delete().eq('entity_slug', slug);
    const { error } = await db.from('entity_photos').insert(
      photos.map((p, i) => ({
        entity_slug: slug,
        url: p.url,
        image_path: p.image_path || null,
        is_cover: p.is_cover || i === 0,
        sort_order: p.sort_order ?? i,
        caption: p.caption || null,
      }))
    );
    if (error) errors.push(`photos: ${error.message}`);
  }

  // ── 5. Events ────────────────────────────────────────────────────────────────
  if (events?.length) {
    const { error } = await db.from('entity_events').insert(
      events.map(e => ({
        entity_slug: slug,
        entity_name: entity.name,
        event_name: e.event_name,
        description: e.description || null,
        event_date: e.event_date || null,
        start_time: e.start_time || null,
        end_time: e.end_time || null,
        day_of_week: e.day_of_week || null,
        recurring: !!e.recurring,
        artist_name: e.artist_name || null,
        cover_charge: e.cover_charge || null,
        is_active: true,
      }))
    );
    if (error) errors.push(`events: ${error.message}`);
  }

  // ── 6. Specials ──────────────────────────────────────────────────────────────
  if (specials?.length) {
    const { error } = await db.from('entity_specials').insert(
      specials.map(s => ({
        entity_slug: slug,
        entity_name: entity.name,
        special_name: s.special_name,
        description: s.description || null,
        discount_type: s.discount_type || null,
        discount_value: s.discount_value || null,
        discount_text: s.discount_text || null,
        days: s.days || null,
        day_of_week: s.day_of_week || null,
        start_time: s.start_time || null,
        end_time: s.end_time || null,
        is_active: true,
      }))
    );
    if (error) errors.push(`specials: ${error.message}`);
  }

  // ── 7. Menu & Drinks (restaurant/coffee/bakery/dessert) ──────────────────────
  await processMenuSections(db, slug, payload, errors);

  // ── 8. Happy Hour ────────────────────────────────────────────────────────────
  await processHappyHour(db, slug, payload, errors);

  // ── 9. Entity Sections (activity, service, staying, shopping, park + extras) ─
  await processEntitySections(db, slug, entity.entity_type, payload, errors);

  return {
    success: true,
    slug,
    warnings: errors.length ? errors : undefined,
  };
}

// ── Menu food + drinks ────────────────────────────────────────────────────────
async function processMenuSections(db, slug, payload, errors) {
  const menuData = payload.menu_items || payload.menu || payload.food_items;
  const drinkData = payload.drink_items || payload.drinks;

  if (menuData?.length) {
    await db.from('menu_sections').delete().eq('entity_slug', slug);

    const grouped = groupBySection(menuData, 'section_name', 'General');
    for (const [sectionName, items] of Object.entries(grouped)) {
      const { data: sec, error: secErr } = await db
        .from('menu_sections')
        .insert({ entity_slug: slug, section_name: sectionName, sort_order: 0 })
        .select('id').single();
      if (secErr) { errors.push(`menu_section "${sectionName}": ${secErr.message}`); continue; }

      const { error } = await db.from('menu_items').insert(
        items.map(item => ({
          entity_slug: slug,
          section_id: sec.id,
          item_name: item.item_name || item.name,
          description: item.description || null,
          price: item.price != null ? parseFloat(item.price) : null,
          tags: item.tags || null,
          image_url: item.image_url || null,
        }))
      );
      if (error) errors.push(`menu_items "${sectionName}": ${error.message}`);
    }
  }

  if (drinkData?.length) {
    await db.from('drink_sections').delete().eq('entity_slug', slug);

    const grouped = groupBySection(drinkData, 'section_name', 'Drinks');
    for (const [sectionName, items] of Object.entries(grouped)) {
      const { data: sec, error: secErr } = await db
        .from('drink_sections')
        .insert({ entity_slug: slug, section_name: sectionName, sort_order: 0 })
        .select('id').single();
      if (secErr) { errors.push(`drink_section "${sectionName}": ${secErr.message}`); continue; }

      const { error } = await db.from('drink_items').insert(
        items.map(item => ({
          entity_slug: slug,
          section_id: sec.id,
          item_name: item.item_name || item.name,
          description: item.description || null,
          price: item.price != null ? parseFloat(item.price) : null,
          image_url: item.image_url || null,
        }))
      );
      if (error) errors.push(`drink_items "${sectionName}": ${error.message}`);
    }
  }
}

// ── Happy Hour ────────────────────────────────────────────────────────────────
async function processHappyHour(db, slug, payload, errors) {
  const hhData = payload.happy_hour_items || payload.happy_hour;
  if (!hhData?.length) return;

  await db.from('happy_hour_sections').delete().eq('entity_slug', slug);

  const grouped = groupBySection(hhData, 'section_name', 'Happy Hour Specials');
  for (const [sectionName, items] of Object.entries(grouped)) {
    const { data: sec, error: secErr } = await db
      .from('happy_hour_sections')
      .insert({ entity_slug: slug, section_name: sectionName, sort_order: 0 })
      .select('id').single();
    if (secErr) { errors.push(`hh_section "${sectionName}": ${secErr.message}`); continue; }

    const { error } = await db.from('happy_hour_items').insert(
      items.map(item => ({
        entity_slug: slug,
        section_id: sec.id,
        item_name: item.item_name || item.name,
        description: item.description || null,
        price: item.price != null ? parseFloat(item.price) : null,
        original_price: item.original_price != null ? parseFloat(item.original_price) : null,
        image_url: item.image_url || null,
      }))
    );
    if (error) errors.push(`hh_items "${sectionName}": ${error.message}`);
  }
}

// ── Entity Sections (flexible — works for ALL types, auto-creates from payload) ─
async function processEntitySections(db, slug, entityType, payload, errors) {
  const sectionsToCreate = resolveSectionsForUpload(entityType, payload);
  if (!sectionsToCreate.length) return;

  // Clear existing entity_sections for this slug
  await db.from('entity_sections').delete().eq('entity_slug', slug);

  for (let i = 0; i < sectionsToCreate.length; i++) {
    const { section_type, section_name, items } = sectionsToCreate[i];

    const { data: sec, error: secErr } = await db
      .from('entity_sections')
      .insert({
        entity_slug: slug,
        section_type,
        section_name,
        sort_order: i,
      })
      .select('id').single();

    if (secErr) { errors.push(`section "${section_name}": ${secErr.message}`); continue; }

    if (!items?.length) continue;

    const { error } = await db.from('entity_section_items').insert(
      items.map((item, idx) => ({
        section_id: sec.id,
        entity_slug: slug,
        item_name: item.item_name || item.name || item.title,
        description: item.description || null,
        price_from: item.price_from ?? item.price ?? null,
        price_to: item.price_to || null,
        price_label: item.price_label || null,
        duration: item.duration || null,
        icon: item.icon || null,
        metadata: item.metadata || {},
        sort_order: item.sort_order ?? idx,
      }))
    );
    if (error) errors.push(`section_items "${section_name}": ${error.message}`);
  }
}

// Group array items by a field (e.g. section_name), fallback to defaultSection
function groupBySection(items, field, defaultSection) {
  return items.reduce((acc, item) => {
    const key = item[field] || defaultSection;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

// ── Bulk upload: process an array of businesses ───────────────────────────────
async function processBulkUpload(db, businesses) {
  const results = { success: [], failed: [], warnings: [] };

  for (const payload of businesses) {
    const result = await processBusiness(db, payload);
    if (result.success) {
      results.success.push(result.slug);
      if (result.warnings) results.warnings.push({ slug: result.slug, warnings: result.warnings });
    } else {
      results.failed.push({ slug: payload.entity?.slug || 'unknown', error: result.error });
    }
  }

  return results;
}

module.exports = { processBusiness, processBulkUpload };
