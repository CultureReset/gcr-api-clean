// Assembling one artist from the tables that actually hold an artist.
//
// The artist slug is the only key that spans everything. Two id spaces exist
// and they do not agree:
//
//   entity_events.artist_id  ->  artists.id            (609/609 rows)
//   songs.artist_id          ->  artist_profiles.id    (15/15 rows)
//   artists.id <> artist_profiles.id                   on all 390 artists
//
// So nothing here joins on an id it was handed. Everything is resolved from
// `artists.slug` = `artist_profiles.slug`, which match on all 390 rows, and the
// id is looked up per table from that slug.
//
// Venues are a different namespace: a show's venue is `entity.slug`. Artists
// are not in `entity` and never were.

const db = require('../db');

/** Fields the artist owns and edits. Everything else here is derived. */
const EDITABLE = [
  'artist_name', 'bio', 'photo_url', 'genre', 'hometown', 'phone',
  'booking_url', 'instagram_url', 'spotify_url', 'youtube_url', 'tip_url',
  'cashtag', 'venmo', 'cashapp_handle', 'venmo_handle', 'members',
  'request_enabled', 'shoutout_enabled', 'default_min_request_amount',
  'is_active',
];

/** First non-empty value. '' and null both count as absent. */
function pick(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * How much of a venue's record is filled in. Used only to break a tie when the
 * same show is attached to two duplicate venue rows — `the-hangout` and
 * `the-hangout-restaurant` both carry the same Webb Dalton date. The fuller
 * record wins so the fan sees one show, not two.
 */
function venueScore(e) {
  if (!e) return -1;
  let n = 0;
  if (e.hero_image_url) n += 2;
  if (e.rating) n += 1;
  if (e.review_count) n += 1;
  if (e.city) n += 1;
  if (e.is_active) n += 1;
  return n;
}

/** One show, shaped for a page rather than for a table. */
function toShow(ev, venue) {
  return {
    id: ev.id,
    event_name: ev.event_name,
    description: ev.description || null,
    date: ev.event_date,
    day_of_week: ev.day_of_week || null,
    start_time: ev.start_time || null,
    end_time: ev.end_time || null,
    recurring: !!ev.recurring,
    cover_charge: ev.cover_charge || null,
    image_url: ev.image_url || null,
    venue_slug: ev.entity_slug,
    // entity.name is the live venue name. entity_events.entity_name is a copy
    // that has drifted on 408 of 1,222 rows, so it is only the fallback.
    venue_name: pick(venue && venue.name, ev.entity_name),
    venue_city: (venue && venue.city) || null,
  };
}

/**
 * Collapse shows that are the same performance recorded against duplicate
 * venue rows. Same artist, same date, same start time — keep the one whose
 * venue record is fuller.
 */
function dedupeShows(shows, venueById) {
  const best = new Map();
  for (const s of shows) {
    const key = `${s.date || ''}|${s.start_time || ''}|${(s.event_name || '').toLowerCase().trim()}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, s); continue; }
    if (venueScore(venueById[s.venue_slug]) > venueScore(venueById[prev.venue_slug])) {
      best.set(key, s);
    }
  }
  return [...best.values()].sort((a, b) => {
    const d = String(a.date || '').localeCompare(String(b.date || ''));
    return d !== 0 ? d : String(a.start_time || '').localeCompare(String(b.start_time || ''));
  });
}

/**
 * Every show for a set of artist slugs, venue included.
 *
 * `entity_events` points at `artists.id`, so the slugs are resolved through
 * `artists` first. Returns { [artistSlug]: Show[] }.
 */
async function showsBySlug(slugs, { upcomingOnly = true } = {}) {
  const out = {};
  for (const s of slugs) out[s] = [];
  if (!slugs.length) return out;

  const { data: ids } = await db
    .from('artists')
    .select('id, slug')
    .in('slug', slugs);
  if (!ids || !ids.length) return out;

  const slugById = {};
  for (const a of ids) slugById[a.id] = a.slug;

  let q = db
    .from('entity_events')
    .select('id, entity_slug, entity_name, event_name, description, event_date, day_of_week, start_time, end_time, recurring, cover_charge, image_url, artist_id')
    .in('artist_id', ids.map(a => a.id))
    .eq('is_active', true);
  if (upcomingOnly) {
    const today = new Date().toISOString().slice(0, 10);
    // A recurring weekly slot has no single date; keep it either way.
    q = q.or(`event_date.gte.${today},event_date.is.null`);
  }
  const { data: events } = await q.order('event_date', { ascending: true });
  if (!events || !events.length) return out;

  const venueSlugs = [...new Set(events.map(e => e.entity_slug).filter(Boolean))];
  const { data: venues } = await db
    .from('entity')
    .select('slug, name, city, hero_image_url, rating, review_count, is_active')
    .in('slug', venueSlugs);
  const venueById = {};
  for (const v of venues || []) venueById[v.slug] = v;

  const grouped = {};
  for (const ev of events) {
    const slug = slugById[ev.artist_id];
    if (!slug) continue;
    (grouped[slug] = grouped[slug] || []).push(toShow(ev, venueById[ev.entity_slug]));
  }
  for (const slug of Object.keys(grouped)) {
    out[slug] = dedupeShows(grouped[slug], venueById);
  }
  return out;
}

/**
 * Merge the two halves of an artist into the one record a page renders.
 *
 * `artist_profiles` is what the artist edits, so it wins. `artists` fills the
 * gaps — it is where genre, hometown and the socials were imported to, and it
 * is the row `entity_events` points at.
 */
function mergeArtist(profile, artist, extras = {}) {
  const p = profile || {};
  const a = artist || {};
  return {
    slug: pick(p.slug, a.slug),
    name: pick(p.artist_name, a.name),
    photo_url: pick(p.photo_url, a.image_url),
    bio: pick(p.bio, a.bio),
    genre: pick(p.genre, a.genre),
    hometown: pick(p.hometown, a.hometown),
    members: p.members || null,
    phone: p.phone || null,
    is_active: p.is_active !== false,

    links: {
      instagram: pick(p.instagram_url, a.social_instagram),
      facebook: a.social_facebook || null,
      tiktok: a.social_tiktok || null,
      spotify: pick(p.spotify_url, a.spotify_url),
      youtube: p.youtube_url || null,
      website: a.website_url || null,
      booking: p.booking_url || null,
      tip: p.tip_url || null,
    },

    requests: {
      request_enabled: !!p.request_enabled,
      shoutout_enabled: !!p.shoutout_enabled,
      min_amount: p.default_min_request_amount ?? null,
      cashtag: pick(p.cashtag, p.cashapp_handle),
      venmo: pick(p.venmo, p.venmo_handle),
    },

    shows: extras.shows || [],
    setlist: extras.setlist || [],
    also_known_as: extras.aliases || [],

    // Both ids, named for what they key, because they are not interchangeable.
    ids: { artists_id: a.id || null, artist_profiles_id: p.id || null },

    // Flat aliases for the pages written against the old artist_profiles
    // payload — ArtistLive's tip and song-request flow reads these. New code
    // should use the grouped fields above; these stay until those pages move.
    artist_name: pick(p.artist_name, a.name),
    instagram_url: pick(p.instagram_url, a.social_instagram),
    spotify_url: pick(p.spotify_url, a.spotify_url),
    youtube_url: p.youtube_url || null,
    booking_url: p.booking_url || null,
    cashtag: pick(p.cashtag, p.cashapp_handle),
    venmo: pick(p.venmo, p.venmo_handle),
    request_enabled: !!p.request_enabled,
    shoutout_enabled: !!p.shoutout_enabled,
    default_min_request_amount: p.default_min_request_amount ?? null,
    songs: extras.setlist || [],
  };
}

/** The complete artist for one slug, or null. */
async function getArtist(slug) {
  const [{ data: profile }, { data: artist }] = await Promise.all([
    db.from('artist_profiles').select('*').eq('slug', slug).maybeSingle(),
    db.from('artists').select('*').eq('slug', slug).maybeSingle(),
  ]);
  if (!profile && !artist) return null;

  const [shows, setlist, aliases] = await Promise.all([
    showsBySlug([slug], { upcomingOnly: false }),
    profile
      ? db.from('songs').select('id, title, sort_order').eq('artist_id', profile.id)
          .order('sort_order', { ascending: true }).then(r => r.data || [])
      : [],
    db.from('artist_aliases').select('alias, alias_type').eq('artist_slug', slug)
      .then(r => r.data || []),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const all = shows[slug] || [];
  const merged = mergeArtist(profile, artist, { shows: all, setlist, aliases });
  merged.upcoming_shows = all.filter(s => !s.date || s.date >= today);
  merged.past_shows = all.filter(s => s.date && s.date < today);
  return merged;
}

/** Every active artist, each with their next show. */
async function listArtists() {
  const [{ data: profiles }, { data: artists }] = await Promise.all([
    db.from('artist_profiles').select('*').eq('is_active', true),
    db.from('artists').select('*'),
  ]);
  const byslug = {};
  for (const a of artists || []) byslug[a.slug] = a;

  const slugs = (profiles || []).map(p => p.slug).filter(Boolean);
  const shows = await showsBySlug(slugs, { upcomingOnly: true });

  return (profiles || [])
    .map(p => {
      const upcoming = shows[p.slug] || [];
      const m = mergeArtist(p, byslug[p.slug], { shows: upcoming });
      m.next_show = upcoming[0] || null;
      m.upcoming_count = upcoming.length;
      return m;
    })
    .sort((x, y) => {
      // Playing soonest first, then everyone else by name.
      const a = x.next_show && x.next_show.date;
      const b = y.next_show && y.next_show.date;
      if (a && b) return a.localeCompare(b);
      if (a) return -1;
      if (b) return 1;
      return String(x.name || '').localeCompare(String(y.name || ''));
    });
}

module.exports = {
  getArtist, listArtists, showsBySlug, mergeArtist, dedupeShows, EDITABLE,
};
