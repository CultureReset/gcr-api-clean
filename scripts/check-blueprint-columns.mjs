#!/usr/bin/env node
/**
 * The blueprint describes the industry tables; the SQL creates them. If those
 * two disagree, the failure is silent and awful: a form offers a field, the
 * write goes through Supabase, and Postgres rejects a column that does not
 * exist — at runtime, per business, with no warning until someone tries.
 *
 * So this parses `sql/industry_tables.sql` for the real column names and
 * checks every column the blueprint names actually exists. It does not check
 * types, which Postgres will catch anyway; it checks existence, which nothing
 * else does.
 *
 *   node scripts/check-blueprint-columns.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(join(here, '..', 'routes', 'x.js'));
const BP = require_(join(here, '..', 'routes', 'industry-blueprints.js'));

/* ── parse the SQL for `create table X ( … )` blocks ─────────────────── */

const sql = readFileSync(join(here, '..', 'sql', 'industry_tables.sql'), 'utf8');
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
  console.error('Parsed no tables from sql/industry_tables.sql — has its shape changed?');
  process.exit(1);
}

/* ── check every column the blueprint names ──────────────────────────── */

const problems = [];

function checkSpec(vertical, level, spec) {
  if (!spec) return;
  const columns = tables.get(spec.table);
  if (!columns) {
    problems.push(`${vertical}.${level}: table "${spec.table}" is not in industry_tables.sql`);
    return;
  }
  if (!columns.has(spec.key)) {
    problems.push(`${vertical}.${level}: key column "${spec.key}" is not on ${spec.table}`);
  }
  for (const name of Object.keys(spec.columns)) {
    if (!columns.has(name)) problems.push(`${vertical}.${level}: ${spec.table}.${name} does not exist`);
  }
  if (spec.parentFk && !columns.has(spec.parentFk)) {
    problems.push(`${vertical}.${level}: ${spec.table}.${spec.parentFk} (parent FK) does not exist`);
  }
  for (const coll of spec.collections || []) {
    const collColumns = tables.get(coll.table);
    if (!collColumns) {
      problems.push(`${vertical}.${level}: collection table "${coll.table}" is not in industry_tables.sql`);
      continue;
    }
    if (!collColumns.has(coll.fk)) problems.push(`${vertical}.${level}: ${coll.table}.${coll.fk} (fk) does not exist`);
    for (const name of Object.keys(coll.columns)) {
      if (!collColumns.has(name)) problems.push(`${vertical}.${level}: ${coll.table}.${name} does not exist`);
    }
  }
  for (const tag of spec.tags || []) {
    const joinColumns = tables.get(tag.join);
    if (!joinColumns) { problems.push(`${vertical}.${level}: tag join "${tag.join}" is not in industry_tables.sql`); continue; }
    for (const fk of [tag.fk, tag.catalogFk]) {
      if (!joinColumns.has(fk)) problems.push(`${vertical}.${level}: ${tag.join}.${fk} does not exist`);
    }
    if (!tables.get(tag.catalog)) problems.push(`${vertical}.${level}: catalog "${tag.catalog}" is not in industry_tables.sql`);
  }
  if (spec.amenities) {
    const joinColumns = tables.get(spec.amenities.join);
    if (!joinColumns) problems.push(`${vertical}.${level}: amenity join "${spec.amenities.join}" is not in industry_tables.sql`);
    else if (!joinColumns.has(spec.amenities.fk)) {
      problems.push(`${vertical}.${level}: ${spec.amenities.join}.${spec.amenities.fk} does not exist`);
    }
  }
}

let checked = 0;
for (const [vertical, schema] of Object.entries(BP.SCHEMAS)) {
  for (const level of ['listing', 'unit']) {
    if (schema[level]) checked += Object.keys(schema[level].columns).length;
    checkSpec(vertical, level, schema[level]);
  }
}

console.log(`Tables in SQL:      ${tables.size}`);
console.log(`Columns described:  ${checked}`);

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  process.exit(1);
}
console.log('\nOK — every column the blueprint names exists in the SQL.');
