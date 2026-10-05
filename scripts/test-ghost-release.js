'use strict';
// Release selection uses existing entitlement decisions; no production network.
const assert = require('node:assert/strict');
const path = require('node:path');
const dbPath = require.resolve('../db');
const audiencePath = require.resolve('../lib/audience');
const entPath = require.resolve('../lib/entitlements');
let tables;
const db = { from(name) {
    let rows = [...(tables[name] || [])];
    const query = {
        select() { return query; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return query; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return query; },
        order() { return query; },
        range(start, end) { return Promise.resolve({data:rows.slice(start,end+1),error:null}); },
    };
    return query;
} };
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:db };
// Exercise the real shared entitlement function, but supply account context
// without a live billing database.
const ent = require('../lib/entitlements');
ent.contextFor = async () => ({decide:item=>ent.decide({item,planItemIds:new Set(),grant:null})});
const {validateRelease,releasesFor}=require('../lib/ghostRelease');
function manifest(commit='a'.repeat(40)) { return {ghost_release:{plan:JSON.stringify({schema_version:1,modules:[{id:'nextgent-maps',repo:'https://git.example/maps',ref:'main',commit}]}),signature:'-----BEGIN SSH SIGNATURE-----\nfixture\n-----END SSH SIGNATURE-----'}}; }
function fixture() {
    tables={store_installs:[{id:'i',entity_slug:'business-a',item_id:'maps',status:'installed',version:1,granted_permissions:['android.settings']}],store_items:[{id:'maps',key:'maps',kind:'map',status:'published',access:'free'}],store_versions:[{id:'v',item_id:'maps',version:1,semver:'1.0.0',permissions:['android.settings'],manifest:manifest()}]};
}
(async()=>{
    assert.equal(validateRelease({},'map'),null);
    assert.equal(validateRelease(manifest(),'map').sha256.length,64);
    assert.throws(()=>validateRelease(manifest('main'),'map'),/pinned commit/);
    assert.throws(()=>validateRelease(manifest(),'app'),/map or box_release/);
    fixture(); assert.equal((await releasesFor('business-a')).length,1); assert.equal((await releasesFor('business-b')).length,0);
    tables.store_versions[0].permissions.push('android.sms'); assert.deepEqual(await releasesFor('business-a'),[]);
    fixture(); tables.store_items[0].status='archived'; assert.deepEqual(await releasesFor('business-a'),[]);
    fixture(); tables.store_installs[0].offered_version=2; tables.store_versions.push({...tables.store_versions[0],id:'v2',version:2,manifest:manifest('b'.repeat(40))}); assert.equal((await releasesFor('business-a'))[0].version,1);
    fixture(); tables.store_installs.push({...tables.store_installs[0],id:'i2',item_id:'box'}); tables.store_items.push({...tables.store_items[0],id:'box',kind:'box_release'}); tables.store_versions.push({...tables.store_versions[0],id:'v2',item_id:'box',manifest:manifest('c'.repeat(40))});
    await assert.rejects(releasesFor('business-a'),{status:409});
    console.log('PASS: signed manifest shape, commit pin, business scope, permission escalation, archived items, installed vs offered version, conflicting plans');
})().catch(err=>{console.error(err);process.exitCode=1;});
