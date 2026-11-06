// tests/portal-tools-response-cap.test.mjs — verify-portals and audit-portals
// read a board with the entry's max_response_mb, the same way the scan does.
//
// Local patch, not upstream. v1.39 refuses a response body over 10 MiB unless
// the portals.yml entry raises the cap, but only scan.mjs applied the setting,
// so both health checks reported boards the scan reads fine (OpenAI, SpaceX) as
// broken. If this fails after an update, the patch was dropped from one of them.
//
// Run:  node --test tests/portal-tools-response-cap.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCompanies } from '../audit-portals.mjs';
import { verifyCompanies } from '../verify-portals.mjs';
import { ASHBY_TIMEOUT_MS } from '../providers/ashby.mjs';

const MB = 1024 * 1024;

function recordingFetch(body) {
  const calls = [];
  return { calls, fetchJson: async (_url, opts) => { calls.push(opts); return body; } };
}

function recordingProvider() {
  return new Map([['fake', {
    id: 'fake',
    detect: () => ({ url: 'x' }),
    fetch: async (_entry, ctx) => {
      await ctx.fetchJson('https://example.test/board');
      return [{ title: 'Engineer', url: 'https://example.test/1', location: 'Remote' }];
    },
  }]]);
}

const ashbyEntry = (extra) => ({ name: 'BigCo', careers_url: 'https://jobs.ashbyhq.com/bigco', ...extra });
const providerEntry = (extra) => ({ name: 'BigCo', careers_url: 'https://example.test/careers', ...extra });

test('verify-portals raises the cap on a direct ATS probe and keeps the timeout', async () => {
  const { calls, fetchJson } = recordingFetch({ jobs: [{ id: 'a' }] });
  const rows = await verifyCompanies([ashbyEntry({ max_response_mb: 32 })], { fetchJson, concurrency: 1 });
  assert.equal(rows[0].status, 'live');
  assert.equal(calls[0].maxBytes, 32 * MB);
  assert.equal(calls[0].timeoutMs, ASHBY_TIMEOUT_MS);
});

test('verify-portals raises the cap on a provider probe', async () => {
  const { calls, fetchJson } = recordingFetch({});
  const rows = await verifyCompanies([providerEntry({ max_response_mb: 64 })], {
    providers: recordingProvider(),
    httpCtx: { fetchJson },
    concurrency: 1,
  });
  assert.equal(rows[0].status, 'live');
  assert.equal(calls[0].maxBytes, 64 * MB);
});

test('verify-portals leaves the default cap when the setting is absent or invalid', async () => {
  for (const extra of [{}, { max_response_mb: '32' }, { max_response_mb: 0 }, { max_response_mb: -1 }]) {
    const { calls, fetchJson } = recordingFetch({ jobs: [{ id: 'a' }] });
    await verifyCompanies([ashbyEntry(extra)], { fetchJson, concurrency: 1 });
    assert.equal(calls[0]?.maxBytes, undefined, JSON.stringify(extra));
  }
});

test('audit-portals raises the cap for that entry only, even on a shared ctx', async () => {
  const { calls, fetchJson } = recordingFetch({});
  const httpCtx = { fetchJson };
  const rows = await auditCompanies(
    [providerEntry({ max_response_mb: 64 }), { ...providerEntry(), name: 'SmallCo' }],
    { providers: recordingProvider(), httpCtx, concurrency: 1 },
  );
  assert.equal(rows.length, 2);
  assert.equal(calls[0].maxBytes, 64 * MB);
  assert.equal(calls[1]?.maxBytes, undefined);
  assert.equal(httpCtx.fetchJson, fetchJson, 'the shared ctx must not be rewrapped');
});
