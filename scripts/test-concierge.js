// ============================================================
// CONCIERGE TOOLS — the time and day filtering
// ============================================================
//
//     npm run test:concierge
//
// whats_on is the tool that answers "what's going on tonight", and it is the
// one with real logic in it rather than a query pass-through: businesses type
// their days by hand, so the column holds arrays, "Mon-Fri", "daily", and
// blanks, and the clock has to be Central regardless of where the server is.
//
// The clock is stubbed to a fixed Wednesday 16:00 so these assertions mean the
// same thing at any hour of any day. The database is stubbed too — no
// credentials, no network.

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

/* ── a fixed clock: Wednesday 16 July 2025, 16:00 Central ─────────────── */
const gcrStub = {
    getCentralNow: () => ({ nowTime: '16:00', today: '2025-07-16', todayName: 'wednesday' }),
    buildFullEntity: async () => null,
    searchEntitySlugs: async () => ({ slugs: [] }),
};

/* ── the rows each table hands back ───────────────────────────────────── */
const TABLES = {
    entity_events: [
        { event_name: 'Dated today', is_active: true, event_date: '2025-07-16', start_time: '20:00', end_time: '23:00', entity_slug: 'a', entity: { name: 'Bar A', phone: '555' } },
        { event_name: 'Dated tomorrow', is_active: true, event_date: '2025-07-17', start_time: '20:00', end_time: '23:00', entity_slug: 'b', entity: { name: 'Bar B' } },
        { event_name: 'Matinee today', is_active: true, event_date: '2025-07-16', start_time: '11:00', end_time: '13:00', entity_slug: 'c', entity: { name: 'Bar C' } },
        { event_name: 'On stage right now', is_active: true, event_date: '2025-07-16', start_time: '15:00', end_time: '18:00', entity_slug: 'p', entity: { name: 'Bar P' } },
        { event_name: 'Weekly wednesday', is_active: true, event_date: null, day_of_week: 'wednesday', recurring: true, start_time: '19:00', end_time: '22:00', entity_slug: 'd', entity: { name: 'Bar D' } },
        { event_name: 'Weekly monday', is_active: true, event_date: null, day_of_week: 'monday', recurring: true, start_time: '19:00', end_time: '22:00', entity_slug: 'e', entity: { name: 'Bar E' } },
    ],
    entity_specials: [
        { special_name: 'Array excludes today', is_active: true, days: ['mon', 'tue'], entity_slug: 'f', entity: { name: 'F' } },
        { special_name: 'Array includes today', is_active: true, days: ['wed', 'thu'], entity_slug: 'g', entity: { name: 'G' } },
        { special_name: 'Range text', is_active: true, days: 'Mon-Fri', entity_slug: 'h', entity: { name: 'H' } },
        { special_name: 'Daily', is_active: true, days: 'daily', entity_slug: 'i', entity: { name: 'I' } },
        { special_name: 'No day recorded', is_active: true, days: null, entity_slug: 'j', entity: { name: 'J' } },
        { special_name: 'Ended last month', is_active: true, days: 'daily', end_date: '2025-06-01', entity_slug: 'k', entity: { name: 'K' } },
    ],
    entity: [
        { slug: 'l', name: 'In happy hour now', is_active: true, hh_days: 'daily', hh_start: '15:00', hh_end: '18:00' },
        { slug: 'm', name: 'Happy hour over', is_active: true, hh_days: 'daily', hh_start: '11:00', hh_end: '13:00' },
        { slug: 'n', name: 'Wrong day', is_active: true, hh_days: ['mon'], hh_start: '15:00', hh_end: '18:00' },
        { slug: 'o', name: 'Crosses midnight', is_active: true, hh_days: 'daily', hh_start: '22:00', hh_end: '02:00' },
        { slug: 'cruise-co', name: 'Cruise Co', is_active: true, entity_subtype: 'dolphin_cruise', rating: 4.6 },
        { slug: 'charter-co', name: 'Charter Co', is_active: true, entity_subtype: 'fishing_charter', rating: 4.4 },
        { slug: 'blocked-co', name: 'Blocked Co', is_active: true, entity_subtype: 'dolphin_cruise', rating: 4.0 },
        { slug: 'tiny-co', name: 'Tiny Co', is_active: true, entity_subtype: 'kayak_rental', rating: 4.1 },
    ],
    entity_tags: [
        { entity_slug: 'a', tag_name: 'outdoor seating' },
        { entity_slug: 'd', tag_name: 'outdoor seating' },
    ],
    entity_amenities: [
        { entity_slug: 'p', amenity: 'Outdoor seating' },
    ],
    happy_hour_sections: [{ entity_slug: 'd' }, { entity_slug: 'z' }],
    entity_hours: [
        { entity_slug: 'd', day_of_week: 'wednesday', opens_at: '11:00', closes_at: '23:00', is_closed: false },
        { entity_slug: 'a', day_of_week: 'wednesday', opens_at: '18:00', closes_at: '23:00', is_closed: false },
    ],
    business_availability: [
        { entity_slug: 'cruise-co', availability_date: '2025-07-16', time_slot: '14:00', end_time: '16:00', status: 'open', remaining_spots: 6, total_capacity: 20 },
        { entity_slug: 'blocked-co', availability_date: '2025-07-16', time_slot: '09:00', status: 'open', remaining_spots: 4, total_capacity: 12 },
        { entity_slug: 'tiny-co', availability_date: '2025-07-16', time_slot: '10:00', status: 'open', remaining_spots: 1, total_capacity: 6 },
    ],
    availability: [
        { entity_slug: 'charter-co', date: '2025-07-16', start_time: '07:00', end_time: '11:00', spots_remaining: 4, spots_total: 6 },
    ],
    booking_calendar: [
        { entity_slug: 'blocked-co', date: '2025-07-16', end_date: null, kind: 'block', offering_id: null, status: 'confirmed' },
    ],
    subtype_taxonomy: [
        { subtype_key: 'fishing_charter', display_name: 'Fishing charters', listing_category: 'On the water', entity_count: 40 },
        { subtype_key: 'dolphin_cruise', display_name: 'Dolphin cruises', listing_category: 'On the water', entity_count: 12 },
        { subtype_key: 'seafood', display_name: 'Seafood', listing_category: 'Eat & drink', entity_count: 90 },
        { subtype_key: 'orphan', display_name: 'No category', listing_category: null, entity_count: 5 },
    ],
};

