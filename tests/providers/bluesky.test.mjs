// tests/providers/bluesky.test.mjs — provider-contract tests.
// Public AppView XRPC, no auth: getAuthorFeed for watched actors, getListFeed
// for a curated list, searchPosts (api.bsky.app) for full-network search.
// Fixtures are the shapes live hiring posts take (measured 2026-10-11): the
// vacancy link sits in a link card embed or a link facet, and the text often
// says only "my team is hiring" without naming the employer.
//
// The policy half reuses telegram-channel's helpers: a post is a Job only when
// it announces a hire AND links one vacancy page; employer comes from the
// user's declaration for a watched actor, the post text, the link card's title,
// the ATS board slug, or the poster's bio — blank only when the link is the
// employer's own vacancy page. Deduced employers are flagged in `note`.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — bluesky');

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const card = (uri, title = 't') => ({ $type: 'app.bsky.embed.external', external: { uri, title, description: '' } });
const facet = (uri) => [{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] }];
const P = (rkey, handle, text, { daysAgo = 1, embed, facets } = {}) => ({
  uri: `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/${rkey}`,
  author: { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle },
  record: { $type: 'app.bsky.feed.post', text, createdAt: iso(daysAgo), ...(embed ? { embed } : {}), ...(facets ? { facets } : {}) },
  indexedAt: iso(daysAgo),
});

const WD = 'https://xboxgaming.wd1.myworkdayjobs.com/Blizzard_External_Careers/job/Irvine/Associate-Game-Designer_R028085';
const GH = 'https://boards.greenhouse.io/acme/jobs/4455667';

// Employer named nowhere, link is the employer's Workday page → company from the tenant.
const P_ATS = P('a1', 'cydereal.bsky.social', 'My team is hiring an Associate Encounter Designer!\n\nWe\'d love a WoW PvE expert.', { embed: card(WD) });
// LinkedIn feed update is not a vacancy → dropped.
const P_LI_FEED = P('a2', 'designswarm.bsky.social', "I'm hiring. Tell your Senior user researcher friends in London.", { embed: card('https://www.linkedin.com/feed/update/urn:li:activity:7513528723799793664/') });
// Not a hiring post → dropped even with a vacancy link.
const P_CHATTER = P('a3', 'jane.bsky.social', 'Great talk on hiring pipelines today, slides here', { facets: facet(GH) });
// "hiring freeze" must not read as a hiring post.
const P_FREEZE = P('a4', 'jane.bsky.social', 'Our hiring freeze continues.', { facets: facet(GH) });
// Watched actor with a declared employer, link in a facet.
const P_DECLARED = P('a5', 'jane.bsky.social', 'Hey folks! We\'re hiring a Staff Platform Engineer to own our Kubernetes fleet. Remote US.', { facets: facet(GH) });
// Board link (LinkedIn job view) with no named employer → dropped.
const P_BOARD_ANON = P('a6', 'rec.bsky.social', 'Now hiring a Data Engineer!', { embed: card('https://www.linkedin.com/jobs/view/4123456789/') });
// Board link with an employer named in the text → emitted.
const P_BOARD_NAMED = P('a7', 'rec.bsky.social', 'Senior Data Engineer @ Northwind\nNow hiring, remote.', { embed: card('https://www.linkedin.com/jobs/view/4123456790/') });
// Digest: two vacancy pages → dropped.
const P_DIGEST = P('a8', 'rec.bsky.social', 'We are hiring two roles!', { facets: [...facet(GH), ...facet('https://boards.greenhouse.io/acme/jobs/9988776')] });
// Too old for the window.
const P_OLD = P('a9', 'jane.bsky.social', "We're hiring a Backend Engineer.", { daysAgo: 60, facets: facet('https://boards.greenhouse.io/acme/jobs/1112223') });

