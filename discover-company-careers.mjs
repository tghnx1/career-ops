#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  buildLocationFilter,
  buildTitleFilter,
  evaluateCompany,
  normalizeKeywordList,
} from './lib/company-discovery.mjs';

import { deriveSlugCandidates, parseAtsSlug, probeSlug } from './verify-portals.mjs';

const DUMPS_DIR = path.resolve('data/company-dumps');
const PORTALS_PATH = path.resolve('portals.yml');
const OUT_DIR = path.resolve('output');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const args = {
    limit: Infinity,
    write: false,
    includeManual: false,
    section: 'direct',
    source: 'startup-map-berlin',
    company: '',
    concurrency: 6,
    allOpenings: false,
    allCompanies: false,
    verbose: false,
    noBrowser: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[++i] || Infinity);
    else if (arg === '--write') args.write = true;
    else if (arg === '--include-manual') args.includeManual = true;
    else if (arg === '--section') args.section = argv[++i] || args.section;
    else if (arg === '--source') args.source = argv[++i] || args.source;
    else if (arg === '--company') args.company = argv[++i] || '';
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i] || args.concurrency);
    else if (arg === '--all-openings') args.allOpenings = true;
    else if (arg === '--all-companies') args.allCompanies = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--no-browser') args.noBrowser = true;
  }

  return args;
}


function loadPortalsConfig() {
  if (!existsSync(PORTALS_PATH)) throw new Error('portals.yml not found');
  return yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}

function parseJsonFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  return [];
}