// The stub applies the filters it is given rather than returning the table
// whole — otherwise a test for "this row was excluded" passes on a router that
// never excluded anything.
function builder(table) {
    const eq = {};
    const preds = [];
    const rows = () => (TABLES[table] || []).filter((r) => {
        for (const [k, v] of Object.entries(eq)) if (r[k] !== v) return false;
        return preds.every((p) => p(r));
    });
    const self = {
        select: () => self,
        eq: (k, v) => { eq[k] = v; return self; },
        neq: (k, v) => { preds.push((r) => r[k] !== v); return self; },
        gt: (k, v) => { preds.push((r) => Number(r[k]) > Number(v)); return self; },
        gte: (k, v) => { preds.push((r) => r[k] >= v); return self; },
        lte: (k, v) => { preds.push((r) => r[k] <= v); return self; },
        is: (k, v) => { preds.push((r) => (v === null ? r[k] == null : r[k] === v)); return self; },
        not: (k, op, v) => { preds.push((r) => (op === 'is' && v === null ? r[k] != null : true)); return self; },
        in: (k, list) => { preds.push((r) => list.includes(r[k])); return self; },
        or: () => self,
        ilike: (k, pat) => {
            const needle = String(pat).replace(/%/g, '').toLowerCase();
            preds.push((r) => String(r[k] ?? '').toLowerCase().includes(needle));
            return self;
        },
        order: () => self,
        limit: () => self,
        maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
        then: (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    };
    return self;
}

function inject(file, exports) {
    const full = require.resolve(file);
    const m = new Module(full, null);
    m.filename = full; m.loaded = true; m.exports = exports;
    require.cache[full] = m;
}

inject(path.join(ROOT, 'db.js'), { from: (t) => builder(t) });
inject(path.join(ROOT, 'routes/gcr.js'), gcrStub);

const { runConciergeTool, CONCIERGE_TOOLS } = require(path.join(ROOT, 'lib/conciergeTools.js'));

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}
const names = (rows, key) => (rows || []).map((r) => r[key]);

