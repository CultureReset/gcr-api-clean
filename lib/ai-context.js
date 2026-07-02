/**
 * lib/ai-context.js
 * ONE source of truth for every AI surface (widget chat, SMS, voice/ghost-ai).
 *
 * buildAIContext() calls the exact same buildFullEntity() the website uses,
 * then flattens the whole business into model-ready text. Whatever the site
 * displays, the AI knows — automatically. Add data anywhere (sections, menus,
 * FAQs, resources, metadata jsonb, child businesses) and the AI can answer
 * about it instantly, for any subtype, with zero per-type code.
 *
 * Resolve by real business data: { slug } | { name, city }.
 * (legacy_site_id intentionally NOT used — that column does not exist on entity.)
 */

const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const trim = (s, n = 300) => (s ? String(s).slice(0, n) : '');
const money = (v) => (v == null ? null : `$${v}`);

function priceOf(item) {
  if (item.price_from != null) {
    return item.price_to != null ? `$${item.price_from}-$${item.price_to}` : `$${item.price_from}`;
  }
  return item.price_label || (item.price != null ? money(item.price) : null);
}

/** Render ANY metadata object as "Key: value" lines — nothing stored is hidden from the AI. */
function metaLines(metadata, indent = '    ') {
  const out = [];
  for (const [k, v] of Object.entries(metadata || {})) {
    if (k.startsWith('_') || v == null || v === '') continue;
    const label = k.replace(/[_-]+/g, ' ');
    if (Array.isArray(v)) out.push(`${indent}${label}: ${v.map(x => typeof x === 'object' ? JSON.stringify(x) : x).join(', ')}`);
    else if (typeof v === 'object') out.push(`${indent}${label}: ${JSON.stringify(v)}`);
    else out.push(`${indent}${label}: ${v}`);
  }
  return out;
}

/** Resolve to a slug from real business data. slug first, then name (+ optional city). */
async function resolveSlug({ slug, name, city } = {}) {
  if (slug) {
    const { data } = await db.from('entity').select('slug').eq('slug', slug).maybeSingle();
    if (data?.slug) return data.slug;
  }
  if (name) {
    let q = db.from('entity').select('slug,city').ilike('name', name.trim());
    if (city) q = q.ilike('city', city.trim());
    const { data } = await q.limit(1).maybeSingle();
    if (data?.slug) return data.slug;
  }
  return null;
}

/**
 * @returns {Promise<string|null>} model-ready context, or null if no entity found
 */