function parseJsonlFile(filePath) {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function loadDumpItems(filePath) {
  if (filePath.endsWith('.jsonl')) return parseJsonlFile(filePath);
  if (filePath.endsWith('.json')) return parseJsonFile(filePath);
  return [];
}

function getCompanySummary(company) {
  const parts = [];
  if (company?.tagline) parts.push(company.tagline);
  const industries = Array.isArray(company?.industries) ? company.industries.map(x => x?.name).filter(Boolean) : [];
  if (industries.length) parts.push(`industries: ${industries.slice(0, 4).join(', ')}`);
  if (company?.employees) parts.push(`size: ${company.employees}`);
  if (company?.growth_stage) parts.push(`stage: ${company.growth_stage}`);
  return parts.join(' | ');
}

function loadRelevantCompanies(config, section, includeManual, companyFilter = '', allOpenings = false, allCompanies = false) {
  if (!existsSync(DUMPS_DIR)) throw new Error(`Dump directory not found: ${DUMPS_DIR}`);

  const titleFilter = buildTitleFilter(config?.title_filter);
  const locationFilter = buildLocationFilter(config?.location_filter);
  const files = readdirSync(DUMPS_DIR).filter(name => /\.(json|jsonl)$/i.test(name)).sort();
  const normalizedCompanyFilter = normalizeName(companyFilter);

  const evaluated = [];
  for (const file of files) {
    const filePath = path.join(DUMPS_DIR, file);
    let items = [];
    try {
      items = loadDumpItems(filePath);
    } catch {
      continue;
    }
    for (const company of items) {
      if (normalizedCompanyFilter) {
        const rawName = normalizeName(company?.name || company?.path || company?.uuid || '');
        if (!rawName.includes(normalizedCompanyFilter)) continue;
      }
      evaluated.push({
        ...evaluateCompany(company, titleFilter, locationFilter),
        summary: getCompanySummary(company),
        linkedin: company?.linkedin_url || '',
        careersHint: company?.linkedin_url || '',
        websitePath: company?.path || '',
        employees: company?.employees || '',
        sourceUuid: company?.uuid || '',
      });
    }
  }

  const seen = new Set();
  const deduped = evaluated.filter(item => {
    const key = item.slug || item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (allCompanies) {
    return deduped.filter(item => item.discoveryEligible);
  }

  if (allOpenings) {
    return deduped.filter(item => item.hasOpeningsSignal);
  }

  return deduped.filter(item => {
    if (section === 'all') return item.discoveryEligible;
    if (section === 'manual') return item.relevance === 'check-manually' || item.relevance === 'no-current-fit';
    if (includeManual) return item.hasOpeningsSignal;
    return item.relevance === 'direct-role-match';
  });
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function buildAtsApiUrl(careersUrl) {
  const parsed = parseAtsSlug(careersUrl);
  if (!parsed) return null;
  const { ats, slug } = parsed;
  if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  if (ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  if (ats === 'lever') return `https://api.lever.co/v0/postings/${slug}`;
  return null;
}

function buildAtsCareersUrl(ats, slug) {
  if (ats === 'greenhouse') return `https://job-boards.greenhouse.io/${slug}`;
  if (ats === 'ashby') return `https://jobs.ashbyhq.com/${slug}`;
  if (ats === 'lever') return `https://jobs.lever.co/${slug}`;
  return null;
}

function buildPortalEntry(companyName, careersUrl, notes) {
  const entry = {
    name: companyName,
    careers_url: careersUrl,
    notes,
    enabled: true,
  };
  const api = buildAtsApiUrl(careersUrl);
  if (api) entry.api = api;
  return entry;
}

function serializePortalEntry(entry) {
  const dumped = yaml.dump(entry, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trimEnd();
  const lines = dumped.split('\n');
  return lines.map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`)).join('\n');
}

function appendPortalEntries(fileText, entries) {
  if (!entries.length) return fileText;
  const addition = entries.map(serializePortalEntry).join('\n\n');
  const trimmed = fileText.replace(/\s*$/, '');
  return `${trimmed}\n\n${addition}\n`;
}

function createLogger(verbose) {
  return {
    info(companyName, message) {
      console.log(`[${companyName}] ${message}`);
    },
    detail(companyName, message) {
      if (verbose) console.log(`[${companyName}] ${message}`);
    },
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  const limit = Math.max(1, Number(concurrency) || 1);

  async function runOne() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
  await Promise.all(runners);
  return results;
}

function careersKeywords() {
  return [
    'careers',
    'career',
    'jobs',
    'join',
    'join-us',
    'joinus',
    'open-positions',
    'open-roles',
    'vacancies',
    'work-with-us',
    'hiring',
    'positions',
  ];
}

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.0)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

function scoreCandidate(url, companyName) {
  const lower = String(url || '').toLowerCase();
  const normalizedCompany = normalizeName(companyName);
  let score = 0;
  if (lower.includes('careers') || lower.includes('jobs') || lower.includes('join')) score += 6;
  if (normalizedCompany && normalizeName(lower).includes(normalizedCompany)) score += 3;
  if (lower.includes('greenhouse') || lower.includes('lever') || lower.includes('ashby') || lower.includes('workday')) score += 3;
  if (lower.includes('apply.workable.com') || lower.includes('jobs.personio.de') || lower.includes('jobs.ashbyhq.com') || lower.includes('job-boards.greenhouse.io') || lower.includes('jobs.lever.co')) score += 8;
  if (lower.includes('linkedin.com')) score -= 6;
  if (lower.includes('facebook.com')) score -= 4;
  return score;
}

function isSupportedPortalUrl(url) {
  const lower = String(url || '').toLowerCase();
  return (
    lower.includes('apply.workable.com') ||
    lower.includes('jobs.personio.de') ||
    lower.includes('jobs.ashbyhq.com') ||
    lower.includes('job-boards.greenhouse.io') ||
    lower.includes('jobs.lever.co')
  );
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/l/') {
      const target = parsed.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return parsed.href;
  } catch {
    return '';
  }
}

async function searchCompany(companyName, { allowBrowser = true, verbose = false } = {}) {
  let browserNoticeShown = false;
  async function searchWithPlaywright(queryText) {
    if (!allowBrowser) return [];
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryText)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1000);
      return await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a.result__a[href]'));
        return anchors.map(anchor => anchor.getAttribute('href') || '').filter(Boolean);
      });
    } catch {
      return [];
    } finally {
      await browser.close().catch(() => {});
    }
  }

  try {
    const queries = [
      `${companyName} careers jobs`,
      `${companyName} hiring`,
      `${companyName} open positions`,
      `${companyName} work with us`,
      `${companyName} join our team`,
    ];
    const rawLinks = [];
    for (const queryText of queries) {
      if (verbose) {
        console.log(`[${companyName}] search query: ${queryText}`);
      }
      let links = [];
      try {
        const query = encodeURIComponent(queryText);
        const { text } = await fetchHtml(`https://html.duckduckgo.com/html/?q=${query}`);
        const re = /class="result__a" href="([^"]+)"/g;
        for (let match = re.exec(text); match; match = re.exec(text)) {
          links.push(decodeHtmlEntities(match[1]));
        }
      } catch {
        links = [];
      }
      if (links.length === 0) {
        if (verbose && !allowBrowser && !browserNoticeShown) {
          console.log(`[${companyName}] DDG HTML search returned no links; browser fallback disabled`);
          browserNoticeShown = true;
        }
        links = await searchWithPlaywright(queryText);
        if (verbose && links.length > 0) {
          console.log(`[${companyName}] browser search fallback returned ${links.length} link(s)`);
        }
      }
      rawLinks.push(...links);
    }

    const seen = new Set();
    const unique = [];
    for (const link of rawLinks.map(normalizeUrl)) {
      if (!link || seen.has(link)) continue;
      seen.add(link);
      unique.push(link);
    }

    return unique
      .map(link => ({ url: link, score: scoreCandidate(link, companyName) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

async function verifyUrl(url) {
  try {
    const { response, text } = await fetchHtml(url);
    const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const bodyText = stripHtml(text).slice(0, 2500);
    const lower = `${title} ${bodyText}`.toLowerCase();
    const lowerUrl = url.toLowerCase();

    if ((response && response.status() >= 400) || lower.includes('404') || lower.includes('not found')) {
      return { status: 'dead', note: `HTTP ${response?.status || 'n/a'}` };
    }
    if (/(career|careers|jobs|open-roles|open-positions|vacancies|work-with-us|join-us)/i.test(lowerUrl)) {
      return { status: 'careers-page', note: title || url };
    }
    if (lowerUrl.includes('linkedin.com/company/') && !lowerUrl.includes('/jobs')) {
      return { status: 'linkedin-company', note: title };
    }
    if (lowerUrl.includes('linkedin.com/company/') && lowerUrl.includes('/jobs')) {
      return { status: 'linkedin-jobs', note: title };
    }
    if (/(career|careers|jobs|open roles|open positions|join us|work with us|vacancies)/i.test(lower)) {
      return { status: 'careers-page', note: title };
    }
    if (/(contact|about us|team|company)/i.test(lower)) {
      return { status: 'company-page', note: title };
    }
    return { status: 'uncertain', note: title };
  } catch (err) {
    return { status: 'error', note: err.message };
  }
}

async function verifyUrlWithPlaywright(url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(900);
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500));
    const title = await page.title();
    const lower = `${title} ${bodyText}`.toLowerCase();
    const lowerUrl = url.toLowerCase();

    if ((response && response.status() >= 400) || lower.includes('404') || lower.includes('not found')) {
      return { status: 'dead', note: `HTTP ${response?.status?.() || 'n/a'}` };
    }
    if (/(career|careers|jobs|open-roles|open-positions|vacancies|work-with-us|join-us)/i.test(lowerUrl)) {
      return { status: 'careers-page', note: title || url };
    }
    if (/(career|careers|jobs|open roles|open positions|join us|work with us|vacancies)/i.test(lower)) {
      return { status: 'careers-page', note: title || url };
    }
    if (/(contact|about us|team|company)/i.test(lower)) {
      return { status: 'company-page', note: title || url };
    }
    return { status: 'uncertain', note: title || url };
  } catch (err) {
    return { status: 'error', note: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function extractLinksWithPlaywright(url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(900);
    return await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors.slice(0, 200).map(anchor => ({
        href: anchor.getAttribute('href') || '',
        text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim(),
      }));
    });
  } catch {
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}

async function findCareersLink(companyUrl, { allowBrowser = true, verbose = false, companyName = '' } = {}) {
  let browserNoticeShown = false;
  try {
    const { text } = await fetchHtml(companyUrl);
    const links = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    for (let match = re.exec(text); match; match = re.exec(text)) {
      links.push({
        href: decodeHtmlEntities(match[1]),
        text: stripHtml(match[2]).toLowerCase(),
      });
    }

    for (const link of links) {
      const target = `${link.href} ${link.text}`.toLowerCase();
      if (!careersKeywords().some(keyword => target.includes(keyword))) continue;
      const url = normalizeUrl(link.href);
      if (!url) continue;
      const verdict = await verifyUrl(url);
      if (verdict.status === 'careers-page' || verdict.status === 'linkedin-jobs') return url;
      if (verdict.status === 'company-page' && /careers|jobs|join|vacanc/i.test(url)) return url;
    }
  } catch {
    // fall through to browser rendering
  }

  if (!allowBrowser) {
    if (verbose && !browserNoticeShown) {
      console.log(`[${companyName || companyUrl}] browser fallback disabled`);
      browserNoticeShown = true;
    }
    return null;
  }

  try {
    const links = await extractLinksWithPlaywright(companyUrl);
    for (const link of links) {
      const target = `${link.href} ${link.text}`.toLowerCase();
      if (!careersKeywords().some(keyword => target.includes(keyword))) continue;
      const url = normalizeUrl(new URL(link.href, companyUrl).href);
      if (!url) continue;
      const verdict = await verifyUrlWithPlaywright(url);
      if (verdict.status === 'careers-page' || verdict.status === 'linkedin-jobs') return url;
      if (verdict.status === 'company-page' && /careers|jobs|join|vacanc/i.test(url)) return url;
    }
  } catch {
    return null;
  }
}

async function discoverCareersUrl(companyName, { allowBrowser = true, verbose = false } = {}) {
  const logger = createLogger(verbose);
  const slugs = deriveSlugCandidates(companyName).slice(0, 8);
  const atsOrder = ['greenhouse', 'ashby', 'lever'];

  logger.info(companyName, `ATS-first probing${allowBrowser ? '' : ' (browser disabled)'}`);
  for (const slug of slugs) {
    for (const ats of atsOrder) {
      const probe = await probeSlug(ats, slug);
      logger.detail(companyName, `ATS probe ${ats}/${slug} -> ${probe.status}${probe.jobCount != null ? ` (${probe.jobCount} jobs)` : ''}`);
      if (probe.status !== 'live' && probe.status !== 'empty') continue;
      const url = buildAtsCareersUrl(ats, slug);
      if (!url) continue;
      const note = `Discovered via ATS-first probe (${ats}/${slug}, ${probe.status}${probe.jobCount != null ? `, ${probe.jobCount} jobs` : ''}) on ${today()}.`;
      logger.info(companyName, `ATS hit: ${url}`);
      return {
        url,
        source: `ATS-first probe (${ats}/${slug})`,
        notes: note,
      };
    }
  }

  logger.info(companyName, 'No ATS hit; searching the public web');
  const candidates = await searchCompany(companyName, { allowBrowser, verbose });
  for (const candidate of candidates) {
    if (!isSupportedPortalUrl(candidate.url)) continue;
    const verdict = await verifyUrl(candidate.url);
    logger.detail(companyName, `Search candidate ${candidate.url} -> ${verdict.status}`);
    if (verdict.status === 'careers-page') return candidate.url;
    if (verdict.status !== 'dead' && verdict.status !== 'error') {
      if (!allowBrowser) continue;
      logger.detail(companyName, `Browser verify ${candidate.url}`);
      const browserVerdict = await verifyUrlWithPlaywright(candidate.url);
      if (browserVerdict.status === 'careers-page') return candidate.url;
    }
  }
  for (const candidate of candidates) {
    const verdict = await verifyUrl(candidate.url);
    logger.detail(companyName, `Fallback candidate ${candidate.url} -> ${verdict.status}`);
    if (verdict.status === 'linkedin-company') continue;
    if (verdict.status === 'linkedin-jobs') return candidate.url;
    if (verdict.status === 'careers-page') return candidate.url;
    if (verdict.status === 'company-page') {
      const linked = await findCareersLink(candidate.url, { allowBrowser, verbose, companyName });
      if (linked) return linked;
    }
    if (verdict.status === 'uncertain' || verdict.status === 'company-page') {
      if (!allowBrowser) continue;
      logger.detail(companyName, `Browser fallback for ${candidate.url}`);
      const browserVerdict = await verifyUrlWithPlaywright(candidate.url);
      if (browserVerdict.status === 'careers-page') return candidate.url;
      if (browserVerdict.status === 'company-page') {
        const linked = await findCareersLink(candidate.url, { allowBrowser, verbose, companyName });
        if (linked) return linked;
      }
    }
  }
  return null;
}

function loadExistingPortalKeys(config) {
  const items = Array.isArray(config?.tracked_companies) ? config.tracked_companies : [];
  const keys = new Set();
  for (const item of items) {
    if (item?.name) keys.add(normalizeName(item.name));
    if (item?.careers_url) keys.add(normalizeName(item.careers_url));
  }
  return keys;
}

function renderReport(results, skipped) {
  const lines = [];
  lines.push(`# Company Career Discovery — ${today()}`);
  lines.push('');
  lines.push(`- Companies inspected: ${results.length + skipped.length}`);
  lines.push(`- New portals found: ${results.length}`);
  lines.push(`- Already tracked or skipped: ${skipped.length}`);
  lines.push('');
  for (const item of results) {
    lines.push(`## ${item.name}`);
    lines.push('');
    lines.push(`- Careers URL: ${item.careers_url}`);
    if (item.api) lines.push(`- API: ${item.api}`);
    lines.push(`- Source: ${item.source}`);
    lines.push(`- Notes: ${item.notes}`);
    lines.push('');
  }
  if (skipped.length > 0) {
    lines.push('## Skipped');
    lines.push('');
    for (const item of skipped) {
      lines.push(`- ${item.name}: ${item.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadPortalsConfig();
  const existingKeys = loadExistingPortalKeys(config);
  const sourceLabel = args.source === 'startup-map-berlin' ? 'Startup Map Berlin' : args.source;
  const allowBrowser = !args.noBrowser;
  const relevant = loadRelevantCompanies(config, args.section, args.includeManual, args.company, args.allOpenings, args.allCompanies)
    .slice(0, args.limit === Infinity ? undefined : args.limit);

  if (relevant.length === 0) {
    console.log('No relevant companies found.');
    return;
  }

  console.log(`Discovery mode: ATS-first${allowBrowser ? ' + browser fallback' : ' only'}. Companies: ${relevant.length}.`);
  const results = await mapWithConcurrency(relevant, args.concurrency, async (company) => {
    const key = normalizeName(company.name);
    if (existingKeys.has(key)) {
      return { status: 'skipped', name: company.name, reason: 'already tracked' };
    }

    const discovery = await withTimeout(
      discoverCareersUrl(company.name, { allowBrowser, verbose: args.verbose }),
      25000,
      company.name,
    ).catch(() => null);
    if (!discovery?.url) {
      return { status: 'skipped', name: company.name, reason: 'no confident careers page found' };
    }

    const entry = buildPortalEntry(company.name, discovery.url, discovery.notes || `Discovered from ${sourceLabel} on ${today()}.`);
    const entryKey = normalizeName(entry.name);
    const urlKey = normalizeName(entry.careers_url);
    if (existingKeys.has(entryKey) || existingKeys.has(urlKey)) {
      return { status: 'skipped', name: company.name, reason: 'already tracked after discovery' };
    }

    existingKeys.add(entryKey);
    existingKeys.add(urlKey);
    return { status: 'found', entry, source: discovery.source || sourceLabel };
  });

  const found = results.filter(x => x?.status === 'found').map(x => x.entry);
  const skipped = results.filter(x => x?.status === 'skipped').map(x => ({ name: x.name, reason: x.reason }));

  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, `company-career-discovery-${today()}.md`);
  const reportItems = results.filter(x => x?.status === 'found').map(x => ({
    ...x.entry,
    source: x.source,
  }));
  writeFileSync(reportPath, renderReport(reportItems, skipped), 'utf-8');
  console.log(`Wrote ${reportPath}`);

  if (args.write && found.length > 0) {
    const raw = readFileSync(PORTALS_PATH, 'utf-8');
    const updated = appendPortalEntries(raw, found);
    writeFileSync(PORTALS_PATH, updated, 'utf-8');
    console.log(`Appended ${found.length} portal entr${found.length === 1 ? 'y' : 'ies'} to portals.yml`);
  } else if (args.write) {
    console.log('Nothing new to append to portals.yml');
  }

  console.log(`Found ${found.length} new portal entr${found.length === 1 ? 'y' : 'ies'}; skipped ${skipped.length}.`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
