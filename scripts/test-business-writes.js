#!/usr/bin/env node
// ============================================================
// Writes through the business sections: the profile, cover photos, tags, uploads
// ============================================================
//
//     npm run test:business-writes
//
// Boots routes/business-data.js and routes/owner.js against the in-memory
// database, with the live schema read stubbed. The guards are the real ones
// (lib/businessTables.js, lib/dataContracts.js). No credentials, no network.

const path = require('path');
const express = require('express');
const { createMemDb, inject, checker } = require('./lib/memdb');

const ROOT = path.resolve(__dirname, '..');
Object.assign(process.env, {
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_KEY: 'service',
});
delete process.env.OWNER_PROFILE_LOCKED_COLUMNS;

const { T, db } = createMemDb({ tables: {
    entity: [
        { id: 1, slug: 'shop', name: 'The Shop', phone: '555', address_line_1: '12 Main St', address_line_2: null, city: 'Gulf Shores', state: 'AL', zip: '36542', is_active: true, rating: 4.5, verified: true, stripe_customer_id: 'cus_1' },
        { id: 2, slug: 'other', name: 'Other', address_line_1: '1 Elsewhere', city: 'Mobile', state: 'AL', zip: '36602', is_active: true },
    ],
    entity_owners: [],
    platform_admins: [],
    entity_photos: [],
    menu_items: [],
} });
inject(path.join(ROOT, 'db.js'), db);

// The owner's session: req.entitySlug from the credential, never the request.
let session = { entitySlug: 'shop', ownerUserId: 'owner-1' };
inject(path.join(ROOT, 'middleware/ownerAuth.js'), {
    ownerRequired: (req, res, next) => (session ? (Object.assign(req, session), next()) : res.status(401).json({ error: 'no' })),
    sessionRequired: (req, res, next) => next(),
});
// An installed app's token (gcr_mcp_…): the permissions the owner approved.
const TOKENS = {
    gcr_mcp_writer: { slug: 'shop', scope: 'write', permissions: ['business:read', 'business:write'], installId: 'in-1' },
    gcr_mcp_reader: { slug: 'shop', scope: 'read', permissions: ['business:read'], installId: 'in-2' },
};
inject(path.join(ROOT, 'lib/businessTokens.js'), {
    isBusinessToken: (raw) => typeof raw === 'string' && raw.startsWith('gcr_mcp_'),
    lookupToken: async (raw) => TOKENS[raw] || { reason: 'That token is not valid.' },
});
inject(path.join(ROOT, 'lib/googlePush.js'), { noteTableWrite: async () => null });
inject(path.join(ROOT, 'lib/businessEvents.js'), { sectionWritten: async () => null });

// The live schema read (lib/businessTables.js). entity carries governed
// columns (is_active, rating, verified, stripe_customer_id) next to the
// owner-editable ones.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://db.example.test/rest/v1/')) {
        const def = (cols) => ({ properties: Object.fromEntries(cols.map((c) => [c, { type: 'string' }])) });
        return { ok: true, status: 200, json: async () => ({ definitions: {
            entity: def(['id', 'slug', 'name', 'phone', 'address_line_1', 'address_line_2', 'city', 'state', 'zip', 'is_active', 'rating', 'verified', 'stripe_customer_id', 'created_at']),
            entity_photos: def(['id', 'entity_slug', 'url', 'image_path', 'caption', 'is_cover', 'sort_order']),
            menu_items: def(['id', 'entity_slug', 'name', 'price', 'tags', 'sort_order']),
        } }) };
    }
    return realFetch(url, init);
};

