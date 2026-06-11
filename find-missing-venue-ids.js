require('dotenv').config({ path: '.env' });
const KEY = process.env.GOOGLE_PLACES_API_KEY;

const SEARCHES = [
  { name: 'Driftwood Oyster Bar',       query: 'Driftwood Oyster Bar Orange Beach Alabama' },
  { name: "Good Time Charlie's",         query: "Good Time Charlies Foley Alabama" },
  { name: "Hub Stacy's",                 query: "Hub Stacys Innerarity Point Florida" },
  { name: 'American Legion Post 199',    query: 'American Legion Post 199 Fairhope Alabama' },
  { name: 'The Point',                   query: 'The Point Restaurant Innerarity Point Florida' },
  { name: 'Gulf Coast Elks Lodge 2782',  query: 'Gulf Coast Elks Lodge 2782 Foley Alabama' },
  { name: 'Perdido Sports Bar',          query: 'Perdido Sports Bar Perdido Key Florida' },
  { name: 'Tavern of Bon Secour',        query: 'Tavern of Bon Secour Alabama' },
  { name: "Luna's",                      query: "Lunas Eat Drink Orange Beach Alabama" },
  { name: 'Tee Off Portside',            query: 'Tee Off at The Wharf Orange Beach Alabama' },
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
  for (const { name, query } of SEARCHES) {
    console.log('\n' + name);
    const results = await search(query);
    if (!results.length) { console.log('  NO RESULTS'); continue; }
    results.forEach((p, i) => {
      console.log(`  [${i}] ${p.displayName?.text}`);
      console.log(`       ${p.formattedAddress}`);
      console.log(`       place_id: ${p.id}`);
    });
  }
}

run().catch(console.error);
