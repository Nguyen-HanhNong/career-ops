// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public `wday/cxs/.../jobs` JSON search endpoint.
//
// Workday is a multi-tenant ATS. Every customer site lives at
//   https://<tenant>.<shard>.myworkdayjobs.com/<site>
// and exposes an unauthenticated POST search endpoint at
//   https://<tenant>.<shard>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
//
// A tracked_companies entry can either:
//   - set `api:` to the cxs `/jobs` endpoint directly (preferred — explicit), or
//   - set `careers_url` to the public listing URL (e.g.
//     https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite), from which
//     the cxs endpoint is derived. An optional leading locale segment such as
//     `/en-US/` is tolerated.
//
// Set `provider: workday` explicitly when the public careers_url is a branded
// custom domain that doesn't contain `myworkdayjobs.com`.

const WORKDAY_HOST_RE = /\.myworkdayjobs\.com$/;
const WD_PAGE_SIZE = 20;          // Workday caps the cxs endpoint at 20 per page
const WD_MAX_PAGES = 100;         // safety cap (2000 postings @ 20/page)
const LOCALE_SEG_RE = /^[a-z]{2}-[A-Za-z]{2,4}$/;  // e.g. en-US, de-DE

function assertWorkdayUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workday: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workday: URL must use HTTPS: ${url}`);
  if (!WORKDAY_HOST_RE.test(parsed.hostname)) {
    throw new Error(`workday: untrusted hostname "${parsed.hostname}" — must be a *.myworkdayjobs.com host`);
  }
  return parsed;
}

// Resolve { apiUrl, host, site } from a tracked_companies entry, or null.
// Exported for unit tests.
export function resolveWorkday(entry) {
  // 1. Explicit cxs `api:` URL wins.
  if (typeof entry.api === 'string' && entry.api) {
    let parsed;
    try { parsed = assertWorkdayUrl(entry.api); } catch { return null; }
    const m = parsed.pathname.match(/^\/wday\/cxs\/[^/]+\/([^/]+)\/jobs\/?$/);
    if (!m) return null;
    return { apiUrl: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`, host: parsed.hostname, site: m[1] };
  }
  // 2. Derive from a public careers_url on a myworkdayjobs.com host.
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try { parsed = assertWorkdayUrl(raw); } catch { return null; }
  const tenant = parsed.hostname.split('.')[0];
  const segs = parsed.pathname.split('/').filter(Boolean);
  // Tolerate a leading locale segment (en-US) before the site id.
  if (segs.length && LOCALE_SEG_RE.test(segs[0])) segs.shift();
  const site = segs[0];
  if (!tenant || !site) return null;
  return { apiUrl: `${parsed.origin}/wday/cxs/${tenant}/${site}/jobs`, host: parsed.hostname, site };
}

/**
 * Parse a Workday cxs `/jobs` response into normalized Job rows.
 * Exported for unit tests.
 *
 * Workday returns:
 *   { total, jobPostings: [{ title, externalPath, locationsText, postedOn }] }
 *
 * The public posting URL is `https://<host>/<site><externalPath>`, where
 * externalPath is an absolute path beginning with "/".
 *
 * @param {any} json
 * @param {{ company: string, host: string, site: string }} meta
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseWorkdayResponse(json, { company, host, site }) {
  const items = json?.jobPostings;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const j of items) {
    const externalPath = typeof j?.externalPath === 'string' ? j.externalPath : '';
    if (!externalPath.startsWith('/')) continue;  // no usable public URL
    out.push({
      title: j.title || '',
      url: `https://${host}/${site}${externalPath}`,
      company,
      location: j.locationsText || '',
    });
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const r = resolveWorkday(entry);
    return r ? { url: r.apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const r = resolveWorkday(entry);
    if (!r) throw new Error(`workday: cannot derive API URL for ${entry.name}`);
    const { apiUrl, host, site } = r;
    assertWorkdayUrl(apiUrl);

    const all = [];
    // Workday reports the real `total` only on the FIRST page (offset 0); later
    // pages echo back total=0. So capture it once and use the actual page sizes
    // (a short/empty page) to terminate the loop.
    let knownTotal = Infinity;
    for (let page = 0; page < WD_MAX_PAGES; page++) {
      const offset = page * WD_PAGE_SIZE;
      const json = await ctx.fetchJson(apiUrl, {
        method: 'POST',
        // redirect:'error' blocks SSRF via server-side redirects; assertWorkdayUrl
        // already pinned the host to the *.myworkdayjobs.com allowlist.
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: WD_PAGE_SIZE, offset, searchText: '' }),
      });
      if (page === 0) {
        const total = Number(json?.total);
        if (Number.isFinite(total) && total > 0) knownTotal = total;
      }
      const parsed = parseWorkdayResponse(json, { company: entry.name, host, site });
      if (parsed.length === 0) break;            // empty page → done
      all.push(...parsed);
      if (parsed.length < WD_PAGE_SIZE) break;    // short page → last page
      if (all.length >= knownTotal) break;        // reached the first-page total
    }
    return all;
  },
};
