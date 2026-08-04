// Checks on the artist assembler that need no network.
//
// The two things worth asserting are the ones the live data actually breaks:
// which half of the artist wins a merge, and what happens when the same show
// is attached to two duplicate venue rows.

const assert = require('assert');
const Module = require('module');

// lib/artist.js requires ../db at load, which exits the process without
// Supabase credentials. Stub it before the require.
const origResolve = Module._resolveFilename;
const dbPath = require.resolve('../db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
Module._resolveFilename = origResolve;

const { mergeArtist, dedupeShows } = require('../lib/artist');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('artist merge');

test('artist_profiles wins over artists when it has a value', () => {
  const m = mergeArtist(
    { slug: 'x', artist_name: 'Edited Name', bio: 'edited bio' },
    { slug: 'x', name: 'Imported Name', bio: 'imported bio' },
  );
  assert.strictEqual(m.name, 'Edited Name');
  assert.strictEqual(m.bio, 'edited bio');
});

test('artists fills the gap when the profile field is empty', () => {
  // Real shape: 6 of 396 artists have a genre, and it is on `artists`, not on
  // `artist_profiles`. An empty string has to count as absent, not as a value.
  const m = mergeArtist(
    { slug: 'x', artist_name: 'Chitlin Switch', genre: '', hometown: null },
    { slug: 'x', name: 'Chitlin Switch', genre: 'Rock', hometown: 'Gulf Shores' },
  );
  assert.strictEqual(m.genre, 'Rock');
  assert.strictEqual(m.hometown, 'Gulf Shores');
});

test('photo falls back from profile to artists', () => {
  const m = mergeArtist({ slug: 'x' }, { slug: 'x', image_url: 'a.jpg' });
  assert.strictEqual(m.photo_url, 'a.jpg');
});

test('both ids are carried and kept apart', () => {
  // entity_events points at artists.id; songs points at artist_profiles.id.
  // Collapsing them to one `id` is what makes shows or setlists vanish.
  const m = mergeArtist({ slug: 'x', id: 'profile-uuid' }, { slug: 'x', id: 'artists-uuid' });
  assert.strictEqual(m.ids.artist_profiles_id, 'profile-uuid');
  assert.strictEqual(m.ids.artists_id, 'artists-uuid');
});

test('legacy flat fields still present for ArtistLive', () => {
  const m = mergeArtist(
    { slug: 'x', artist_name: 'N', venmo: 'v', cashtag: 'c', default_min_request_amount: 5 },
    { slug: 'x', name: 'N' },
  );
  assert.strictEqual(m.artist_name, 'N');
  assert.strictEqual(m.venmo, 'v');
  assert.strictEqual(m.cashtag, 'c');
  assert.strictEqual(m.default_min_request_amount, 5);
});

test('an artist with only an artists row still resolves', () => {
  const m = mergeArtist(null, { slug: 'x', name: 'Solo', image_url: 'p.jpg' });
  assert.strictEqual(m.slug, 'x');
  assert.strictEqual(m.name, 'Solo');
});

console.log('\nshow dedupe');

test('one show on two duplicate venue rows collapses to the fuller venue', () => {
  // Real case: `the-hangout` and `the-hangout-restaurant` both carry the same
  // Webb Dalton date at 18:30. A fan should see one row, not two.
  const shows = [
    { id: 1, date: '2026-09-26', start_time: '18:30:00', event_name: 'Live Music', venue_slug: 'the-hangout' },
    { id: 2, date: '2026-09-26', start_time: '18:30:00', event_name: 'Live Music', venue_slug: 'the-hangout-restaurant' },
  ];
  const venues = {
    'the-hangout': { slug: 'the-hangout', name: 'The Hangout', hero_image_url: 'h.jpg', rating: 4.4, review_count: 900, city: 'Gulf Shores', is_active: true },
    'the-hangout-restaurant': { slug: 'the-hangout-restaurant', name: 'The Hangout Restaurant', is_active: true },
  };
  const out = dedupeShows(shows, venues);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].venue_slug, 'the-hangout');
});

test('two real shows on the same night at different venues both survive', () => {
  const shows = [
    { id: 1, date: '2026-08-08', start_time: '17:00:00', event_name: 'Happy Hour Set', venue_slug: 'lulus-gulf-shores' },
    { id: 2, date: '2026-08-08', start_time: '21:00:00', event_name: 'Late Set', venue_slug: 'flounder-s-chowder-house' },
  ];
  assert.strictEqual(dedupeShows(shows, {}).length, 2);
});

test('shows come back in date then time order', () => {
  const shows = [
    { id: 1, date: '2026-09-26', start_time: '18:30:00', event_name: 'c', venue_slug: 'v' },
    { id: 2, date: '2026-08-08', start_time: '21:00:00', event_name: 'b', venue_slug: 'v' },
    { id: 3, date: '2026-08-08', start_time: '17:00:00', event_name: 'a', venue_slug: 'v' },
  ];
  assert.deepStrictEqual(dedupeShows(shows, {}).map(s => s.id), [3, 2, 1]);
});

test('a recurring slot with no date is kept, not dropped', () => {
  const shows = [{ id: 1, date: null, start_time: '19:00:00', event_name: 'Every Friday', venue_slug: 'v' }];
  assert.strictEqual(dedupeShows(shows, {}).length, 1);
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
