require('dotenv').config({ path: '.env' });
const KEY = process.env.GOOGLE_PLACES_API_KEY;

const SEARCHES = [
  { slug: 'wolf-bay-restaurant',  query: 'Wolf Bay Restaurant Orange Beach Alabama' },
  { slug: 'ginny-lane-bar-grill', query: 'Ginny Lane Bar Grill Gulf Shores Alabama' },
  { slug: 'icehouse-tap-room',    query: 'Icehouse Tap Room Gulf Shores Alabama' },
];

async function search(query) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 3 }),
  });
  const d = await r.json();
  return d.places || [];
}

async function run() {
  for (const { slug, query } of SEARCHES) {
    console.log('\nSlug:', slug);
    console.log('Query:', query);
    const results = await search(query);
    if (!results.length) { console.log('  NO RESULTS'); continue; }
    results.forEach((p, i) => {
      console.log(`  [${i}] ${p.displayName?.text} | ${p.formattedAddress}`);
      console.log(`       place_id: ${p.id}`);
    });
  }
}

run().catch(console.error);
