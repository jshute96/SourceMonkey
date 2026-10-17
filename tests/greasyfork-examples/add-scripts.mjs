#!/usr/bin/env node
// Find GreasyFork script IDs from IDs, URLs or pages that link to scripts, and
// compare them against corpus.json or add the new ones to it.
//
// Usage:
//   node tests/greasyfork-examples/add-scripts.mjs [mode] SOURCE... [options]
//
// Each SOURCE is one of:
//   - a script ID: 12345
//   - a GreasyFork script URL: https://greasyfork.org/en/scripts/12345-name
//     (any page under it, or its update.greasyfork.org code URL, works too)
//   - a GreasyFork listing or search URL:
//     https://greasyfork.org/en/scripts?q=youtube&sort=total_installs
//     https://greasyfork.org/en/scripts/by-site/youtube.com
//   - a GreasyFork user page: https://greasyfork.org/en/users/1234-name
//   - any other URL (a GitHub README, a forum post, ...): every link
//     on it to a GreasyFork script is taken
//   - a saved HTML file: every link in it to a GreasyFork script, as for a URL.
//     Relative links resolve against the page's URL, from the comment a
//     browser's Save As writes (`<!-- saved from url=... -->`), `<base href>`
//     or `<link rel="canonical">`
//
// Modes:
//   --compare    (default) one line per ID found: whether it's in the corpus,
//                and if so its validation status (whether it passes
//                SourceMonkey's offline install checks) and test status.
//                Fetches the names of new IDs a listing source didn't give
//   --list       print just the unique IDs found, one per line
//   --show       print the records `--add` would write, as JSON, without
//                writing them (fetching any script data it needs, as `--add` does)
//   --add        add the IDs not yet in the corpus, with their listing blocks
//
// Options:
//   --pages N      for a listing URL, read N pages from the one given (default 1;
//                  stops early at an empty page)
//   --all-pages    for a listing URL, read every page from page 1, taking the
//                  page count from the page links at the bottom of its HTML
//   --corpus PATH  corpus file (default tests/greasyfork-examples/corpus.json)
//
// Labels, used by --add and --show (other modes ignore them):
//   --label-new L      give the newly added scripts label L
//   --label-all L      the same, and give L to the scripts found that are
//                      already in the corpus; with --label-with-rank, ones that
//                      had L take their new rank
//   --label-with-rank  rank each script under its label by the order the
//                      sources found it in, from 1 (across all pages and
//                      sources). With --label-new, only the new scripts are
//                      ranked, so their ranks have gaps
//
// Listing and script data comes from GreasyFork's JSON API (api.greasyfork.org).
// After `--add`, run download-scripts.mjs and `record-results.mjs validate`.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS_JSON, labelRank, printHelp, readCorpus, setLabel, updateCorpus } from './corpus.mjs';

const API_ORIGIN = 'https://api.greasyfork.org';

// Pause between API requests, to be polite.
const DELAY_MS = 200;

// Paths on greasyfork.org, after an optional locale (`/en`, `/zh-CN`).
const SCRIPT_PATH = /^(?:\/[a-zA-Z-]+)?\/scripts\/(\d+)(?:[-/].*)?$/;
const LISTING_PATH = /^(?:\/[a-zA-Z-]+)?\/scripts(?:\/by-site\/[^/]+)?\/?$/;
const USER_PATH = /^(?:\/[a-zA-Z-]+)?\/users\/\d+(?:-[^/]*)?\/?$/;
// A script's code URL: update.greasyfork.org/scripts/<id>/<name>.user.js
const CODE_PATH = /^\/scripts\/(\d+)\//;

