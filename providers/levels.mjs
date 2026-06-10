// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Levels.fyi Jobs provider.
//
// Two modes:
//  1. SEARCH mode (when `levels_search` carries filters) — builds a path-filtered
//     URL like /jobs/location/{loc}/level/{lvl}/title/{family}, which Levels.fyi
//     renders server-side with the filter applied, and reads the clean structured
//     job objects embedded in the page's __NEXT_DATA__. Zero-token, richer data
//     (salary, posting date, apply URL), and server-side narrowing.
//     Comp / base-salary / recency filters are applied in-provider on those fields
//     because Levels only honors them through its encrypted client API.
//  2. LEGACY HTML mode (default / when no filters) — parses the server-rendered
//     company cards from the bare /jobs page.
//
// NOTE on coverage: Levels paginates and deep-filters only via an *encrypted* API
// (`/v1/job/search` returns a ciphertext payload and 402s without browser headers),
// so the zero-token path returns the first page (~5 companies x up to 3 jobs) per
// filter combination. SEARCH mode fans out across locations x levels x titles to
// widen coverage. For exhaustive pagination, the agent Playwright tier is required.

const BASE_URL = 'https://www.levels.fyi';
const DEFAULT_JOBS_URL = `${BASE_URL}/jobs`;
const ALLOWED_HOSTS = new Set(['www.levels.fyi', 'levels.fyi']);
const LOCATION_SEPARATOR = ' · ';
// Location/title slugs use hyphens (new-york-city-area); level slugs use
// underscores (mid_staff, entry_junior). Allow both; still no /, ., or spaces.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DEFAULT_MAX_QUERIES = 12;

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
    .split('·')
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => !/(?:^|\s)(?:[A-Z]{1,3}\$|[$€£¥₹])\s?\d/i.test(p));
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
 * Parse Levels.fyi's server-rendered job cards (legacy HTML mode).
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

// ── SEARCH mode helpers ──────────────────────────────────────────────

