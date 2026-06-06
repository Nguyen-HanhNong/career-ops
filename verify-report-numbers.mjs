#!/usr/bin/env node
/**
 * verify-report-numbers.mjs
 *
 * After a pipeline run, checks that every entry in data/applications.md that
 * has a report link points to a file that actually exists in reports/.
 * Also checks the inverse: every report file in reports/ is referenced in
 * applications.md (or at least not orphaned).
 *
 * Usage:
 *   node verify-report-numbers.mjs              # check all entries
 *   node verify-report-numbers.mjs --recent 20  # check last N entries only
 *   node verify-report-numbers.mjs --fix        # rename orphaned report files
 *                                               # to match their applications.md #
 */

import { readFileSync, existsSync, readdirSync, renameSync } from 'fs';
import path from 'path';

const APPLICATIONS_PATH = 'data/applications.md';
const REPORTS_DIR = 'reports';

const args = process.argv.slice(2);
const recentFlag = args.indexOf('--recent');
const recentN = recentFlag !== -1 ? parseInt(args[recentFlag + 1], 10) : null;
const fixMode = args.includes('--fix');

// ── Parse applications.md ───────────────────────────────────────────

function parseTracker() {
  if (!existsSync(APPLICATIONS_PATH)) {
    console.error('Error: data/applications.md not found');
    process.exit(1);
  }

  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const entries = [];

  for (const line of text.split('\n')) {
    // Match tracker table rows: | # | date | company | role | score | status | pdf | report | notes |
    const m = line.match(/^\|\s*(\d+)\s*\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|\s*\[(\d+)\]\(([^)]+)\)/);
    if (!m) continue;
    entries.push({
      appNum: parseInt(m[1], 10),
      reportNum: parseInt(m[2], 10),
      reportPath: m[3].trim(),   // e.g. reports/563-waymo-swe-2026-06-01.md
    });
  }

  return entries;
}

// ── Get all report files ────────────────────────────────────────────

function getReportFiles() {
  if (!existsSync(REPORTS_DIR)) return new Set();
  return new Set(
    readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep')
      .map(f => `${REPORTS_DIR}/${f}`)
  );
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const allEntries = parseTracker();
  const entries = recentN ? allEntries.slice(-recentN) : allEntries;
  const reportFiles = getReportFiles();

  const missing = [];      // report link in tracker but file doesn't exist
  const mismatched = [];   // appNum ≠ reportNum (cosmetic mismatch)
  const orphaned = [];     // report file exists but not referenced in tracker

  // Check tracker entries
  for (const entry of entries) {
    const exists = existsSync(entry.reportPath) || reportFiles.has(entry.reportPath);
    if (!exists) {
      missing.push(entry);
    }
    if (entry.appNum !== entry.reportNum) {
      mismatched.push(entry);
    }
  }

  // Check for orphaned report files (files not referenced by any tracker entry)
  const referencedPaths = new Set(allEntries.map(e => e.reportPath));
  for (const f of reportFiles) {
    if (!referencedPaths.has(f)) {
      orphaned.push(f);
    }
  }

  // ── Report ──────────────────────────────────────────────────────

  const total = entries.length;
  const ok = total - missing.length;

  console.log(`\nReport Number Verification`);
  console.log(`${'─'.repeat(40)}`);
  console.log(`Entries checked:   ${total}${recentN ? ` (last ${recentN})` : ''}`);
  console.log(`Files found:       ${ok}`);
  console.log(`Missing files:     ${missing.length}`);
  console.log(`# mismatches:      ${mismatched.length} (cosmetic — links still work)`);
  console.log(`Orphaned reports:  ${orphaned.length} (files with no tracker entry)`);

  if (missing.length > 0) {
    console.log(`\n❌ Missing report files (link in tracker but file not on disk):`);
    for (const e of missing) {
      console.log(`  App #${e.appNum} → [${e.reportNum}](${e.reportPath})  ← FILE NOT FOUND`);
    }
  }

  if (mismatched.length > 0) {
    console.log(`\n⚠️  App# / Report# mismatches (cosmetic, link still works):`);
    for (const e of mismatched) {
      console.log(`  App #${e.appNum} links to report file #${e.reportNum} — ${path.basename(e.reportPath)}`);
    }
    if (!fixMode) {
      console.log(`  → Run with --fix to rename report files to match their App#`);
    }
  }

  if (orphaned.length > 0 && orphaned.length <= 20) {
    console.log(`\n📂 Orphaned report files (on disk but not in tracker):`);
    for (const f of orphaned) {
      console.log(`  ${f}`);
    }
  } else if (orphaned.length > 20) {
    console.log(`\n📂 ${orphaned.length} orphaned report files (run without --recent to see all)`);
  }

  // ── Fix mode: rename report files to match App# ─────────────────

  if (fixMode && mismatched.length > 0) {
    console.log(`\n🔧 Fixing mismatches (renaming report files to match App#)...`);
    let fixed = 0;
    for (const e of mismatched) {
      const oldPath = e.reportPath;
      if (!existsSync(oldPath)) continue;

      // Build new filename: replace leading number with appNum
      const filename = path.basename(oldPath);
      const newFilename = filename.replace(/^\d+/, String(e.appNum).padStart(3, '0'));
      const newPath = path.join(REPORTS_DIR, newFilename);

      if (oldPath === newPath) continue;
      if (existsSync(newPath)) {
        console.log(`  ⚠️  Skip #${e.appNum}: ${newPath} already exists`);
        continue;
      }

      renameSync(oldPath, newPath);
      console.log(`  ✅ #${e.appNum}: ${filename} → ${newFilename}`);
      fixed++;
    }
    console.log(`Fixed ${fixed} file(s). Re-run without --fix to verify.`);
  }

  if (missing.length === 0 && mismatched.length === 0) {
    console.log(`\n✅ All report links verified — numbers match.`);
  }

  process.exit(missing.length > 0 ? 1 : 0);
}

main();
