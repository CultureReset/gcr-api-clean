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
const sqlDir = path.join(ROOT, 'sql');
const { RESOURCES, permitsResource, resourceForTable } = require(path.join(ROOT, 'lib/businessTables.js'));
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
console.log('\n── business facts the apps used to keep themselves (DECISIONS #44, #49) ──');
check('leads.items → entity_leads', contracts.contractFor('leads.items')?.table === 'entity_leads');
check('customers.items → entity_customers', contracts.contractFor('customers.items')?.table === 'entity_customers');
check('both are on the contacts resource (DECISIONS #59)', RESOURCES.includes('contacts') && ['leads.items', 'customers.items'].every((n) => contracts.contractFor(n).resource === 'contacts'));
const cols = (...names) => names.map((name) => ({ name }));
check('the registry pins a raw table name to its contract\'s resource before the name rules: entity_leads → contacts, not business', resourceForTable('entity_leads', cols('id', 'entity_slug', 'email')) === 'contacts' && resourceForTable('entity_customers', cols('id', 'entity_slug', 'phone')) === 'contacts');
check('a table the registry does not name is decided by the name rules as before', resourceForTable('menu_items', cols('id', 'entity_slug', 'item_name')) === 'menu' && resourceForTable('entity_hours', cols('id', 'entity_slug', 'day')) === 'business');
check('and a table of people the registry does not name reaches no permissioned token', resourceForTable('customer_notes', cols('id', 'entity_slug', 'customer_email')) === null);
check('the pin changes two raw tables: booking_calendar is availability (its contract\'s), waivers is bookings (was unreachable by name)', resourceForTable('booking_calendar', cols('id', 'entity_slug', 'date')) === 'availability' && resourceForTable('waivers', cols('id', 'entity_slug', 'customer_name')) === 'bookings');
check('BUSINESS_RESOURCE_TABLES still pins above everything', (() => { process.env.BUSINESS_RESOURCE_TABLES = '{"entity_leads":"menu"}'; const r = resourceForTable('entity_leads', cols('id')); delete process.env.BUSINESS_RESOURCE_TABLES; return r === 'menu'; })());
check('business.currency → entity.currency, read-only', contracts.contractFor('business.currency')?.table === 'entity' && contracts.contractFor('business.currency').readOnly && contracts.contractFor('business.currency').columns.test('currency'));
delete process.env.DEFAULT_CURRENCY;
check('a business with no currency set answers null when no default is configured', contracts.toContractRow(contracts.contractFor('business.currency'), { slug: 's', currency: null }).currency === null);
process.env.DEFAULT_CURRENCY = 'usd';
check('and the environment default otherwise — nothing hard-coded', contracts.toContractRow(contracts.contractFor('business.currency'), { slug: 's', currency: null }).currency === 'usd');
check('a set currency wins', contracts.toContractRow(contracts.contractFor('business.currency'), { slug: 's', currency: 'eur' }).currency === 'eur');
delete process.env.DEFAULT_CURRENCY;
const contactsSql = fs.existsSync(path.join(sqlDir, 'nextgent_business_contacts.sql')) ? fs.readFileSync(path.join(sqlDir, 'nextgent_business_contacts.sql'), 'utf8') : '';
const PROVENANCE = ['source_type', 'source_id', 'external_record_id', 'source_updated_at', 'last_synced_at', 'created_by', 'updated_by', 'owner_override'];
for (const table of ['entity_leads', 'entity_customers']) {
    const block = contactsSql.match(new RegExp(`create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`));
    check(`sql creates ${table} with entity_slug and the SPEC §6.6 provenance columns`, !!block && /entity_slug\s+text not null/.test(block[1]) && PROVENANCE.every((c) => new RegExp(`^\\s*${c}\\s`, 'm').test(block[1])));
    check(`${table} has RLS on and anon/authenticated revoked`, new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(contactsSql) && new RegExp(`revoke all on public\\.${table}\\s+from anon, authenticated`).test(contactsSql));
}
check('one customer per phone per business, when a phone is known', /create unique index if not exists \S+ on public\.entity_customers \(entity_slug, phone\) where phone is not null/.test(contactsSql));
const currencySql = fs.existsSync(path.join(sqlDir, 'nextgent_business_currency.sql')) ? fs.readFileSync(path.join(sqlDir, 'nextgent_business_currency.sql'), 'utf8') : '';
check('entity.currency is added nullable, with no default baked in', /add column if not exists currency text\s*;/.test(currencySql) && !/currency text\s+(not null\s+)?default/.test(currencySql));
const order = fs.readFileSync(path.join(sqlDir, 'ORDER.md'), 'utf8');
check('both files are in sql/ORDER.md', order.includes('nextgent_business_contacts.sql') && order.includes('nextgent_business_currency.sql'));
check('the registry names faqs canonical and entity_faqs legacy', /faqs[\s\S]{0,120}canonical[\s\S]{0,200}entity_faqs[\s\S]{0,80}legacy/.test(fs.readFileSync(path.join(ROOT, 'lib/dataContracts.js'), 'utf8')));
check('lib/businessEvents.js says bookings is canonical, booking_calendar the mirror', /`?bookings`? is (the )?canonical/.test(fs.readFileSync(path.join(ROOT, 'lib/businessEvents.js'), 'utf8')) && !/Bookings live in booking_calendar/.test(fs.readFileSync(path.join(ROOT, 'lib/businessEvents.js'), 'utf8')));

