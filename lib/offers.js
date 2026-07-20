// lib/offers.js — L2 offer model reader.
//
// Reads entity_offer / entity_offer_price / entity_offer_section /
// entity_offer_inclusion, the normalized tables that replaced menu_items,
// drink_items, happy_hour_items, offerings, charter_trips and
// bookable_resources as the source of truth for "things a business sells".
//
// Additive: buildFullEntity() keeps returning all its existing keys.
// This adds offer_sections / offers_unsectioned / price_summary alongside them.

/**
 * Fetch the full offer tree for one entity.
 * @param {object} db - supabase client
 * @param {string} slug - entity_slug
 */
async function fetchOffers(db, slug) {
  const [sectionsRes, offersRes] = await Promise.all([
    db.from('entity_offer_section')
      .select('section_id,name,section_type,description,sort_order')
      .eq('entity_slug', slug)
      .order('sort_order'),
    db.from('entity_offer')
      .select('offer_id,section_id,name,description,offer_type,sort_order,is_available,' +
              'duration_minutes,duration_minutes_max,party_min,party_max,capacity,' +
              'image_url,booking_url,badge')
      .eq('entity_slug', slug)
      .eq('is_available', true)
      .order('sort_order'),
  ]);

  const sections = sectionsRes.data || [];
  const offers = offersRes.data || [];
  if (!offers.length) {
    return { offer_sections: [], offers_unsectioned: [], price_summary: null };
  }

  const offerIds = offers.map(o => o.offer_id);

  // Supabase .in() gets unhappy past a few thousand ids; chunk defensively.
  const chunk = (arr, n) => arr.reduce((acc, x, i) => {
    if (i % n === 0) acc.push([]);
    acc[acc.length - 1].push(x);
    return acc;
  }, []);

  const idChunks = chunk(offerIds, 500);

  const [priceChunks, inclusionChunks] = await Promise.all([
    Promise.all(idChunks.map(ids =>
      db.from('entity_offer_price')
        .select('price_id,offer_id,label,amount,currency,price_unit,party_role,' +
                'age_min,age_max,min_quantity,max_quantity,day_of_week,' +
                'time_start,time_end,is_promotional,price_status,price_note')
        .in('offer_id', ids))),
    Promise.all(idChunks.map(ids =>
      db.from('entity_offer_inclusion')
        .select('inclusion_id,offer_id,kind,item,sort_order')
        .in('offer_id', ids)
        .order('sort_order'))),
  ]);

  const prices = priceChunks.flatMap(r => r.data || []);
  const inclusions = inclusionChunks.flatMap(r => r.data || []);

  const pricesByOffer = new Map();
  for (const p of prices) {
    if (!pricesByOffer.has(p.offer_id)) pricesByOffer.set(p.offer_id, []);
    pricesByOffer.get(p.offer_id).push(p);
  }
  // cheapest first, nulls last — matches how cards want to read it
  for (const list of pricesByOffer.values()) {
    list.sort((a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity));
  }

  const inclusionsByOffer = new Map();
  for (const i of inclusions) {
    if (!inclusionsByOffer.has(i.offer_id)) inclusionsByOffer.set(i.offer_id, []);
    inclusionsByOffer.get(i.offer_id).push(i);
  }

  const hydrate = o => {
    const p = pricesByOffer.get(o.offer_id) || [];
    const inc = inclusionsByOffer.get(o.offer_id) || [];
    const published = p.filter(x => x.price_status === 'published' && x.amount != null);
    return {
      ...o,
      prices: p,
      inclusions: inc,
      included: inc.filter(x => x.kind === 'included').map(x => x.item),
      bring: inc.filter(x => x.kind === 'bring').map(x => x.item),
      // convenience fields so a card can render without walking the price array
      price_from: published.length ? published[0].amount : null,
      price_to: published.length ? published[published.length - 1].amount : null,
      price_unit: published.length ? published[0].price_unit : null,
      is_market_price: p.some(x => x.price_status === 'market_price'),
      has_promotional: p.some(x => x.is_promotional),
    };
  };

  const hydrated = offers.map(hydrate);

  const bySection = new Map();
  const unsectioned = [];
  for (const o of hydrated) {
    if (o.section_id == null) { unsectioned.push(o); continue; }
    if (!bySection.has(o.section_id)) bySection.set(o.section_id, []);
    bySection.get(o.section_id).push(o);
  }

  const offer_sections = sections
    .map(s => ({ ...s, offers: bySection.get(s.section_id) || [] }))
    .filter(s => s.offers.length > 0);

  const allPublished = hydrated
    .flatMap(o => o.prices)
    .filter(p => p.price_status === 'published' && p.amount != null);

  const price_summary = allPublished.length ? {
    min: Math.min(...allPublished.map(p => Number(p.amount))),
    max: Math.max(...allPublished.map(p => Number(p.amount))),
    units: [...new Set(allPublished.map(p => p.price_unit).filter(Boolean))],
  } : null;

  return { offer_sections, offers_unsectioned: unsectioned, price_summary };
}

/**
 * Hours grouped by hours_type: { regular: [...], happy_hour: [...], kitchen: [...] }
 * Replaces the need for a separate entity_secondary_hours query.
 */
async function fetchTypedHours(db, slug) {
  const { data } = await db.from('entity_hours')
    .select('day_of_week,opens_at,closes_at,is_closed,hours_type,note')
    .eq('entity_slug', slug)
    .order('day_of_week');

  const out = {};
  for (const row of (data || [])) {
    const key = row.hours_type || 'regular';
    if (!out[key]) out[key] = [];
    out[key].push(row);
  }
  return out;
}

module.exports = { fetchOffers, fetchTypedHours };
