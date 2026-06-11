// ============================================================
// Availability Search Engine
// Real-time search across all connected booking platforms
// GET /api/availability/search?category=fishing&date_from=2025-08-10&date_to=2025-08-12&party_size=4
// ============================================================

const express  = require('express');
const supabase = require('../db');
const router   = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/availability/search
// Main search endpoint — used by the public search page
// ─────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const {
    category,           // fishing, charter, kayak, snorkel, etc.  (optional)
    date_from,          // YYYY-MM-DD — required
    date_to,            // YYYY-MM-DD — defaults to date_from (single day)
    party_size,         // number — filter by min available capacity
    location,           // future: geo filter
    limit = 50,
  } = req.query;

  if (!date_from) return res.status(400).json({ error: 'date_from required' });

  const endDate = date_to || date_from;

  try {
    // Find all slots that cover every day in the requested range
    // with enough available capacity
    let q = supabase
      .from('availability_slots')
      .select(`
        site_id, item_id, item_name, category,
        slot_date, start_time, end_time,
        available_capacity, capacity,
        price_min, price_max,
        booking_url, provider,
        integration_items!inner(category, image_url, description, min_capacity, max_capacity),
        businesses!inner(name, logo_url, cover_url)
      `)
      .eq('status', 'available')
      .gte('slot_date', date_from)
      .lte('slot_date', endDate)
      .gt('available_capacity', 0)
      .order('slot_date', { ascending: true });

    if (category) q = q.eq('integration_items.category', category);
    if (party_size) q = q.gte('available_capacity', parseInt(party_size));

    const { data: slots, error } = await q.limit(parseInt(limit) * 10);
    if (error) throw error;

    if (!slots?.length) return res.json({ results: [], total: 0 });

    // Group by business + item — only include if available on ALL requested days
    const days      = getDaysInRange(date_from, endDate);
    const dayCount  = days.length;
    const grouped   = {};

    for (const slot of slots) {
      const key = `${slot.site_id}::${slot.item_id}`;
      if (!grouped[key]) {
        grouped[key] = {
          site_id:    slot.site_id,
          item_id:    slot.item_id,
          item_name:  slot.item_name,
          provider:   slot.provider,
          category:   slot.integration_items?.category,
          description:slot.integration_items?.description,
          image_url:  slot.integration_items?.image_url,
          biz_name:   slot.businesses?.name,
          biz_logo:   slot.businesses?.logo_url,
          biz_cover:  slot.businesses?.cover_url,
          min_cap:    slot.integration_items?.min_capacity,
          max_cap:    slot.integration_items?.max_capacity,
          price_min:  null,
          price_max:  null,
          booking_url:slot.booking_url,
          slots:      {},
          days_covered: new Set(),
        };
      }
      const g = grouped[key];
      g.days_covered.add(slot.slot_date);

      // Track lowest available capacity across all days (true availability)
      if (!g.slots[slot.slot_date] || slot.available_capacity < g.slots[slot.slot_date]) {
        g.slots[slot.slot_date] = slot.available_capacity;
      }

      // Price range across all slots
      if (slot.price_min && (g.price_min === null || slot.price_min < g.price_min)) g.price_min = slot.price_min;
      if (slot.price_max && (g.price_max === null || slot.price_max > g.price_max)) g.price_max = slot.price_max;
    }

    // Filter: only return items available on ALL requested days
    const results = Object.values(grouped)
      .filter(g => g.days_covered.size >= dayCount)
      .map(g => {
        const minAvailable = Math.min(...Object.values(g.slots));
        return {
          site_id:      g.site_id,
          item_id:      g.item_id,
          item_name:    g.item_name,
          biz_name:     g.biz_name,
          biz_logo:     g.biz_logo,
          biz_cover:    g.biz_cover,
          category:     g.category,
          description:  g.description,
          image_url:    g.image_url,
          available_spots: minAvailable,
          price_min:    g.price_min,
          price_max:    g.price_max,
          booking_url:  g.booking_url,
          provider:     g.provider,
          days_available: g.days_covered.size,
        };
      })
      .sort((a, b) => {
        // Sort: most available spots first, then price
        if (b.available_spots !== a.available_spots) return b.available_spots - a.available_spots;
        return (a.price_min || 0) - (b.price_min || 0);
      })
      .slice(0, parseInt(limit));

    res.json({ results, total: results.length, days_searched: dayCount, date_from, date_to: endDate });
  } catch (e) {
    console.error('Availability search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/availability/categories
// List available categories (for search UI filters)
// ─────────────────────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  const { data } = await supabase
    .from('integration_items')
    .select('category')
    .eq('active', true)
    .not('category', 'is', null);

  const cats = [...new Set((data || []).map(r => r.category))].filter(Boolean).sort();
  res.json(cats);
});

// ─────────────────────────────────────────────────────────────
// GET /api/availability/calendar/:site_id/:item_id
// Availability calendar for a specific item (for booking detail page)
// ─────────────────────────────────────────────────────────────
router.get('/calendar/:site_id/:item_id', async (req, res) => {
  const { site_id, item_id } = req.params;
  const { month } = req.query; // YYYY-MM

  const startDate = month ? month + '-01' : new Date().toISOString().slice(0, 10);
  const endDate   = month
    ? new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0).toISOString().slice(0, 10)
    : new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('availability_slots')
    .select('slot_date, start_time, end_time, available_capacity, capacity, price_min, status, booking_url')
    .eq('site_id', site_id)
    .eq('item_id', item_id)
    .gte('slot_date', startDate)
    .lte('slot_date', endDate)
    .order('slot_date');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ─────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────
function getDaysInRange(from, to) {
  const days = [];
  const cur  = new Date(from + 'T12:00:00Z');
  const end  = new Date(to   + 'T12:00:00Z');
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

module.exports = router;
