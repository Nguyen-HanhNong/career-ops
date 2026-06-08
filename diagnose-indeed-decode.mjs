#!/usr/bin/env node
/**
 * Diagnose the Indeed URL corruption + whether Indeed is reachable by Playwright.
 *
 * Test A: Prove the corruption is a double quoted-printable decode (=XX -> byte),
 *         and show whether the job key (jk) is recoverable.
 * Test B: Check if Playwright can reach Indeed at all (bot-block check), using a
 *         normal search URL built from the CLEAN title/company in the email.
 */

import { chromium } from 'playwright';

// ---------- TEST A: corruption analysis ----------
console.log('='.repeat(80));
console.log('TEST A — Corruption analysis (quoted-printable double-decode)');
console.log('='.repeat(80));

// What we received from the MCP (corrupted) vs known-clean values from the footer
const cases = [
  { field: 'alid', received: 'alidj233651ec088f2355e6082e', cleanFromFooter: 'alid=6a233651ec088f2355e6082e' },
  { field: 'jk (Google)', received: 'jk.411dcf982837ea', cleanFromFooter: '(no clean copy exists anywhere in the email)' },
  { field: 'jk (Tower)', received: 'jkkea5607afaca107', cleanFromFooter: '(no clean copy exists anywhere in the email)' },
];

// QP decode rule: '=' + 2 hex -> that byte; '=' + non-hex -> unchanged
function qpDecodeOnce(s) {
  return s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

console.log('\nVerify the rule "=6a -> j" explains the alid corruption:');
const alidOnceDecoded = qpDecodeOnce('alid=6a233651ec088f2355e6082e');
console.log(`  clean  : alid=6a233651ec088f2355e6082e`);
console.log(`  decode : ${alidOnceDecoded}`);
console.log(`  received: alidj233651ec088f2355e6082e`);
console.log(`  MATCH  : ${alidOnceDecoded === 'alidj233651ec088f2355e6082e' ? '✅ yes — confirms double-decode' : '❌ no'}`);

console.log('\nReverse attempt on job keys (is the original recoverable?):');
for (const c of cases) {
  if (!c.field.startsWith('jk')) continue;
  console.log(`  ${c.field}: received "${c.received}"`);
  console.log(`    -> '.' / missing / � shows a byte was already consumed by the bad decode.`);
  console.log(`    -> The eaten "=XX" is ambiguous (e.g. 'j' could be literal 'j' OR from =6A),`);
  console.log(`       and unlike alid/subId/alert (which appear CLEAN in the footer's`);
  console.log(`       /update/6a2336... link), the jk has NO clean copy anywhere else.`);
  console.log(`    -> VERDICT: job key NOT recoverable from the corrupted body. ❌`);
}

// ---------- TEST B: is Indeed reachable by Playwright at all? ----------
console.log('\n' + '='.repeat(80));
console.log('TEST B — Can Playwright reach Indeed? (bot-block check)');
console.log('='.repeat(80));

async function testReachability() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  const targets = [
    { label: 'Indeed homepage', url: 'https://www.indeed.com/' },
    {
      label: 'Indeed search (clean metadata from email)',
      url: 'https://www.indeed.com/jobs?' +
        new URLSearchParams({ q: 'Google Software Engineer Data Global Sustainability', l: 'New York, NY' }).toString()
    },
  ];

  for (const t of targets) {
    try {
      const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2500);
      const status = resp.status();
      const title = await page.title().catch(() => '');
      const body = (await page.textContent('body').catch(() => '')) || '';
      const low = (title + ' ' + body.slice(0, 1500)).toLowerCase();
      let verdict;
      if (low.includes('blocked') || low.includes('verify') || low.includes('captcha') || low.includes('not a robot')) {
        verdict = '🔴 BLOCKED by bot detection';
      } else if (status >= 400) {
        verdict = `🔴 HTTP ${status}`;
      } else {
        verdict = '🟢 reachable';
      }
      console.log(`\n${t.label}`);
      console.log(`  status=${status} title="${title}" verdict=${verdict}`);
    } catch (e) {
      console.log(`\n${t.label}\n  🔴 ERROR: ${e.message}`);
    }
  }

  await ctx.close();
  await browser.close();
}

await testReachability();
