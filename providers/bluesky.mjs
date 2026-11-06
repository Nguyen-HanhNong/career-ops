// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
//
// Bluesky provider — hiring posts from people you watch (recruiters,
// engineering managers), from a Bluesky list of them, and from full-network
// post search. Public AppView XRPC endpoints, no account, no API key:
//
//   actors → app.bsky.feed.getAuthorFeed    (public.api.bsky.app)
//   list   → app.bsky.feed.getListFeed      (public.api.bsky.app)
//   search → app.bsky.feed.searchPosts      (api.bsky.app — the public.api
//            host answers 403 for search; measured 2026-10-11)
//
// Configured under `job_boards:` with `provider: bluesky` (no detect(); see
// templates/portals.example.yml). bsky.app/robots.txt allows crawling and
// points automated readers at exactly this API.
//
// A post is not a listing, so the same fail-closed, per-post Source Indexing
// Policy as telegram-channel.mjs applies, through that provider's exported
// helpers:
//   1. The post must read as a hiring post (HIRING_RE) — most of what a
//      recruiter or manager posts is not.
//   2. It must link one vacancy page (`applicationLink`): the employer's own
//      ATS/careers page wins over a board mirror; a LinkedIn feed update, a
//      shortener, a form or a homepage is not a vacancy, and a post linking
//      several vacancies is a digest and is skipped. `url` is that link.
//   3. Employer, in order, first hit wins:
//        a. the `company` YOU declared for a watched actor (only for posts
//           that actor wrote, never their reposts);
//        b. an employer the post text names (`employerName`);
//        c. the vacancy link's preview title, as stored in the post's link
//           card ("Job Application for X at Acme", "Acme hiring X | LinkedIn");
//        d. the vacancy link's ATS board slug or tenant
//           (boards.greenhouse.io/acme, acme.wd1.myworkdayjobs.com);
//        e. the poster's own Bluesky bio ("Recruiter @ Acme"), one batched
//           getProfiles call for the posts a–d left blank. A bio that reads as
//           an agency/staffing recruiter is never taken as the employer.
//      c–e are deductions, not statements: the Job's `note` says which basis
//      named the employer and that it is unverified, so the employer is
//      confirmed at the source before evaluation (AGENTS.md, aggregator rule).
//      Still blank → kept only when the link is the employer's own vacancy
//      page; a board link with no employer is dropped. Nothing is taken from a
//      handle.
// The post permalink + poster ride in `note` (→ data/pipeline.md `note:`) and
// in `description` as `Source:`, so the person who posted it stays one click
// away for outreach.

import { applicationLink, employerName } from './telegram-channel.mjs';
import { DESCRIPTION_CAP } from './_html-to-text.mjs';
import { fetchJsonWithRetry, sleep } from './_http.mjs';

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';
const SEARCH_API = 'https://api.bsky.app/xrpc';
const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 10;
const PAGE_LIMIT = 100;
const REQUEST_DELAY_MS = 300;
const TITLE_CAP = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

