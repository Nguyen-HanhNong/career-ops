// tests/providers/linkedin.test.mjs — LinkedIn guest-search provider contract.
//
// Regression guards for three failures measured live on 2026-11-01, each of
// which made the provider report "0 jobs found" or a silently capped result
// with no error in the scan summary:
//
//   1. Short pages ended pagination. The provider asks for count=25 but the
//      guest API serves 10 cards per page, and `cards.length < PAGE_SIZE` was
//      read as "last page" — every search topped out at 10 results whatever
//      `max_pages` said.
//   2. A 429 was swallowed. `catch → break` on page 0 returned [] and the
//      search read as empty. It must retry, and fail loudly if still limited.
//   3. Entries fired concurrently. scan.mjs runs sources CONCURRENCY-wide, so
//      six linkedin_search entries hit the API at once and drew 429s. Every
//      LinkedIn request must go through one gate, never overlapping.
//
// No network: ctx.fetchText is a fake guest API and ctx.sleep is stubbed (it
// also absorbs the inter-request gap and the retry backoff).
//
// Run:  node --test tests/providers/linkedin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mod = await import(pathToFileURL(join(ROOT, 'providers/linkedin.mjs')).href);
const linkedin = mod.default;

// One job card in the shape the guest API returns (seeMoreJobPostings/search).
const card = (id) => `<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/software-engineer-at-acme-${id}?position=1&amp;trk=public_jobs"></a>
    <h3 class="base-search-card__title">
      Software Engineer &amp; Platform ${id}
    </h3>
    <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme &amp; Co</a></h4>
    <span class="job-search-card__location">New York, NY</span>
  </div>
</li>`;
const pageHtml = (start, n) => Array.from({ length: n }, (_, i) => card(4000000000 + start + i)).join('\n');
const http = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const entry = (search = {}) => ({ name: 'LinkedIn — test', provider: 'linkedin', linkedin_search: { keywords: 'Software Engineer', location: 'New York, NY', max_pages: 3, ...search } });

/** Fake guest API: `respond(start, call)` returns HTML or throws. Records every requested URL. */
function fakeCtx(respond) {
  const urls = [];
  const ctx = {
    urls,
    fetchText: async (url) => {
      urls.push(url);
      const start = Number(new URL(url).searchParams.get('start'));
      return respond(start, urls.length);
    },
    sleep: async () => {},
  };
  return ctx;
}

test('detect claims entries with linkedin_search only', () => {
  assert.ok(linkedin.detect(entry()));
  assert.equal(linkedin.detect({ name: 'x', careers_url: 'https://example.com' }), null);
});

test('parses a guest-API card into title/company/location/canonical url', async () => {
  const ctx = fakeCtx((start) => (start === 0 ? pageHtml(0, 1) : ''));
  const jobs = await linkedin.fetch(entry({ max_pages: 1 }), ctx);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    title: 'Software Engineer & Platform 4000000000',
    url: 'https://www.linkedin.com/jobs/view/4000000000',
    company: 'Acme & Co',
    location: 'New York, NY',
  });
});

test('a short page (10 cards < count=25) is NOT the last page', async () => {
  const ctx = fakeCtx((start) => pageHtml(start, 10));
  const jobs = await linkedin.fetch(entry({ max_pages: 3 }), ctx);
  assert.equal(ctx.urls.length, 3, 'should request all max_pages pages');
  assert.equal(jobs.length, 30, `got ${jobs.length} jobs — pagination stopped at a short page`);
});

test('start advances by the cards actually served, with no gaps or overlap', async () => {
  const ctx = fakeCtx((start) => pageHtml(start, 10));
  await linkedin.fetch(entry({ max_pages: 3 }), ctx);
  const starts = ctx.urls.map((u) => Number(new URL(u).searchParams.get('start')));
  assert.deepEqual(starts, [0, 10, 20]);
});

test('an empty page stops pagination', async () => {
  const ctx = fakeCtx((start) => (start === 0 ? pageHtml(0, 10) : '<ul></ul>'));
  const jobs = await linkedin.fetch(entry({ max_pages: 5 }), ctx);
  assert.equal(jobs.length, 10);
  assert.equal(ctx.urls.length, 2);
});

test('a page of only already-seen ids stops pagination', async () => {
  const ctx = fakeCtx(() => pageHtml(0, 10)); // API ignores start, repeats page 1
  const jobs = await linkedin.fetch(entry({ max_pages: 5 }), ctx);
  assert.equal(jobs.length, 10);
  assert.equal(ctx.urls.length, 2);
});

test('a transient 429 is retried, not treated as an empty result', async () => {
  const ctx = fakeCtx((start, call) => {
    if (call === 1) throw http(429);
    return start === 0 ? pageHtml(0, 10) : '';
  });
  const jobs = await linkedin.fetch(entry({ max_pages: 2 }), ctx);
  assert.equal(jobs.length, 10);
});

test('a persistent 429 on the first page throws (never a silent 0 jobs)', async () => {
  const ctx = fakeCtx(() => { throw http(429); });
  await assert.rejects(() => linkedin.fetch(entry(), ctx), /rate-limited/);
  assert.ok(ctx.urls.length > 1, 'should have retried before giving up');
});

test('a persistent 429 on a later page keeps the pages already fetched', async () => {
  const ctx = fakeCtx((start) => { if (start > 0) throw http(429); return pageHtml(0, 10); });
  const origError = console.error;
  const warnings = [];
  console.error = (m) => warnings.push(String(m));
  try {
    const jobs = await linkedin.fetch(entry({ max_pages: 3 }), ctx);
    assert.equal(jobs.length, 10);
  } finally { console.error = origError; }
  assert.ok(warnings.some((w) => /linkedin: .*truncated/.test(w)), 'partial result must be announced');
});

test('a bot-detection page throws', async () => {
  const ctx = fakeCtx(() => '<html>authwall — please sign in to continue browsing the site</html>');
  await assert.rejects(() => linkedin.fetch(entry(), ctx), /bot-detection/);
});

test('concurrent entries never overlap requests and keep the minimum gap', async () => {
  assert.ok(mod.REQUEST_GAP_MS >= 1000, `REQUEST_GAP_MS=${mod.REQUEST_GAP_MS}; LinkedIn 429s below ~1s spacing`);
  let inFlight = 0;
  let maxInFlight = 0;
  const gaps = [];
  const mk = () => ({
    fetchText: async (url) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      const start = Number(new URL(url).searchParams.get('start'));
      return start === 0 ? pageHtml(0, 10) : '';
    },
    sleep: async (ms) => { gaps.push(ms); },
  });
  // Six entries at once, as scan.mjs's parallelFetch launches them.
  await Promise.all(Array.from({ length: 6 }, () => linkedin.fetch(entry({ max_pages: 2 }), mk())));
  assert.equal(maxInFlight, 1, `${maxInFlight} LinkedIn requests were in flight at once`);
  assert.ok(gaps.length >= 6, `expected the gate to pause between requests, saw ${gaps.length} pauses`);
});
