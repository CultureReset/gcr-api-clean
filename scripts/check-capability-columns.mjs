#!/usr/bin/env node
/**
 * The capability map describes the tables; the SQL creates them. If those
 * two disagree, the failure is silent and awful: a form offers a field, the
 * write goes through Supabase, and Postgres rejects a column that does not
 * exist — at runtime, per business, with no warning until someone tries.
 *
 * So this parses `sql/capability_tables.sql` for the real column names and
 * checks every column the blueprint names actually exists. It does not check
 * types, which Postgres will catch anyway; it checks existence, which nothing
 * else does.
 *
 *   node scripts/check-capability-columns.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(join(here, '..', 'routes', 'x.js'));
const CAP = require_(join(here, '..', 'routes', 'capabilities.js'));

/* ── parse the SQL for `create table X ( … )` blocks ─────────────────── */

// Every SQL file, not just one: a capability's tables can be split across
// files — service periods live in menu_normalization.sql because they belong
// with the menu — and reading one file would report those as missing.
const sqlDir = join(here, '..', 'sql');
const sql = readdirSync(sqlDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(sqlDir, f), 'utf8'))
  .join('\n');
const tables = new Map();

for (const match of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const [, table, body] = match;
  const columns = new Set();
  for (const line of body.split('\n')) {
    const stripped = line.replace(/--.*$/, '').trim();
    if (!stripped) continue;
    // A column line starts with an identifier; constraints and keys do not.
    const m = /^(\w+)\s+/.exec(stripped);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (['primary', 'foreign', 'constraint', 'unique', 'check'].includes(name)) continue;
    columns.add(m[1]);
  }
  tables.set(table, columns);
}

if (tables.size === 0) {
  console.error('Parsed no tables from sql/*.sql — has their shape changed?');
  process.exit(1);
}

/* ── check every column the capability map names ──────────────────────── */

const problems = [];

function checkTable(label, table, columnNames, keyColumn) {
  const columns = tables.get(table);
  if (!columns) { problems.push(`${label}: table "${table}" is not in capability_tables.sql`); return; }
  if (keyColumn && !columns.has(keyColumn)) problems.push(`${label}: key column "${keyColumn}" is not on ${table}`);
  for (const name of columnNames) {
    if (!columns.has(name)) problems.push(`${label}: ${table}.${name} does not exist`);
  }
}

let checked = 0;
for (const [key, capability] of Object.entries(CAP.CAPABILITIES)) {
  const names = Object.keys(capability.columns);
  checked += names.length;
  checkTable(key, capability.table, names, capability.key);

  for (const child of capability.children || []) {
    const childNames = Object.keys(child.columns);
    checked += childNames.length;
    checkTable(`${key}.${child.label}`, child.table, childNames, child.fk);
  }
  if (capability.amenities) {
    checkTable(`${key}.amenities`, capability.amenities.join, ['amenity_id'], capability.amenities.fk);
  }
}

for (const [key, list] of Object.entries(CAP.ENTITY_LISTS)) {
  checkTable(`entity.${key}`, list.join, [list.catalogFk], 'entity_slug');
  if (!tables.get(list.catalog)) problems.push(`entity.${key}: catalog "${list.catalog}" is not in capability_tables.sql`);
}

console.log(`Tables in SQL:      ${tables.size}`);
console.log(`Columns described:  ${checked}`);

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  process.exit(1);
}
console.log('\nOK — every column the capability map names exists in the SQL.');
