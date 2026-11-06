#!/usr/bin/env node
/**
 * mark-applied.mjs — Mark evaluated offers as Applied in applications.md
 *
 * Flips the Status column of one or more tracker rows to the canonical
 * `Applied` state (see templates/states.yml). Use it after you have
 * manually submitted an application for a job that already has a report.
 *
 * Rows are matched by the REPORT number — the number in the Report-link
 * column, e.g. [1453](../reports/1453-affirm-2026-06-18.md) → 1453.
 * NOTE: this is the report number (and report filename), which can differ
 * from the tracker's own `#` column. Always pass the report numbers you
 * see in reports/ and in scan/pipeline summaries.
 *
 * The Date column is left untouched (it records when the offer was
 * evaluated); the apply date is recorded in the Notes column instead,
 * matching how existing Applied rows are kept.
 *
 * Usage:
 *   node mark-applied.mjs <reportNum> [<reportNum> ...] [options]
 *
 * Options:
 *   --date YYYY-MM-DD   Apply date to record in Notes (default: today)
 *   --note "text"       Extra note appended after the Applied tag
 *   --dry-run           Show what would change without writing
 *   --json              Emit a machine-readable JSON summary
 *
 * Examples:
 *   node mark-applied.mjs 1453 1464
 *   node mark-applied.mjs 1461 --date 2026-06-17 --note "via referral, tailored PDF"
 *   node mark-applied.mjs 1453 --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');

// -- Parse args --
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
let date = new Date().toISOString().slice(0, 10);
let extraNote = '';
const nums = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run' || a === '--json') continue;
  else if (a === '--date') date = (argv[++i] || '').trim();
  else if (a === '--note') extraNote = (argv[++i] || '').trim();
  else if (/^#?\d+$/.test(a)) nums.push(a.replace(/^#/, ''));
  else console.error(`⚠️  Ignoring unrecognized argument: ${a}`);
}

if (nums.length === 0) {
  console.error('Usage: node mark-applied.mjs <reportNum> [<reportNum> ...] [--date YYYY-MM-DD] [--note "..."] [--dry-run] [--json]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`❌ Invalid --date "${date}". Expected YYYY-MM-DD.`);
  process.exit(1);
}
if (!existsSync(APPS_FILE)) {
  console.error(`❌ Tracker not found: ${APPS_FILE}`);
  process.exit(1);
}

const lines = readFileSync(APPS_FILE, 'utf8').split('\n');

// Extract the report number from a Report-column cell.
// Prefer the number in the path (reports/NNN-...), fall back to link text [NNN].
function reportNumOf(cell) {
  const p = cell.match(/reports\/(\d+)-/);
  if (p) return p[1];
  const t = cell.match(/\[(\d+)\]/);
  return t ? t[1] : null;
}

// Index every data row by its report number. A row has 8 fixed columns
// (# Date Company Role Score Status PDF Report) plus a Notes column that
// may itself contain "|" — so we keep the first 8 and rejoin the rest.
const rowsByNum = new Map();
lines.forEach((line, idx) => {
  if (!line.startsWith('|')) return;
  const parts = line.split('|').slice(1, -1).map((c) => c.trim());
  if (parts.length < 9) return;
  if (parts[0] === '#' || /^[-:\s]+$/.test(parts[0])) return; // header / separator
  const fixed = parts.slice(0, 8);
  const notes = parts.slice(8).join(' | ');
  const rNum = reportNumOf(fixed[7]);
  if (!rNum) return;
  if (!rowsByNum.has(rNum)) rowsByNum.set(rNum, []);
  rowsByNum.get(rNum).push({ idx, fixed, notes });
});

const results = [];
let changed = 0;

for (const num of nums) {
  const matches = rowsByNum.get(num);
  if (!matches || matches.length === 0) {
    results.push({ num, action: 'not-found' });
    continue;
  }
  if (matches.length > 1) {
    results.push({ num, action: 'ambiguous', companies: matches.map((m) => m.fixed[2]) });
    continue;
  }
  const row = matches[0];
  const company = row.fixed[2];
  const role = row.fixed[3];
  const prev = row.fixed[5];
  if (/^applied$/i.test(prev)) {
    results.push({ num, action: 'already', company, role });
    continue;
  }
  row.fixed[5] = 'Applied';
  const tag = extraNote ? `Applied ${date} — ${extraNote}` : `Applied ${date}`;
  row.notes = row.notes ? `${tag}. ${row.notes}` : tag;
  lines[row.idx] = '| ' + row.fixed.join(' | ') + ' | ' + row.notes + ' |';
  results.push({ num, action: 'applied', company, role, prev });
  changed++;
}

// -- Report --
if (JSON_OUT) {
  console.log(JSON.stringify({ date, changed, dryRun: DRY, results }, null, 2));
} else {
  for (const r of results) {
    if (r.action === 'applied') console.log(`✅ #${r.num} ${r.company} — ${r.role} : ${r.prev} → Applied`);
    else if (r.action === 'already') console.log(`⏭️  #${r.num} ${r.company} — already Applied (no change)`);
    else if (r.action === 'not-found') console.log(`❌ #${r.num} — no tracker row with that report number`);
    else if (r.action === 'ambiguous') console.log(`⚠️  #${r.num} — matches multiple rows (${r.companies.join(', ')}); fix manually`);
  }
}

if (DRY) {
  if (!JSON_OUT) console.log(`\n(dry-run) ${changed} row(s) would be marked Applied. Nothing written.`);
  process.exit(0);
}

if (changed > 0) {
  writeFileSync(APPS_FILE, lines.join('\n'));
  if (!JSON_OUT) console.log(`\n💾 ${changed} row(s) marked Applied in ${APPS_FILE.replace(CAREER_OPS + '/', '')}.`);
} else if (!JSON_OUT) {
  console.log(`\nNo changes written.`);
}
