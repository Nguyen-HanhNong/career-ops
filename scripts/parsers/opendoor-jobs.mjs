#!/usr/bin/env node

const careersUrl = process.argv[2] || 'https://www.opendoor.com/careers/open-positions';

function decodeHtml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

const response = await fetch(careersUrl, {
  headers: {
    'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.8)',
  },
});

if (!response.ok) {
  throw new Error(`OpenDoor careers page returned HTTP ${response.status}`);
}

const html = await response.text();
const jobs = [];
const seen = new Set();

const linkPattern = /<a\b[^>]*href="([^"]*\/careers\/open-positions\/jobs\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
for (const match of html.matchAll(linkPattern)) {
  const url = new URL(decodeHtml(match[1]), careersUrl).href;
  if (seen.has(url)) continue;
  seen.add(url);

  const title = decodeHtml(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  if (!title) continue;

  const afterLink = html.slice(match.index + match[0].length, match.index + match[0].length + 600);
  const locationMatch = afterLink.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  const location = locationMatch
    ? decodeHtml(locationMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    : '';

  jobs.push({ title, url, company: 'OpenDoor', location });
}

console.log(JSON.stringify(jobs));
