#!/usr/bin/env node

/**
 * linkedin-alerts.mjs — Deterministic parser for LinkedIn job-alert emails.
 *
 * Hop 0 of the two-hop LinkedIn ingestion (see modes/scan.md, Nivel 4). The agent
 * reads LinkedIn alert emails out of Gmail via the Gmail MCP and pipes the raw
 * HTML/text body to this script. This script does the boring, testable part —
 * extract each job card's { jobId, title, company, location }, dedup by jobId,
 * and build the public guest-endpoint URL — so the agent doesn't burn tokens
 * eyeballing tracking-laden HTML. Resolution to the real JD (company ATS first,
 * guest endpoint as fallback) is Hop 1 and stays in the agent/mode layer.
 *
 * Zero Claude API tokens — pure regex over text the agent already has.
 *
 * Usage:
 *   node linkedin-alerts.mjs                 # parse email body from stdin -> JSON
 *   node linkedin-alerts.mjs --file mail.html# parse one file -> JSON
 *   node linkedin-alerts.mjs a.html b.html   # parse + merge several files (dedup by jobId)
 *   node linkedin-alerts.mjs --guest-url ID  # print the guest endpoint URL for a jobId
 *   node linkedin-alerts.mjs --seen 12,34    # drop these jobIds from the output
 *   node linkedin-alerts.mjs --self-test     # run built-in fixtures, exit 0/1
 *   node linkedin-alerts.mjs --help
 *
 * Output: JSON array on stdout, one object per unique job:
 *   { "jobId": "4012345678", "title": "...", "company": "...",
 *     "location": "...", "guestUrl": "https://www.linkedin.com/jobs-guest/..." }
 */

import { readFileSync } from 'fs';

// ── Guest endpoint ──────────────────────────────────────────────────
// Public, logged-out rendering LinkedIn itself serves to anonymous users.
// Used only as Hop-1 fallback when no company ATS posting is found.
const GUEST_ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

export function guestUrl(jobId) {
  return `${GUEST_ENDPOINT}${jobId}`;
}

// ── HTML helpers ────────────────────────────────────────────────────

// Strip tags, decode the handful of entities LinkedIn actually emits, and
// collapse whitespace. Good enough for card text; we never render this.
export function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&middot;|&#0?183;/gi, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

// A jobId is the canonical key. LinkedIn embeds it three ways across alert
// emails; all of them contain the digits we want.
//   .../jobs/view/4012345678/...        (and /comm/jobs/view/ — superset match)
//   ...?currentJobId=4012345678...
const VIEW_RE = /\/jobs\/view\/(\d{6,})/g;
const CURRENT_RE = /[?&]currentJobId=(\d{6,})/g;

// A job card: an <a> whose href points at /jobs/view/{id}. Capture the anchor
// text (the title) and the id. `s` so inner <span>s don't break the match.
const CARD_RE =
  /<a\b[^>]*href="[^"]*\/jobs\/view\/(\d{6,})[^"]*"[^>]*>(.*?)<\/a>/gis;

// Company · Location is the most common single-line layout in alert cards.
const MIDDOT_SPLIT = /\s*[·|•]\s*/;

/**
 * Split a card's trailing HTML into block-level text lines. We split on closing
 * block tags BEFORE stripping, because stripTags collapses whitespace and would
 * otherwise fuse "Beta Labs" and "Remote, US" into one line.
 */
function tailLines(tailHtml) {
  return tailHtml
    .split(/<\/(?:p|div|li|tr|h[1-6]|span|td)>/gi)
    .map((seg) => stripTags(seg))
    .filter(Boolean);
}

/**
 * Best-effort company/location for one card, from its block lines. LinkedIn is
 * not consistent here, so this is heuristic by design — the agent can refine
 * from the email or, ultimately, from the resolved JD. Never fails the parse.
 */
function extractCompanyLocation(lines) {
  const out = { company: '', location: '' };
  if (!lines.length) return out;
  // Prefer an explicit "Company · Location" segment.
  for (const line of lines) {
    if (MIDDOT_SPLIT.test(line)) {
      const [company, ...rest] = line.split(MIDDOT_SPLIT);
      out.company = (company || '').trim();
      out.location = rest.join(' · ').trim();
      return out;
    }
  }
  // Fall back to the first two non-empty segments: company then location.
  if (lines[0]) out.company = lines[0];
  if (lines[1]) out.location = lines[1];
  return out;
}

/**
 * Parse one email body (HTML or pre-stripped text) into job records.
 * Dedup is by jobId; the first occurrence wins but later occurrences backfill
 * any missing title/company/location.
 */
export function parseAlerts(body) {
  const records = new Map(); // jobId -> record (insertion order preserved)

  if (typeof body !== 'string' || !body) return [];

  // Pass 1 — anchor cards give us the richest data (title + nearby text).
  // Re-segment on the raw HTML so each card's "tail" stops at the next card.
  const cardMatches = [...body.matchAll(CARD_RE)];
  for (let i = 0; i < cardMatches.length; i++) {
    const m = cardMatches[i];
    const jobId = m[1];
    const title = stripTags(m[2] || '');
    const start = m.index + m[0].length;
    const end = i + 1 < cardMatches.length ? cardMatches[i + 1].index : body.length;
    const { company, location } = extractCompanyLocation(tailLines(body.slice(start, end)));
    upsert(records, jobId, { title, company, location });
  }

  // Pass 2 — sweep for any jobIds that never appeared as a titled anchor
  // (digest "view all" links, currentJobId search URLs). They still deserve a
  // pipeline entry; the agent resolves identity from the jobId alone.
  for (const re of [VIEW_RE, CURRENT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (!records.has(m[1])) upsert(records, m[1], {});
    }
  }

  return [...records.values()];
}

function upsert(map, jobId, fields) {
  const existing = map.get(jobId);
  if (!existing) {
    map.set(jobId, {
      jobId,
      title: fields.title || '',
      company: fields.company || '',
      location: fields.location || '',
      guestUrl: guestUrl(jobId),
    });
    return;
  }
  // Backfill only — don't clobber data captured from a richer occurrence.
  if (!existing.title && fields.title) existing.title = fields.title;
  if (!existing.company && fields.company) existing.company = fields.company;
  if (!existing.location && fields.location) existing.location = fields.location;
}

// ── CLI ─────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

const HELP = `linkedin-alerts.mjs — parse LinkedIn job-alert emails into job records.

  node linkedin-alerts.mjs                  parse stdin -> JSON
  node linkedin-alerts.mjs --file mail.html parse a file -> JSON
  node linkedin-alerts.mjs a.html b.html    parse + merge files (dedup by jobId)
  node linkedin-alerts.mjs --guest-url ID   print the guest URL for a jobId
  node linkedin-alerts.mjs --seen 12,34     omit these jobIds from output
  node linkedin-alerts.mjs --self-test      run fixtures (exit 0 pass / 1 fail)
  node linkedin-alerts.mjs --help

Hop 0 of LinkedIn ingestion. The agent supplies the email body (read via the
Gmail MCP). Resolution to the full JD is Hop 1 — see modes/pipeline.md.`;

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  if (args.includes('--self-test')) {
    return selfTest();
  }

  const guestIdx = args.indexOf('--guest-url');
  if (guestIdx !== -1) {
    const id = args[guestIdx + 1];
    if (!id || !/^\d{6,}$/.test(id)) {
      console.error('--guest-url requires a numeric jobId');
      return 1;
    }
    console.log(guestUrl(id));
    return 0;
  }

  const seen = new Set();
  const seenIdx = args.indexOf('--seen');
  if (seenIdx !== -1 && args[seenIdx + 1]) {
    for (const id of args[seenIdx + 1].split(',')) seen.add(id.trim());
  }

  // Collect bodies: explicit --file values + bare positional paths, else stdin.
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') {
      if (args[i + 1]) files.push(args[++i]);
    } else if (args[i] === '--seen') {
      i++; // skip its value
    } else if (!args[i].startsWith('-')) {
      files.push(args[i]);
    }
  }

  let body = '';
  if (files.length) {
    for (const f of files) {
      try {
        body += '\n' + readFileSync(f, 'utf-8');
      } catch (e) {
        console.error(`cannot read ${f}: ${e.message}`);
        return 1;
      }
    }
  } else {
    body = readStdin();
  }

  const records = parseAlerts(body).filter((r) => !seen.has(r.jobId));
  console.log(JSON.stringify(records, null, 2));
  return 0;
}

