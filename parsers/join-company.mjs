#!/usr/bin/env node

import { readFile } from 'fs/promises';

function usage() {
  console.error('Usage: node parsers/join-company.mjs <join-company-url>');
  process.exit(1);
}

function clean(value) {
  return String(value || '').trim();
}

function companySlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/companies\/([^/]+)/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function extractNextData(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function toJobs(payload, baseUrl, slug) {
  const jobs = payload?.props?.pageProps?.initialState?.jobs?.items;
  if (!Array.isArray(jobs)) return [];

  return jobs
    .map((job) => {
      const title = clean(job?.title);
      const idParam = clean(job?.idParam);
      if (!title || !idParam) return null;
      return {
        title,
        url: `https://join.com/companies/${slug}/${idParam}`,
        company: clean(payload?.props?.pageProps?.initialState?.company?.name) || clean(payload?.props?.pageProps?.initialState?.job?.company?.name),
        location: clean([job?.city?.cityName, job?.city?.countryName].filter(Boolean).join(', ')),
      };
    })
    .filter(Boolean);
}

async function main() {
  const input = process.argv[2];
  if (!input) usage();

  const companyUrl = String(input);
  const slug = companySlugFromUrl(companyUrl);
  if (!slug) usage();

  const response = await fetch(companyUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; career-ops local-parser)',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${companyUrl}`);
  }

  const html = await response.text();
  const payload = extractNextData(html);
  const jobs = payload ? toJobs(payload, companyUrl, slug) : [];

  process.stdout.write(JSON.stringify({ jobs }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
