#!/usr/bin/env node
// Extract the top GreasyFork userscripts into corpus.json's `listing` blocks.
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
//   --corpus PATH  corpus file to update (default tests/greasyfork-examples/corpus.json)
//
// Only each record's `listing` block is rewritten; test findings are kept. After
// a full run (no --count, default page set), a script missing from the listing
// keeps its record with `rank: null`.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_JSON, printHelp, updateCorpus } from './corpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://greasyfork.org';

// The listing fields that are counts; stored as numbers, or null when the
// page didn't show one (a real zero and "not shown" differ).
const NUMERIC = new Set(['total_installs', 'daily_installs', 'ratings_good', 'ratings_ok', 'ratings_bad']);

/** A parsed listing row as a corpus `listing` block, with its 1-based rank. */
function listingBlock(row, rank) {
  const block = { rank };
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue;
    block[key] = NUMERIC.has(key) ? (value === '' ? null : Number(value)) : value;
  }
  return block;
}

function parseArgs(argv) {
  const opts = {
    files: [],
    dir: path.join(REPO_ROOT, 'tests/greasyfork-examples/greasyfork-dump'),
    count: Infinity,
    corpus: CORPUS_JSON,
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
      case '--corpus': opts.corpus = path.resolve(next()); break;
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

async function main() {
  if (printHelp(process.argv.slice(2), import.meta.url)) return;
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

  const full = opts.files.length === 0 && opts.count === Infinity;
  const added = await updateCorpus(opts.corpus, (corpus) => {
    // Only a full run says what dropped out. A --count or hand-picked pages
    // run covers part of the listing, so it leaves other ranks alone.
    if (full) for (const record of Object.values(corpus)) if (record.listing) record.listing.rank = null;
    let fresh = 0;
    rows.forEach((row, i) => {
      if (!corpus[row.id]) { corpus[row.id] = {}; fresh++; }
      corpus[row.id].listing = listingBlock(row, i + 1);
    });
    return fresh;
  });
  console.info(`Updated ${rows.length} listings in ${opts.corpus} (${added} new scripts)`);
}

await main();
