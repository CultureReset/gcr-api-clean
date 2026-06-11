const https = require('https');

const API = 'https://gcr-api-clean.vercel.app';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function headImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve({ status: 0, size: 0 });
    try {
      const u = new URL(url.trim());
      const req = https.request({ hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'HEAD' }, res => {
        resolve({ status: res.statusCode, size: parseInt(res.headers['content-length'] || '0') });
      });
      req.on('error', () => resolve({ status: 0, size: 0 }));
      req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, size: 0 }); });
      req.end();
    } catch { resolve({ status: 0, size: 0 }); }
  });
}

function classify(status, size) {
  if (status === 404) return 'MISSING';
  if (status === 0) return 'ERROR';
  if (size < 5000) return 'BLACK/CORRUPT';
  if (size < 50000) return 'LOW_QUALITY';
  return 'OK';
}

async function main() {
  const first = await get(`${API}/api/gcr/entities?limit=1&offset=0`);
  const total = first.total;
  console.log(`Total entities: ${total}`);

  let all = [];
  const pageSize = 200;
  for (let offset = 0; offset < total; offset += pageSize) {
    const page = await get(`${API}/api/gcr/entities?limit=${pageSize}&offset=${offset}`);
    all = all.concat(page.entities);
    process.stdout.write(`\rFetched ${all.length}/${total}`);
  }
  console.log('\n');

  // Check for duplicate names
  const seenNames = {};
  for (const e of all) {
    const key = e.name?.toLowerCase().trim();
    if (key) {
      if (!seenNames[key]) seenNames[key] = [];
      seenNames[key].push(e.slug);
    }
  }

  // Collect all images to check: { slug, name, type, url }
  const toCheck = [];
  for (const e of all) {
    if (e.hero_image_url) {
      toCheck.push({ slug: e.slug, name: e.name, type: 'hero', url: e.hero_image_url.trim() });
    }
    if (e.photos && e.photos.length) {
      e.photos.forEach((p, i) => {
        const url = (p.url || p.image_url || '').trim();
        if (url) toCheck.push({ slug: e.slug, name: e.name, type: `photo_${i+1}`, url });
      });
    }
  }

  console.log(`Checking ${toCheck.length} images across ${all.length} entities...\n`);

  const issues = [];
  const BATCH = 30;
  for (let i = 0; i < toCheck.length; i += BATCH) {
    const batch = toCheck.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(item => headImage(item.url)));
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const r = results[j];
      const label = classify(r.status, r.size);
      if (label !== 'OK') {
        issues.push({ ...item, status: r.status, size: r.size, label });
      }
    }
    process.stdout.write(`\rChecked ${Math.min(i + BATCH, toCheck.length)}/${toCheck.length}`);
  }

  console.log('\n\n=== IMAGE ISSUES ===');
  const byLabel = {};
  issues.forEach(i => { if (!byLabel[i.label]) byLabel[i.label] = []; byLabel[i.label].push(i); });

  for (const [label, items] of Object.entries(byLabel)) {
    console.log(`\n-- ${label} (${items.length}) --`);
    items.forEach(i => console.log(`  [${i.type}] ${i.slug}  (${i.size}b)`));
  }

  console.log('\n=== DUPLICATE NAMES ===');
  const dupes = Object.entries(seenNames).filter(([,slugs]) => slugs.length > 1);
  dupes.forEach(([name, slugs]) => console.log(`  "${name}"\n    ${slugs.join('\n    ')}`));

  console.log(`\n\nSUMMARY: ${issues.length} image issues across ${[...new Set(issues.map(i=>i.slug))].length} entities | ${dupes.length} duplicate names`);
}

main().catch(console.error);