function parseArgs(argv) {
  const opts = {
    mode: 'compare', sources: [], pages: 1, allPages: false, corpus: CORPUS_JSON,
    label: undefined, labelAll: false, labelWithRank: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--compare': case '--list': case '--show': case '--add': opts.mode = arg.slice(2); break;
      case '--pages': opts.pages = Number(next()); break;
      case '--all-pages': opts.allPages = true; break;
      case '--label-new': case '--label-all':
        if (opts.label !== undefined) throw new Error('Use one of --label-new and --label-all, once');
        opts.label = next();
        opts.labelAll = arg === '--label-all';
        break;
      case '--label-with-rank': opts.labelWithRank = true; break;
      case '--corpus': opts.corpus = path.resolve(next()); break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        opts.sources.push(arg);
    }
  }
  if (!(Number.isInteger(opts.pages) && opts.pages >= 1)) throw new Error('The --pages value must be a positive integer');
  if (opts.allPages && argv.includes('--pages')) throw new Error('Use either --pages or --all-pages, not both');
  if (opts.label === '') throw new Error('A label can\'t be empty');
  if (opts.labelWithRank && opts.label === undefined) {
    throw new Error('The --label-with-rank flag needs --label-new or --label-all');
  }
  if (opts.sources.length === 0) throw new Error('No sources given. Use --help for usage.');
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOk(url) {
  // Node's own user agent: some sites (Codeberg) turn away a browser one
  // that doesn't act like a browser.
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    // A connection failure: `fetch failed` alone, with the reason in `cause`.
    throw new Error(`Fetching ${url} failed: ${err.cause?.message ?? err.message}`);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Fetching ${url} failed: HTTP ${response.status}`), { status: response.status });
  }
  return response;
}

function isGreasyFork(url) {
  return url.hostname === 'greasyfork.org' || url.hostname === 'www.greasyfork.org';
}

/** The script ID a URL points at, or null when it isn't a GreasyFork script URL. */
function scriptIdOf(url) {
  if (isGreasyFork(url)) return SCRIPT_PATH.exec(url.pathname)?.[1] ?? null;
  if (url.hostname === 'update.greasyfork.org') return CODE_PATH.exec(url.pathname)?.[1] ?? null;
  return null;
}

/** Progress and skip notes, on stderr so `--list` output can be piped. */
function note(text) {
  process.stderr.write(`${text}\n`);
}

/**
 * Read a listing URL's results through the API, which takes the same path and
 * query plus `format=json` (a `.json` suffix fails on `by-site/<domain>`).
 * Search results come wrapped, under `execute`, and a user page's scripts
 * under `scripts`, all on one page.
 */
async function readListing(url, pages) {
  const api = new URL(url.pathname + url.search, API_ORIGIN);
  api.searchParams.set('format', 'json');
  const first = Number(api.searchParams.get('page') ?? 1);
  const scripts = [];
  for (let page = first; page < first + pages; page++) {
    api.searchParams.set('page', String(page));
    if (page > first) await sleep(DELAY_MS);
    const body = await (await fetchOk(api)).json();
    const rows = Array.isArray(body) ? body : body.execute ?? body.scripts;
    if (!Array.isArray(rows)) throw new Error(`Reading ${api}: The response has no list of scripts`);
    if (rows.length === 0) break;
    scripts.push(...rows);
  }
  return scripts;
}

/**
 * How many pages a listing has: the highest numbered link in the pagination at
 * the bottom of its HTML (`1 2 3 ... 20 >`). The API doesn't report it. A
 * listing with one page has no pagination, so that reads as 1.
 */
async function pageCount(url) {
  const html = await (await fetchOk(url)).text();
  let count = 1;
  for (const match of html.matchAll(/<a\s[^>]*href="[^"]*[?&](?:amp;)?page=(\d+)[^"]*"[^>]*>\s*(\d+)\s*<\/a>/g)) {
    if (match[1] === match[2]) count = Math.max(count, Number(match[1]));
  }
  return count;
}

/** A source's count note: its unique scripts, which a page can link to many times over. */
function noteFound(source, found) {
  note(`${source}: ${new Set(found).size} scripts`);
}

/** The script IDs of every link in an HTML page, in page order. */
function linkedIds(html, base) {
  const ids = [];
  for (const match of html.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const href = (match[1] ?? match[2] ?? match[3]).replaceAll('&amp;', '&');
    let link;
    try { link = new URL(href, base); } catch { continue; }
    const id = scriptIdOf(link);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * The URL a saved page came from, for resolving its relative links. Falls back
 * to the file's own URL, where a relative link can't reach GreasyFork.
 */
function savedPageBase(html, file) {
  const found =
    /<!-- saved from url=\(\d+\)(\S+?) -->/.exec(html)?.[1] ??
    /<base\s[^>]*href="([^"]+)"/i.exec(html)?.[1] ??
    /<link\s[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(html)?.[1];
  try {
    if (found) return new URL(found.replaceAll('&amp;', '&'));
  } catch { /* not a URL: use the file's */ }
  return pathToFileURL(file);
}

/**
 * Resolve every source to IDs, in order found. `known` collects the API rows
 * that listing sources returned, so `--add` needn't fetch those again.
 */
async function collectIds(opts, known) {
  const ids = [];
  for (const source of opts.sources) {
    if (/^\d+$/.test(source)) { ids.push(source); continue; }
    if (!/^https?:\/\//i.test(source)) {
      let html;
      try { html = await readFile(source, 'utf8'); } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`${source} is not a script ID, URL or existing file`);
        throw new Error(`Reading ${source} failed: ${err.message}`);
      }
      const found = linkedIds(html, savedPageBase(html, path.resolve(source)));
      noteFound(source, found);
      ids.push(...found);
      continue;
    }
    const url = new URL(source);
    const direct = scriptIdOf(url);
    let found;
    if (direct) {
      found = [direct];
    } else if (isGreasyFork(url) && (LISTING_PATH.test(url.pathname) || USER_PATH.test(url.pathname))) {
      const user = USER_PATH.test(url.pathname);
      let pages = user ? 1 : opts.pages;
      if (opts.allPages && !user) {
        url.searchParams.set('page', '1');
        pages = await pageCount(url);
        note(`${source}: ${pages} page${pages === 1 ? '' : 's'}`);
      }
      const rows = await readListing(url, pages);
      for (const row of rows) known.set(String(row.id), row);
      found = rows.map((row) => String(row.id));
    } else {
      found = linkedIds(await (await fetchOk(url)).text(), url);
    }
    if (!direct) noteFound(source, found);
    ids.push(...found);
  }
  return [...new Set(ids)];
}

/** A script's API row as a corpus `listing` block, laid out as README.md describes. */
function listingBlock(row) {
  const page = new URL(row.url);
  // Existing records use the English page; the API gives the unlocalized one.
  if (!/^\/[a-zA-Z-]+\/scripts\//.test(page.pathname)) page.pathname = `/en${page.pathname}`;
  return {
    name: row.name,
    info_page: page.toString(),
    script_url: row.code_url,
    total_installs: row.total_installs ?? null,
    daily_installs: row.daily_installs ?? null,
    ratings_good: row.good_ratings ?? null,
    ratings_ok: row.ok_ratings ?? null,
    ratings_bad: row.bad_ratings ?? null,
    created_date: row.created_at?.slice(0, 10) ?? null,
    updated_date: row.code_updated_at?.slice(0, 10) ?? null,
  };
}

/**
 * A record's TESTED cell: its test result, else the kind of validation error
 * when it's invalid (its derived `invalid:<reason>` tag), else blank.
 */
function testedCell(record) {
  const test = record.test;
  if (test) {
    const detail = test.blame ?? test.reason;
    return `${test.status}${detail ? ` (${detail})` : ''}`;
  }
  if (record.valid?.status !== 'invalid') return '';
  const reason = record.valid.tags?.find((tag) => tag.startsWith('invalid:'))?.slice('invalid:'.length);
  return reason ? `invalid (${reason})` : 'invalid';
}

/** Print rows as columns sized to fit, the first right-aligned and the last unpadded. */
function printColumns(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  for (const row of rows) {
    const cells = row.map((cell, i) =>
      i === 0 ? cell.padStart(widths[i]) : i === row.length - 1 ? cell : cell.padEnd(widths[i]));
    console.log(cells.join('  ').trimEnd());
  }
}

/**
 * One line per ID. NEW marks IDs not in the corpus. VALID is the latest
 * offline install check from `record-results.mjs validate` (`ok`, `invalid` or
 * `tool error`; blank when the script isn't downloaded), TESTED the latest run
 * on its site.
 */
async function compare(ids, corpus, known) {
  let present = 0;
  // Names for the new IDs, or why one can't be added, where the sources
  // didn't give them.
  const fresh = new Map((await newScripts(ids, corpus, known)).map((entry) => [entry.id, entry]));
  const rows = [['ID', 'NEW', 'VALID', 'TESTED', 'NAME']];
  for (const id of ids) {
    const record = corpus[id];
    if (record) present++;
    const entry = fresh.get(id);
    const name = record?.listing?.name ?? entry?.row?.name ?? '';
    const skip = entry?.skip ? `(${entry.skip})` : '';
    rows.push([
      id,
      record ? '' : 'new',
      record?.valid?.status ?? '',
      record ? testedCell(record) : '',
      [name, skip].filter(Boolean).join('  '),
    ]);
  }
  printColumns(rows);
  console.info(`${ids.length} scripts: ${present} in the corpus, ${ids.length - present} new`);
}

/**
 * The IDs not in the corpus, each with its API row: from a listing source when
 * it gave one, otherwise fetched one at a time. `skip` says why one can't be
 * added (deleted, unknown, no code); `row` is still set when GreasyFork gave one.
 */
async function newScripts(ids, corpus, known) {
  const out = [];
  let fetched = 0;
  for (const id of ids.filter((id) => !corpus[id])) {
    let row = known.get(id);
    if (!row) {
      if (fetched++ > 0) await sleep(DELAY_MS);
      try {
        row = await (await fetchOk(`${API_ORIGIN}/scripts/${id}.json`)).json();
      } catch (err) {
        out.push({ id, skip: err.status === 404 ? 'GreasyFork has no script with this ID' : err.message });
        continue;
      }
    }
    const skip = row.deleted ? 'The script is deleted'
      : !row.code_url ? 'GreasyFork gives no code URL for it'
      : undefined;
    out.push({ id, row, skip });
  }
  return out;
}

/** The new scripts that can be added, noting each one skipped. */
async function addableRows(ids, corpus, known) {
  const rows = [];
  for (const { id, row, skip } of await newScripts(ids, corpus, known)) {
    if (skip) note(`Skipping ${id}: ${skip}`);
    else rows.push(row);
  }
  return rows;
}

/**
 * What a run with labels does: a new record for each addable row, and which
 * existing records gain the label. `ranks` maps each ID to its place in the
 * order found, when ranking.
 */
function labelPlan(opts, ids) {
  const ranks = opts.labelWithRank ? new Map(ids.map((id, i) => [id, i + 1])) : undefined;
  const label = (record, id) => opts.label !== undefined && setLabel(record, opts.label, ranks?.get(String(id)));
  return {
    newRecord(row) {
      const record = { listing: listingBlock(row) };
      label(record, row.id);
      return record;
    },
    // Labels existing records in `corpus` for --label-all, and re-ranks the
    // ones that had the label. Returns how many of each, and how many had a
    // ranked label but weren't found, keeping old ranks that can now repeat.
    labelExisting(corpus) {
      const counts = { added: 0, reranked: 0, stale: 0 };
      if (!opts.labelAll) return counts;
      for (const id of ids) {
        const change = corpus[id] && label(corpus[id], id);
        if (change) counts[change]++;
      }
      if (ranks) {
        for (const [id, record] of Object.entries(corpus)) {
          if (!ranks.has(id) && labelRank(record, opts.label) !== undefined) counts.stale++;
        }
      }
      return counts;
    },
  };
}

function noteStale(opts, stale) {
  if (stale) note(`${stale} scripts with label ${opts.label} weren't found and keep their old ranks`);
}

