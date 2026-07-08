/**
 * Import The Wharf (Orange Beach) directory — 158 businesses — from the
 * enriched JSON pack, as children of the `the-wharf` parent hub entity.
 *
 * Source: data-imports/the-wharf/the_wharf_enriched_data.json
 * (official alwharf.com directory data, one record per business)
 *
 * Safe to re-run: entities are upserted on slug, tags/photos are replaced,
 * menu items are only (re)inserted if the entity has none yet.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.GCR_SUPABASE_URL.trim(), process.env.GCR_SUPABASE_SERVICE_KEY.trim());

const PARENT_SLUG = 'the-wharf';

const DATA_PATH = path.join(__dirname, 'data-imports/the-wharf/the_wharf_enriched_data.json');

// The Wharf's official category taxonomy -> our entity_type/entity_subtype/also_appears_on.
// "Visitor Information" is deliberately excluded — those are informational pages about
// The Wharf itself (parking, hours, pet rules...), not standalone businesses, and belong
// on the parent hub's own content instead of as child entities.
const CATEGORY_MAP = {
  'Restaurants + Eateries':  { entity_type: 'restaurant', also_appears_on: ['restaurants'] },
  'Bars + Tasting Rooms':    { entity_type: 'restaurant', entity_subtype: 'bar', also_appears_on: ['restaurants', 'nightlife'] },
  'Retail':                  { entity_type: 'shopping', also_appears_on: ['shopping'] },
  'Entertainment + Attractions': { entity_type: 'activity', also_appears_on: ['things-to-do'] },
  'Event Venues':            { entity_type: 'activity', entity_subtype: 'event-venue', also_appears_on: ['things-to-do'] },
  'Health + Beauty':         { entity_type: 'service', entity_subtype: 'health-beauty', also_appears_on: ['services'] },
  'Marine Sales':            { entity_type: 'service', entity_subtype: 'marine-sales', also_appears_on: ['services'] },
  'Real Estate + Rentals':   { entity_type: 'service', entity_subtype: 'real-estate', also_appears_on: ['services'] },
  'Businesses + Services':   { entity_type: 'service', also_appears_on: ['services'] },
  'Accommodations':          { entity_type: 'hotel', also_appears_on: ['staying'] },
};

const SKIP_CATEGORY = 'Visitor Information';

// Boilerplate tags every Wharf record carries (its own category name, "the wharf",
// "orange beach") — useful for filtering, worthless as AI-facing signal, so they're
// excluded from known_for/highlights/seo_keywords but kept in the full tag set below.
function distinctiveTags(rec) {
  const boilerplate = new Set([
    'the wharf', 'orange beach',
    ...Object.keys(CATEGORY_MAP).map(c => c.toLowerCase()),
  ]);
  return (rec.tags || []).filter(t => !boilerplate.has(t.toLowerCase()));
}

function typeInfoFor(categories) {
  for (const c of categories || []) {
    if (CATEGORY_MAP[c]) return CATEGORY_MAP[c];
  }
  return { entity_type: 'service', also_appears_on: [] };
}

function parsePriceToFloat(priceStr) {
  if (!priceStr) return null;
  const m = String(priceStr).replace(/,/g, '').match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

async function upsertEntity(rec) {
  const typeInfo = typeInfoFor(rec.categories);
  const dTags = distinctiveTags(rec);

  const entityRecord = {
    slug: rec.slug,
    name: rec.name,
    entity_type: typeInfo.entity_type,
    entity_subtype: typeInfo.entity_subtype || null,
    also_appears_on: typeInfo.also_appears_on,
    parent_entity_slug: PARENT_SLUG,
    description: rec.summary || null,
    editorial_summary: rec.data_status || null,
    hero_image_url: rec.image_url || null,
    website_url: rec.official_directory_url || null,
    city: 'Orange Beach',
    state: 'AL',
    address_line_1: rec.location ? `The Wharf — ${rec.location}` : 'The Wharf',
    is_active: true,
    // AI/RAG-facing fields — short, distinctive signals a concierge chat can quote
    // directly instead of re-summarizing the full description every time. Left null
    // (not []) when the source has no real signal beyond its own category/location —
    // about 80% of Wharf records are that thin; description still carries real content
    // for those via rec.summary, so nothing is lost, we just don't fabricate a highlight.
    known_for: dTags.length ? dTags.slice(0, 3) : null,
    highlights: dTags.length ? dTags : null,
    seo_keywords: rec.tags || [],
  };

  const { data: existing } = await db.from('entity').select('slug').eq('slug', rec.slug);
  let err;
  if (existing && existing.length) {
    ({ error: err } = await db.from('entity').update(entityRecord).eq('slug', rec.slug));
  } else {
    ({ error: err } = await db.from('entity').insert(entityRecord));
  }
  if (err) { console.log(`  entity FAILED: ${err.message}`); return false; }

  // Photos — single cover image from the directory listing
  if (rec.image_url) {
    await db.from('entity_photos').delete().eq('entity_slug', rec.slug);
    await db.from('entity_photos').insert({ entity_slug: rec.slug, url: rec.image_url, sort_order: 0, is_cover: true });
  }

  // Tags — 'amenity' is the standard tag_category used platform-wide (see admin.html's
  // Tags tab), so these join/filter consistently alongside every other entity's tags.
  await db.from('entity_tags').delete().eq('entity_slug', rec.slug).eq('tag_category', 'amenity');
  const tagRows = (rec.tags || []).map(t => ({ entity_slug: rec.slug, tag_name: t, tag_category: 'amenity' }));
  if (tagRows.length) await db.from('entity_tags').insert(tagRows);

  // Price items -> menu_items, only when present and none already exist (don't clobber
  // hand-edited menus on re-run)
  if (rec.price_items && rec.price_items.length) {
    const { data: existingItems } = await db.from('menu_items').select('id').eq('entity_slug', rec.slug).limit(1);
    if (!existingItems || !existingItems.length) {
      const { data: section, error: sectionErr } = await db
        .from('menu_sections')
        .insert({ entity_slug: rec.slug, section_name: 'Menu', sort_order: 0 })
        .select()
        .single();
      if (!sectionErr && section) {
        const itemRows = rec.price_items.map(([name, price, note]) => ({
          entity_slug: rec.slug,
          section_id: section.id,
          item_name: name,
          description: note || null,
          price: parsePriceToFloat(price),
        }));
        await db.from('menu_items').insert(itemRows);
      }
    }
  }

  return true;
}

async function run() {
  const all = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const toImport = all.filter(r => !(r.categories || []).includes(SKIP_CATEGORY));
  const skipped = all.filter(r => (r.categories || []).includes(SKIP_CATEGORY));

  console.log(`Loaded ${all.length} records. Importing ${toImport.length}, skipping ${skipped.length} visitor-info pages:`);
  skipped.forEach(r => console.log(`  - ${r.slug} (${r.name})`));
  console.log('');

  let ok = 0, fail = 0;
  for (const rec of toImport) {
    process.stdout.write(`${rec.slug} ... `);
    const success = await upsertEntity(rec);
    console.log(success ? 'OK' : 'FAILED');
    success ? ok++ : fail++;
  }

  console.log(`\nDone. ${ok} imported/updated, ${fail} failed, ${skipped.length} skipped (visitor info).`);
  console.log(`NOTE: parent entity '${PARENT_SLUG}' is not created by this script — verify it exists`);
  console.log(`(name, address, hero image for The Wharf itself) before these children can render in a hub view.`);
}

run().catch(console.error);
