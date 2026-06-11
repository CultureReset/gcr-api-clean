/**
 * Import Gulf Coast Events June 11-26 2026
 * - Recurring events (karaoke, bingo, trivia, etc): ONE record, recurring:true, no date
 * - One-time events (named performers): one record per date, recurring:false
 * Run: node import-gulf-coast-events.js --dry-run
 * Run: node import-gulf-coast-events.js
 */
require('dotenv').config({ path: '.env' });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.GCR_SUPABASE_URL.trim(), process.env.GCR_SUPABASE_SERVICE_KEY.trim());
const DRY_RUN = process.argv.includes('--dry-run');

const RECURRING = new Set([
  'Flora-Bama Possible Probables',
  'Flora-Bama Family Friendly Bingo',
  'Trivia',
  'Team Trivia',
  'Bingo',
  'Bingo Night',
  'Karaoke',
  'Karaoke w. Corey',
  'Karaoke/DJ w. Cory',
  'Open Jam',
  'Open Jam (no singing)',
  'Open Jam w. Nigel Dickie & Company',
  'The Defrosters Open Jam',
  'Open Mic',
  'League Pool',
  "Texas Hold 'em",
  'BBRC Running Club',
  'Danny Grady',
  'Smokey Otis Duo',
  'Veronica Jean Otis Trio',
  'Tim Robinson',
  'Tim Roberts & Tommy Irwin',
  'Family Trivia',
]);

function resolveVenue(venue, city, title) {
  if ((title || '').toLowerCase().includes('flora-bama')) return { slug: 'flora-bama-lounge', name: 'Flora-Bama Lounge' };
  if (!venue) return null;
  const v = venue.toLowerCase().replace(/['']/g, "'").trim();
  const c = (city || '').toLowerCase();

  if (v.includes('angry crab'))              return { slug: 'angry-crab-shack',                   name: 'Angry Crab Shack' };
  if (v.includes('lulu'))                    return { slug: 'lulu-s-gulf-shores',                  name: "LuLu's Gulf Shores" };
  if (v.includes('ginny lane'))              return { slug: 'ginny-lane-bar-and-grill',             name: 'Ginny Lane Bar and Grill' };
  if (v.includes('the hangout'))             return { slug: 'the-hangout-gulf-shores',              name: 'The Hangout Gulf Shores' };
  if (v.includes('tacky jack')) {
    if (c.includes('gulf shores'))           return { slug: 'tacky-jacks-gulf-shores',              name: 'Tacky Jacks Gulf Shores' };
    if (c.includes('fort morgan') || c.includes('ft. morgan')) return { slug: 'tacky-jacks-fort-morgan', name: 'Tacky Jacks Fort Morgan' };
    return                                          { slug: 'tacky-jacks-orange-beach',              name: 'Tacky Jacks Orange Beach' };
  }
  if (v.includes('papa rocco') || v.includes('pappa rocco')) return { slug: 'papa-roccos',         name: "Papa Rocco's" };
  if (v.includes('the sloop'))               return { slug: 'the-sloop',                            name: 'The Sloop' };
  if (v.includes('the office'))              return { slug: 'the-office-lounge-foley',               name: 'The Office Lounge' };
  if (v.includes('the undertow'))            return { slug: 'the-undertow-orange-beach',             name: 'The Undertow' };
  if (v.includes('flora-bama'))              return { slug: 'flora-bama-lounge',                    name: 'Flora-Bama Lounge' };
  if (v.includes('big beach brew'))          return { slug: 'big-beach-brewing',                    name: 'Big Beach Brewing Company' };
  if (v.includes('tin top'))                 return { slug: 'the-tin-top-restaurant-oyster-bar',    name: 'The Tin Top Restaurant & Oyster Bar' };
  if (v.includes('driftwood oyster'))        return { slug: 'driftwood-oyster-bar-orange-beach',    name: 'Driftwood Oyster Bar' };
  if (v.includes('south baldwin community')) return { slug: 'south-baldwin-community-theatre',      name: 'South Baldwin Community Theatre' };
  if (v.includes('gt') && v.includes('bay')) return { slug: 'gts-on-the-bay',                      name: "GTs On The Bay" };
  if (v.includes('tiki raw bar'))            return { slug: 'tiki-and-raw-bar-orange-beach',        name: 'Tiki & Raw Bar' };
  if (v.includes('tiki') && c.includes('orange beach')) return { slug: 'tiki-and-raw-bar-orange-beach', name: 'Tiki & Raw Bar' };
  if (v.includes('groovy goat'))             return { slug: 'groovy-goat-HZPcBc',                   name: 'Groovy Goat' };
  if (v.includes('american legion post 44')) return { slug: 'american-legion-post-44',              name: 'American Legion Post 44' };
  if (v.includes('american legion post 99')) return { slug: 'american-legion-post-99-_OwWR0',       name: 'American Legion Post 99' };
  if (v.includes('american legion post 199') || v.includes('american legion post. 199')) return { slug: 'american-legion-post-199-fairhope', name: 'American Legion Post 199' };
  if (v.includes('pirates cove'))            return { slug: 'pirates-cove',                         name: 'Pirates Cove' };
  if (v.includes('sandshaker'))              return { slug: 'sandshaker-at-the-wharf',              name: 'Sandshaker at The Wharf' };
  if (v.includes('gulf coast elks'))         return { slug: 'gulf-coast-elks-lodge-2782',           name: 'Gulf Coast Elks Lodge 2782' };
  if (v.includes('perdido sports bar'))      return { slug: 'perdido-key-sports-bar',               name: 'Perdido Key Sports Bar & Restaurant' };
  if (v.includes('tavern of bon secour'))    return { slug: 'the-tavern-of-bon-secour',             name: 'The Tavern of Bon Secour' };
  if (v.includes('luna'))                    return { slug: 'lunas-eat-and-drink-orange-beach',     name: "Luna's Eat & Drink" };
  if (v.includes('tee off'))                 return { slug: 'tee-off-at-the-wharf',                 name: 'Tee Off at The Wharf' };
  if (v.includes('hub stac'))                return { slug: 'hub-stacey-s-at-the-point',            name: "Hub Stacey's at The Point" };
  if (v.includes('the point') && (c.includes('innerarity') || c.includes('pensacola'))) return { slug: 'the-point-restaurant', name: 'The Point Restaurant' };
  if (v.includes('good time charlie'))       return { slug: 'good-time-charlies-foley',             name: "Good Time Charlie's" };
  if (v.includes('moe'))                     return { slug: 'moes-original-bbq-orange-beach',       name: "Moe's Original BBQ" };
  if (v.includes('legendary marine'))        return { slug: 'legendary-marine-waterway-village',    name: 'Legendary Marine Waterway Village' };

  return null;
}

function parseTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'noon') return '12:00:00';
  if (s.startsWith('see ') || s.startsWith('http') || s.length > 20) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  let hour = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  const pm = s.includes('p.m') || s.includes('pm');
  const am = s.includes('a.m') || s.includes('am');
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  if (!pm && !am && hour >= 1 && hour <= 9) hour += 12;
  return String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00';
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = []; let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"' && !inQ) { inQ = true; continue; }
      if (c === '"' && inQ)  { inQ = false; continue; }
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
  console.log(`Parsed ${rows.length} rows\n`);

  // Load existing to prevent dupes
  const { data: existingDated } = await db.from('entity_events')
    .select('entity_slug, event_name, event_date')
    .gte('event_date', '2026-06-11').lte('event_date', '2026-06-26');
  const { data: existingRecurring } = await db.from('entity_events')
    .select('entity_slug, event_name').eq('recurring', true);

  const datedSet    = new Set((existingDated    || []).map(e => `${e.entity_slug}|${e.event_name}|${e.event_date}`));
  const recurringSet = new Set((existingRecurring || []).map(e => `${e.entity_slug}|${e.event_name}`));

  const toInsert = [];
  const skipped = [];
  const dupes = [];
  const seenRecurring = new Set();

  for (const row of rows) {
    const venue = resolveVenue(row.venue, row.city_area, row.title);
    if (!venue) { skipped.push(`${row.title} @ ${row.venue}`); continue; }

    if (RECURRING.has(row.title)) {
      const key = `${venue.slug}|${row.title}`;
      if (seenRecurring.has(key) || recurringSet.has(key)) { dupes.push(`RECURRING | ${row.title} @ ${venue.name}`); continue; }
      seenRecurring.add(key);
      toInsert.push({
        entity_slug: venue.slug,
        entity_name: venue.name,
        event_name:  row.title,
        event_date:  null,
        start_time:  parseTime(row.start_time_raw),
        day_of_week: new Date(row.date).getDay(),
        description: row.event_type !== 'Live Music' ? row.event_type : null,
        recurring:   true,
        is_active:   true,
      });
    } else {
      const key = `${venue.slug}|${row.title}|${row.date}`;
      if (datedSet.has(key)) { dupes.push(`${row.date} | ${row.title} @ ${venue.name}`); continue; }
      datedSet.add(key);
      toInsert.push({
        entity_slug: venue.slug,
        entity_name: venue.name,
        event_name:  row.title,
        event_date:  row.date,
        start_time:  parseTime(row.start_time_raw),
        description: row.event_type !== 'Live Music' ? row.event_type : null,
        recurring:   false,
        is_active:   true,
      });
    }
  }

  const recurringEvents = toInsert.filter(e => e.recurring);
  const oneTimeEvents   = toInsert.filter(e => !e.recurring);

  console.log('=== SUMMARY ===');
  console.log(`Recurring (1 record each): ${recurringEvents.length}`);
  console.log(`One-time:                  ${oneTimeEvents.length}`);
  console.log(`Total to insert:           ${toInsert.length}`);
  console.log(`Duplicates skipped:        ${dupes.length}`);
  console.log(`No venue match skipped:    ${skipped.length}`);

  if (DRY_RUN) {
    console.log('\n--- RECURRING (insert once, shows every week) ---');
    recurringEvents.forEach(e => console.log(`  day_of_week:${e.day_of_week} ${e.start_time || '?'} | ${e.event_name} @ ${e.entity_name}`));
    console.log('\n--- ONE-TIME ---');
    oneTimeEvents.forEach(e => console.log(`  ${e.event_date} ${e.start_time || '?'} | ${e.event_name} @ ${e.entity_name}`));
    return;
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 50) {
    const { error } = await db.from('entity_events').insert(toInsert.slice(i, i + 50));
    if (error) console.error('Batch error:', error.message);
    else inserted += toInsert.slice(i, i + 50).length;
  }
  console.log(`\nDone. Inserted ${inserted} events.`);
}

run().catch(console.error);
