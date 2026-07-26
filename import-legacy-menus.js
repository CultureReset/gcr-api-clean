#!/usr/bin/env node
/**
 * Import restaurant menus that only exist in the legacy GCR Supabase project.
 * ───────────────────────────────────────────────────────────────────────────
 * The legacy project holds 7,551 menu_items across 176 businesses. Most of
 * those businesses already have a (usually better) menu in the current
 * project, but ~48 restaurants have a full legacy menu and ZERO menu rows
 * here — their profiles render with no menu at all. This copies only those.
 *
 * Safety rules this script follows, deliberately:
 *   • INSERT-ONLY. It never updates or deletes a single existing row.
 *   • It skips any business that already has >=1 menu_items row here, so it
 *     can never overwrite or duplicate a menu you already have.
 *   • It skips ambiguous matches (e.g. "China Dragon" exists 3x in the
 *     current project) rather than guessing which one owns the menu.
 *   • Every inserted row is stamped source='legacy-gcr-import', so the whole
 *     import is identifiable and reversible with one DELETE on that value.
 *   • Dry-run by default. Nothing is written without --commit.
 *
 * Usage:
 *   node import-legacy-menus.js                 # dry run, prints the plan
 *   node import-legacy-menus.js --commit        # actually insert
 *   node import-legacy-menus.js --only=slug,... # limit to specific targets
 *
 * Env:
 *   GCR_SUPABASE_URL / GCR_SUPABASE_SERVICE_KEY        → destination (current)
 *   LEGACY_SUPABASE_URL / LEGACY_SUPABASE_SERVICE_KEY  → source (legacy)
 */

const { createClient } = require('@supabase/supabase-js');

const COMMIT = process.argv.includes('--commit');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').map(s => s.trim()).filter(Boolean);

const IMPORT_TAG = 'legacy-gcr-import';

/**
 * Legacy name → destination slug, for businesses whose names differ too much
 * for normName() to match on its own. Each entry below was verified by hand
 * against the destination DB: the target exists, is the same business/location,
 * and currently has ZERO menu rows.
 *
 * Deliberately NOT mapped (checked and rejected — do not add without a human
 * decision, the item counts show these are already handled or are a different
 * location entirely):
 *   "Bleus Burger" (87)                  → bleus-burger-restaurant-and-bar already has 87 items
 *   "Moe's Original BBQ Orange Beach"(52)→ moes-original-bbq-orange-beach already has 52 items
 *   "Shrimp Basket of Orange Beach" (85) → only Gulf Shores has a menu (90); the two
 *                                          empty "Shrimp Basket" rows are ambiguous
 *   "Tee Off at the Wharf …" (156)       → tee-off-at-the-wharf already has 67 items;
 *                                          merging two partial menus risks duplicates
 */
const MANUAL_MAP = {
  'anchored coffeehouse': 'anchored-coffee-house',
  'milkshake momma': 'milkshake-momma-mama-orange-beach',
};

