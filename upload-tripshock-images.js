require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

const IMAGES_DIR = '/Users/owner/tripshock_images';
const BUCKET = 'entity-photos';
const SUPABASE_URL = process.env.GCR_SUPABASE_URL;

const matches = require('./tripshock-google-matches.json');

// Build map: place_id -> folders[]
const placeToFolders = {};
for (const m of matches) {
  if (!m.place_id) continue;
  if (!placeToFolders[m.place_id]) placeToFolders[m.place_id] = [];
  placeToFolders[m.place_id].push(m.folder);
}

async function uploadFolder(entitySlug, folder) {
  const folderPath = path.join(IMAGES_DIR, folder);
  if (!fs.existsSync(folderPath)) return [];

  const files = fs.readdirSync(folderPath)
    .filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i))
    .sort();

  const urls = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const storagePath = `${entitySlug}/photo_${String(i + 1).padStart(2, '0')}.jpg`;
    const fileBuffer = fs.readFileSync(path.join(folderPath, file));

    const { error } = await db.storage.from(BUCKET).upload(storagePath, fileBuffer, {
      contentType: 'image/jpeg',
      upsert: true
    });

    if (error) {
      console.error(`  Error uploading ${storagePath}:`, error.message);
      continue;
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
    urls.push(publicUrl);
    process.stdout.write(`  Uploaded ${storagePath}\n`);
  }
  return urls;
}

async function run() {
  // Get all 28 matched entities by place_id
  const placeIds = Object.keys(placeToFolders);
  const { data: entities, error } = await db.from('entity')
    .select('id, slug, name, google_place_id')
    .in('google_place_id', placeIds);

  if (error) return console.error('DB error:', error.message);

  console.log(`Found ${entities.length} entities to update\n`);

  for (const entity of entities) {
    const folders = placeToFolders[entity.google_place_id] || [];
    console.log(`\n[${entity.name}] (${entity.slug})`);
    console.log(`  Folders: ${folders.join(', ')}`);

    let allUrls = [];
    for (const folder of folders) {
      const urls = await uploadFolder(entity.slug, folder);
      allUrls = allUrls.concat(urls);
    }

    if (allUrls.length === 0) {
      console.log('  No images uploaded, skipping DB update');
      continue;
    }

    const heroUrl = allUrls[0];
    const galleryPhotos = allUrls.map((url, i) => ({
      url,
      path: url.split(`/public/${BUCKET}/`)[1],
      order: i + 1
    }));

    const { error: updateError } = await db.from('entity')
      .update({
        hero_image_url: heroUrl,
        gallery_sections: [{ title: 'Photos', photos: galleryPhotos }]
      })
      .eq('id', entity.id);

    if (updateError) {
      console.error(`  DB update error:`, updateError.message);
    } else {
      console.log(`  Updated DB: hero + ${galleryPhotos.length} gallery photos`);
    }
  }

  console.log('\nDone!');
}

run();