async function run() {
    console.log('\n── the tool list ──');
    check('eight public tools', CONCIERGE_TOOLS.length === 8, String(CONCIERGE_TOOLS.length));
    check('every tool is marked read-only', CONCIERGE_TOOLS.every((t) => t.annotations?.readOnlyHint === true));

    console.log('\n── whats_on: "now" (Wednesday 16:00) ──');
    const now = await runConciergeTool('whats_on', { when: 'now' });
    check('reports the clock it used', now.as_of === '2025-07-16 16:00 Central', now.as_of);
    check('an event on stage right now is in', names(now.events, 'event').includes('On stage right now'));
    check('an event that finished at lunch is out', !names(now.events, 'event').includes('Matinee today'));
    check('an event that has not started yet is out of "now"', !names(now.events, 'event').includes('Dated today'));
    check('happy hour running now is in', names(now.happy_hour, 'business').includes('In happy hour now'));
    check('happy hour that ended is out', !names(now.happy_hour, 'business').includes('Happy hour over'));
    check('a midnight-crossing window is not "now" at 16:00', !names(now.happy_hour, 'business').includes('Crosses midnight'));

    console.log('\n── whats_on: day matching ──');
    const today = await runConciergeTool('whats_on', { when: 'today' });
    const specials = names(today.specials, 'special');
    check('an array naming other days is excluded', !specials.includes('Array excludes today'));
    check('an array naming today is included', specials.includes('Array includes today'));
    check('"Mon-Fri" is kept — a range cannot be expanded safely', specials.includes('Range text'));
    check('"daily" is kept', specials.includes('Daily'));
    check('a blank day field is kept', specials.includes('No day recorded'));
    check('an expired special is dropped on its end_date', !specials.includes('Ended last month'));
    check('the raw day text is passed through verbatim',
        today.specials.find((s) => s.special === 'Range text')?.day_text === 'Mon-Fri');
    check('recurring weekly event on today is in', names(today.events, 'event').includes('Weekly wednesday'));
    check('recurring weekly event on another day is out', !names(today.events, 'event').includes('Weekly monday'));

    console.log('\n── whats_on: other windows ──');
    const tonight = await runConciergeTool('whats_on', { when: 'tonight' });
    check('tonight keeps a 20:00 event', names(tonight.events, 'event').includes('Dated today'));
    check('tonight drops an 11:00 matinee', !names(tonight.events, 'event').includes('Matinee today'));

    const tomorrow = await runConciergeTool('whats_on', { when: 'tomorrow' });
    check("tomorrow keeps tomorrow's event", names(tomorrow.events, 'event').includes('Dated tomorrow'));
    check("tomorrow drops today's event", !names(tomorrow.events, 'event').includes('Dated today'));

    const week = await runConciergeTool('whats_on', { when: 'this_week' });
    check('this_week spans both dated events',
        names(week.events, 'event').includes('Dated today') && names(week.events, 'event').includes('Dated tomorrow'));

    const exact = await runConciergeTool('whats_on', { when: '2025-07-17' });
    check('an explicit date works', names(exact.events, 'event').includes('Dated tomorrow'));

    console.log('\n── whats_on: shape ──');
    const onlyHh = await runConciergeTool('whats_on', { kind: 'happy_hour' });
    check('kind narrows to one section', onlyHh.happy_hour && !onlyHh.events && !onlyHh.specials);
    check('the note warns against reading day_text as today', /read it out rather than asserting/.test(today.note));
    check('a phone number rides along', today.events.some((e) => e.phone === '555'));

    console.log('\n── list_categories ──');
    const cats = await runConciergeTool('list_categories');
    const water = cats.categories.find((c) => c.category === 'On the water');
    check('groups subtypes under their category', water?.subtypes.length === 2);
    check('sums the businesses in a category', water?.businesses === 52, String(water?.businesses));
    check('sorts the biggest category first', cats.categories[0].category === 'Eat & drink');
    check('drops rows with no category', !cats.categories.some((c) => c.category === null));

    console.log('\n── find_available ──');
    const avail = await runConciergeTool('find_available', {});
    const open = names(avail.available, 'slug');
    check('defaults to today on the Central clock', avail.date === '2025-07-16', avail.date);
    check('capacity rows count', open.includes('cruise-co'));
    check('booking-engine slot rows count too', open.includes('charter-co'));
    check('an entity-wide block vetoes the date', !open.includes('blocked-co'));
    check('party_size filters out a slot that is too small',
        !names((await runConciergeTool('find_available', { party_size: 4 })).available, 'slug').includes('tiny-co'));
    check('open slots carry the real number left',
        avail.available.find((a) => a.slug === 'cruise-co')?.open_slots[0].spots === 6);
    check('nobody published is not the same as everybody booked',
        /rather than saying the coast is booked out/.test(
            (await runConciergeTool('find_available', { date: '2030-01-01' })).note));

    console.log('\n── stacking filters ──');
    const stacked = await runConciergeTool('search_businesses', {
        must_have: ['outdoor seating'], has_happy_hour: true, live_music: 'today', open_now: true,
    });
    check('a four-part request runs as one call', typeof stacked === 'object');
    const missing = await runConciergeTool('search_businesses', { must_have: ['helipad'] });
    check('an unmatched condition is reported, not dropped',
        /do not drop the condition/.test(missing.note || ''), JSON.stringify(missing).slice(0, 120));
    const noMusic = await runConciergeTool('search_businesses', { live_music: '2030-01-01' });
    check('no live music that night says so',
        /Nobody has live music listed/.test(noMusic.note || ''));

    console.log('\n── the public boundary ──');
    const { whyPrivate } = require(path.join(ROOT, 'lib/businessTables.js'));
    const cols = (...n) => n.map((name) => ({ name }));

    // The rule reads columns, not names. These are the real shapes.
    const shaped = [
        ['menu_items', cols('id', 'entity_slug', 'item_name', 'price', 'description'), false],
        ['entity_events', cols('id', 'entity_slug', 'event_name', 'event_date', 'artist_name'), false],
        ['fish_species', cols('id', 'entity_slug', 'species', 'season'), false],
        ['bookable_resources', cols('id', 'entity_slug', 'name', 'nightly_price', 'bedrooms'), false],
        ['entity_team', cols('id', 'entity_slug', 'name', 'title', 'bio'), false],
        ['entity_reviews', cols('id', 'entity_slug', 'body', 'rating', 'reviewer_name'), false],
        ['business_availability', cols('id', 'entity_slug', 'remaining_spots', 'status'), false],
        // A table nobody has ever seen, holding plain business columns, is public.
        // That is the point: the schema decides, not a list somebody maintains.
        ['some_new_table_2027', cols('id', 'entity_slug', 'label', 'value'), false],
        ['bookings', cols('id', 'entity_slug', 'customer_name', 'customer_email', 'amount_paid'), true],
        ['customers', cols('id', 'entity_slug', 'name', 'email', 'phone'), true],
        ['signed_waivers', cols('id', 'entity_slug', 'guest_name', 'signature'), true],
        ['entity_owners', cols('id', 'entity_slug', 'user_id', 'role'), true],
        ['oauth_tokens', cols('id', 'entity_slug', 'access_token'), true],
        ['sms_log', cols('id', 'entity_slug', 'to_number', 'body'), true],
        // Named innocuously, but it carries an email address.
        ['entity_notes', cols('id', 'entity_slug', 'note', 'contact_email'), true],
    ];
    const wrong = shaped.filter(([t, c, priv]) => !!whyPrivate(t, c) !== priv).map(([t]) => t);
    check(`${shaped.length} real table shapes classified by their columns`, !wrong.length, wrong.join(', '));
    check('a business phone number does not make a table private',
        !whyPrivate('entity', cols('slug', 'name', 'phone', 'city')));
    check('the reason names the deciding column',
        /customer_name/.test(whyPrivate('bookings', cols('customer_name'))));

    // The name rule is only a backstop now, for the transaction tables that can
    // exist without a personal column on them at all.
    const { PRIVATE_TABLE } = require(path.join(ROOT, 'lib/businessTables.js'));
    const backstop = ['bookings', 'entity_bookings', 'signed_waivers', 'oauth_tokens', 'sms_log', 'business_leads'];
    const throughTheNet = backstop.filter((t) => !PRIVATE_TABLE.test(t));
    check('the backstop still catches a transaction table with no personal column',
        !throughTheNet.length, throughTheNet.join(', '));
    const overreach = ['menu_items', 'entity_events', 'entity_reviews', 'fish_species', 'bookable_resources']
        .filter((t) => PRIVATE_TABLE.test(t));
    check('and does not reach past them', !overreach.length, overreach.join(', '));
    console.log('\n── unknown ──');
    check('an unknown tool returns null', (await runConciergeTool('nope', {})) === null);

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

run();