// A handle is a domain name (`jane.bsky.social`, `jane.dev`); a DID is
// `did:plc:…` / `did:web:…`. Either is the only actor value reaching a URL.
const HANDLE_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;
const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]{3,253})$/i;
const LIST_URI_RE = /^at:\/\/(did:[a-z]+:[a-z0-9.:-]+)\/app\.bsky\.graph\.list\/([a-z0-9]{3,32})$/i;
const LIST_WEB_RE = /^https:\/\/bsky\.app\/profile\/([^/?#]+)\/lists\/([a-z0-9]{3,32})\/?$/i;

// "We're hiring", "my team is hiring a…", "join our team", "open role(s)".
// Apostrophes come as ' or ’ on Bluesky. Deliberately misses the bare word
// "hiring" ("hiring freeze", "hiring is broken") — a post has to announce one.
const HIRING_RE = /\b(?:we(?:['’]re| are)\s+(?:also\s+)?hiring|(?:i['’]m|i am)\s+hiring|(?:team|we|org|group|company|startup|lab)\s+(?:is|are)\s+(?:also\s+)?hiring|now hiring|(?:still\s+)?hiring\s+(?:a|an|for|our|my|multiple|several|two|three|\d+)\b|join\s+(?:my|our)\s+team|open\s+(?:role|position|req|headcount)s?\b|job\s+opening|(?:new|open)\s+headcount)/i;

/**
 * The sentence that announces the hire, as the title: "Hey folks! My team is
 * hiring a security engineer. We're looking…" → "My team is hiring a security
 * engineer." A bare "I'm hiring." borrows the following sentence so the role
 * reaches title_filter. Exported for tests.
 *
 * @param {string} text
 */
export function hiringTitle(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentences = flat.split(/(?<=[.!?])\s+/);
  const i = sentences.findIndex((s) => HIRING_RE.test(s));
  let title = i === -1 ? sentences[0] : sentences[i];
  if (i !== -1 && title.length < 40 && sentences[i + 1]) title = `${title} ${sentences[i + 1]}`;
  title = title.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
  if (title.length <= TITLE_CAP) return title;
  const cut = title.slice(0, TITLE_CAP);
  const space = cut.lastIndexOf(' ');
  return `${space > TITLE_CAP / 3 ? cut.slice(0, space) : cut}…`;
}

/**
 * Every link a post carries: rich-text link facets (the full URL — the text
 * shows a truncated one) and the link-card embed, including a card inside a
 * quote-with-media embed. Exported for tests.
 *
 * @param {any} record - app.bsky.feed.post record.
 * @returns {string[]}
 */
export function postLinks(record) {
  const out = [];
  for (const facet of Array.isArray(record?.facets) ? record.facets : []) {
    for (const f of Array.isArray(facet?.features) ? facet.features : []) {
      if (f?.$type === 'app.bsky.richtext.facet#link' && typeof f.uri === 'string') out.push(f.uri);
    }
  }
  const embed = record?.embed;
  for (const ext of [embed?.external, embed?.media?.external]) {
    if (ext && typeof ext.uri === 'string') out.push(ext.uri);
  }
  return out;
}

/** bsky.app permalink for an `at://did/app.bsky.feed.post/rkey` post. */
function webUrl(post) {
  const m = String(post?.uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!m) return '';
  const who = typeof post?.author?.handle === 'string' && post.author.handle !== 'handle.invalid'
    ? post.author.handle
    : m[1];
  return `https://bsky.app/profile/${who}/post/${m[2]}`;
}

// Words that make a name a vendor/board, not an employer.
const NOT_EMPLOYER_RE = /^(?:linkedin|indeed|glassdoor|greenhouse|lever|ashby|workday|workable|smartrecruiters|careers?|jobs?|job board|apply|hiring|remote|hybrid|on-?site|us|usa|uk|eu|europe|worldwide|anywhere)$/i;
const LOCATIONISH_RE = /\b(?:remote|hybrid|on-?site|full[- ]?time|part[- ]?time|contract)\b/i;
const ANONYMOUS_RE = /\b(?:confidential|undisclosed|stealth|our client|a client)\b/i;
// Agency/staffing recruiters name the agency, not the employer they fill for.
const AGENCY_RE = /\b(?:agency|staffing|headhunt\w*|executive search|recruitment (?:firm|consultan\w*|partner\w*)|recruiting firm|freelance recruiter|independent recruiter|search firm|talent (?:solutions|partners))\b/i;
const AGENCY_NAME_RE = /\b(?:recruit\w*|staffing|resourcing|search|talent|headhunt\w*|consult\w*|personnel|placement\w*)\b/i;
// Large agencies whose names carry none of the words above.
const KNOWN_AGENCY_RE = /^(?:hays|robert half|randstad|adecco|michael page|page group|harvey nash|teksystems|kforce|insight global|aerotek|allegis|manpower(?:group)?|experis|kelly(?: services)?|robert walters|hudson|korn ferry|spencer stuart|heidrick|russell reynolds|harnham|hirewell|jobot|cybercoders|motion|modis|akkodis|apex systems|lorien|nigel frank|jefferson frank|huxley|computer futures|oliver bernard|hired)\b/i;

/** A deduced name, or '' when it does not read as an employer. */
function plausibleName(raw) {
  const n = String(raw || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^[-–—:|·•\s]+|[-–—:|·•,;!.\s]+$/g, '');
  if (n.length < 2 || n.length > 60 || n.split(' ').length > 5) return '';
  if (!/\p{L}/u.test(n) || NOT_EMPLOYER_RE.test(n) || LOCATIONISH_RE.test(n) || ANONYMOUS_RE.test(n)) return '';
  if (/^https?:|\//i.test(n)) return '';
  return n;
}

/** `acme-robotics_inc` → `Acme Robotics Inc`. */
function humanizeSlug(slug) {
  let s;
  try { s = decodeURIComponent(slug); } catch { s = slug; }
  return s.split(/[-_+.\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// [host test, where the slug sits, ATS label for the note]
const ATS_SLUGS = [
  [/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, 'path', 'greenhouse'],
  [/^jobs(?:\.eu)?\.lever\.co$/, 'path', 'lever'],
  [/^jobs\.ashbyhq\.com$/, 'path', 'ashby'],
  [/^apply\.workable\.com$/, 'path', 'workable'],
  [/^(?:jobs|careers)\.smartrecruiters\.com$/, 'path', 'smartrecruiters'],
  [/^ats\.rippling\.com$/, 'path', 'rippling'],
  [/^jobs\.gem\.com$/, 'path', 'gem'],
  [/\.wd\d+\.myworkdayjobs\.com$/, 'sub', 'workday'],
  [/\.myworkdaysite\.com$/, 'none', 'workday'],
  [/\.recruitee\.com$/, 'sub', 'recruitee'],
  [/\.teamtailor\.com$/, 'sub', 'teamtailor'],
  [/\.bamboohr\.com$/, 'sub', 'bamboohr'],
  [/\.breezy\.hr$/, 'sub', 'breezy'],
  [/\.jobs\.personio\.(?:de|com)$/, 'sub', 'personio'],
  [/\.applytojob\.com$/, 'sub', 'jazzhr'],
  [/\.pinpointhq\.com$/, 'sub', 'pinpoint'],
];
const SLUG_STOP_RE = /^(?:embed|job_app|jobs?|v\d+|www|careers?|apply|en|en-us)$/i;

/**
 * Employer from a vacancy link's ATS board slug or tenant, or null. Greenhouse's
 * embed form carries the board in `?for=`. Exported for tests.
 *
 * @param {string} href
 * @returns {{ company: string, ats: string } | null}
 */
export function companyFromAtsUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const host = u.hostname.toLowerCase();
  for (const [re, where, ats] of ATS_SLUGS) {
    if (!re.test(host)) continue;
    let slug = '';
    if (where === 'sub') slug = host.split('.')[0];
    else if (where === 'path') {
      slug = u.searchParams.get('for') || u.pathname.split('/').filter(Boolean)[0] || '';
    }
    if (!slug || SLUG_STOP_RE.test(slug) || /^\d+$/.test(slug)) return null;
    const company = plausibleName(humanizeSlug(slug));
    return company ? { company, ats } : null;
  }
  return null;
}

/**
 * Employer from the link card's title — the vacancy page's own og:title as
 * the poster's client fetched it — or ''. Only shapes that say which part is
 * the employer are read. Exported for tests.
 *
 * @param {string} title
 * @param {string} href - The card's link, for host-specific shapes.
 */
export function companyFromCardTitle(title, href = '') {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let host = '';
  try { host = new URL(href).hostname.toLowerCase(); } catch { /* none */ }
  let m;
  if ((m = t.match(/^Job Application for .+? at (.+)$/i))) return plausibleName(m[1]);
  if ((m = t.match(/^(.+?) hiring .+?\|\s*LinkedIn$/i))) return plausibleName(m[1]);
  if (/(^|\.)lever\.co$/.test(host) && (m = t.match(/^(.+?) - .+$/))) return plausibleName(m[1]);
  const bare = t.replace(/\s*[|–—-]\s*(?:Greenhouse|Lever|Ashby|Workday|Workable|LinkedIn|Careers?|Jobs?)$/i, '');
  if ((m = bare.match(/^.{3,}?\s(?:at|@)\s+([^@|]+)$/i))) return plausibleName(m[1]);
  return '';
}

/**
 * Employer the poster states in their own bio/display name ("Recruiter @
 * Acme", "Engineering Manager at Acme"), or '' — also '' for agency
 * recruiters, past roles, and bios naming more than one employer. Exported
 * for tests.
 *
 * @param {{ displayName?: string, description?: string } | undefined} profile
 */
export function companyFromProfile(profile) {
  const text = [profile?.displayName, profile?.description].filter((v) => typeof v === 'string').join('\n');
  if (!text.trim() || AGENCY_RE.test(text)) return '';
  const ROLE = String.raw`(?:recruit(?:er|ing)|talent(?: acquisition| partner| lead)?|sourcer|people(?: partner)?|hiring|eng(?:ineering)? manager|EM|manager|director|head of [\w ]{2,30}?|lead|engineer|developer|scientist|designer|researcher|founder|co-?founder|CTO|CEO|VP[\w ]{0,30}?|staff|principal|SWE|SRE)`;
  const re = new RegExp(String.raw`\b${ROLE}\b[^@\n|·•]{0,25}?\s(?:at|@)\s?([\p{L}\p{N}][\p{L}\p{N}&'’ .-]{0,40})`, 'giu');
  const found = new Set();
  for (const segment of text.split(/[\n|·•/]+/)) {
    if (/\b(?:ex-?|former(?:ly)?|previously|prev\b|alum)/i.test(segment)) continue;
    for (const m of segment.matchAll(re)) {
      // "@acme.bsky.social" mentions a handle; its first label is not a name.
      const raw = m[1].replace(/\s+(?:and|&)\s.*$/i, '').split(/[,;()]/)[0].trim();
      if (/\.[a-z]{2,}/i.test(raw)) continue;
      // "Recruiter at Acme helping people grow": the name ends at the first
      // lowercase word after it.
      const [head, ...tail] = raw.split(' ');
      const cut = [head];
      for (const w of tail) { if (!/^[\p{Lu}\p{N}&]/u.test(w)) break; cut.push(w); }
      const name = plausibleName(cut.join(' '));
      if (name && !AGENCY_NAME_RE.test(name) && !KNOWN_AGENCY_RE.test(name)) found.add(name);
    }
  }
  return found.size === 1 ? [...found][0] : '';
}

/** The link card's title when the card is the chosen vacancy link. */
function cardTitleFor(record, url) {
  const embed = record?.embed;
  for (const ext of [embed?.external, embed?.media?.external]) {
    if (ext && ext.uri === url && typeof ext.title === 'string') return ext.title;
  }
  return '';
}

/**
 * Decide a post's Job, or why there is none. `missing` marks a hiring post
 * with a vacancy link whose employer nothing named — the case a profile
 * lookup can still resolve.
 *
 * @param {any} post
 * @param {{ company?: string, isRepost?: boolean, profile?: any }} opts
 */
function analyzePost(post, opts) {
  const none = { job: null, missing: false };
  const record = post?.record;
  const text = typeof record?.text === 'string' ? record.text : '';
  if (!text.trim() || !HIRING_RE.test(text)) return none;
  const link = applicationLink(postLinks(record));
  if (!link) return none;
  const title = hiringTitle(text);
  if (!title) return none;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let company = !opts.isRepost && typeof opts.company === 'string' ? opts.company.trim() : '';
  let basis = company ? 'declared' : '';
  if (!company && (company = employerName(lines))) basis = 'post text';
  if (!company && (company = companyFromCardTitle(cardTitleFor(record, link.url), link.url))) basis = 'link preview title';
  if (!company && link.kind === 'employer') {
    const ats = companyFromAtsUrl(link.url);
    if (ats) { company = ats.company; basis = `${ats.ats} board slug`; }
  }
  if (!company && (company = companyFromProfile(opts.profile))) basis = "poster's Bluesky bio";

  // A board page (LinkedIn job view, an aggregator) proves nothing about who
  // hires; without an employer the post is unattributable.
  if (!company && link.kind !== 'employer') return { job: null, missing: true };

  const permalink = webUrl(post);
  const author = post?.author?.handle ? `@${post.author.handle}` : '';
  const source = `\n\nSource: ${permalink}${author ? ` (posted by ${author})` : ''}`;
  const noteParts = [`bsky post ${permalink}${author ? ` by ${author}` : ''}`];
  if (basis && basis !== 'declared' && basis !== 'post text') noteParts.push(`company inferred from ${basis}, unverified`);
  else if (!company) noteParts.push('employer not named');
  const createdAt = Date.parse(record?.createdAt || post?.indexedAt || '');
  return {
    job: {
      title,
      url: link.url,
      company,
      location: '',
      description: text.slice(0, DESCRIPTION_CAP - source.length) + source,
      note: noteParts.join('; '),
      ...(Number.isFinite(createdAt) ? { postedAt: createdAt } : {}),
    },
    missing: !company,
  };
}

/**
 * Turn one AppView post view into a Job, or null when the policy cannot
 * attribute it. Exported for tests.
 *
 * @param {any} post - app.bsky.feed.defs#postView.
 * @param {{ company?: string, isRepost?: boolean, profile?: any }} [opts] -
 *   `company` is the employer the user declared for the watched actor
 *   (ignored for reposts); `profile` is the post author's profile view.
 */
export function postToJob(post, opts = {}) {
  return analyzePost(post, opts).job;
}

/**
 * Profiles (bio + display name) for the given actors, keyed by lowercased
 * DID. getProfiles takes 25 actors per call. A failed lookup only loses the
 * bio fallback, never the run.
 *
 * @param {any} ctx
 * @param {string[]} dids
 * @returns {Promise<Map<string, any>>}
 */
async function fetchProfiles(ctx, dids) {
  const out = new Map();
  for (let i = 0; i < dids.length; i += 25) {
    if (i > 0) await sleep(REQUEST_DELAY_MS, ctx);
    const qs = dids.slice(i, i + 25).map((d) => `actors=${encodeURIComponent(d)}`).join('&');
    try {
      const data = await fetchJsonWithRetry(ctx, `${PUBLIC_API}/app.bsky.actor.getProfiles?${qs}`, { redirect: 'error' });
      for (const p of Array.isArray(data?.profiles) ? data.profiles : []) {
        if (typeof p?.did === 'string') out.set(p.did.toLowerCase(), p);
      }
    } catch (err) {
      console.error(`⚠️  bluesky: profile lookup failed (${err.message}) — employers are not deduced from bios this run`);
      break;
    }
  }
  return out;
}

/** @param {unknown} raw @param {number} fallback @param {number} cap */
function pageCount(raw, fallback, cap) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, cap);
}

/**
 * Normalize `actors:` — bare handles or `{ handle, company }` objects.
 * Exported for tests.
 *
 * @param {unknown} raw
 * @returns {{ actor: string, company: string }[]}
 */
export function normalizeActors(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('bluesky: `actors` must be a list of handles or { handle, company } entries');
  return raw.map((a) => {
    const handle = String(typeof a === 'string' ? a : a?.handle ?? '').trim().replace(/^@/, '');
    if (!HANDLE_RE.test(handle) && !DID_RE.test(handle)) {
      throw new Error(`bluesky: ${JSON.stringify(handle)} is not a Bluesky handle (jane.bsky.social) or DID`);
    }
    const company = a && typeof a === 'object' && typeof a.company === 'string' ? a.company.trim() : '';
    return { actor: handle, company };
  });
}

/**
 * Resolve `list:` — an at:// list URI, or a bsky.app list URL whose profile
 * part is a handle (resolved to a DID) or a DID.
 *
 * @param {string} raw
 * @param {any} ctx
 */
async function resolveListUri(raw, ctx) {
  const value = String(raw).trim();
  if (LIST_URI_RE.test(value)) return value;
  const m = value.match(LIST_WEB_RE);
  if (!m) throw new Error(`bluesky: list must be an at://…/app.bsky.graph.list/… URI or a https://bsky.app/profile/…/lists/… URL, got ${JSON.stringify(raw)}`);
  let did = decodeURIComponent(m[1]);
  if (!DID_RE.test(did)) {
    if (!HANDLE_RE.test(did)) throw new Error(`bluesky: list owner ${JSON.stringify(did)} is not a handle or DID`);
    const res = await fetchJsonWithRetry(ctx, `${PUBLIC_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`, { redirect: 'error' });
    if (!res || typeof res.did !== 'string' || !DID_RE.test(res.did)) throw new Error(`bluesky: could not resolve list owner @${did}`);
    did = res.did;
  }
  return `at://${did}/app.bsky.graph.list/${m[2]}`;
}

/**
 * Walk one cursor-paged feed newest-first until the cutoff or the page cap.
 *
 * @param {any} ctx
 * @param {(cursor: string|null) => string} urlFor
 * @param {(page: any) => Array<{ post: any, isRepost: boolean }>} itemsOf
 * @param {number} cutoff
 * @param {number} maxPages
 * @param {(item: { post: any, isRepost: boolean }) => void} onItem
 * @returns {Promise<{ truncated: boolean, read: number }>}
 */
async function walkFeed(ctx, urlFor, itemsOf, cutoff, maxPages, onItem) {
  let cursor = null;
  let read = 0;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(REQUEST_DELAY_MS, ctx);
    const data = await fetchJsonWithRetry(ctx, urlFor(cursor), { redirect: 'error' });
    const items = itemsOf(data);
    let reachedCutoff = false;
    for (const item of items) {
      read++;
      // Reposts carry the original post's date; the repost itself is recent,
      // so they are judged by when they were indexed into this feed instead.
      const when = Date.parse(item.isRepost ? item.indexedAt : item.post?.record?.createdAt);
      if (Number.isFinite(when) && when < cutoff) { if (!item.isRepost) reachedCutoff = true; continue; }
      onItem(item);
    }
    cursor = typeof data?.cursor === 'string' && data.cursor ? data.cursor : null;
    if (reachedCutoff || !cursor || items.length === 0) return { truncated: false, read };
  }
  return { truncated: cursor !== null, read };
}

/** @param {any} data */
function feedItems(data) {
  const feed = Array.isArray(data?.feed) ? data.feed : [];
  return feed
    .filter((f) => f && f.post)
    .map((f) => {
      const isRepost = f.reason?.$type === 'app.bsky.feed.defs#reasonRepost';
      return { post: f.post, isRepost, indexedAt: isRepost ? f.reason.indexedAt : f.post.indexedAt };
    });
}

/** @type {Provider} */
export default {
  id: 'bluesky',

  /**
   * @param {{ name?: string, actors?: unknown, list?: string, search?: unknown, since_days?: number|string, max_pages?: number|string }} entry
   * @param {{ fetchJson: Function, sleep?: Function, maxPages?: number, sinceMs?: number }} ctx
   */
  async fetch(entry, ctx) {
    const label = entry.name || 'Bluesky';
    const actors = normalizeActors(entry.actors);
    const searches = entry.search === undefined || entry.search === null
      ? []
      : (Array.isArray(entry.search) ? entry.search : [entry.search]).map((q) => String(q).trim()).filter(Boolean);
    const list = typeof entry.list === 'string' && entry.list.trim() ? entry.list : '';
    if (actors.length === 0 && searches.length === 0 && !list) {
      throw new Error(`bluesky: "${label}" needs at least one of actors, list or search`);
    }
    const entryPages = pageCount(entry.max_pages, DEFAULT_MAX_PAGES, MAX_PAGES_CAP);
    const maxPages = Math.min(entryPages, ctx.maxPages ?? Infinity);
    const sinceDays = Number(entry.since_days);
    const windowDays = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : DEFAULT_SINCE_DAYS;
    const cutoff = Math.max(Date.now() - windowDays * DAY_MS, Number.isFinite(ctx.sinceMs) ? Number(ctx.sinceMs) : 0);
    const sinceIso = new Date(cutoff).toISOString();

    const jobs = [];
    const seenPosts = new Set();
    const truncated = [];
    // A watched actor's declared employer applies to their own posts wherever
    // they surface — their feed, the list feed, or a search hit.
    const declaredBy = new Map();
    for (const a of actors) if (a.company) declaredBy.set(a.actor.toLowerCase(), a.company);
    const companyFor = (post) => declaredBy.get(String(post?.author?.handle || '').toLowerCase())
      ?? declaredBy.get(String(post?.author?.did || '').toLowerCase());

    const items = [];
    const take = ({ post, isRepost }) => {
      if (!post?.uri || seenPosts.has(post.uri)) return;
      seenPosts.add(post.uri);
      items.push({ post, isRepost });
    };

    let first = true;
    const pause = async () => { if (!first) await sleep(REQUEST_DELAY_MS, ctx); first = false; };

    for (const { actor } of actors) {
      await pause();
      const r = await walkFeed(ctx,
        (cursor) => `${PUBLIC_API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&filter=posts_no_replies&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        feedItems, cutoff, maxPages, take);
      if (r.truncated) truncated.push(`@${actor}`);
    }

    if (list) {
      await pause();
      const listUri = await resolveListUri(list, ctx);
      const r = await walkFeed(ctx,
        (cursor) => `${PUBLIC_API}/app.bsky.feed.getListFeed?list=${encodeURIComponent(listUri)}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        feedItems, cutoff, maxPages, take);
      if (r.truncated) truncated.push('list');
    }

    for (const q of searches) {
      await pause();
      const r = await walkFeed(ctx,
        (cursor) => `${SEARCH_API}/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&since=${encodeURIComponent(sinceIso)}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        (data) => (Array.isArray(data?.posts) ? data.posts : []).map((post) => ({ post, isRepost: false })),
        cutoff, maxPages, take);
      if (r.truncated) truncated.push(`search ${JSON.stringify(q)}`);
    }

    // Second pass: posts still missing an employer get their author's bio.
    const analyzed = items.map((it) => ({ ...it, r: analyzePost(it.post, { company: companyFor(it.post), isRepost: it.isRepost }) }));
    const dids = [...new Set(analyzed
      .filter((a) => a.r.missing && typeof a.post?.author?.did === 'string' && DID_RE.test(a.post.author.did))
      .map((a) => a.post.author.did.toLowerCase()))];
    let profiles = new Map();
    if (dids.length) { await pause(); profiles = await fetchProfiles(ctx, dids); }
    for (const a of analyzed) {
      const profile = a.r.missing ? profiles.get(String(a.post?.author?.did || '').toLowerCase()) : undefined;
      const job = profile
        ? analyzePost(a.post, { company: companyFor(a.post), isRepost: a.isRepost, profile }).job
        : a.r.job;
      if (job) jobs.push(job);
    }

    // Silent under ctx.maxPages, which is verify-portals asking for one page.
    if (truncated.length && maxPages === entryPages) {
      console.error(`⚠️  bluesky: ${label} truncated at max_pages=${maxPages} for ${truncated.join(', ')} (window since_days=${windowDays} not reached) — raise max_pages on this entry for the full window`);
    }
    return jobs;
  },
};
