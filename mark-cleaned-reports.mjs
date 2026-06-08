#!/usr/bin/env node
/**
 * mark-cleaned-reports.mjs — Sync "report cleaned" markers in the tracker.
 *
 * Report files in reports/ are gitignored and intentionally ephemeral: the
 * `cleanup` mode deletes every report not from today. This script keeps the
 * tracker (data/applications.md) honest about which reports are still on disk
 * by annotating the Report column:
 *
 *   - report file ON disk    → no marker (e.g. `[811](../reports/811-...md)`)
 *   - report file NOT on disk → append ` 🧹` (e.g. `[750](../reports/750-...md) 🧹`)
 *
 * The marker is appended AFTER the markdown link, so every existing consumer
 * (merge-tracker extractReportNum `\[(\d+)\]`, link normalizers, verify-pipeline,
 * verify-report-numbers) keeps working — they all parse the `[num](path)` part.
 *
 * Idempotent: re-running adds/removes markers only as disk state changes, so a
 * report regenerated under the same number automatically loses its marker.
 *
 * Run:
 *   node mark-cleaned-reports.mjs          # update the tracker in place
 *   node mark-cleaned-reports.mjs --check  # report counts only, write nothing
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');

const CHECK_ONLY = process.argv.includes('--check');
const MARKER = '🧹';

if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found — nothing to mark.');
  process.exit(0);
}

const TRACKER_DIR = dirname(APPS_FILE);
const reportExists = (link) =>
  existsSync(join(TRACKER_DIR, link)) || existsSync(join(CAREER_OPS, link));

const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

let marked = 0;     // newly absent → marker added
let unmarked = 0;   // back on disk → marker removed
let alreadyClean = 0; // absent and already marked
let present = 0;     // on disk, no marker

const out = lines.map((line) => {
  if (!line.startsWith('|')) return line;
  // Locate the report cell: a markdown link [num](path) somewhere in the row.
  const linkMatch = line.match(/\[(\d+)\]\(([^)]+)\)/);
  if (!linkMatch) return line;

  const link = linkMatch[2].trim();
  const onDisk = reportExists(link);

  // Does the report cell already carry a marker? (look just after the link)
  // Cell text from the link to the next pipe.
  const afterLinkIdx = line.indexOf(linkMatch[0]) + linkMatch[0].length;
  const nextPipeIdx = line.indexOf('|', afterLinkIdx);
  const tail = line.slice(afterLinkIdx, nextPipeIdx === -1 ? undefined : nextPipeIdx);
  const hasMarker = tail.includes(MARKER);

  if (onDisk) {
    present++;
    if (hasMarker) {
      // Report came back (regenerated) → strip the marker from the tail.
      unmarked++;
      const cleanedTail = tail.replace(new RegExp(`\\s*${MARKER}\\s*`, 'g'), ' ').replace(/\s+$/, '');
      return line.slice(0, afterLinkIdx) + cleanedTail + line.slice(nextPipeIdx === -1 ? line.length : nextPipeIdx);
    }
    return line;
  }

  // Not on disk → ensure marker present.
  if (hasMarker) { alreadyClean++; return line; }
  marked++;
  // Insert ` 🧹` immediately after the link, before any existing tail/space.
  const insertAt = afterLinkIdx;
  return line.slice(0, insertAt) + ` ${MARKER}` + line.slice(insertAt);
});

const summary = `📊 Reports: ${present} on disk, ${marked + alreadyClean} cleaned (${marked} newly marked, ${alreadyClean} already marked)` +
  (unmarked ? `, ${unmarked} marker(s) removed (report back on disk)` : '');

if (CHECK_ONLY) {
  console.log(summary);
  console.log('(--check: no changes written)');
  process.exit(0);
}

if (marked === 0 && unmarked === 0) {
  console.log(summary);
  console.log('✅ Tracker already in sync — no changes.');
  process.exit(0);
}

writeFileSync(APPS_FILE, out.join('\n'));
console.log(summary);
console.log(`✅ Updated ${APPS_FILE}`);
