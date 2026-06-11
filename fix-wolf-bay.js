require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.GCR_SUPABASE_URL.trim(), process.env.GCR_SUPABASE_SERVICE_KEY.trim());
const KEY = process.env.GOOGLE_PLACES_API_KEY;

async function searchPlace(query) {
  const url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' + encodeURIComponent(query) + '&inputtype=textquery&fields=place_id,name,formatted_address&key=' + KEY;
  const r = await fetch(url);
  const d = await r.json();
  return d.candidates || [];
}

async function getDetails(placeId) {
  const fields = 'place_id,name,formatted_address,formatted_phone_number,website,rating,opening_hours,photos,types,address_components';
  const url = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + placeId + '&fields=' + fields + '&key=' + KEY;
  const r = await fetch(url);
  const d = await r.json();
  return d.result;
}

function getPhotoUrl(ref) {
  return 'https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=' + ref + '&key=' + KEY;
}

async function run() {
  const slug = 'wolf-bay-restaurant';
  console.log('Searching: Wolf Bay Restaurant Orange Beach Alabama');
  const candidates = await searchPlace('Wolf Bay Restaurant Orange Beach Alabama');
  if (!candidates.length) { console.log('NO RESULTS'); return; }
  const det = await getDetails(candidates[0].place_id);
  console.log('Found:', det.name, '|', det.formatted_address);

  const comps = det.address_components || [];
  const get = type => (comps.find(c => c.types.includes(type)) || {}).long_name || null;
  const streetNum = get('street_number');
  const route = get('route');
  const address = streetNum && route ? streetNum + ' ' + route : det.formatted_address.split(',')[0];

  const updates = {
    google_place_id: det.place_id,
    address_line_1: address,
    city: get('locality') || get('sublocality'),
    state: get('administrative_area_level_1'),
    zip: get('postal_code'),
    phone: det.formatted_phone_number || null,
    website: det.website || null,
    rating: det.rating || null,
  };

  const photoUrls = (det.photos || []).slice(0, 3).map(p => getPhotoUrl(p.photo_reference));
  if (photoUrls.length) updates.hero_image_url = photoUrls[0];

  const { error } = await db.from('entity').update(updates).eq('slug', slug);
  console.log('Entity updated:', error ? error.message : 'OK');

  for (let i = 0; i < photoUrls.length; i++) {
    await db.from('entity_photos').insert({ entity_slug: slug, url: photoUrls[i], sort_order: i + 1 });
  }
  console.log('Photos inserted:', photoUrls.length);

  const tags = (det.types || [])
    .filter(t => !['establishment', 'point_of_interest', 'food'].includes(t))
    .map(t => ({ tag_name: t.replace(/_/g, ' '), tag_category: 'google_type', entity_slug: slug }));
  for (const tag of tags) await db.from('entity_tags').insert(tag);
  console.log('Tags inserted:', tags.length);

  if (det.opening_hours && det.opening_hours.periods) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const p of det.opening_hours.periods) {
      const day = days[p.open && p.open.day];
      const open_time = p.open && p.open.time ? p.open.time.slice(0, 2) + ':' + p.open.time.slice(2) : null;
      const close_time = p.close && p.close.time ? p.close.time.slice(0, 2) + ':' + p.close.time.slice(2) : null;
      if (day) await db.from('entity_hours').upsert({ entity_slug: slug, day_of_week: day, open_time, close_time }, { onConflict: 'entity_slug,day_of_week' });
    }
    console.log('Hours inserted:', det.opening_hours.periods.length);
  }

  console.log('Done.');
}

run().catch(console.error);
