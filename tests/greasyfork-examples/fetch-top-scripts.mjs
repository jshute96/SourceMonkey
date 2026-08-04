#!/usr/bin/env node
// Extract the top GreasyFork userscripts into a CSV.
//
// GreasyFork sits behind a Cloudflare bot check that rejects scripted fetches
// (curl and headless/headed Playwright alike), so this tool does NOT download
// anything. It parses listing pages you saved from a real browser:
//
//   1. Visit https://greasyfork.org/en/scripts?sort=total_installs&page=1
//   2. Save each page (Ctrl+S, "Webpage, HTML Only") into greasyfork-dump/ as gfpageN.html
//   3. node tests/greasyfork-examples/fetch-top-scripts.mjs
//
// Each listing page holds 100 scripts, so 20 pages == the top 2000.
//
// Usage:
//   node tests/greasyfork-examples/fetch-top-scripts.mjs [files...] [options]
//
//   files...     saved listing pages; defaults to <dir>/gfpage*.html sorted by
//                the number in the filename
//   --dir PATH   where to look for the default gfpage*.html set
//                (default tests/greasyfork-examples/greasyfork-dump)
//   --count N    keep only the first N scripts (default: all of them)
//   --out PATH   CSV output path (default tests/greasyfork-examples/top-scripts.csv)

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://greasyfork.org';

// Order matters: this is the CSV column order.
const COLUMNS = [
  'id',
  'name',
  'info_page',
  'script_url',
  'total_installs',
  'daily_installs',
  'ratings_good',
  'ratings_ok',
  'ratings_bad',
  'created_date',
  'updated_date',
];

function parseArgs(argv) {
  const opts = {
    files: [],
    dir: path.join(REPO_ROOT, 'tests/greasyfork-examples/greasyfork-dump'),
    count: Infinity,
    out: path.join(REPO_ROOT, 'tests/greasyfork-examples/top-scripts.csv'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--dir': opts.dir = path.resolve(next()); break;
      case '--count': opts.count = Number(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        opts.files.push(path.resolve(arg));
    }
  }
  if (!(opts.count >= 1)) throw new Error('--count must be a positive number');
  return opts;
}

/** Default input set: <dir>/gfpage<N>.html, ordered by N (so page 2 precedes page 10). */
async function defaultFiles(dir) {
  const entries = await readdir(dir);
  return entries
    .map((name) => ({ name, page: /^gfpage(\d+)\.html$/i.exec(name)?.[1] }))
    .filter((entry) => entry.page !== undefined)
    .sort((a, b) => Number(a.page) - Number(b.page))
    .map((entry) => path.join(dir, entry.name));
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function attr(block, name) {
  // Attributes on the item's opening <li> tag; values are always double-quoted.
  const match = new RegExp(`${name}="([^"]*)"`).exec(block);
  return match ? decodeEntities(match[1]) : '';
}

function spanText(block, className) {
  const match = new RegExp(`<span[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([^<]*)</span>`).exec(block);
  return match ? decodeEntities(match[1]).trim() : '';
}

/**
 * Parse one saved listing page. Everything we need is on the `<li>` itself:
 * GreasyFork puts installs/dates/code URL in data-* attributes, and the rating
 * breakdown in the good/ok/bad count spans just below.
 *
 * Each `<li data-script-id=...>` starts a block that runs to the next one (or
 * to end of file); every field is read as the FIRST match inside that block, so
 * trailing page chrome after the last item can't leak into a row.
 */
function parseListingPage(html) {
  const blocks = html.split(/(?=<li data-script-id=)/).slice(1);
  return blocks.map((block) => {
    const href = /<a[^>]*class="[^"]*\bscript-link\b[^"]*"[^>]*href="([^"]*)"/.exec(block)?.[1] ?? '';
    return {
      id: attr(block, 'data-script-id'),
      name: attr(block, 'data-script-name'),
      info_page: href ? new URL(decodeEntities(href), ORIGIN).toString() : '',
      script_url: attr(block, 'data-code-url'),
      total_installs: attr(block, 'data-script-total-installs'),
      daily_installs: attr(block, 'data-script-daily-installs'),
      ratings_good: spanText(block, 'good-rating-count'),
      ratings_ok: spanText(block, 'ok-rating-count'),
      ratings_bad: spanText(block, 'bad-rating-count'),
      created_date: attr(block, 'data-script-created-date'),
      updated_date: attr(block, 'data-script-updated-date'),
    };
  });
}

function toCsv(rows) {
  const escape = (value) => {
    const str = String(value ?? '');
    return /[",\n\r]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  const lines = [COLUMNS.join(',')];
  for (const row of rows) lines.push(COLUMNS.map((column) => escape(row[column])).join(','));
  return lines.join('\n') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files.length > 0 ? opts.files : await defaultFiles(opts.dir);
  if (files.length === 0) throw new Error(`No gfpage*.html files found in ${opts.dir}`);

  const rows = [];
  const seen = new Set();
  for (const file of files) {
    const pageRows = parseListingPage(await readFile(file, 'utf8'));
    let kept = 0;
    for (const row of pageRows) {
      // A script can repeat across pages when installs tick over between saves.
      if (!row.info_page || seen.has(row.info_page)) continue;
      seen.add(row.info_page);
      rows.push(row);
      kept++;
      if (rows.length >= opts.count) break;
    }
    console.info(`${path.basename(file)}: ${pageRows.length} scripts, ${kept} new (${rows.length} total)`);
    if (rows.length >= opts.count) break;
  }

  await mkdir(path.dirname(opts.out), { recursive: true });
  await writeFile(opts.out, toCsv(rows), 'utf8');
  console.info(`Wrote ${rows.length} scripts to ${opts.out}`);
}

await main();
