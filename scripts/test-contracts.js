#!/usr/bin/env node
// ============================================================
// Data contracts: one registry, one copy of the dataKey → table mapping
// ============================================================
//
//     npm run test:contracts
//
// Pure: lib/dataContracts.js has no database. The one-copy checks read
// routes/platform.js as text, so a second BOOKING_KEYS or a table literal
// creeping back into the dispatch fails here rather than drifting.

const path = require('path');
const fs = require('fs');
const { checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
const contracts = require(path.join(ROOT, 'lib/dataContracts.js'));
const { RESOURCES, permitsResource } = require(path.join(ROOT, 'lib/businessTables.js'));
const { check, done } = checker();

console.log('\n── the registry (SPEC §12.6, DECISIONS #45) ──');
const expectTable = {
    'menu.items': 'menu_items', 'menu.sections': 'menu_sections', 'media.images': 'entity_photos',
    'reviews.items': 'entity_reviews', 'events.items': 'entity_events', 'booking.records': 'bookings',
    'availability.claims': 'booking_calendar', 'products.items': 'offerings', 'faqs.items': 'faqs',
    'specials.items': 'entity_specials', 'waivers.items': 'waivers', 'coupons.items': 'promos',
    'business.profile': 'entity', 'business.links': 'entity',
};
for (const [name, table] of Object.entries(expectTable)) {
    check(`${name} → ${table}`, contracts.contractFor(name)?.table === table, JSON.stringify(contracts.contractFor(name)));
}
check('products.items is offerings kind=product, server-side', contracts.contractFor('products.items').filter.kind === 'product');
check('every offerings kind has a products.<kind> contract', Object.values(contracts.OFFERING_KINDS).every((k) => contracts.contractFor(`products.${k}`)?.filter.kind === k));
check('every contract names a known resource', contracts.contractNames().every((n) => RESOURCES.includes(contracts.contractFor(n).resource)),
    contracts.contractNames().filter((n) => !RESOURCES.includes(contracts.contractFor(n).resource)).join(','));
check('the business record is keyed by slug and read-only through contracts', contracts.contractFor('business.profile').slugColumn === 'slug' && contracts.contractFor('business.profile').readOnly);
check('business.links is a column rule over entity, not a list of networks', contracts.contractFor('business.links').columns instanceof RegExp && contracts.contractFor('business.links').columns.test('social_anything'));
check('a raw table name is not a contract', !contracts.isContractName('menu_items') && contracts.contractFor('menu_items') === null);
check('an unknown dotted name is not a contract', contracts.contractFor('nope.items') === null);
check('a prototype name is not a contract', contracts.contractFor('constructor.x') === null);

console.log('\n── the legacy dashboard keys (routes/platform.js dispatch) ──');
const expectKey = {
    bookings: 'bookings', charter_trips: 'bookings', appointments: 'bookings', services: 'offerings', products: 'offerings',
    photos: 'entity_photos', specials: 'entity_specials', events: 'entity_events', menu_items: 'menu_items', faqs: 'faqs',
    waivers: 'waivers', blocks: 'booking_calendar', coupons: 'promos', reviews: 'entity_reviews',
};
for (const [key, table] of Object.entries(expectKey)) {
    check(`dataKey ${key} → ${table}`, contracts.tableForDataKey(key) === table, String(contracts.tableForDataKey(key)));
}
check('a dataKey without a purpose-built table is the generic store (null)', contracts.tableForDataKey('song_requests') === null && contracts.tableForDataKey('leads') === null);
check('services is products.service', contracts.contractForDataKey('services') === 'products.service');

console.log('\n── one copy ──');
const platform = fs.readFileSync(path.join(ROOT, 'routes/platform.js'), 'utf8');
check('routes/platform.js takes the registry', /require\('\.\.\/lib\/dataContracts'\)/.test(platform));
check('routes/platform.js holds no BOOKING_KEYS of its own', !/const BOOKING_KEYS\s*=/.test(platform));
check('routes/platform.js holds no OFFERING_KINDS of its own', !/const OFFERING_KINDS\s*=\s*\{/.test(platform));
check('deleteRecord has no dataKey → table map of its own', !/photos:\s*'entity_photos'/.test(platform));

console.log('\n── a contract\'s resource decides the permission ──');
check('resource:read reads', permitsResource({ scope: 'read', permissions: ['business:read'] }, 'business', 'read'));
check('write does not imply read', !permitsResource({ scope: 'write', permissions: ['business:write'] }, 'business', 'read'));
check('another resource does not reach it', !permitsResource({ scope: 'read', permissions: ['menu:read'] }, 'business', 'read'));
check('a legacy token is governed by scope', permitsResource({ scope: 'read', permissions: null }, 'business', 'read') && !permitsResource({ scope: 'read', permissions: null }, 'business', 'write') && permitsResource({ scope: 'write', permissions: null }, 'business', 'write'));
check('an unknown resource reaches nothing', !permitsResource({ scope: 'write', permissions: ['business:read'] }, 'nope', 'read'));

console.log('\n── field maps ──');
const entry = { fieldMap: { from: 'from_name' } };
check('toTableRow renames a contract field to its column', JSON.stringify(contracts.toTableRow(entry, { from: 'A', x: 1 })) === '{"x":1,"from_name":"A"}');
check('toContractRow renames it back', contracts.toContractRow(entry, { from_name: 'A', id: 2 }).from === 'A');
check('no fieldMap: the row is the row', contracts.toContractRow({ fieldMap: null }, { a: 1 }).a === 1);

done('contracts');