// ── Self-test ───────────────────────────────────────────────────────

function selfTest() {
  let failed = 0;
  const check = (name, cond) => {
    if (cond) {
      console.log(`  ✅ ${name}`);
    } else {
      console.log(`  ❌ ${name}`);
      failed++;
    }
  };

  // Fixture: a trimmed-down but structurally real LinkedIn alert with two cards
  // (one "Company · Location" line, one split lines) plus a tracking duplicate
  // of the first job and a bare currentJobId search link.
  const fixture = `
  <table><tr><td>
    <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trk=eml-jobs_alert">
      <span>Senior AI Engineer</span>
    </a>
    <p>Acme Corp &middot; San Francisco, CA (Remote)</p>
  </td></tr>
  <tr><td>
    <a href="https://www.linkedin.com/jobs/view/4099887766/?refId=xyz">Forward Deployed Engineer</a>
    <p>Beta Labs</p>
    <p>Remote, United States</p>
  </td></tr>
  <tr><td>
    <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trk=eml-dup">see this job again</a>
  </td></tr></table>
  <a href="https://www.linkedin.com/jobs/search/?currentJobId=4055000111&trk=eml">View all 12 jobs</a>`;

  const recs = parseAlerts(fixture);
  const byId = Object.fromEntries(recs.map((r) => [r.jobId, r]));

  check('finds 3 unique jobIds', recs.length === 3);
  check('dedups the repeated jobId', recs.filter((r) => r.jobId === '4012345678').length === 1);
  check('extracts title from anchor', byId['4012345678']?.title === 'Senior AI Engineer');
  check('extracts company from "·" line', byId['4012345678']?.company === 'Acme Corp');
  check('extracts location from "·" line',
    byId['4012345678']?.location === 'San Francisco, CA (Remote)');
  check('extracts split-line company', byId['4099887766']?.company === 'Beta Labs');
  check('extracts split-line location', byId['4099887766']?.location === 'Remote, United States');
  check('picks up currentJobId search link', !!byId['4055000111']);
  check('guest URL is well-formed',
    byId['4012345678']?.guestUrl === `${GUEST_ENDPOINT}4012345678`);

  // --seen filtering happens in main(); verify the predicate shape here.
  const afterSeen = recs.filter((r) => !new Set(['4012345678']).has(r.jobId));
  check('--seen drops the named jobId', afterSeen.length === 2);

  // Empty / junk input must not throw and must return [].
  check('empty input -> []', parseAlerts('').length === 0);
  check('non-string input -> []', parseAlerts(null).length === 0);
  check('no-job HTML -> []', parseAlerts('<p>hello world</p>').length === 0);

  console.log(failed === 0 ? '\nlinkedin-alerts self-test: PASS' : `\nlinkedin-alerts self-test: FAIL (${failed})`);
  return failed === 0 ? 0 : 1;
}

// Only run as CLI when invoked directly (not when imported by tests).
import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