function toNum(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function slugList(value) {
  const arr = Array.isArray(value) ? value : value != null ? [value] : [];
  return arr
    .map(s => String(s).trim().toLowerCase())
    .filter(s => SLUG_RE.test(s));
}

/** True when levels_search carries actual filters (not just a legacy `url`). */
export function hasLevelsSearchFilters(search) {
  if (!search || typeof search !== 'object') return false;
  const keys = ['titles', 'title', 'locations', 'location', 'levels', 'level',
    'min_total_comp', 'min_base_salary', 'posted_within_days'];
  return keys.some(k => {
    const v = search[k];
    if (v == null) return false;
    return Array.isArray(v) ? v.length > 0 : true;
  });
}

/**
 * Build the set of path-filtered Levels job URLs from a search config.
 * Fans out the cartesian product of locations x levels x titles. Empty
 * dimensions are simply omitted from the path. Order is location/level/title
 * (the order Levels itself generates and which yields the tightest filtering).
 * @returns {string[]}
 */
export function buildLevelsPaths(search) {
  const titles = slugList(search?.titles ?? search?.title);
  const locations = slugList(search?.locations ?? search?.location);
  const levels = slugList(search?.levels ?? search?.level);

  const L = locations.length ? locations : [null];
  const V = levels.length ? levels : [null];
  const T = titles.length ? titles : [null];

  const urls = [];
  for (const loc of L) {
    for (const lvl of V) {
      for (const title of T) {
        let p = `${BASE_URL}/jobs`;
        if (loc) p += `/location/${loc}`;
        if (lvl) p += `/level/${lvl}`;
        if (title) p += `/title/${title}`;
        urls.push(p);
      }
    }
  }
  return [...new Set(urls)];
}

/** Extract and parse the Next.js __NEXT_DATA__ blob from a page's HTML. */
export function extractNextData(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Flatten the structured jobs out of a parsed __NEXT_DATA__ object.
 * Returns rich records (salary/date/arrangement preserved for filtering).
 */
export function parseLevelsSearchData(nextData) {
  const results = nextData?.props?.pageProps?.initialJobsData?.results;
  if (!Array.isArray(results)) return [];

  const out = [];
  for (const company of results) {
    const companyName = String(company?.companyName || '').trim();
    const jobs = Array.isArray(company?.jobs) ? company.jobs : [];
    for (const j of jobs) {
      const id = j?.id != null ? String(j.id) : '';
      const title = String(j?.title || '').trim();
      if (!id || !title) continue;
      out.push({
        id,
        title,
        company: companyName,
        locations: Array.isArray(j?.locations) ? j.locations.map(l => String(l).trim()).filter(Boolean) : [],
        minTotalSalary: toNum(j?.minTotalSalary),
        minBaseSalary: toNum(j?.minBaseSalary),
        postingDate: j?.postingDate || null,
        workArrangement: String(j?.workArrangement || ''),
        applicationUrl: typeof j?.applicationUrl === 'string' ? j.applicationUrl : '',
      });
    }
  }
  return out;
}

/**
 * Apply the in-provider filters Levels only honors via its encrypted API:
 * minimum total comp, minimum base salary, recency. Salary/date values that are
 * unknown are KEPT (missing data is not penalized) — tighten the path filters if
 * you need stricter precision. Returns the normalized scan shape.
 */
export function filterLevelsJobs(jobs, search = {}) {
  const minTC = toNum(search.min_total_comp);
  const minBase = toNum(search.min_base_salary);
  const withinDays = toNum(search.posted_within_days);
  const cutoff = withinDays != null && withinDays > 0 ? Date.now() - withinDays * 86_400_000 : null;

  const out = [];
  const seen = new Set();
  for (const j of jobs) {
    if (minTC != null && j.minTotalSalary != null && j.minTotalSalary < minTC) continue;
    if (minBase != null && j.minBaseSalary != null && j.minBaseSalary < minBase) continue;
    if (cutoff != null && j.postingDate) {
      const t = Date.parse(j.postingDate);
      if (!Number.isNaN(t) && t < cutoff) continue;
    }
    const url = `${BASE_URL}/jobs?jobId=${encodeURIComponent(j.id)}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: j.title,
      url,
      company: j.company,
      location: j.locations.join(LOCATION_SEPARATOR),
    });
  }
  return out;
}

async function fetchSearch(entry, ctx, search) {
  const urls = buildLevelsPaths(search);
  const maxQueries = Math.max(1, Math.min(50, toNum(search.max_queries) ?? DEFAULT_MAX_QUERIES));

  const collected = [];
  const seenJobIds = new Set();
  for (const url of urls.slice(0, maxQueries)) {
    let html;
    try {
      html = await ctx.fetchText(url, { headers: LEVELS_HEADERS });
    } catch {
      continue; // one bad filter combo must not abort the rest
    }
    const data = extractNextData(html);
    for (const job of parseLevelsSearchData(data)) {
      if (seenJobIds.has(job.id)) continue;
      seenJobIds.add(job.id);
      collected.push(job);
    }
  }
  return filterLevelsJobs(collected, search);
}

/** @type {Provider} */
export default {
  id: 'levels',

  detect(entry) {
    if (hasLevelsSearchFilters(entry?.levels_search)) return { url: DEFAULT_JOBS_URL };
    const url = resolveJobsUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const search = entry?.levels_search;
    if (hasLevelsSearchFilters(search)) {
      return await fetchSearch(entry, ctx, search);
    }
    // Legacy HTML mode (default, or when only a `url` override is set).
    const url = resolveJobsUrl(entry, { defaultToJobs: true });
    if (!url) throw new Error(`levels: cannot derive jobs URL for ${entry.name}`);
    const html = await ctx.fetchText(url, { headers: LEVELS_HEADERS });
    return parseLevelsJobsHtml(html);
  },
};