check('listings.items → offerings with no fixed kind (DECISIONS #62): kind is a column the app filters on', contracts.contractFor('listings.items')?.table === 'offerings' && Object.keys(contracts.contractFor('listings.items').filter).length === 0 && contracts.contractFor('listings.items').resource === 'business');
check('menu.items lists sort_order as orderable, then id (DECISIONS #65)', JSON.stringify(contracts.contractFor('menu.items').orderBy) === '["sort_order","id"]');
const menuSql = fs.existsSync(path.join(sqlDir, 'nextgent_menu_items_order.sql')) ? fs.readFileSync(path.join(sqlDir, 'nextgent_menu_items_order.sql'), 'utf8') : '';
check('sql adds menu_items.sort_order and is_available, if not exists, additively', /alter table public\.menu_items[\s\S]*add column if not exists sort_order\s+integer/.test(menuSql) && /add column if not exists is_available\s+boolean[^,;]*default true/.test(menuSql));
check('and is in sql/ORDER.md', fs.readFileSync(path.join(sqlDir, 'ORDER.md'), 'utf8').includes('nextgent_menu_items_order.sql'));
check('products.items is offerings kind=product, server-side', contracts.contractFor('products.items').filter.kind === 'product');
check('every offerings kind has a products.<kind> contract', Object.values(contracts.OFFERING_KINDS).every((k) => contracts.contractFor(`products.${k}`)?.filter.kind === k));
check('every contract names a known resource', contracts.contractNames().every((n) => RESOURCES.includes(contracts.contractFor(n).resource)),
    contracts.contractNames().filter((n) => !RESOURCES.includes(contracts.contractFor(n).resource)).join(','));
check('the business record is keyed by slug: one record per business, PATCH only (DECISIONS #96)', contracts.contractFor('business.profile').slugColumn === 'slug' && contracts.contractFor('business.profile').single && !contracts.contractFor('business.profile').readOnly);
const profile = contracts.contractFor('business.profile');
check('address_display is derived from the address columns (DECISIONS #100)', contracts.toContractRow(profile, { slug: 's', address_line_1: '12 Main St', address_line_2: '', city: 'Gulf Shores', state: 'AL', zip: '36542' }).address_display === '12 Main St, Gulf Shores, AL 36542');
check('each part only when set', contracts.toContractRow(profile, { slug: 's', address_line_1: '1 Elm', address_line_2: 'Suite 4', city: 'Mobile', state: null, zip: null }).address_display === '1 Elm, Suite 4, Mobile'
    && contracts.toContractRow(profile, { slug: 's' }).address_display === null);
check('a write drops it: it is not a column', !('address_display' in contracts.toTableRow(profile, { name: 'x', address_display: 'y' })));
check('business.links is a column rule over entity, not a list of networks', contracts.contractFor('business.links').columns instanceof RegExp && contracts.contractFor('business.links').columns.test('social_anything'));
const linksEntry = contracts.contractFor('business.links');
const entityCols = ['id', 'slug', 'name', 'social_instagram', 'social_facebook', 'website_url', 'email'];
check('business.links pivots the record into rows (DECISIONS #63), writable', !!linksEntry.pivot && !linksEntry.readOnly);
check('rows: one per set link column, { id, network, url }', JSON.stringify(contracts.pivotRows(linksEntry, { slug: 's', social_instagram: 'ig', social_facebook: null, website_url: 'w', email: 'e' }, entityCols))
    === JSON.stringify([{ id: 'instagram', network: 'instagram', url: 'ig' }, { id: 'website', network: 'website', url: 'w' }]));
check('a row id maps back to its column: instagram → social_instagram, website → website_url', contracts.pivotColumnFor(linksEntry, 'instagram', entityCols) === 'social_instagram' && contracts.pivotColumnFor(linksEntry, 'website', entityCols) === 'website_url');
check('an id with no such column, or a column of something else, maps to nothing', contracts.pivotColumnFor(linksEntry, 'myspace', entityCols) === null && contracts.pivotColumnFor(linksEntry, 'email', entityCols) === null && contracts.pivotColumnFor(linksEntry, 'name', entityCols) === null);
check('a raw table name is not a contract', !contracts.isContractName('menu_items') && contracts.contractFor('menu_items') === null);
check('an unknown dotted name is not a contract', contracts.contractFor('nope.items') === null);
check('a prototype name is not a contract', contracts.contractFor('constructor.x') === null);
check('a dotted name with dashes is a well-formed name (DECISIONS #54)', contracts.isContractName('my-app.items') && contracts.contractFor('my-app.items') === null);
check('business.currency is a scalar contract read as { value }', contracts.contractFor('business.currency').scalar === 'currency');

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