async function show(opts, ids, corpus, known) {
  const rows = await addableRows(ids, corpus, known);
  const plan = labelPlan(opts, ids);
  const records = {};
  for (const row of rows) records[row.id] = plan.newRecord(row);
  console.log(JSON.stringify(records, null, 2));
  note(`${rows.length} scripts would be added (${ids.length - rows.length} already present or skipped)`);
  if (opts.labelAll) {
    // Label a copy, to count without changing what was read.
    const { added, reranked, stale } = plan.labelExisting(structuredClone(corpus));
    note(`${added} existing scripts would get the label ${opts.label}, and ${reranked} would be re-ranked`);
    noteStale(opts, stale);
  }
}

async function add(opts, ids, corpus, known) {
  const rows = await addableRows(ids, corpus, known);
  const plan = labelPlan(opts, ids);
  const { added, labeled } = await updateCorpus(opts.corpus, ({ scripts: latest }) => {
    let count = 0;
    for (const row of rows) {
      // Another writer may have added it since we read the corpus.
      if (latest[row.id]) continue;
      latest[row.id] = plan.newRecord(row);
      console.info(`Added ${row.id}  ${row.name}`);
      count++;
    }
    // The records just added have the label already, so this counts only older ones.
    return { added: count, labeled: plan.labelExisting(latest) };
  });
  console.info(`Added ${added} scripts to ${opts.corpus} (${ids.length - rows.length} already present or skipped)`);
  if (opts.labelAll) {
    console.info(`Labeled ${labeled.added} existing scripts ${opts.label}, and re-ranked ${labeled.reranked}`);
    noteStale(opts, labeled.stale);
  }
  if (added > 0) console.info('Next: download-scripts.mjs, then record-results.mjs validate');
}

async function main() {
  const argv = process.argv.slice(2);
  if (printHelp(argv, import.meta.url)) return;
  const opts = parseArgs(argv);
  const known = new Map();
  const ids = await collectIds(opts, known);
  if (opts.mode === 'list') {
    for (const id of ids) console.log(id);
    return;
  }
  // The script records, keyed by ID; tag definitions don't matter here.
  const corpus = (await readCorpus(opts.corpus)).scripts;
  if (opts.mode === 'compare') await compare(ids, corpus, known);
  else if (opts.mode === 'show') await show(opts, ids, corpus, known);
  else await add(opts, ids, corpus, known);
}

try {
  await main();
} catch (err) {
  note(`Error: ${err.message}`);
  process.exitCode = 1;
}