async function buildAIContext(handle) {
  const slug = await resolveSlug(handle || {});
  if (!slug) return null;

  // Same function the website uses — single source of truth
  const { buildFullEntity } = require('../routes/gcr');
  const e = await buildFullEntity(slug);
  if (!e) return null;

  const L = [];
  const section = (title) => L.push(`\n${title}`);
  const line = (s) => s && L.push(s);

  // ── Identity ────────────────────────────────────────────────────────────────
  L.push(`BUSINESS: ${e.name}${e.subtitle ? ` — ${e.subtitle}` : ''}`);
  line(e.entity_type && `Type: ${e.entity_type}${e.entity_subtype ? ` / ${e.entity_subtype}` : ''}`);
  line(e.address_line_1 && `Address: ${e.address_line_1}, ${e.city || ''} ${e.state || ''}`.trim());
  line(e.phone && `Phone: ${e.phone}`);
  line(e.website_url && `Website: ${e.website_url}`);
  line(e.booking_url && `Booking link: ${e.booking_url}`);
  line(e.reservation_url && `Reservations: ${e.reservation_url}`);
  line(e.order_url && `Online ordering: ${e.order_url}`);
  line(e.price_range && `Price range: ${e.price_range}`);
  line(e.rating && `Rating: ${e.rating}/5 (${e.review_count || 0} reviews)`);

  // ── About ───────────────────────────────────────────────────────────────────
  if (e.description || e.editorial_summary || e.ai_overview) {
    section('ABOUT:');
    line(trim(e.description || e.editorial_summary || e.ai_overview, 600));
  }
  const asArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  if (asArr(e.known_for).length) line(`Known for: ${asArr(e.known_for).join(', ')}`);
  if (asArr(e.highlights).length) line(`Highlights: ${asArr(e.highlights).join(', ')}`);
  if (asArr(e.good_for).length) line(`Good for: ${asArr(e.good_for).join(', ')}`);
  line(e.what_makes_it_different && `What makes it different: ${trim(e.what_makes_it_different)}`);

  // ── Hours ───────────────────────────────────────────────────────────────────
  if (e.hours?.length) {
    section('HOURS:');
    for (const h of e.hours) {
      L.push(`  ${DAYS[h.day_of_week] ?? h.day_of_week}: ${h.is_closed ? 'Closed' : `${h.opens_at}-${h.closes_at}`}`);
    }
  }
  if (e.hh_days || e.hh_start) line(`Happy Hour: ${e.hh_days || ''} ${e.hh_start || ''}-${e.hh_end || ''} ${e.hh_description || ''}`.trim());

  // ── Universal sections (Offerings/Rooms/Services/etc — ALL metadata included) ─
  for (const sec of e.sections || []) {
    section(`${(sec.section_name || 'SECTION').toUpperCase()}:`);
    if (sec.subtitle) L.push(`  (${sec.subtitle})`);
    for (const item of (sec.items || []).slice(0, 40)) {
      const bits = [item.item_name];
      const p = priceOf(item); if (p) bits.push(p);
      if (item.duration) bits.push(item.duration);
      L.push(`  - ${bits.join(' | ')}`);
      if (item.description) L.push(`      ${trim(item.description, 220)}`);
      L.push(...metaLines(item.metadata));
    }
  }

  // ── Menus ───────────────────────────────────────────────────────────────────
  const menuBlock = (title, sections) => {
    if (!sections?.length) return;
    section(title);
    for (const ms of sections) {
      L.push(`  [${ms.section_name || ms.name}${ms.time_range ? ` — ${ms.time_range}` : ''}]`);
      for (const it of (ms.items || []).slice(0, 60)) {
        L.push(`    - ${it.item_name}${it.price != null ? ` ${money(it.price)}` : ''}${it.description ? `: ${trim(it.description, 120)}` : ''}`);
      }
    }
  };
  menuBlock('MENU:', e.menu_sections);
  menuBlock('DRINKS:', e.drink_sections);
  menuBlock('HAPPY HOUR MENU:', e.happy_hour_sections);
  if (e.specials?.length) {
    section('SPECIALS:');
    for (const s of e.specials) L.push(`  - ${s.title || s.special_name}: ${trim(s.description, 150)}`);
  }
  if (e.daily_features?.length) {
    section('DAILY FEATURES:');
    for (const d of e.daily_features) L.push(`  - ${d.label || d.feature_name}: ${d.value || d.description || ''}${d.price != null ? ` ${money(d.price)}` : ''}`);
  }

  // ── Activity data ─────────────────────────────────────────────────────────────
  if (e.pricing?.length) {
    section('PRICING:');
    for (const p of e.pricing) {
      L.push(`  - ${p.item_name || p.name}${p.price != null ? ` ${money(p.price)}` : ''}${p.description ? `: ${trim(p.description, 120)}` : ''}`);
      for (const t of p.tiers || []) L.push(`      tier: ${t.tier_name || t.label || ''} ${money(t.price) || ''}`);
    }
  }
  const listBlock = (title, arr, pick) => {
    if (!arr?.length) return;
    section(title);
    for (const x of arr) L.push(`  - ${pick(x)}`);
  };
  listBlock("WHAT'S INCLUDED:", e.whats_included, x => x.item_name || x.included_item);
  listBlock('WHAT TO BRING:', e.what_to_bring, x => x.item);
  listBlock('REQUIREMENTS:', e.requirements, x => x.requirement_text || x.requirement_name);
  listBlock('MEETING POINTS:', e.meeting_points, x => `${x.name}: ${x.address || ''} ${x.instructions || ''} ${x.parking_note || ''}`.trim());
  listBlock('FISH SPECIES:', e.fish_species, x => `${x.species}${x.season ? ` (season: ${x.season})` : ''}`);

  // ── Bookable resources (units, boats, services — every industry) ──────────────
  if (e.bookable_resources?.length) {
    section('BOOKABLE OPTIONS:');
    for (const r of e.bookable_resources.slice(0, 30)) {
      const bits = [r.name];
      if (r.nightly_price != null) bits.push(`${money(r.nightly_price)}/night`);
      if (r.capacity) bits.push(`holds ${r.capacity}`);
      if (r.bedrooms) bits.push(`${r.bedrooms}BR/${r.bathrooms || '?'}BA`);
      L.push(`  - ${bits.join(' | ')}`);
      if (r.description) L.push(`      ${trim(r.description, 200)}`);
      if (r.min_nights) L.push(`      min nights: ${r.min_nights}; check-in ${r.check_in_time || '?'} / check-out ${r.check_out_time || '?'}`);
      if (r.cleaning_fee != null || r.service_fee != null) L.push(`      fees: cleaning ${money(r.cleaning_fee) || '—'}, service ${money(r.service_fee) || '—'}`);
      if (Array.isArray(r.amenities) && r.amenities.length) L.push(`      amenities: ${r.amenities.join(', ')}`);
      if (r.booking_url) L.push(`      book at: ${r.booking_url}`);
    }
  }

  // ── Parent-child hub (what's under this location) ─────────────────────────────
  if (e.children?.length) {
    section('WHAT ELSE IS AT THIS LOCATION:');
    for (const c of e.children.slice(0, 40)) {
      L.push(`  - ${c.name} (${c.entity_subtype || c.entity_type})${c.price_from != null ? ` — from ${money(c.price_from)}${c.price_unit ? '/' + c.price_unit : ''}` : ''}`);
    }
  }

  // ── FAQs / policies ───────────────────────────────────────────────────────────
  if (e.faqs?.length) {
    section('FAQS:');
    for (const f of e.faqs.slice(0, 40)) L.push(`  Q: ${f.question}\n  A: ${trim(f.answer, 350)}`);
  }
  if (e.policies?.length) {
    section('POLICIES:');
    for (const p of e.policies) L.push(`  - ${p.title || p.policy_type}: ${trim(p.body || p.content, 300)}`);
  }

  // ── Events / team / reviews / extras ──────────────────────────────────────────
  if (e.events?.length) {
    section('UPCOMING EVENTS:');
    for (const ev of e.events.slice(0, 15)) {
      L.push(`  - ${ev.event_name}${ev.event_date ? ` on ${ev.event_date}` : ev.day_of_week ? ` every ${ev.day_of_week}` : ''}${ev.start_time ? ` at ${ev.start_time}` : ''}${ev.artist_name ? ` — ${ev.artist_name}` : ''}${ev.cover_charge ? ` (cover: ${ev.cover_charge})` : ''}`);
    }
  }
  if (e.team?.length) {
    section('TEAM:');
    for (const t of e.team) L.push(`  - ${t.name}${t.title ? `, ${t.title}` : ''}${t.specialty ? ` (${t.specialty})` : ''}`);
  }
  if (e.reviews?.length) {
    section('RECENT REVIEWS:');
    for (const r of e.reviews.slice(0, 4)) L.push(`  - ${r.rating}/5 "${trim(r.body, 160)}" — ${r.reviewer_name || 'Guest'}`);
  }
  if (e.about_bullets?.length) listBlock('QUICK FACTS:', e.about_bullets, x => x.text);
  if (e.perfect_for?.length) line(`Perfect for: ${e.perfect_for.map(x => x.label).join(', ')}`);
  if (e.announcements?.length) listBlock('ANNOUNCEMENTS:', e.announcements, x => x.message);
  if (e.order_links?.length) listBlock('ORDER LINKS:', e.order_links, x => `${x.label}: ${x.url}`);
  if (e.stay_links?.length) listBlock('BOOKING PLATFORMS:', e.stay_links, x => `${x.platform || x.label}: ${x.url}`);
  if (e.loyalty_program) line(`Loyalty: text "${e.loyalty_program.keyword}" to ${e.loyalty_program.sms_number} to join ${e.loyalty_program.program_name}`);
  if (e.tags?.length) line(`Tags: ${[...new Set(e.tags.map(t => t.tag_name))].slice(0, 30).join(', ')}`);

  // Hard cap for token safety
  const out = L.filter(Boolean).join('\n');
  return out.length > 28000 ? out.slice(0, 28000) + '\n[...context truncated]' : out;
}

module.exports = { buildAIContext, resolveSlug };
