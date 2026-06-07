// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Levels.fyi Jobs provider - parses the public server-rendered /jobs page.
// The hydrated search API returns an opaque payload and is rate-limited, while
// the listing HTML exposes company cards and stable /jobs?jobId=... links.

const BASE_URL = 'https://www.levels.fyi';
const DEFAULT_JOBS_URL = `${BASE_URL}/jobs`;
const ALLOWED_HOSTS = new Set(['www.levels.fyi', 'levels.fyi']);
const LOCATION_SEPARATOR = ' \u00b7 ';

const LEVELS_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'referer': DEFAULT_JOBS_URL,
};

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function textFromHtml(fragment) {
  return decodeEntities(fragment)
    .replace(/<!--\s*-->/g, '')
    .replace(/<span\b[^>]*companyJobDate[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocation(location) {
  const parts = textFromHtml(location)
    .split('\u00b7')
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => !/(?:^|\s)(?:[A-Z]{1,3}\$|[$\u20ac\u00a3\u00a5\u20b9])\s?\d/i.test(p));
  return parts.join(LOCATION_SEPARATOR);
}

function rawUrlFor(entry, defaultToJobs = false) {
  if (typeof entry?.levels_search?.url === 'string') return entry.levels_search.url;
  if (typeof entry?.careers_url === 'string') return entry.careers_url;
  return defaultToJobs ? DEFAULT_JOBS_URL : null;
}

function resolveJobsUrl(entry, { defaultToJobs = false } = {}) {
  const raw = rawUrlFor(entry, defaultToJobs);
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  if (parsed.pathname.replace(/\/+$/, '') !== '/jobs') return null;

  parsed.hostname = 'www.levels.fyi';
  parsed.hash = '';
  parsed.searchParams.delete('jobId');
  return parsed.href;
}

/**
 * Parse Levels.fyi's server-rendered job cards.
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseLevelsJobsHtml(html) {
  if (typeof html !== 'string' || html.trim() === '') return [];

  const jobs = [];
  const seen = new Set();
  const companyStartRe = /<div\b(?=[^>]*\brole=["']button["'])(?=[^>]*company-jobs-preview-card[^"']*__container)[^>]*>/gi;
  const starts = [...html.matchAll(companyStartRe)].map(match => ({ index: match.index || 0, end: (match.index || 0) + match[0].length }));

  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i].end, starts[i + 1]?.index ?? html.length);
    const companyMatch = chunk.match(/<h2\b[^>]*companyName[^>]*>([\s\S]*?)<\/h2>/i);
    const altMatch = chunk.match(/<img\b[^>]*alt=["']([^"']+?)\s+logo["'][^>]*>/i);
    const company = companyMatch
      ? textFromHtml(companyMatch[1])
      : decodeEntities(altMatch?.[1] || '').trim();

    const anchorRe = /<a\b[^>]*href=["']([^"']*\/jobs\?jobId=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of chunk.matchAll(anchorRe)) {
      const href = decodeEntities(match[1]);
      const body = match[2];
      const titleMatch = body.match(/<div\b[^>]*companyJobTitle[^>]*>([\s\S]*?)<\/div>/i);
      const locationMatch = body.match(/<div\b[^>]*companyJobLocation[^>]*>([\s\S]*?)<\/div>/i);
      const title = titleMatch ? textFromHtml(titleMatch[1]) : '';
      if (!title) continue;

      let url;
      try {
        url = new URL(href, BASE_URL).href;
      } catch {
        continue;
      }

      if (seen.has(url)) continue;
      seen.add(url);
      jobs.push({
        title,
        url,
        company,
        location: locationMatch ? normalizeLocation(locationMatch[1]) : '',
      });
    }
  }

  return jobs;
}

/** @type {Provider} */
export default {
  id: 'levels',

  detect(entry) {
    const url = resolveJobsUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const url = resolveJobsUrl(entry, { defaultToJobs: true });
    if (!url) throw new Error(`levels: cannot derive jobs URL for ${entry.name}`);
    const html = await ctx.fetchText(url, { headers: LEVELS_HEADERS });
    return parseLevelsJobsHtml(html);
  },
};
