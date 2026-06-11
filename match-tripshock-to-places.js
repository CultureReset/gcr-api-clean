require('dotenv').config();
const https = require('https');
const fs = require('fs');

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const IMAGES_DIR = '/Users/owner/tripshock_images';

function googleSearch(query) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      input: query,
      inputtype: 'textquery',
      fields: 'place_id,name,formatted_address,geometry',
      locationbias: 'circle:50000@30.2741,-87.7044', // Orange Beach area
      key: GOOGLE_API_KEY
    });
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function folderToQuery(folder) {
  // strip trailing -NUMBER
  const base = folder.replace(/-\d+$/, '');
  // replace dashes with spaces, clean up double spaces
  return base.replace(/--/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

async function run() {
  const folders = fs.readdirSync(IMAGES_DIR)
    .filter(f => f !== '.DS_Store' && f !== 'tripshock-gift-card-1025');

  const results = [];

  for (const folder of folders) {
    const query = folderToQuery(folder) + ' Orange Beach Alabama';
    process.stdout.write(`Searching: ${query}\n`);

    try {
      const res = await googleSearch(query);
      const candidate = res.candidates?.[0] || null;
      results.push({
        folder,
        query,
        place_id: candidate?.place_id || null,
        google_name: candidate?.name || null,
        address: candidate?.formatted_address || null,
      });
    } catch (e) {
      results.push({ folder, query, error: e.message });
    }

    // small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  fs.writeFileSync('/Users/owner/gcr-api-clean/tripshock-google-matches.json', JSON.stringify(results, null, 2));

  console.log('\n=== RESULTS ===');
  results.forEach(r => {
    console.log(`\n[${r.folder}]`);
    console.log(`  Google: ${r.google_name || 'NO MATCH'}`);
    console.log(`  Address: ${r.address || '-'}`);
    console.log(`  Place ID: ${r.place_id || '-'}`);
  });

  console.log(`\nSaved to tripshock-google-matches.json`);
}

run();
