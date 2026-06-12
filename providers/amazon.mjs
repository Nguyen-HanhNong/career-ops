// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Amazon provider — hits the public amazon.jobs `search.json` endpoint.
//
// Amazon's board is enormous, so a tracked_companies entry MUST scope the
// search via `api:`, a search.json URL carrying the query params, e.g.
//   api: https://www.amazon.jobs/en/search.json?base_query=software+engineer&result_limit=100
// The provider paginates by rewriting `offset` (and defaulting `result_limit`
// to 100) until it reaches `hits` or the page cap. `title_filter` /
// `location_filter` in portals.yml narrow the results further downstream.

const ALLOWED_AMAZON_HOSTS = new Set(['www.amazon.jobs', 'amazon.jobs']);
const AMZ_DEFAULT_LIMIT = 100;
const AMZ_MAX_PAGES = 10;  // safety cap (1000 postings @ 100/page)

function assertAmazonUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`amazon: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`amazon: URL must use HTTPS: ${url}`);
  if (!ALLOWED_AMAZON_HOSTS.has(parsed.hostname)) {
    throw new Error(`amazon: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_AMAZON_HOSTS].join(', ')}`);
  }
  return parsed;
}

// Resolve a base search.json URL from the entry, or null. Exported for tests.
export function resolveAmazonSearchUrl(entry) {
  const raw = typeof entry.api === 'string' ? entry.api : '';
  if (!raw) return null;
  let parsed;
  try { parsed = assertAmazonUrl(raw); } catch { return null; }
  if (!parsed.pathname.endsWith('/search.json')) return null;
  return parsed.toString();
}

function pageUrl(baseUrl, offset) {
  const u = new URL(baseUrl);
  if (!u.searchParams.has('result_limit')) u.searchParams.set('result_limit', String(AMZ_DEFAULT_LIMIT));
  u.searchParams.set('offset', String(offset));
  return u.toString();
}

/**
 * Parse an amazon.jobs search.json response into normalized Job rows.
 * Exported for unit tests.
 *
 * search.json returns:
 *   { hits, jobs: [{ title, job_path, location, normalized_location, ... }] }
 *
 * The public posting URL is `https://www.amazon.jobs<job_path>`, where job_path
 * is an absolute path beginning with "/".
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseAmazonResponse(json, companyName) {
  const items = json?.jobs;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const j of items) {
    const jobPath = typeof j?.job_path === 'string' ? j.job_path : '';
    if (!jobPath.startsWith('/')) continue;  // no usable public URL
    out.push({
      title: j.title || '',
      url: `https://www.amazon.jobs${jobPath}`,
      company: companyName,
      location: j.normalized_location || j.location || '',
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'amazon',

  detect(entry) {
    const url = resolveAmazonSearchUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const baseUrl = resolveAmazonSearchUrl(entry);
    if (!baseUrl) throw new Error(`amazon: cannot derive search URL for ${entry.name}`);

    const limit = Number(new URL(baseUrl).searchParams.get('result_limit')) || AMZ_DEFAULT_LIMIT;
    const all = [];
    let hits = Infinity;
    for (let page = 0; page < AMZ_MAX_PAGES; page++) {
      const url = pageUrl(baseUrl, page * limit);
      assertAmazonUrl(url);
      // redirect:'error' blocks SSRF via server-side redirects; assertAmazonUrl
      // already pinned the host to the amazon.jobs allowlist.
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      if (page === 0) {
        const total = Number(json?.hits);
        if (Number.isFinite(total) && total >= 0) hits = total;
      }
      const parsed = parseAmazonResponse(json, entry.name);
      if (parsed.length === 0) break;            // empty page → done
      all.push(...parsed);
      if (parsed.length < limit) break;           // short page → last page
      if (all.length >= hits) break;              // reached total hits
    }
    return all;
  },
};
