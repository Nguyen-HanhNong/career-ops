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
//   3. Employer, in order: the `company` YOU declared for a watched actor (only
//      for posts that actor wrote, never their reposts) → an employer the post
//      text names (`employerName`) → blank, and blank only when the link is
//      the employer's own vacancy page, which names the employer when the
//      posting is evaluated. Nothing is guessed from a handle or a link host.
// The bsky.app permalink travels in `description` as `Source:`, so the person
// who posted it stays one click away for outreach.

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

/**
 * Turn one AppView post view into a Job, or null when the policy cannot
 * attribute it. Exported for tests.
 *
 * @param {any} post - app.bsky.feed.defs#postView.
 * @param {{ company?: string, isRepost?: boolean }} [opts] - `company` is the
 *   employer the user declared for the watched actor; ignored for reposts.
 */
export function postToJob(post, opts = {}) {
  const record = post?.record;
  const text = typeof record?.text === 'string' ? record.text : '';
  if (!text.trim() || !HIRING_RE.test(text)) return null;
  const link = applicationLink(postLinks(record));
  if (!link) return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const declared = !opts.isRepost && typeof opts.company === 'string' ? opts.company.trim() : '';
  const company = declared || employerName(lines);
  // A board page (LinkedIn job view, an aggregator) proves nothing about who
  // hires; without a named employer the post is unattributable.
  if (!company && link.kind !== 'employer') return null;
  const title = hiringTitle(text);
  if (!title) return null;
  const permalink = webUrl(post);
  const author = post?.author?.handle ? `@${post.author.handle}` : '';
  const source = `\n\nSource: ${permalink}${author ? ` (posted by ${author})` : ''}`;
  const createdAt = Date.parse(record?.createdAt || post?.indexedAt || '');
  return {
    title,
    url: link.url,
    company,
    location: '',
    description: text.slice(0, DESCRIPTION_CAP - source.length) + source,
    ...(Number.isFinite(createdAt) ? { postedAt: createdAt } : {}),
  };
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

    const take = ({ post, isRepost }) => {
      if (!post?.uri || seenPosts.has(post.uri)) return;
      seenPosts.add(post.uri);
      const job = postToJob(post, { company: companyFor(post), isRepost });
      if (job) jobs.push(job);
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

    // Silent under ctx.maxPages, which is verify-portals asking for one page.
    if (truncated.length && maxPages === entryPages) {
      console.error(`⚠️  bluesky: ${label} truncated at max_pages=${maxPages} for ${truncated.join(', ')} (window since_days=${windowDays} not reached) — raise max_pages on this entry for the full window`);
    }
    return jobs;
  },
};
