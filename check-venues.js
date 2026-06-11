require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const db = createClient(process.env.GCR_SUPABASE_URL.trim(), process.env.GCR_SUPABASE_SERVICE_KEY.trim());

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && !inQ) { inQ = true; continue; }
      if (c === '"' && inQ) { inQ = false; continue; }
      if (c === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
      cur += c;
    }
    cols.push(cur);
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = (cols[i] || '').trim());
    return obj;
  });
}

async function run() {
  const rows = parseCSV(fs.readFileSync('/Users/owner/gulf_coast_events_june_11_26_2026.csv', 'utf8'));
  const { data: entities } = await db.from('entity').select('slug, name, city').eq('is_active', true);

  const venues = {};
  rows.forEach(r => {
    if (!r.venue) return;
    const key = r.venue + '|' + (r.city_area || '');
    if (!venues[key]) venues[key] = { venue: r.venue, city: r.city_area, count: 0 };
    venues[key].count++;
  });

  const allVenues = Object.values(venues).sort((a, b) => a.venue.localeCompare(b.venue));

  for (const v of allVenues) {
    const vl = v.venue.toLowerCase().replace(/['']/g, "'");
    const words = vl.split(' ').filter(w => w.length > 3);
    const match = entities.find(e => {
      const el = e.name.toLowerCase();
      const matched = words.filter(w => el.includes(w)).length;
      return matched >= Math.min(2, words.length);
    });
    const status = match
      ? '✅ ' + match.name + ' (' + match.slug + ')'
      : '❌ NO MATCH';
    console.log('[' + v.count + 'x] ' + v.venue + ' / ' + (v.city || '?') + ' => ' + status);
  }
}
run().catch(console.error);
