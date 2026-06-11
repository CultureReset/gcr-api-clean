require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

const ACTIVITIES_DIR = '/Users/owner/Desktop/activities';
const IMAGES_DIR = '/Users/owner/tripshock_images';
const BUCKET = 'entity-photos';
const SUPABASE_URL = process.env.GCR_SUPABASE_URL;

const googleMatches = require('./tripshock-google-matches.json');

// activity_id -> place_id
const activityIdToPlaceId = {};
for (const m of googleMatches) {
  if (!m.place_id) continue;
  const match = m.folder.match(/-(\d+)$/);
  if (match) activityIdToPlaceId[match[1]] = m.place_id;
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[&@]/g, 'and')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function findImageFolder(activityId) {
  if (!fs.existsSync(IMAGES_DIR)) return null;
  return fs.readdirSync(IMAGES_DIR).find(f => {
    const match = f.match(/-(\d+)$/);
    return match && match[1] === activityId;
  }) || null;
}

async function uploadImages(slug, imageFolder) {
  const folderPath = path.join(IMAGES_DIR, imageFolder);
  if (!fs.existsSync(folderPath)) return [];

  const files = fs.readdirSync(folderPath)
    .filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i))
    .sort();

  const urls = [];
  for (let i = 0; i < files.length; i++) {
    const storagePath = `${slug}/photo_${String(i + 1).padStart(2, '0')}.jpg`;
    const fileBuffer = fs.readFileSync(path.join(folderPath, files[i]));
    const { error } = await db.storage.from(BUCKET).upload(storagePath, fileBuffer, {
      contentType: 'image/jpeg',
      upsert: true
    });
    if (error) { console.error(`    Upload error ${storagePath}: ${error.message}`); continue; }
    urls.push(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`);
    process.stdout.write(`    Uploaded ${storagePath}\n`);
  }
  return urls;
}

function buildGallery(urls) {
  return [{
    title: 'Photos',
    photos: urls.map((url, i) => ({
      url,
      path: url.split(`/public/${BUCKET}/`)[1],
      order: i + 1
    }))
  }];
}

function buildEntityFields(data, parentEntity) {
  return {
    entity_type: 'activity',
    entity_subtype: data.category || null,
    description: data.description || null,
    subtitle: data.category || null,
    rating: data.rating ? parseFloat(data.rating) : null,
    review_count: data.review_count ? parseInt(data.review_count) : null,
    price_from: data.price_from || null,
    duration_text: data.duration || null,
    highlights: data.highlights?.length ? data.highlights : null,
    address_line_1: data.meeting_point || parentEntity.address_line_1 || null,
    city: parentEntity.city || null,
    state: parentEntity.state || null,
    zip: parentEntity.zip || null,
    latitude: parentEntity.latitude || null,
    longitude: parentEntity.longitude || null,
    is_active: true,
  };
}

async function run() {
  // Load all parent entities by place_id
  const placeIds = [...new Set(Object.values(activityIdToPlaceId))];
  const { data: parentEntities, error: dbErr } = await db.from('entity')
    .select('id, slug, name, google_place_id, address_line_1, city, state, zip, latitude, longitude')
    .in('google_place_id', placeIds);
  if (dbErr) throw new Error(dbErr.message);

  const placeIdToParent = {};
  for (const e of parentEntities) placeIdToParent[e.google_place_id] = e;

  // Load all activity folders and group by place_id
  const activityFolders = fs.readdirSync(ACTIVITIES_DIR)
    .filter(f => fs.existsSync(path.join(ACTIVITIES_DIR, f, 'data.json')));

  const grouped = {}; // placeId -> [{data, folder}]
  const skipped = [];

  for (const folder of activityFolders) {
    const data = JSON.parse(fs.readFileSync(path.join(ACTIVITIES_DIR, folder, 'data.json'), 'utf8'));
    const placeId = activityIdToPlaceId[data.activity_id];
    if (!placeId || !placeIdToParent[placeId]) { skipped.push(data.title); continue; }
    if (!grouped[placeId]) grouped[placeId] = [];
    grouped[placeId].push({ data, folder });
  }

  let updated = 0, created = 0, failed = 0;

  for (const [placeId, listings] of Object.entries(grouped)) {
    const parent = placeIdToParent[placeId];

    if (listings.length === 1) {
      // Only one listing — update the parent entity directly
      const { data, folder } = listings[0];
      console.log(`\n[UPDATE] ${parent.name}`);
      console.log(`  Activity: ${data.title}`);

      const imageFolder = findImageFolder(data.activity_id);
      let heroUrl = null, gallerySections = [];
      if (imageFolder) {
        const urls = await uploadImages(parent.slug, imageFolder);
        if (urls.length > 0) { heroUrl = urls[0]; gallerySections = buildGallery(urls); }
      }

      const fields = buildEntityFields(data, parent);
      const { error } = await db.from('entity').update({
        ...fields,
        hero_image_url: heroUrl || undefined,
        gallery_sections: gallerySections.length ? gallerySections : undefined,
      }).eq('id', parent.id);

      if (error) { console.error(`  FAILED: ${error.message}`); failed++; }
      else { console.log(`  Updated with ${gallerySections[0]?.photos?.length || 0} images`); updated++; }

    } else {
      // Multiple listings — create child entities
      console.log(`\n[CHILDREN] ${parent.name} → ${listings.length} listings`);

      for (const { data } of listings) {
        const slug = generateSlug(data.title);
        console.log(`  [${data.activity_id}] ${slug}`);

        const { data: existing } = await db.from('entity').select('id').eq('slug', slug).maybeSingle();
        if (existing) { console.log(`    SKIP - already exists`); continue; }

        const imageFolder = findImageFolder(data.activity_id);
        let heroUrl = null, gallerySections = [];
        if (imageFolder) {
          const urls = await uploadImages(slug, imageFolder);
          if (urls.length > 0) { heroUrl = urls[0]; gallerySections = buildGallery(urls); }
        }

        const row = {
          slug,
          name: data.title,
          parent_entity_slug: parent.slug,
          ...buildEntityFields(data, parent),
          hero_image_url: heroUrl,
          gallery_sections: gallerySections,
        };

        const { error } = await db.from('entity').insert(row);
        if (error) { console.error(`    FAILED: ${error.message}`); failed++; }
        else { console.log(`    CREATED with ${gallerySections[0]?.photos?.length || 0} images`); created++; }
      }
    }
  }

  if (skipped.length) { console.log('\nSKIPPED (no match):'); skipped.forEach(s => console.log(' -', s)); }
  console.log('\n' + '='.repeat(60));
  console.log(`DONE: ${updated} updated, ${created} created, ${failed} failed`);
  console.log('='.repeat(60));
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
