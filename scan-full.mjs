#!/usr/bin/env node

/**
 * scan-full.mjs -- OpenCode-compatible full scan workflow.
 *
 * Claude Code's scan mode is agentic: it runs the zero-token scanner, verifies
 * new postings with Playwright, and checks Gmail alert emails via MCP. This
 * wrapper makes those same checks explicit for non-Claude CLIs.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import { checkUrlLiveness } from './liveness-browser.mjs';
import { resolveNoApplyControlPolicy } from './liveness-core.mjs';

loadDotenv({ quiet: true });

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';
const GMAIL_CREDS_PATH = `${process.env.HOME}/.gmail-mcp/credentials.json`;
const GMAIL_KEYS_PATH = `${process.env.HOME}/.gmail-mcp/gcp-oauth.keys.json`;
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BRAVE_SEARCH_API = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_RESULT_COUNT = 10;
const BRAVE_DELAY_MS = 1100;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function readYaml(path) {
  return yaml.load(readFileSync(path, 'utf8')) || {};
}

function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.filter(v => typeof v === 'string').map(v => v.toLowerCase().trim()).filter(Boolean);
}

function buildTitleFilter(titleFilter) {
  const positive = normalizeKeywordList(titleFilter?.positive);
  const negative = normalizeKeywordList(titleFilter?.negative);
  return title => {
    const lower = String(title || '').toLowerCase();
    return (positive.length === 0 || positive.some(k => lower.includes(k))) && !negative.some(k => lower.includes(k));
  };
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);
  return location => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.some(k => lower.includes(k))) return true;
    if (block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

function loadSeenUrls() {
  const seen = new Set();
  for (const file of [SCAN_HISTORY_PATH, PIPELINE_PATH, APPLICATIONS_PATH]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(match[0]);
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (!existsSync(APPLICATIONS_PATH)) return seen;
  const text = readFileSync(APPLICATIONS_PATH, 'utf8');
  for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
    const company = match[1].trim().toLowerCase();
    const role = match[2].trim().toLowerCase();
    if (company && role && company !== 'company') seen.add(`${company}::${role}`);
  }
  return seen;
}

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf8') : '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  const block = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';
  if (idx === -1) {
    text += `\n${marker}\n${block}`;
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf8');
}

function appendToScanHistory(offers, status = 'added') {
  if (offers.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf8');
  }
  const lines = offers.map(o => `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}\t${o.location || ''}`).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSearchUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|trk|gh_src$)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.href;
  } catch {
    return '';
  }
}

function extractCompanyFromResult(title, url) {
  const cleaned = decodeHtml(title).replace(/\s+[-|–—]\s+(Jobs|Careers|Greenhouse|Ashby|Lever|Indeed|Wellfound).*$/i, '').trim();
  const match = cleaned.match(/(?:@|\bat\b|\|)\s*([^|@–—-]+)$/i);
  if (match?.[1]) return match[1].trim();
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (host.includes('ashbyhq.com') || host.includes('greenhouse.io') || host.includes('lever.co')) {
      return decodeHtml(pathParts[0] || host);
    }
    if (host.includes('indeed.com') || host.includes('wellfound.com')) return host.split('.')[0];
    return host.split('.')[0];
  } catch {
    return 'Unknown';
  }
}

function extractTitleFromResult(title) {
  let cleaned = decodeHtml(title)
    .replace(/\s+[-|–—]\s+(Jobs|Careers|Greenhouse|Ashby|Lever|Indeed|Wellfound).*$/i, '')
    .trim();
  cleaned = cleaned.replace(/\s+(?:@|\bat\b|\|)\s*[^|@–—-]+$/i, '').trim();
  return cleaned;
}

async function verifySearchOffers(offers, { noApplyControl = 'drop' } = {}) {
  if (offers.length === 0) return { verified: [], noApplyReview: [], expired: [], dropped: [], invalid: [] };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const verified = [];
  const noApplyReview = [];
  const expired = [];
  const dropped = [];
  const invalid = [];

  try {
    for (const offer of offers) {
      const { result, code, reason } = await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && ['invalid_url', 'unsupported_protocol', 'blocked_host'].includes(code)) {
        invalid.push({ ...offer, reason, code });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        if (noApplyControl === 'keep') {
          noApplyReview.push({ ...offer, reason });
          console.log(`  ⚠️ review    ${offer.company} | ${offer.title} (${reason})`);
        } else {
          dropped.push({ ...offer, reason });
          console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
        }
      } else {
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }
    }
  } finally {
    await browser.close();
  }

  return { verified, noApplyReview, expired, dropped, invalid };
}

async function processBraveSearch(config, { verify = true, dryRun = false } = {}) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { enabled: false, queries: 0, found: 0, candidates: 0, added: 0, skipped: 0, errors: ['BRAVE_SEARCH_API_KEY is not set'] };
  }

  const queries = (config.search_queries || []).filter(q => q?.enabled !== false && q.query);
  const titleFilter = buildTitleFilter(config.title_filter);
  const seenUrls = loadSeenUrls();
  const seenRoles = loadSeenCompanyRoles();
  const candidates = [];
  const errors = [];
  let found = 0;
  let skipped = 0;

  for (const query of queries) {
    const url = new URL(BRAVE_SEARCH_API);
    url.searchParams.set('q', query.query);
    url.searchParams.set('count', String(BRAVE_RESULT_COUNT));
    url.searchParams.set('search_lang', 'en');
    url.searchParams.set('country', 'us');
    try {
      const response = await fetch(url, {
        headers: {
          'x-subscription-token': apiKey,
          'accept': 'application/json',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const payload = await response.json();
      const results = payload.web?.results || [];
      found += results.length;
      for (const result of results) {
        const offerUrl = cleanSearchUrl(result.url);
        if (!offerUrl || seenUrls.has(offerUrl)) { skipped++; continue; }
        const title = extractTitleFromResult(result.title || '');
        if (!title || !titleFilter(title)) { skipped++; continue; }
        const company = extractCompanyFromResult(result.title || '', offerUrl);
        const key = `${company.toLowerCase()}::${title.toLowerCase()}`;
        if (seenRoles.has(key)) { skipped++; continue; }
        seenUrls.add(offerUrl);
        seenRoles.add(key);
        candidates.push({ title, url: offerUrl, company, location: '', source: `brave:${query.name || 'search'}` });
      }
    } catch (err) {
      errors.push(`${query.name || query.query}: ${err.message}`);
    }
    await sleep(BRAVE_DELAY_MS);
  }

  const noApplyControl = resolveNoApplyControlPolicy(config);
  const verifiedResult = verify
    ? await verifySearchOffers(candidates, { noApplyControl })
    : { verified: candidates, noApplyReview: [], expired: [], dropped: [], invalid: [] };
  const addableOffers = [...verifiedResult.verified, ...verifiedResult.noApplyReview];
  if (!dryRun) {
    appendToPipeline(addableOffers);
    appendToScanHistory(verifiedResult.verified);
    appendToScanHistory(verifiedResult.noApplyReview, 'added_no_apply_review');
    appendToScanHistory(verifiedResult.expired, 'skipped_expired');
    appendToScanHistory(verifiedResult.dropped, 'skipped_no_apply_control');
    appendToScanHistory(verifiedResult.invalid, 'skipped_invalid_url');
  }

  return {
    enabled: true,
    queries: queries.length,
    found,
    candidates: candidates.length,
    added: addableOffers.length,
    skipped,
    expired: verifiedResult.expired.length,
    dropped: verifiedResult.dropped.length,
    noApplyReview: verifiedResult.noApplyReview.length,
    invalid: verifiedResult.invalid.length,
    noApplyControl,
    dryRun,
    errors,
  };
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function collectBodyParts(part, out = []) {
  if (!part) return out;
  if (part.body?.data) out.push({ mimeType: part.mimeType || '', text: base64UrlDecode(part.body.data) });
  for (const child of part.parts || []) collectBodyParts(child, out);
  return out;
}

function messageBody(message) {
  const parts = collectBodyParts(message.payload);
  const html = parts.filter(p => p.mimeType.includes('html')).map(p => p.text).join('\n');
  const plain = parts.filter(p => p.mimeType.includes('plain')).map(p => p.text).join('\n');
  return { raw: `${plain}\n${html}`, text: `${plain}\n${htmlToText(html)}`.trim() };
}

function header(message, name) {
  return message.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function canonicalizeUrl(raw) {
  let value = String(raw || '').replace(/&amp;/g, '&');
  try { value = decodeURIComponent(value); } catch {}

  const linkedIn = value.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i);
  if (linkedIn) return `https://www.linkedin.com/jobs/view/${linkedIn[1]}`;

  const indeed = value.match(/[?&]jk=([a-z0-9]+)/i);
  if (indeed) return `https://www.indeed.com/viewjob?jk=${indeed[1]}`;

  const wellfound = value.match(/https?:\/\/(?:www\.)?wellfound\.com\/jobs\/[^\s"'<>]+/i);
  if (wellfound) return wellfound[0].replace(/[).,]+$/, '');

  return null;
}

function extractAlertUrls(body) {
  const urls = new Set();
  for (const match of body.raw.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const canonical = canonicalizeUrl(match[0]);
    if (canonical) urls.add(canonical);
  }
  return [...urls];
}

function inferTitle(bodyText, url, titleFilter) {
  const idx = bodyText.indexOf(url);
  const windowText = idx === -1 ? bodyText : bodyText.slice(Math.max(0, idx - 1200), idx + 300);
  const lines = windowText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('http'));
  const candidate = lines.find(l => l.length <= 140 && titleFilter(l));
  return candidate || '';
}

function inferCompany(bodyText, url, sourceName) {
  const idx = bodyText.indexOf(url);
  const windowText = idx === -1 ? bodyText : bodyText.slice(Math.max(0, idx - 500), idx + 300);
  const lines = windowText.split('\n').map(l => l.trim()).filter(Boolean);
  const companyLine = lines.find(l => /company| at /i.test(l) && l.length <= 100);
  if (companyLine) return companyLine.replace(/^company\s*:?\s*/i, '').trim();
  return `${sourceName} Alert`;
}