const destUrl = (process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const destKey = (process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const srcUrl  = (process.env.LEGACY_SUPABASE_URL || '').trim();
const srcKey  = (process.env.LEGACY_SUPABASE_SERVICE_KEY || '').trim();

if (!destUrl || !destKey) {
  console.error('Missing GCR_SUPABASE_URL / GCR_SUPABASE_SERVICE_KEY (destination).');
  process.exit(1);
}
if (!srcUrl || !srcKey) {
  console.error('Missing LEGACY_SUPABASE_URL / LEGACY_SUPABASE_SERVICE_KEY (legacy source).');
  process.exit(1);
}

const dest = createClient(destUrl, destKey);
const src  = createClient(srcUrl, srcKey);

// Names differ only cosmetically between the two projects (curly vs straight
// apostrophes, "&" vs "and", trailing "LLC", punctuation). Normalize hard so a
// real match isn't missed, but keep it deterministic — no fuzzy scoring.
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|the)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Legacy price lived in either price (numeric) or price_text ("Market",
// "$12/$18", "MP"). Keep the numeric when there is one; otherwise preserve the
// original string in metadata and flag market pricing so the UI can render it.
function mapPrice(row) {
  const out = { price: row.price ?? null, has_market_price: false, meta: {} };
  const txt = (row.price_text || '').trim();
  if (out.price == null && txt) {
    out.meta.price_text = txt;
    if (/market|^mp$|m\.p\./i.test(txt)) out.has_market_price = true;
    const num = txt.match(/(\d+(?:\.\d{1,2})?)/);
    if (num) out.price = parseFloat(num[1]);
  }
  return out;
}

function toTextArray(tags) {
  if (!tags) return null;
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
  if (typeof tags === 'string') return [tags];
  if (typeof tags === 'object') return Object.values(tags).map(String).filter(Boolean);
  return null;
}

async function main() {
  console.log(COMMIT ? '=== COMMIT MODE — rows will be inserted ===' : '=== DRY RUN — no writes (pass --commit to apply) ===');

  // ── 1. Legacy businesses that actually have a menu ────────────────────────
  const { data: legacyEntities, error: e1 } = await src
    .from('entity').select('id, slug, name');
  if (e1) throw new Error('legacy entity read failed: ' + e1.message);

  const { data: legacySections, error: e2 } = await src
    .from('menu_sections')
    .select('id, entity_id, section_name, section_description, section_note, sort_order, available_days');
  if (e2) throw new Error('legacy menu_sections read failed: ' + e2.message);

  const legacyItems = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await src
      .from('menu_items')
      .select('id, entity_id, menu_section_id, item_name, description, price, price_text, allergens, is_available, image_url, photo_url, sort_order, tags, modifiers, item_type')
      .range(from, from + 999);
    if (error) throw new Error('legacy menu_items read failed: ' + error.message);
    if (!data?.length) break;
    legacyItems.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`Legacy: ${legacyEntities.length} entities, ${legacySections.length} sections, ${legacyItems.length} items`);

  const itemsByEntity = new Map();
  for (const it of legacyItems) {
    if (!it.entity_id) continue;
    if (!itemsByEntity.has(it.entity_id)) itemsByEntity.set(it.entity_id, []);
    itemsByEntity.get(it.entity_id).push(it);
  }
  const sectionsByEntity = new Map();
  for (const s of legacySections) {
    if (!s.entity_id) continue;
    if (!sectionsByEntity.has(s.entity_id)) sectionsByEntity.set(s.entity_id, []);
    sectionsByEntity.get(s.entity_id).push(s);
  }

  // ── 2. Current-project entities, indexed by normalized name ───────────────
  const { data: destEntities, error: e3 } = await dest
    .from('entity').select('slug, name');
  if (e3) throw new Error('destination entity read failed: ' + e3.message);

  const destByName = new Map();
  for (const e of destEntities) {
    const k = normName(e.name);
    if (!k) continue;
    if (!destByName.has(k)) destByName.set(k, []);
    destByName.get(k).push(e.slug);
  }

  // Which destination slugs already have a menu — those are untouchable.
  const slugsWithMenus = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await dest.from('menu_items').select('entity_slug').range(from, from + 999);
    if (error) throw new Error('destination menu_items read failed: ' + error.message);
    if (!data?.length) break;
    data.forEach(r => slugsWithMenus.add(r.entity_slug));
    if (data.length < 1000) break;
  }
  console.log(`Destination: ${destEntities.length} entities, ${slugsWithMenus.size} already have menus\n`);

  // ── 3. Decide what to import ──────────────────────────────────────────────
  const plan = [], skipped = { no_match: [], ambiguous: [], already_has_menu: [] };

  for (const le of legacyEntities) {
    const items = itemsByEntity.get(le.id) || [];
    if (!items.length) continue;

    const manual = MANUAL_MAP[normName(le.name)];
    const matches = manual ? [manual] : (destByName.get(normName(le.name)) || []);
    if (!matches.length) { skipped.no_match.push(`${le.name} (${items.length} items)`); continue; }
    if (manual && !destEntities.some(e => e.slug === manual)) {
      skipped.no_match.push(`${le.name} → MANUAL_MAP target "${manual}" does not exist`);
      continue;
    }

    const open = matches.filter(s => !slugsWithMenus.has(s));
    if (!open.length) { skipped.already_has_menu.push(`${le.name} → ${matches.join(', ')}`); continue; }
    if (open.length > 1) { skipped.ambiguous.push(`${le.name} → ${open.join(' | ')} (${items.length} items)`); continue; }

    const targetSlug = open[0];
    if (ONLY.length && !ONLY.includes(targetSlug)) continue;

    plan.push({
      legacyId: le.id,
      legacyName: le.name,
      targetSlug,
      sections: sectionsByEntity.get(le.id) || [],
      items,
    });
  }

  // One legacy business per destination slug — if two legacy rows both map to
  // the same empty slug, importing both would interleave two menus into one.
  const seenTarget = new Map();
  const finalPlan = [];
  for (const p of plan.sort((a, b) => b.items.length - a.items.length)) {
    if (seenTarget.has(p.targetSlug)) {
      skipped.ambiguous.push(`${p.legacyName} → ${p.targetSlug} (already claimed by "${seenTarget.get(p.targetSlug)}")`);
      continue;
    }
    seenTarget.set(p.targetSlug, p.legacyName);
    finalPlan.push(p);
  }

  console.log('── PLAN ─────────────────────────────────────────────');
  finalPlan.forEach(p => console.log(
    `  ${String(p.items.length).padStart(4)} items, ${String(p.sections.length).padStart(2)} sections  →  ${p.targetSlug}   (legacy: "${p.legacyName}")`
  ));
  const totalItems = finalPlan.reduce((s, p) => s + p.items.length, 0);
  const totalSections = finalPlan.reduce((s, p) => s + p.sections.length, 0);
  console.log(`\n  ${finalPlan.length} businesses, ${totalSections} sections, ${totalItems} menu items\n`);

  console.log(`Skipped — already have a menu here: ${skipped.already_has_menu.length}`);
  console.log(`Skipped — no name match in current DB: ${skipped.no_match.length}`);
  skipped.no_match.slice(0, 15).forEach(s => console.log(`    · ${s}`));
  if (skipped.no_match.length > 15) console.log(`    … ${skipped.no_match.length - 15} more`);
  console.log(`Skipped — ambiguous, needs a human call: ${skipped.ambiguous.length}`);
  skipped.ambiguous.forEach(s => console.log(`    · ${s}`));

  if (!COMMIT) {
    console.log('\nDry run complete. Re-run with --commit to insert.');
    return;
  }

  // ── 4. Insert ─────────────────────────────────────────────────────────────
  let okBiz = 0, okSections = 0, okItems = 0;
  const failures = [];

  for (const p of finalPlan) {
    try {
      // Re-check immediately before writing: cheap guard against a menu having
      // been added by someone else since this script started reading.
      const { count } = await dest.from('menu_items')
        .select('id', { count: 'exact', head: true }).eq('entity_slug', p.targetSlug);
      if (count > 0) { failures.push(`${p.targetSlug}: gained a menu mid-run, skipped`); continue; }

      const sectionIdMap = new Map();
      if (p.sections.length) {
        const rows = p.sections.map(s => ({
          entity_slug: p.targetSlug,
          section_name: s.section_name,
          section_description: s.section_description || null,
          sort_order: s.sort_order ?? 0,
          available_days: s.available_days || null,
          substitution_notes: s.section_note || null,
          source: IMPORT_TAG,
        }));
        const { data: ins, error } = await dest.from('menu_sections').insert(rows).select('id, section_name, sort_order');
        if (error) throw new Error('sections insert: ' + error.message);
        // Match inserted rows back to legacy ids by (name, sort_order).
        p.sections.forEach(s => {
          const hit = (ins || []).find(r => r.section_name === s.section_name && (r.sort_order ?? 0) === (s.sort_order ?? 0));
          if (hit) sectionIdMap.set(s.id, hit.id);
        });
        okSections += ins?.length || 0;
      }

      const itemRows = p.items.map(it => {
        const { price, has_market_price, meta } = mapPrice(it);
        const metadata = { ...meta, imported_from: 'legacy-gcr', legacy_item_id: it.id };
        if (it.allergens) metadata.allergens = it.allergens;
        if (it.modifiers) metadata.modifiers = it.modifiers;
        if (it.item_type) metadata.item_type = it.item_type;
        return {
          entity_slug: p.targetSlug,
          section_id: sectionIdMap.get(it.menu_section_id) || null,
          item_name: it.item_name,
          description: it.description || null,
          price,
          has_market_price,
          tags: toTextArray(it.tags),
          image_url: it.image_url || it.photo_url || null,
          is_available: it.is_available !== false,
          sort_order: it.sort_order ?? 0,
          metadata,
          source: IMPORT_TAG,
        };
      });

      for (let i = 0; i < itemRows.length; i += 200) {
        const chunk = itemRows.slice(i, i + 200);
        const { error } = await dest.from('menu_items').insert(chunk);
        if (error) throw new Error('items insert: ' + error.message);
        okItems += chunk.length;
      }

      okBiz++;
      console.log(`  ✓ ${p.targetSlug} — ${itemRows.length} items`);
    } catch (err) {
      failures.push(`${p.targetSlug}: ${err.message}`);
      console.error(`  ✗ ${p.targetSlug} — ${err.message}`);
    }
  }

  console.log(`\nDone. ${okBiz} businesses, ${okSections} sections, ${okItems} items inserted.`);
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    failures.forEach(f => console.log(`  · ${f}`));
  }
  console.log(`\nTo undo this import entirely:`);
  console.log(`  delete from menu_items    where source = '${IMPORT_TAG}';`);
  console.log(`  delete from menu_sections where source = '${IMPORT_TAG}';`);
}

main().catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
