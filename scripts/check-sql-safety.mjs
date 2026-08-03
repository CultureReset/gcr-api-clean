#!/usr/bin/env node
/**
 * No SQL file in this repo may destroy data.
 *
 * The tables here hold a live business's menu, its bookings and its calendar.
 * A `drop table`, a `drop column` or a `truncate` that reaches production is
 * not a bug you fix forward from. So rather than promising it in a comment,
 * this fails the build if one appears.
 *
 * Allowed: create table if not exists, add column if not exists, create index,
 * inserts with on-conflict-do-nothing, and `drop policy if exists` immediately
 * before recreating an RLS policy — which touches no rows.
 *
 *   node scripts/check-sql-safety.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/** Statements that destroy data or change a column's shape under live rows. */
const FORBIDDEN = [
  { re: /\bdrop\s+table\b/i, what: 'drop table' },
  { re: /\bdrop\s+schema\b/i, what: 'drop schema' },
  { re: /\btruncate\b/i, what: 'truncate' },
  { re: /\balter\s+table[\s\S]{0,120}?\bdrop\s+column\b/i, what: 'drop column' },
  { re: /\balter\s+table[\s\S]{0,120}?\balter\s+column[\s\S]{0,60}?\btype\b/i, what: 'alter column type' },
  { re: /\bdelete\s+from\b/i, what: 'delete from' },
  { re: /\bdrop\s+database\b/i, what: 'drop database' },
];

const problems = [];
let scanned = 0;

for (const file of readdirSync(sqlDir).filter((f) => f.endsWith('.sql'))) {
  scanned += 1;
  const raw = readFileSync(join(sqlDir, file), 'utf8');
  // Strip comments so prose about "we do not drop tables" is not a finding.
  const sql = raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  for (const rule of FORBIDDEN) {
    if (rule.re.test(sql)) problems.push(`${file}: ${rule.what}`);
  }
}

console.log(`SQL files scanned: ${scanned}`);

if (problems.length) {
  console.log(`\n${problems.length} destructive statement${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nThese tables hold live data. Add, do not replace.');
  process.exit(1);
}
console.log('OK — no SQL file drops a table, a column or a row.');