const quiet = { sleep: async () => {} };

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/bluesky.mjs')).href);
  const bs = mod.default;
  const { postToJob, hiringTitle, postLinks, normalizeActors, companyFromAtsUrl, companyFromCardTitle, companyFromProfile } = mod;

  if (bs.id === 'bluesky') pass('bluesky.id is "bluesky"'); else fail(`bluesky.id is ${JSON.stringify(bs.id)}`);
  if (typeof bs.detect !== 'function') pass('bluesky has no detect() — explicit provider: only'); else fail('bluesky must not auto-detect');

  // ── hiringTitle ──
  const t1 = hiringTitle('Hey folks! My team is hiring a corporate security engineer. We’re looking for someone…');
  if (t1 === 'My team is hiring a corporate security engineer.') pass('hiringTitle picks the sentence announcing the hire');
  else fail(`hiringTitle → ${JSON.stringify(t1)}`);
  const t2 = hiringTitle("I'm hiring. Tell your Senior user researcher friends in London.");
  if (t2 === "I'm hiring. Tell your Senior user researcher friends in London.") pass('a bare "I\'m hiring." borrows the next sentence so the role reaches title_filter');
  else fail(`hiringTitle short → ${JSON.stringify(t2)}`);
  const t3 = hiringTitle(`We're hiring ${'a very long role description '.repeat(10)}`);
  if (t3.length <= 121 && t3.endsWith('…')) pass('a long title is cut at a word boundary with an ellipsis');
  else fail(`long hiringTitle → ${JSON.stringify(t3)}`);

  // ── postLinks ──
  const links = postLinks({ facets: facet(GH), embed: { $type: 'app.bsky.embed.recordWithMedia', media: card(WD) } });
  if (links.length === 2 && links[0] === GH && links[1] === WD) pass('postLinks reads link facets and the card inside a quote-with-media embed');
  else fail(`postLinks → ${JSON.stringify(links)}`);

  // ── postToJob policy ──
  const ats = postToJob(P_ATS);
  if (ats && ats.url === WD && ats.company === 'Xboxgaming' && ats.title.startsWith('My team is hiring')) pass('employer ATS link + no named employer → company from the Workday tenant, url = the ATS page');
  else fail(`P_ATS → ${JSON.stringify(ats)}`);
  if (ats?.description.includes('Source: https://bsky.app/profile/cydereal.bsky.social/post/a1 (posted by @cydereal.bsky.social)')) pass('description carries the bsky.app permalink and poster as Source:');
  else fail(`P_ATS description → ${JSON.stringify(ats?.description)}`);
  if (ats?.note === 'bsky post https://bsky.app/profile/cydereal.bsky.social/post/a1 by @cydereal.bsky.social; company inferred from workday board slug, unverified')
    pass('note carries the post permalink + poster and flags a deduced employer as unverified');
  else fail(`P_ATS note → ${JSON.stringify(ats?.note)}`);
  if (postToJob(P_LI_FEED) === null) pass('a LinkedIn feed update is not a vacancy link → dropped'); else fail('P_LI_FEED should drop');
  if (postToJob(P_CHATTER) === null) pass('a post that announces no hire is dropped'); else fail('P_CHATTER should drop');
  if (postToJob(P_FREEZE) === null) pass('"hiring freeze" does not read as a hiring post'); else fail('P_FREEZE should drop');
  const decl = postToJob(P_DECLARED, { company: 'Acme' });
  if (decl && decl.company === 'Acme' && decl.url === GH && !/inferred/.test(decl.note)) pass('a watched actor\'s declared company is the employer, not flagged as inferred');
  else fail(`P_DECLARED → ${JSON.stringify(decl)}`);
  const repost = postToJob(P_DECLARED, { company: 'Acme', isRepost: true });
  if (repost && repost.company === 'Acme' && /greenhouse board slug, unverified/.test(repost.note)) pass('a declared company is never applied to that actor\'s reposts (the slug names it instead, flagged)');
  else fail(`repost → ${JSON.stringify(repost)}`);
  if (postToJob(P_BOARD_ANON) === null) pass('a board link with no named employer is unattributable → dropped'); else fail('P_BOARD_ANON should drop');
  const named = postToJob(P_BOARD_NAMED);
  if (named && named.company === 'Northwind') pass('a board link with "Title @ Employer" in the text → Job with that employer');
  else fail(`P_BOARD_NAMED → ${JSON.stringify(named)}`);
  // ── employer deduction ──
  const gh = companyFromAtsUrl('https://job-boards.greenhouse.io/embed/job_app?for=north-wind&token=1');
  if (gh?.company === 'North Wind' && gh.ats === 'greenhouse') pass('companyFromAtsUrl reads the Greenhouse embed ?for= board and humanizes the slug');
  else fail(`greenhouse embed → ${JSON.stringify(gh)}`);
  if (companyFromAtsUrl('https://jobs.ashbyhq.com/linear/abc')?.company === 'Linear' && companyFromAtsUrl('https://acme.com/careers/123') === null)
    pass('companyFromAtsUrl reads ATS board slugs and ignores non-ATS hosts');
  else fail('companyFromAtsUrl ashby/non-ATS');
  const cards = [
    ['Job Application for Staff Engineer at Acme Robotics', '', 'Acme Robotics'],
    ['Northwind hiring Data Engineer in London | LinkedIn', 'https://www.linkedin.com/jobs/view/1/', 'Northwind'],
    ['Acme - Senior Engineer', 'https://jobs.lever.co/acme/1', 'Acme'],
    ['Senior Engineer | Remote', '', ''],
  ];
  const badCard = cards.find(([t, u, want]) => companyFromCardTitle(t, u) !== want);
  if (!badCard) pass('companyFromCardTitle reads Greenhouse/LinkedIn/Lever/"at" shapes and refuses a location after a pipe');
  else fail(`companyFromCardTitle(${JSON.stringify(badCard[0])}) → ${JSON.stringify(companyFromCardTitle(badCard[0], badCard[1]))}`);
  const bios = [
    ['Senior Recruiter at Contoso helping people grow', 'Contoso'],
    ['Talent Partner @ Northwind | ex-Google', 'Northwind'],
    ['Recruiter at Hays Technology', ''],
    ['Agency recruiter for fintech clients. Recruiter @ Bigco', ''],
    ['Engineer at Acme, Founder at SideCo', ''],
    ['Dad, runner, coffee', ''],
  ];
  const badBio = bios.find(([d, want]) => companyFromProfile({ description: d }) !== want);
  if (!badBio) pass('companyFromProfile takes one stated employer, never an agency, a past role or an ambiguous bio');
  else fail(`companyFromProfile(${JSON.stringify(badBio[0])}) → ${JSON.stringify(companyFromProfile({ description: badBio[0] }))}`);
  const P_BOARD_CARD = P('b1', 'rec.bsky.social', 'Now hiring a Data Engineer!', { embed: card('https://www.linkedin.com/jobs/view/4123456791/', 'Fabrikam hiring Data Engineer in Berlin | LinkedIn') });
  const bc = postToJob(P_BOARD_CARD);
  if (bc?.company === 'Fabrikam' && /link preview title, unverified/.test(bc.note)) pass('a board link the text leaves anonymous is attributed from its link card title, flagged');
  else fail(`P_BOARD_CARD → ${JSON.stringify(bc)}`);
  const bp = postToJob(P_BOARD_ANON, { profile: { description: 'Technical Recruiter @ Contoso' } });
  if (bp?.company === 'Contoso' && /poster's Bluesky bio, unverified/.test(bp.note)) pass('a board link is attributed from the poster\'s bio when nothing else names the employer');
  else fail(`P_BOARD_ANON + bio → ${JSON.stringify(bp)}`);
  if (postToJob(P_BOARD_ANON, { profile: { description: 'Recruitment consultant at Hays' } }) === null) pass('an agency recruiter\'s bio never becomes the employer → still dropped');
  else fail('agency bio attributed a board link');
  const P_OWN = P('b2', 'em.bsky.social', 'We\'re hiring a Backend Engineer!', { facets: facet('https://careers.example.org/jobs/123') });
  const own = postToJob(P_OWN);
  if (own?.company === '' && /employer not named$/.test(own.note)) pass('an employer-site link with nothing naming the employer stays blank and says so');
  else fail(`P_OWN → ${JSON.stringify(own)}`);

  if (postToJob(P_DIGEST) === null) pass('a post linking two vacancies is a digest → dropped'); else fail('P_DIGEST should drop');

  // ── normalizeActors ──
  const actors = normalizeActors(['@jane.bsky.social', { handle: 'bob.dev', company: 'Acme' }]);
  if (actors.length === 2 && actors[0].actor === 'jane.bsky.social' && actors[1].company === 'Acme') pass('actors accept bare handles (leading @ stripped) and { handle, company }');
  else fail(`normalizeActors → ${JSON.stringify(actors)}`);
  let threw = false;
  try { normalizeActors(['evil.com/../x?y=1']); } catch { threw = true; }
  if (threw) pass('an actor that is not a handle or DID is refused before any request'); else fail('bad handle accepted');

  // ── fetch(): routing, window, dedup, hosts ──
  const calls = [];
  const ctx = {
    ...quiet,
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      if (url.includes('getAuthorFeed')) {
        return { feed: [
          { post: P_DECLARED },
          { post: P_ATS, reason: { $type: 'app.bsky.feed.defs#reasonRepost', indexedAt: iso(1) } },
          { post: P_CHATTER },
          { post: P_OLD },
        ], cursor: 'next' };
      }
      if (url.includes('searchPosts')) return { posts: [P_DECLARED, P_BOARD_NAMED] };
      throw new Error(`unexpected ${url}`);
    },
  };
  const jobs = await bs.fetch({ name: 'BS', actors: [{ handle: 'jane.bsky.social', company: 'Acme' }], search: '"my team is hiring"' }, ctx);
  const urls = jobs.map((j) => j.url).sort();
  if (jobs.length === 3 && urls.includes(GH) && urls.includes(WD)) pass('fetch() merges actor feed + search, dedups by post, drops chatter');
  else fail(`fetch jobs → ${JSON.stringify(jobs.map((j) => [j.company, j.url]))}`);
  const author = calls.filter((c) => c.url.includes('getAuthorFeed'));
  if (author.length === 1) pass('the author feed stops at the window: an older own post ends paging despite a cursor');
  else fail(`author feed pages = ${author.length}`);
  if (author[0]?.url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=jane.bsky.social&filter=posts_no_replies'))
    pass('author feed is read from public.api.bsky.app without replies');
  else fail(`author url = ${author[0]?.url}`);
  const search = calls.find((c) => c.url.includes('searchPosts'));
  if (search?.url.startsWith('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=%22my%20team%20is%20hiring%22&sort=latest&since='))
    pass('search goes to api.bsky.app (public.api answers 403 for search), newest first, bounded by since=');
  else fail(`search url = ${search?.url}`);
  if (calls.every((c) => c.opts?.redirect === 'error')) pass('every request refuses redirects'); else fail('a request allowed redirects');
  const declaredJob = jobs.find((j) => j.url === GH);
  if (declaredJob?.company === 'Acme') pass('a watched actor\'s post surfacing via search still gets their declared company');
  else fail(`declared via search → ${JSON.stringify(declaredJob)}`);

  // ── profile lookup: only for posts still missing an employer, batched ──
  const P_SEARCH_ANON = { ...P('c1', 'rec.bsky.social', 'Now hiring a Data Engineer!', { embed: card('https://www.linkedin.com/jobs/view/4123456792/') }),
    author: { did: 'did:plc:cccccccccccccccccccccccc', handle: 'rec.bsky.social' } };
  const profCalls = [];
  const profCtx = {
    ...quiet,
    async fetchJson(url) {
      profCalls.push(url);
      if (url.includes('searchPosts')) return { posts: [P_SEARCH_ANON, P_DECLARED] };
      if (url.includes('getProfiles')) return { profiles: [{ did: 'did:plc:cccccccccccccccccccccccc', handle: 'rec.bsky.social', description: 'Recruiter at Contoso' }] };
      throw new Error(`unexpected ${url}`);
    },
  };
  const profJobs = await bs.fetch({ name: 'P', search: 'now hiring' }, profCtx);
  const prof = profCalls.filter((u) => u.includes('getProfiles'));
  if (prof.length === 1 && prof[0] === 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?actors=did%3Aplc%3Acccccccccccccccccccccccc'
      && profJobs.some((j) => j.company === 'Contoso'))
    pass('fetch() looks up bios once, only for authors whose posts no other source attributed');
  else fail(`profile lookup → calls=${JSON.stringify(prof)} jobs=${JSON.stringify(profJobs.map((j) => j.company))}`);
  const failCtx = { ...profCtx, async fetchJson(url) { if (url.includes('getProfiles')) throw new Error('503'); return profCtx.fetchJson(url); } };
  const origErr = console.error; console.error = () => {};
  let failJobs;
  try { failJobs = await bs.fetch({ name: 'P', search: 'now hiring' }, failCtx); } finally { console.error = origErr; }
  if (failJobs.length === 1) pass('a failed profile lookup drops only the bio fallback, not the run');
  else fail(`profile failure → ${failJobs.length} jobs`);

  let emptyErr = '';
  try { await bs.fetch({ name: 'Empty' }, ctx); } catch (e) { emptyErr = e.message; }
  if (/needs at least one of actors, list or search/.test(emptyErr)) pass('an entry with no actors, list or search fails loudly instead of reading as an empty board');
  else fail(`empty entry → ${JSON.stringify(emptyErr)}`);

  // ── list resolution ──
  const listCalls = [];
  const listCtx = {
    ...quiet,
    async fetchJson(url) {
      listCalls.push(url);
      if (url.includes('resolveHandle')) return { did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' };
      if (url.includes('getListFeed')) return { feed: [{ post: P_ATS }] };
      throw new Error(`unexpected ${url}`);
    },
  };
  const listJobs = await bs.fetch({ name: 'L', list: 'https://bsky.app/profile/me.bsky.social/lists/3kabc123' }, listCtx);
  const lf = listCalls.find((u) => u.includes('getListFeed'));
  if (listJobs.length === 1 && lf?.includes(encodeURIComponent('at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.graph.list/3kabc123')))
    pass('a bsky.app list URL resolves its owner handle to a DID and reads getListFeed');
  else fail(`list → jobs=${listJobs.length} calls=${JSON.stringify(listCalls)}`);
  let listErr = '';
  try { await bs.fetch({ name: 'L', list: 'https://evil.example/lists/x' }, listCtx); } catch (e) { listErr = e.message; }
  if (/list must be/.test(listErr)) pass('a list value that is not a Bluesky list URI/URL is refused'); else fail(`bad list → ${listErr}`);
} catch (err) {
  fail(`bluesky provider tests crashed: ${err.stack || err.message}`);
}