const { check, done } = checker();
const app = express();
app.use(express.json());
app.use('/api/owner', require(path.join(ROOT, 'routes/owner.js')));
app.use('/api/business', require(path.join(ROOT, 'routes/business-data.js')));
const server = app.listen(0, run);
const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
async function call(method, p, { token, body, headers = {} } = {}) {
    const res = await fetch(url(p), {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
const shop = () => T.entity.find((e) => e.slug === 'shop');

async function run() {
    try {
        console.log('\n── business.profile is writable through the contract (DECISIONS #96) ──');
        const tables = require(path.join(ROOT, 'lib/businessTables.js'));
        const profileCols = await tables.sectionColumns(await tables.sectionNamed('business.profile'));
        check('the read selects the slug and the owner-editable columns, never the governed ones', profileCols.includes('slug') && profileCols.includes('name') && profileCols.includes('address_line_1')
            && !profileCols.includes('is_active') && !profileCols.includes('rating') && !profileCols.includes('verified') && !profileCols.includes('stripe_customer_id'), profileCols.join(','));
        let r = await call('GET', '/api/business/business.profile');
        check('GET returns the record as one row', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].name === 'The Shop', `${r.status} ${JSON.stringify(r.body)}`);
        check('address_display is computed from the address columns (DECISIONS #100)', r.body.rows[0].address_display === '12 Main St, Gulf Shores, AL 36542', JSON.stringify(r.body.rows[0]));
        r = await call('PATCH', '/api/business/business.profile', { body: { name: 'The Shop & Co', phone: '' } });
        check('the owner PATCHes the record with no id (one record per business)', r.status === 200 && shop().name === 'The Shop & Co' && r.body.row.name === 'The Shop & Co', `${r.status} ${JSON.stringify(r.body)}`);
        check('an empty input is null, as PATCH /api/owner/profile stores it', shop().phone === null);
        check('the row comes back with address_display', r.body.row.address_display === '12 Main St, Gulf Shores, AL 36542', JSON.stringify(r.body.row));
        r = await call('PATCH', '/api/business/business.profile/shop', { body: { address_line_2: 'Suite 4' } });
        check('PATCH /:id works too when the id is this business\'s record', r.status === 200 && shop().address_line_2 === 'Suite 4' && r.body.row.address_display === '12 Main St, Suite 4, Gulf Shores, AL 36542', `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('PATCH', '/api/business/business.profile/other', { body: { name: 'Mine now' } });
        check('another business\'s record is not there', r.status === 404 && T.entity.find((e) => e.slug === 'other').name === 'Other', `${r.status}`);
        r = await call('PATCH', '/api/business/business.profile', { body: { name: 'Still', is_active: false } });
        check('a governed column is refused, by name, and nothing is written', r.status === 400 && /is_active/.test(r.body.error) && shop().is_active === true && shop().name === 'The Shop & Co', `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('PATCH', '/api/business/business.profile', { body: { rating: 5, stripe_customer_id: 'cus_x' } });
        check('so are rating and billing columns', r.status === 400 && /rating/.test(r.body.error) && shop().rating === 4.5, `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('PATCH', '/api/business/business.profile', { body: { slug: 'other', address_display: 'x', name: 'Round trip' } });
        check('a read row round-trips: slug and address_display are dropped, not refused', r.status === 200 && shop().name === 'Round trip' && shop().slug === 'shop' && !('address_display' in shop()), `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('PATCH', '/api/business/business.profile', { body: { address_display: 'x' } });
        check('with nothing left to change: 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('POST', '/api/business/business.profile', { body: { name: 'Second shop' } });
        check('POST is refused: the record exists once', r.status === 405 && T.entity.length === 2, `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('DELETE', '/api/business/business.profile/shop');
        check('DELETE is refused', r.status === 405 && T.entity.length === 2, `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('PATCH', '/api/business/menu.items', { body: { name: 'x' } });
        check('PATCH with no id on an ordinary section still needs the id', r.status === 400 && /id/.test(r.body.error), `${r.status} ${JSON.stringify(r.body)}`);

        console.log('\n── an installed app\'s token ──');
        r = await call('PATCH', '/api/business/business.profile', { token: 'gcr_mcp_writer', body: { name: 'By the app' } });
        check('business:write may PATCH the profile', r.status === 200 && shop().name === 'By the app', `${r.status} ${JSON.stringify(r.body)}`);
        r = await call('PATCH', '/api/business/business.profile', { token: 'gcr_mcp_reader', body: { name: 'Read only' } });
        check('business:read may not', r.status === 403 && shop().name === 'By the app', `${r.status}`);
        r = await call('GET', '/api/business/business.profile', { token: 'gcr_mcp_reader' });
        check('but reads it, with address_display', r.status === 200 && r.body.rows[0].address_display === '12 Main St, Suite 4, Gulf Shores, AL 36542', `${r.status} ${JSON.stringify(r.body)}`);

        console.log('\n── PATCH /api/owner/profile applies the same rule (one helper) ──');
        r = await call('PATCH', '/api/owner/profile', { body: { name: 'Owner route', is_active: false, nope: 1 } });
        check('the legacy route still ignores what it may not change and writes the rest', r.status === 200 && shop().name === 'Owner route' && shop().is_active === true && r.body.ignored.includes('is_active') && r.body.ignored.includes('nope'), `${r.status} ${JSON.stringify(r.body)}`);
        const fs = require('fs');
        const ownerSrc = fs.readFileSync(path.join(ROOT, 'routes/owner.js'), 'utf8');
        const dataSrc = fs.readFileSync(path.join(ROOT, 'routes/business-data.js'), 'utf8');
        check('neither route filters the entity columns itself: both call lib/businessTables.js ownerProfilePatch', /ownerProfilePatch/.test(ownerSrc) && /ownerProfilePatch/.test(dataSrc) && !/ownerEditableEntityColumns/.test(ownerSrc));
    } catch (e) {
        check('no exception', false, e.stack);
    }
    server.close();
    done('business-writes');
}
