#!/usr/bin/env node
/**
 * dedup-check.mjs — zero-token dedup lookup for agent-driven scan levels
 *
 * scan.mjs already dedups Level 0 (local parser + API) candidates in-process
 * against data/scan-history.tsv, data/pipeline.md, and data/applications.md
 * without ever putting those files in front of an LLM. Levels 1–3 (Playwright,
 * ATS API fallback, WebSearch) are agent-driven and had no equivalent: the
 * only documented path was "read scan-history.tsv / pipeline.md /
 * applications.md" directly, which means pulling a multi-hundred-KB / multi-
 * thousand-line file into the model's context just to answer "have I seen
 * this before." This script exposes scan.mjs's existing loaders
 * (loadSeenUrls, loadSeenCompanyRoles, buildCompanyCanonicalizer) as a CLI so
 * the agent sends candidate URLs/company+role pairs and gets back a verdict,
 * never the raw files.
 *
 * Usage:
 *   node dedup-check.mjs --url "https://..." [--url "https://..." ...]
 *   node dedup-check.mjs --pair "Company|Role" [--pair "Company|Role" ...]
 *   node dedup-check.mjs --file candidates.json
 *     # candidates.json: { "urls": ["https://..."], "pairs": [["Company","Role"]] }
 *   node dedup-check.mjs --url "..." --pair "Company|Role" --json   # default output
 *
 * Output (stdout, JSON):
 *   {
 *     "urls": [ { "url": "...", "seen": true|false } ],
 *     "pairs": [ { "company": "...", "role": "...", "seen": true|false } ]
 *   }
 *
 * Exit 0 always on a successful lookup (seen/new is data, not an error).
 * Non-zero only on bad input (no candidates given, unreadable --file).
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import {
  loadSeenUrls,
  loadSeenCompanyRoles,
  buildCompanyCanonicalizer,
  normalizeUrlForDedup,
  companyRoleDedupKey,
} from './scan.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const APPLICATIONS_PATH = process.env.CAREER_OPS_TRACKER || 'data/applications.md';

function loadPortalsConfig() {
  if (!existsSync(PORTALS_PATH)) return {};
  try {
    const raw = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function scanHistoryPolicy(config = {}) {
  const raw = config.scan_history?.recheck_after_days;
  const parsed = Number.parseInt(raw, 10);
  return {
    recheckAfterDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
  };
}

function parseArgs(argv) {
  const urls = [];
  const pairs = [];
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') urls.push(argv[++i]);
    else if (arg === '--pair') {
      const raw = argv[++i] || '';
      const sep = raw.indexOf('|');
      if (sep === -1) {
        console.error(`Error: --pair expects "Company|Role", got: ${raw}`);
        process.exit(1);
      }
      pairs.push([raw.slice(0, sep), raw.slice(sep + 1)]);
    } else if (arg === '--file') file = argv[++i];
    else if (arg === '--json') { /* default and only output format; accepted for clarity */ }
  }

  if (file) {
    if (!existsSync(file)) {
      console.error(`Error: --file not found: ${file}`);
      process.exit(1);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (err) {
      console.error(`Error: failed to parse ${file}: ${err.message}`);
      process.exit(1);
    }
    for (const u of parsed.urls || []) urls.push(u);
    for (const p of parsed.pairs || []) pairs.push([p[0], p[1]]);
  }

  return { urls, pairs };
}

function main() {
  const { urls, pairs } = parseArgs(process.argv.slice(2));

  if (urls.length === 0 && pairs.length === 0) {
    console.error('Usage: node dedup-check.mjs --url <url> | --pair "Company|Role" | --file candidates.json');
    process.exit(1);
  }

  const config = loadPortalsConfig();
  const historyPolicy = scanHistoryPolicy(config);
  const canonicalizeCompany = buildCompanyCanonicalizer(config.company_aliases);

  const urlResult = urls.length
    ? (() => {
        const { seen } = loadSeenUrls(historyPolicy);
        return urls.map((url) => ({ url, seen: seen.has(normalizeUrlForDedup(url)) }));
      })()
    : [];

  const pairResult = pairs.length
    ? (() => {
        const seen = loadSeenCompanyRoles(APPLICATIONS_PATH, canonicalizeCompany, { policy: historyPolicy });
        return pairs.map(([company, role]) => ({
          company,
          role,
          seen: seen.has(companyRoleDedupKey(company, role, canonicalizeCompany)),
        }));
      })()
    : [];

  console.log(JSON.stringify({ urls: urlResult, pairs: pairResult }, null, 2));
}

main();
