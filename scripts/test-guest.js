// Guest trial clock — pure logic, DB stubbed.  npm run test:guest
const path = require('path');
const Module = require('module');
const store = {};
const dbStub = { from: () => {
  let id; const q = {
    select: () => q, eq: (_c, v) => { id = v; return q; },
    maybeSingle: async () => ({ data: store[id] || null }),
    upsert: async (row) => { store[row.guest_id] = row; return { error: null }; },
  }; return q; } };
const realLoad = Module._load;
Module._load = function (req, parent, ...r) {
  if (req === '../db' && parent && parent.filename.includes(path.join('lib', 'guestUsage'))) return dbStub;
  return realLoad.call(this, req, parent, ...r);
};
process.env.GUEST_TRIAL_MS = String(10 * 60 * 1000);
const g = require('../lib/guestUsage');
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };
(async () => {
  t('negative/garbage delta adds nothing', g.clampDelta(-5) === 0 && g.clampDelta('x') === 0);
  t('one beat is capped at 60s', g.clampDelta(10 * 60 * 1000) === 60000);
  t('fresh guest is allowed', g.statusFrom(null).signin_required === false);
  t('merged guest must sign in', g.statusFrom({ used_ms: 0, merged_into: 'u' }).signin_required === true);
  const id = '11111111-1111-4111-8111-111111111111';
  let s;
  for (let i = 0; i < 9; i++) s = await g.recordUsage(id, { deltaMs: 60000 });
  t('9 min used, still allowed', s.used_ms === 540000 && !s.signin_required);
  s = await g.recordUsage(id, { deltaMs: 999999, chat: true });
  t('10 min used, sign-in required', s.used_ms === 600000 && s.signin_required && s.remaining_ms === 0);
  t('chat turns counted', store[id].chat_count === 1);
  t('first_seen kept across beats', !!store[id].first_seen);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
