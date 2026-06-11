const https = require('https');

const GOOGLE_API_KEY = 'AIzaSyBP1yLnGq3IQXsqkbqiFhTGVyj1XV5_Rjc';

const missingVenues = [
  'Bushwacker\'s Landing',
  'Cobalt the Restaurant Orange Beach AL',
  'Crabs on the Beach',
  'Doc\'s Seafood and Steaks Orange Beach AL',
  'Flounder\'s Chowder House Pensacola Beach FL',
  'Gulf Coast Elks Lodge 2782',
  'Johnny B\'s Front Porch Lillian AL',
  'Lillian Community Club Lillian AL',
  'McGuire\'s Irish Pub Pensacola FL',
  'Moonshine Saloon',
  'Paddy O\'Leary\'s Irish Pub',
  'Paradise Bar & Grill Gulf Shores AL',
  'Pedro\'s Tacos & Tequila Bar Gulf Breeze FL',
  'Peg Leg Pete\'s Pensacola Beach FL',
  'Red Fish Blue Fish',
  'Shipp\'s Dockside Grill',
  'Southwind Marina & Tiki Bar',
  'The Country Gym',
  'Tipsy Pelican Patio Bar',
  'Windjammers on the Pier Navarre Beach FL',
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  console.log('Searching Google Places for missing venues...\n');
  const results = [];

  for (const venue of missingVenues) {
    const query = encodeURIComponent(venue + ' Gulf Coast Alabama Florida');
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=name,place_id,formatted_address&key=${GOOGLE_API_KEY}`;
    const data = await get(url);
    const candidate = data.candidates?.[0];
    if (candidate) {
      console.log(`FOUND: ${venue}`);
      console.log(`  Name:     ${candidate.name}`);
      console.log(`  Place ID: ${candidate.place_id}`);
      console.log(`  Address:  ${candidate.formatted_address}`);
      results.push({ query: venue, ...candidate });
    } else {
      console.log(`NOT FOUND: ${venue}`);
      results.push({ query: venue, name: null, place_id: null });
    }
    console.log('');
    await new Promise(r => setTimeout(r, 200));
  }

  require('fs').writeFileSync('/tmp/missing_venues_google.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to /tmp/missing_venues_google.json');
}

main();