async function refreshAccessToken() {
  if (!existsSync(GMAIL_CREDS_PATH) || !existsSync(GMAIL_KEYS_PATH)) return null;
  const creds = JSON.parse(readFileSync(GMAIL_CREDS_PATH, 'utf8'));
  if (creds.access_token && Number(creds.expiry_date || 0) > Date.now() + 60_000) return creds.access_token;
  if (!creds.refresh_token) return creds.access_token || null;

  const keys = JSON.parse(readFileSync(GMAIL_KEYS_PATH, 'utf8'));
  const client = keys.installed || keys.web;
  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch(client.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: HTTP ${res.status}`);
  const next = await res.json();
  const merged = { ...creds, ...next, expiry_date: Date.now() + Number(next.expires_in || 3600) * 1000 };
  writeFileSync(GMAIL_CREDS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged.access_token;
}

async function gmailRequest(path, token, opts = {}) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Gmail API ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function ensureLabel(token, configuredId, labelName) {
  if (configuredId) return configuredId;
  const labels = await gmailRequest('/labels', token);
  const existing = labels.labels?.find(l => l.name === labelName);
  if (existing) return existing.id;
  const created = await gmailRequest('/labels', token, {
    method: 'POST',
    body: JSON.stringify({ name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  });
  return created.id;
}

async function processGmailAlerts(config) {
  const alertConfig = config.linkedin_alerts;
  if (!alertConfig?.enabled) return { enabled: false, processed: 0, added: 0, skipped: 0, errors: [] };

  const token = await refreshAccessToken();
  if (!token) return { enabled: true, processed: 0, added: 0, skipped: 0, errors: ['Gmail OAuth credentials missing'] };

  const sources = Array.isArray(alertConfig.sources) ? alertConfig.sources : [];
  const senders = sources.flatMap(s => Array.isArray(s.senders) ? s.senders : []);
  if (senders.length === 0) return { enabled: true, processed: 0, added: 0, skipped: 0, errors: ['No Gmail alert senders configured'] };

  const labelName = alertConfig.processed_label_name || 'career-ops-processed';
  const labelId = await ensureLabel(token, alertConfig.processed_label_id, labelName);
  const query = `from:(${senders.join(' OR ')}) -label:${labelName}`;
  const listing = await gmailRequest(`/messages?maxResults=25&q=${encodeURIComponent(query)}`, token);
  const messages = listing.messages || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const seenUrls = loadSeenUrls();
  const seenRoles = loadSeenCompanyRoles();
  const newOffers = [];
  const errors = [];
  let skipped = 0;

  for (const item of messages) {
    try {
      const message = await gmailRequest(`/messages/${item.id}?format=full`, token);
      const from = header(message, 'From').toLowerCase();
      const subject = header(message, 'Subject');
      const source = sources.find(s => (s.senders || []).some(sender => from.includes(sender.toLowerCase())));
      const sourceName = source?.name || 'Gmail';
      const body = messageBody(message);

      if (/is now active|job alert is active|alert is set up|alert created/i.test(subject)) {
        skipped++;
      } else {
        for (const url of extractAlertUrls(body)) {
          if (seenUrls.has(url)) { skipped++; continue; }
          const title = inferTitle(body.text, url, titleFilter);
          if (!title || !titleFilter(title)) { skipped++; continue; }
          const company = inferCompany(body.text, url, sourceName);
          const location = '';
          if (!locationFilter(location)) { skipped++; continue; }
          const key = `${company.toLowerCase()}::${title.toLowerCase()}`;
          if (seenRoles.has(key)) { skipped++; continue; }
          seenUrls.add(url);
          seenRoles.add(key);
          newOffers.push({ url, title, company, location, source: `${sourceName.toLowerCase()}-alert` });
        }
      }

      await gmailRequest(`/messages/${item.id}/modify`, token, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: [labelId] }),
      });
    } catch (err) {
      errors.push(`${item.id}: ${err.message}`);
    }
  }

  appendToPipeline(newOffers);
  appendToScanHistory(newOffers);
  return { enabled: true, processed: messages.length, added: newOffers.length, skipped, errors };
}

async function main() {
  const verify = !process.argv.includes('--no-verify');
  const braveEnabled = !process.argv.includes('--no-brave');
  const braveOnly = process.argv.includes('--brave-only');
  const dryRun = process.argv.includes('--dry-run');
  const scanArgs = ['scan.mjs'];
  if (verify) scanArgs.push('--verify');

  console.log(`career-ops full scan (${verify ? 'with' : 'without'} Playwright verification)`);
  console.log('='.repeat(56));
  if (braveOnly) {
    console.log('Base portal scan skipped by --brave-only');
  } else {
    await run('node', scanArgs);
  }

  const config = readYaml(PORTALS_PATH);

  console.log('\nBrave WebSearch Level 3');
  console.log('='.repeat(56));
  if (!braveEnabled) {
    console.log('Brave WebSearch disabled by --no-brave');
  } else {
    const brave = await processBraveSearch(config, { verify, dryRun });
    if (!brave.enabled) {
      console.log(`Brave WebSearch skipped: ${brave.errors.join('; ')}`);
    } else {
      if (brave.dryRun) console.log('Dry run: no Brave results were written');
      console.log(`Queries executed:       ${brave.queries}`);
      console.log(`Search results found:   ${brave.found}`);
      console.log(`Candidates after filter:${brave.candidates}`);
      if (verify) {
        console.log(`Expired dropped:        ${brave.expired}`);
        const noApplyStatus = brave.noApplyControl === 'keep'
          ? `${brave.noApplyReview} kept for review, ${brave.dropped} dropped`
          : `${brave.dropped}`;
        console.log(`No-apply control:      ${noApplyStatus}`);
        console.log(`Invalid dropped:        ${brave.invalid}`);
      }
      console.log(`WebSearch offers ${brave.dryRun ? 'would add' : 'added'}: ${brave.added}`);
      console.log(`Search items skipped:   ${brave.skipped}`);
      if (brave.errors.length) {
        console.log('Brave errors:');
        for (const err of brave.errors) console.log(`  - ${err}`);
      }
    }
  }

  console.log('\nGmail alert scan');
  console.log('='.repeat(56));
  if (braveOnly) {
    console.log('Gmail alerts skipped by --brave-only');
    return;
  }
  const gmail = await processGmailAlerts(config);
  if (!gmail.enabled) {
    console.log('Gmail alerts disabled in portals.yml');
  } else {
    console.log(`Alert emails processed: ${gmail.processed}`);
    console.log(`Alert offers added:      ${gmail.added}`);
    console.log(`Alert items skipped:     ${gmail.skipped}`);
    if (gmail.errors.length) {
      console.log('Gmail alert errors:');
      for (const err of gmail.errors) console.log(`  - ${err}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
