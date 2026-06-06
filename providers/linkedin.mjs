// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn guest API provider — no authentication required.
// Uses LinkedIn's public /jobs-guest endpoint, which returns job cards
// as HTML snippets for any search query without requiring a session.
//
// portals.yml entry format:
//   - name: LinkedIn — Software Engineer NYC
//     provider: linkedin
//     linkedin_search:
//       keywords: "Software Engineer"
//       location: "New York, NY"
//       f_TPR: r604800        # r86400=24h, r604800=7d, r2592000=30d
//       f_E: "2,3"            # 1=Intern,2=Entry,3=Associate,4=Mid-Senior,5=Director
//       f_WT: "1,2,3"         # 1=On-site,2=Remote,3=Hybrid (omit for all)
//       max_pages: 2          # pages to fetch (25 results/page, default 2)
//     enabled: true

const GUEST_API = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_SIZE = 25;
const DEFAULT_MAX_PAGES = 2;
const PAGE_DELAY_MS = 1200; // polite delay between pages

// LinkedIn blocks default fetch UA — use a browser-like one.
const LI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'referer': 'https://www.linkedin.com/jobs/search/',
};

function buildPageUrl(search, start) {
  const p = new URLSearchParams();
  if (search.keywords) p.set('keywords', search.keywords);
  if (search.location) p.set('location', search.location);
  if (search.f_TPR)    p.set('f_TPR', String(search.f_TPR));
  if (search.f_E)      p.set('f_E', String(search.f_E));
  if (search.f_WT)     p.set('f_WT', String(search.f_WT));
  p.set('start', String(start));
  p.set('count', String(PAGE_SIZE));
  return `${GUEST_API}?${p}`;
}

// Extract job cards from the HTML blob LinkedIn returns.
function parseCards(html) {
  const jobs = [];

  // Split on opening <li — each list item is one job card.
  const chunks = html.split(/<li[\s>]/);
  for (const chunk of chunks.slice(1)) {

    // Job ID: prefer data-entity-urn="urn:li:jobPosting:JOBID"
    let jobId = null;
    const urnMatch = chunk.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    if (urnMatch) {
      jobId = urnMatch[1];
    } else {
      const hrefMatch = chunk.match(/href="https:\/\/www\.linkedin\.com\/jobs\/view\/[^"]*?(\d{7,})(?:[/?"][^"]*)?"/);
      if (hrefMatch) jobId = hrefMatch[1];
    }
    if (!jobId) continue;

    // Title: <h3 ...>TITLE</h3>
    const titleMatch = chunk.match(/<h3[^>]*base-search-card__title[^>]*>\s*([\s\S]*?)\s*<\/h3>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    if (!title) continue;

    // Company: <h4 ...>COMPANY</h4>
    const companyMatch = chunk.match(/<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i);
    const company = companyMatch
      ? companyMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()
      : '';

    // Location: <span class="job-search-card__location">LOCATION</span>
    const locationMatch = chunk.match(/<span[^>]*job-search-card__location[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
    const location = locationMatch
      ? locationMatch[1].replace(/<[^>]+>/g, '').trim()
      : '';

    jobs.push({
      title,
      url: `https://www.linkedin.com/jobs/view/${jobId}`,
      company,
      location,
    });
  }

  return jobs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  detect(entry) {
    return entry.linkedin_search ? {} : null;
  },

  async fetch(entry, ctx) {
    const search = entry.linkedin_search;
    if (!search) throw new Error('linkedin: missing linkedin_search config');

    // Build blocklist from portals config passed via entry._config (injected by scan.mjs)
    const blocklist = (entry._blocklist || []).map(n => n.toLowerCase());
    const isBlocked = (company) =>
      blocklist.length > 0 && blocklist.some(b => company.toLowerCase().includes(b));

    const maxPages = Number(search.max_pages ?? DEFAULT_MAX_PAGES);
    const allJobs = [];
    const seenIds = new Set();

    for (let page = 0; page < maxPages; page++) {
      const start = page * PAGE_SIZE;
      const url = buildPageUrl(search, start);

      let html;
      try {
        html = await ctx.fetchText(url, { headers: LI_HEADERS });
      } catch (err) {
        // 429 = rate limited; 400 = bad params — stop pagination
        if (err.status === 429 || err.status === 400) break;
        throw err;
      }

      if (!html || html.trim().length < 50) break;

      if (html.includes('authwall') || html.includes('challenge') || html.includes('captcha')) {
        throw new Error('linkedin: bot-detection triggered — try again later');
      }

      const cards = parseCards(html);
      let newOnPage = 0;
      for (const job of cards) {
        if (job.company && isBlocked(job.company)) continue;
        const id = new URL(job.url).pathname.split('/').pop();
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        allJobs.push(job);
        newOnPage++;
      }

      // Fewer than a full page = last page
      if (cards.length < PAGE_SIZE || newOnPage === 0) break;

      if (page < maxPages - 1) await sleep(PAGE_DELAY_MS);
    }

    return allJobs;
  },
};
