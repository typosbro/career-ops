#!/usr/bin/env node

/**
 * funding-watch.mjs — zero-key RSS watcher for recently funded companies.
 * Reads <root>/config/funding-sources.yml and merges into
 * <root>/data/funded-companies.{tsv,md,discover.yml}. No keys, no LLM, and no
 * probing of company sites. Run with --help.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

import { decodeEntities } from './providers/_html-entities.mjs';
import { localToday } from './lib/local-today.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
const USER_AGENT = 'career-ops-funding-watch/1.0';
const FEED_TIMEOUT_MS = 20_000;
const ARTICLE_TIMEOUT_MS = 15_000;
const COLUMNS = 'first_seen last_seen funding_date region company round amount homepage tags status source source_url careers_url notes'.split(' ');
const HEADER = COLUMNS.join('\t');
const SOCIAL_HOSTS = new Set('twitter.com x.com linkedin.com facebook.com youtube.com instagram.com crunchbase.com techcrunch.com prnewswire.com medium.com google.com t.me wikipedia.org'.split(' '));
const FUNDING_TITLE_RE = /\b(raises?|raised|secures?|secured|closes?|closed|lands?|landed|bags?|bagged|snags?|snagged|gets?|got|announces?|announced|funding|seed|series\s+[a-e]|pre-seed|round)\b/i;
const COMPANY_VERB_RE = /\b(raises?|raised|secures?|secured|closes?|closed|lands?|landed|bags?|bagged|snags?|snagged|gets?|got|announces?|announced)\b/i;
const ROUND_RE = /\b(pre-seed|seed|series\s+[a-e]\+?|growth|bridge)\b/i;
const AMOUNT_RE = /[$€£]\s?\d[\d.,]*(?:\s?(?:k|m|b|million|billion))?/i;
const KRW_AMOUNT_RE = /(?:₩|KRW)\s?\d[\d.,]*(?:\s?(?:억|조|million|billion))?|\d[\d.,]*\s?(?:억|조)/i;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const normalizeCompany = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (company, region) => `${normalizeCompany(company).toLowerCase()}|${String(region ?? '').trim().toLowerCase()}`;
const tsvCell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const mdCell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';
const homepageHost = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
function withinWindow(dateString, cutoff) {
  const date = new Date(`${dateString}T00:00:00`);
  return Number.isFinite(date.getTime()) && date >= cutoff;
}
function stripHtml(input) {
  return decodeEntities(String(input).replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function rawField(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : '';
}
const fieldText = (block, name) => stripHtml(rawField(block, name));
function itemLink(block) {
  const match = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
    || block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i)
    || block.match(/<guid\b[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i);
  return match ? stripHtml(match[1]) : '';
}
function parseFeed(xml) {
  const blocks = [];
  for (const re of [/<item\b[^>]*>([\s\S]*?)<\/item>/gi, /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi]) {
    let match;
    while ((match = re.exec(xml))) blocks.push(match[1]);
  }
  return blocks.map((block) => {
    const rawDate = fieldText(block, 'pubDate') || fieldText(block, 'published')
      || fieldText(block, 'updated') || fieldText(block, 'dc:date');
    const date = rawDate ? new Date(rawDate) : null;
    return { title: fieldText(block, 'title'), link: itemLink(block),
      date: date && Number.isFinite(date.getTime()) ? date : null,
      contentHtml: rawField(block, 'content:encoded') || rawField(block, 'content') };
  });
}
function englishCompany(title) {
  const match = title.match(COMPANY_VERB_RE);
  if (!match) return '';
  let raw = title.slice(0, match.index);
  const colon = raw.lastIndexOf(':');
  if (colon >= 0 && raw.slice(0, colon).trim().length > 25) raw = raw.slice(colon + 1);
  raw = raw.trim()
    .replace(/^(exclusive|breaking|update|report|watch)\s*:\s*/i, '').trim()
    .replace(/^[\p{L}\s.'’-]{2,40}-based\s+/u, '').trim()
    .replace(/^[A-Z][\p{L}.'’-]*['’]s\s+(?=\p{Lu})/u, '').trim();
  let name = raw.replace(/^[\s"'“”‘’\-–—:|,]+/, '')
    .replace(/[\s"'“”‘’\-–—,.;:|]+$/, '').replace(/\s+/g, ' ').trim();
  let previous;
  do {
    previous = name;
    name = name.replace(/\s+(?:reportedly|to|in talks to|is|has|plans to|set to|nets|scoops|picks up)$/i, '')
      .replace(/[\s"'“”‘’\-–—,.;:|]+$/, '').trim();
  } while (name !== previous);
  if (name.length < 2 || /\b(?:backer|investor|fund|capital|ventures|vc|partners)\b/i.test(name)) return '';
  if (/\s+(?:and|&)\s+/i.test(name)) return '';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0].length < 3) return '';
  return name.length > 60 ? name.slice(0, 60).trim().replace(/[\s,.;:]+$/, '') : name;
}
function englishRound(title) {
  const match = title.match(ROUND_RE);
  if (!match) return '';
  const raw = match[0].toLowerCase();
  if (raw.startsWith('pre-')) return 'Pre-Seed';
  if (raw === 'growth' || raw === 'bridge') return raw[0].toUpperCase() + raw.slice(1);
  if (raw === 'seed') return 'Seed';
  const series = raw.match(/series\s+([a-e])(\+?)/);
  return series ? `Series ${series[1].toUpperCase()}${series[2]}` : '';
}
const englishAmount = (title) => (title.match(AMOUNT_RE) || title.match(KRW_AMOUNT_RE) || [''])[0].trim();
function koreanRound(title) {
  const match = title.match(/시리즈\s*([A-E])\b/i);
  if (match) return `Series ${match[1].toUpperCase()}`;
  if (/프리\s*[Aa]/.test(title)) return 'Pre-A';
  if (/프리\s*시드|프리시드|프리/.test(title)) return 'Pre-Seed';
  return /시드/.test(title) ? 'Seed' : '';
}
const koreanAmount = (title) => (title.match(KRW_AMOUNT_RE) || [''])[0].trim();
function koreanCompany(title) {
  const quoted = title.match(/[“”"'‘’]([^“”"'‘’]{2,40})[“”"'‘’]/);
  if (quoted) return normalizeCompany(quoted[1]);
  const first = title.trim().split(/[\s,]+/)[0] || '';
  return normalizeCompany(first.replace(/^[\s"'“”‘’\-–—:|,]+|[\s"'“”‘’\-–—,.;:|]+$/g, ''));
}
function tipsCompanies(html) {
  const found = [];
  const generic = /^(이달의\s*TIPS|TIPS|선정|기업|스타트업|참고|관련|출처|기업명)$/i;
  const push = (value) => {
    const text = normalizeCompany(stripHtml(value).replace(/^[\s\-–—•·|:]+/, '').replace(/[\s,.;:·|]+$/, ''));
    if (text.length >= 2 && text.length <= 40 && !generic.test(text)
      && /[\uac00-\ud7a3A-Za-z0-9]/.test(text)
      && !found.some((entry) => entry.toLowerCase() === text.toLowerCase())) found.push(text);
  };
  for (const match of html.matchAll(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi)) push(match[2]);
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const bold = match[1].match(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/i);
    push(bold ? bold[2] : stripHtml(match[1]).split(/\s*[:：|\-–—,]\s*/)[0]);
  }
  return found;
}
function sourceHost(source) {
  try { return new URL(source.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
function findHomepage(html, company, ownHost) {
  const slug = String(company).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (slug.length < 4) return '';
  const prefix = slug.slice(0, 4);
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    if (!/^https?:\/\//i.test(match[1])) continue;
    let url;
    try { url = new URL(decodeEntities(match[1]).trim()); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host || host === ownHost || [...SOCIAL_HOSTS].some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    const anchor = stripHtml(match[2]).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (anchor.includes(prefix) || host.replace(/[^a-z0-9]/g, '').includes(prefix)) return `${url.protocol}//${url.hostname}/`;
  }
  return '';
}
// --- network ----------------------------------------------------------------
let requestDelayMs = 1200;
let maxArticleFetches = 40;
let articleFetches = 0;
let lastRequestAt = 0;
const articleCache = new Map();
async function politeFetch(url, timeoutMs) {
  const wait = requestDelayMs - (Date.now() - lastRequestAt);
  if (lastRequestAt && wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}
async function fetchArticle(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  if (articleCache.has(url)) return articleCache.get(url);
  if (articleFetches >= maxArticleFetches) return '';
  articleFetches += 1;
  try {
    const html = await politeFetch(url, ARTICLE_TIMEOUT_MS);
    articleCache.set(url, html);
    return html;
  } catch (err) {
    console.error(`funding-watch: article ${url}: ${err.message}`);
    articleCache.set(url, '');
    return '';
  }
}
// --- extraction -------------------------------------------------------------
function baseCandidate(item, source, values) {
  return { company: normalizeCompany(values.company), round: values.round || '', amount: values.amount || '',
    fundingDate: localToday(item.date), region: String(source.region || 'global').toLowerCase(),
    source: source.id, sourceUrl: item.link || source.url, sourceHost: sourceHost(source),
    homepage: '', tags: values.tags || [] };
}
function englishCandidates(item, source) {
  if (!FUNDING_TITLE_RE.test(item.title)) return [];
  const round = englishRound(item.title);
  const amount = englishAmount(item.title);
  if (!round && !amount) return [];
  const company = englishCompany(item.title);
  return company ? [baseCandidate(item, source, { company, round, amount })] : [];
}
function koreanCandidates(item, source) {
  const company = koreanCompany(item.title);
  return company ? [baseCandidate(item, source, {
    company, round: koreanRound(item.title), amount: koreanAmount(item.title) })] : [];
}
async function tipsCandidates(item, source) {
  let html = item.contentHtml || '';
  if (!html && item.link) html = await fetchArticle(item.link);
  if (!html) {
    console.error(`funding-watch: ${source.id}: TIPS item has no content: ${item.link}`);
    return [];
  }
  if (item.link) articleCache.set(item.link, html);
  const companies = tipsCompanies(html);
  if (!companies.length) {
    console.error(`funding-watch: ${source.id}: could not parse TIPS companies: ${item.link}`);
    return [];
  }
  return companies.map((company) => baseCandidate(item, source, { company, round: 'TIPS', tags: ['tips'] }));
}
async function candidatesForItem(item, source) {
  if (/이달의\s*TIPS/i.test(item.title)) return await tipsCandidates(item, source);
  if (/투자|유치/.test(item.title)) return koreanCandidates(item, source);
  return englishCandidates(item, source);
}
// --- tracker merge ----------------------------------------------------------
function cellsToRow(cells) {
  const at = (name) => cells[COLUMNS.indexOf(name)] ?? '';
  return { firstSeen: at('first_seen'), lastSeen: at('last_seen'), fundingDate: at('funding_date'),
    region: at('region'), company: at('company'), round: at('round'), amount: at('amount'),
    homepage: at('homepage'), tags: at('tags').split(',').map((tag) => tag.trim()).filter(Boolean),
    status: at('status'), source: at('source'), sourceUrl: at('source_url'),
    careersUrl: at('careers_url'), notes: at('notes'), extra: [] };
}
const rowToCells = (row) => [
  row.firstSeen, row.lastSeen, row.fundingDate, row.region, row.company, row.round, row.amount,
  row.homepage, row.tags.join(','), row.status, row.source, row.sourceUrl, row.careersUrl, row.notes,
].map(tsvCell);
function readTsv(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  const index = COLUMNS.map((name) => header.indexOf(name));
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const values = index.map((at, fallback) => (at >= 0 ? cells[at] : cells[fallback]) ?? '');
    const row = cellsToRow(values);
    row.extra = cells.slice(COLUMNS.length);
    return row;
  });
}
function mergeTags(existing, incoming) {
  const out = [...existing];
  for (const tag of incoming) if (!out.some((entry) => entry.toLowerCase() === tag.toLowerCase())) out.push(tag);
  return out;
}
function mergeRows(existingRows, candidates, today) {
  const byKey = new Map();
  for (const row of existingRows) {
    const key = keyOf(row.company, row.region);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  let newCount = 0;
  for (const candidate of candidates) {
    const key = keyOf(candidate.company, candidate.region);
    const row = byKey.get(key);
    if (!row) {
      byKey.set(key, { firstSeen: today, lastSeen: today, fundingDate: candidate.fundingDate,
        region: candidate.region, company: candidate.company, round: candidate.round,
        amount: candidate.amount, homepage: candidate.homepage, tags: [...candidate.tags],
        status: 'new', source: candidate.source, sourceUrl: candidate.sourceUrl,
        careersUrl: '', notes: '', extra: [] });
      newCount += 1;
      continue;
    }
    row.lastSeen = today;
    if (!row.homepage && candidate.homepage) row.homepage = candidate.homepage;
    if (!row.fundingDate && candidate.fundingDate) row.fundingDate = candidate.fundingDate;
    if (!row.round && candidate.round) row.round = candidate.round;
    if (!row.amount && candidate.amount) row.amount = candidate.amount;
    if (!row.source && candidate.source) row.source = candidate.source;
    if (!row.sourceUrl && candidate.sourceUrl) row.sourceUrl = candidate.sourceUrl;
    row.tags = mergeTags(row.tags, candidate.tags);
  }
  return { rows: [...byKey.values()], newCount };
}
// --- output -----------------------------------------------------------------
function mdLink(url) {
  if (!url) return '—';
  try { const parsed = new URL(url); return `[${mdCell(parsed.hostname)}](${url})`; }
  catch { return mdCell(url); }
}
function renderReport(rows, { today, months, newCount, cutoff }) {
  const ready = rows.filter((row) => row.homepage && row.status !== 'in_portals').length;
  const visible = rows.filter((row) => withinWindow(row.fundingDate, cutoff))
    .sort((a, b) => String(b.fundingDate).localeCompare(String(a.fundingDate))
      || String(a.company).localeCompare(String(b.company)));
  const table = (title, keep) => {
    const out = ['', `## ${title}`, '', '| date | company | round | amount | home page | careers | source |', '|---|---|---|---|---|---|---|'];
    for (const row of visible.filter(keep)) {
      const source = row.sourceUrl ? mdLink(row.sourceUrl) : mdCell(row.source);
      out.push(`| ${mdCell(row.fundingDate)} | ${mdCell(row.company)} | ${mdCell(row.round)} | ${mdCell(row.amount)} | ${mdLink(row.homepage)} | ${mdLink(row.careersUrl)} | ${source} |`);
    }
    return out;
  };
  return [`# Funded companies — watch report (${today})`, '',
    `Window: last ${months} month${months === 1 ? '' : 's'}. Tracked: ${rows.length} (${newCount} new this run). Ready for discover-ats: ${ready}.`,
    ...table('Korea', (row) => row.region === 'korea'),
    ...table('Global', (row) => row.region !== 'korea'), ''].join('\n');
}
function renderDiscover(rows, today) {
  const lines = ['# Generated by funding-watch.mjs — do not edit by hand.',
    '# Feed this file to discover-ats.mjs to add recently funded companies.', `generated_at: "${today}"`];
  const fresh = rows.filter((row) => row.status === 'new');
  if (!fresh.length) return `${[...lines, 'companies: []'].join('\n')}\n`;
  lines.push('companies:');
  for (const row of fresh) {
    lines.push(`  - name: ${JSON.stringify(row.company)}`);
    const host = homepageHost(row.homepage);
    if (host) lines.push(`    website: ${JSON.stringify(host)}`);
  }
  return `${lines.join('\n')}\n`;
}
function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, content, 'utf-8');
  renameSync(temp, file);
}
// --- CLI --------------------------------------------------------------------
function printHelp() {
  console.log(`Usage: node funding-watch.mjs [options]

Zero-key RSS watcher for recently funded companies.

  --help                 Show this help and exit.
  --dry-run              Print what would be written; write nothing.
  --root <dir>           Data root (default: getCareerOpsRoot()).
  --since-months <n>     Override the config window_months.
  --only <source-id>     Process one configured source only.

Config: <root>/config/funding-sources.yml
Output: <root>/data/funded-companies.{tsv,md,discover.yml}`);
}
function parseArgs(argv) {
  const options = { help: false, dryRun: false, root: null, sinceMonths: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--root') options.root = argv[++i];
    else if (arg === '--since-months') options.sinceMonths = Number(argv[++i]);
    else if (arg === '--only') options.only = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.root !== null && !String(options.root).trim()) throw new Error('--root needs a directory');
  if (options.sinceMonths !== null && (!Number.isInteger(options.sinceMonths) || options.sinceMonths < 1)) throw new Error('--since-months needs a positive integer');
  if (options.only !== null && !String(options.only).trim()) throw new Error('--only needs a source id');
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return 0; }

  const today = localToday();
  const root = options.root ? resolve(options.root) : getCareerOpsRoot();
  const configPath = join(root, 'config', 'funding-sources.yml');
  if (!existsSync(configPath)) { console.error(`funding-watch: config not found: ${configPath}`); return 1; }
  let config;
  try { config = yaml.load(readFileSync(configPath, 'utf-8')) || {}; }
  catch (err) { console.error(`funding-watch: cannot read ${configPath}: ${err.message}`); return 1; }

  const configuredMonths = Number(config.window_months);
  const months = options.sinceMonths ?? (Number.isFinite(configuredMonths) && configuredMonths > 0 ? configuredMonths : 3);
  const configuredFetches = Number(config.max_article_fetches);
  maxArticleFetches = Number.isFinite(configuredFetches) && configuredFetches >= 0 ? configuredFetches : 40;
  const configuredDelay = Number(config.request_delay_ms);
  requestDelayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 1200;

  let sources = (Array.isArray(config.sources) ? config.sources : [])
    .filter((source) => source && source.id && source.url && source.enabled !== false);
  if (options.only) sources = sources.filter((source) => source.id === options.only);
  if (!sources.length) {
    console.error(options.only ? `funding-watch: no enabled source with id "${options.only}"` : 'funding-watch: no enabled sources in config');
    return 1;
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  let sourcesOk = 0;
  let itemCount = 0;
  const candidates = new Map();
  const addCandidate = (candidate) => {
    const key = keyOf(candidate.company, candidate.region);
    const existing = candidates.get(key);
    if (!existing) { candidates.set(key, candidate); return; }
    existing.tags = mergeTags(existing.tags, candidate.tags);
    if (!existing.homepage && candidate.homepage) existing.homepage = candidate.homepage;
    if (!existing.round && candidate.round) existing.round = candidate.round;
    if (!existing.amount && candidate.amount) existing.amount = candidate.amount;
  };
  for (const source of sources) {
    let feed;
    try { feed = await politeFetch(source.url, FEED_TIMEOUT_MS); }
    catch (err) { console.error(`funding-watch: ${source.id}: ${err.message}`); continue; }
    sourcesOk += 1;
    for (const item of parseFeed(feed)) {
      if (!item.date || item.date < cutoff) continue;
      itemCount += 1;
      try { for (const candidate of await candidatesForItem(item, source)) addCandidate(candidate); }
      catch (err) { console.error(`funding-watch: ${source.id}: ${err.message}`); }
    }
  }

  const dataDir = join(root, 'data');
  const paths = { tsv: join(dataDir, 'funded-companies.tsv'), report: join(dataDir, 'funded-companies.md'), discover: join(dataDir, 'funded-companies.discover.yml') };
  const existingRows = readTsv(paths.tsv);
  const existingKeys = new Set(existingRows.map((row) => keyOf(row.company, row.region)));
  for (const candidate of candidates.values()) {
    if (existingKeys.has(keyOf(candidate.company, candidate.region)) || candidate.homepage) continue;
    if (articleFetches >= maxArticleFetches) break;
    const html = await fetchArticle(candidate.sourceUrl);
    if (html) candidate.homepage = findHomepage(html, candidate.company, candidate.sourceHost);
  }

  const merged = mergeRows(existingRows, [...candidates.values()], today);
  const tsv = [HEADER, ...merged.rows.map((row) => [...rowToCells(row), ...row.extra].join('\t'))].join('\n') + '\n';
  const report = renderReport(merged.rows, { today, months, newCount: merged.newCount, cutoff });
  const discover = renderDiscover(merged.rows, today);
  if (options.dryRun) {
    for (const file of Object.values(paths)) console.log(`[dry-run] would write ${file}`);
    console.log(`[dry-run] ${merged.rows.length} rows tracked, ${merged.newCount} new`);
  } else {
    writeAtomic(paths.tsv, tsv);
    writeAtomic(paths.report, report);
    writeAtomic(paths.discover, discover);
  }
  console.log(`funding-watch: ${sourcesOk}/${sources.length} sources, ${itemCount} items, ${merged.newCount} new, ${merged.rows.length} tracked`);
  return sourcesOk === 0 ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`funding-watch: ${err.message}`);
    process.exitCode = 1;
  });
