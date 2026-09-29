#!/usr/bin/env node
// Download the userscripts listed in corpus.json, then the unique
// `@require` libraries and `@resource` assets they pull in, into a URL-shaped
// tree on disk.
//
// Layout: every file lands at <root>/<host>/<path>, keeping the URL's
// percent-encoding verbatim in the filename, e.g.
//   https://update.greasyfork.org/scripts/25253/ZOOM%20HACK%20for%20Blobleio%21.user.js
//   → tests/greasyfork-examples/files/update.greasyfork.org/scripts/25253/ZOOM%20HACK%20for%20Blobleio%21.user.js
//
// Unlike the listing pages (see README.md), the raw `.user.js` URLs are not
// behind the Cloudflare bot check, so a plain fetch works.
//
// Usage:
//   node tests/greasyfork-examples/download-scripts.mjs [options]
//
//   --corpus PATH      script list (default tests/greasyfork-examples/corpus.json)
//   --root PATH        download root (default tests/greasyfork-examples/files)
//   --count N          only the first N scripts, in listing order (default: all)
//   --delay MS         pause between requests (default 200)
//   --concurrency N    parallel requests (default 1 — be polite)
//   --force            re-download files that already exist on disk
//   --scripts-only     only the userscripts; skip @require and @resource
//   --requires-only    only @require libraries, scanned from downloaded scripts
//   --resources-only   only @resource assets, scanned from downloaded scripts
//   --report PATH      where to write the run report (default download-report.json here)
//   --max-broken-hosts N  abort once more than N hosts have gone unreachable (default 5)
//
// Failure handling, in short:
//   - 429 aborts the run outright — that's the one status that means "slow down"
//   - a host that 403s or won't connect is dropped after 3 strikes; its
//     remaining URLs are skipped and the rest of the corpus continues
//   - 404/410 dead links are recorded and otherwise ignored
// Re-running resumes, since files already on disk are skipped.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeader, getValues } from '../../dist/userscript-header.js';
import {
  CORPUS_JSON, dependencyUrlFor, detectMaxFilename, exists, listingRows, readCorpus, readDownloaded, resolveTarget, urlToPath,
} from './corpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'tests/greasyfork-examples/files');
const REPORT_PATH = path.join(REPO_ROOT, 'tests/greasyfork-examples/download-report.json');

// Sent on every request: some hosts serving @require libraries reject the
// default Node UA outright.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const opts = {
    corpus: CORPUS_JSON,
    root: DEFAULT_ROOT,
    count: Infinity,
    delay: 200,
    concurrency: 1,
    force: false,
    scripts: true,
    requires: true,
    resources: true,
    maxBrokenHosts: 5,
    report: REPORT_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--corpus': opts.corpus = path.resolve(next()); break;
      case '--root': opts.root = path.resolve(next()); break;
      case '--count': opts.count = Number(next()); break;
      case '--delay': opts.delay = Number(next()); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--force': opts.force = true; break;
      case '--scripts-only': opts.requires = false; opts.resources = false; break;
      case '--requires-only': opts.scripts = false; opts.resources = false; break;
      case '--resources-only': opts.scripts = false; opts.requires = false; break;
      case '--report': opts.report = path.resolve(next()); break;
      case '--max-broken-hosts': opts.maxBrokenHosts = Number(next()); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Validate every numeric option: NaN silently disables the thing it controls
  // (a bad --delay turns politeness off, a bad --max-broken-hosts disables the
  // abort), which is the opposite of what a typo should do.
  if (!(opts.count >= 1)) throw new Error('--count must be a positive number');
  if (!(opts.concurrency >= 1)) throw new Error('--concurrency must be at least 1');
  if (!(opts.delay >= 0)) throw new Error('--delay must be a non-negative number of milliseconds');
  if (!(opts.maxBrokenHosts >= 0)) throw new Error('--max-broken-hosts must be a non-negative number');
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the server signals we should stop entirely, not just skip one file. */
class AbortRun extends Error {}

/**
 * Anything on `greasyfork.org` itself sits behind the same Cloudflare bot check
 * as the listing pages and always 403s us, but `update.greasyfork.org` serves
 * the same bytes unprotected:
 *   /scripts/<id>-<slug>/code/<File>.js → /scripts/<id>/<File>.js
 *   /libraries/<name>/<ver>/<File>.js   → same path, mirror host
 * Fetch from the mirror; the file is still stored under the URL the script
 * actually references, so a lookup by @require URL finds it. A deleted script
 * answers 410 on the mirror and is recorded as a dead link.
 */
function mirrorUrl(url) {
  // The optional `/<locale>` segment is what you get from copying a URL out of
  // the browser (greasyfork.org/en/scripts/…). Without it those 403 and, worse,
  // earn host strikes that take the mirrorable URLs down with them.
  const locale = '(?:/[a-z]{2}(?:-[A-Za-z]{2,4})?)?';
  const code = new RegExp(`^https://greasyfork\\.org${locale}/scripts/(\\d+)[^/]*/code/(.+)$`).exec(url);
  if (code) return `https://update.greasyfork.org/scripts/${code[1]}/${code[2]}`;
  const library = new RegExp(`^https://greasyfork\\.org${locale}/(libraries/.+)$`).exec(url);
  return library ? `https://update.greasyfork.org/${library[1]}` : null;
}

// How a failed request is classified, which decides whether the run keeps going:
//   'missing' — 404/410/other 4xx: a dead link, expected in a corpus this size
//   'blocked' — 403: this host is bot-checking us
//   'error'   — 5xx or network trouble: might mean we're being throttled
async function download(url, file, { attempts = 3 } = {}) {
  const fetchUrl = mirrorUrl(url) ?? url;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetch(fetchUrl, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
    } catch (err) {
      lastError = `network error: ${err.message}`;
      await sleep(500 * attempt);
      continue;
    }
    // Only an explicit 429 means "you are going too fast" — stop everything.
    if (response.status === 429) throw new AbortRun(`HTTP 429 (rate limited) for ${fetchUrl}`);
    if (response.status === 403) return { ok: false, kind: 'blocked', error: 'HTTP 403' };
    if (!response.ok) {
      lastError = `HTTP ${response.status}`;
      // 4xx won't fix itself on a retry.
      if (response.status < 500) return { ok: false, kind: 'missing', error: lastError };
      await sleep(500 * attempt);
      continue;
    }
    const body = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return { ok: true, bytes: body.length, mirrored: fetchUrl !== url };
  }
  return { ok: false, kind: 'error', error: lastError };
}

/**
 * Fetch every URL, honoring --concurrency/--delay and the consecutive-failure
 * cutoff. Returns per-URL outcomes; `aborted` is set when the run bailed early.
 */
async function downloadAll(urls, opts, label) {
  const results = {
    downloaded: 0, mirrored: 0, skipped: 0,
    missing: [], skippedHosts: [], failures: [], brokenHosts: [], aborted: null,
  };
  // Per-host circuit breaker. Across a corpus this size some hosts are simply
  // unusable — bot-checked (403) or unreachable from this network (Chinese CDNs
  // resolve but never connect). Those are host problems, not "we're being
  // throttled", so after a few strikes we stop asking that host and carry on.
  const HOST_STRIKE_LIMIT = 3;
  const strikes = new Map(); // host → failed attempts
  let index = 0;
  let stopped = false;
  let resolveQueue = Promise.resolve();

  const worker = async () => {
    while (!stopped) {
      const i = index++;
      if (i >= urls.length) return;
      const url = urls[i];
      let file;
      try {
        // Serialized: resolveTarget can move an existing file into a new
        // directory, which must not interleave with another worker's lookup.
        // The queue is chained through a swallowed rejection so one bad URL
        // doesn't poison every later link with its stale error.
        const job = resolveQueue.then(() =>
          resolveTarget(urlToPath(opts.root, url), opts.root, {
            onMove: (moved) => console.info(`  moved ${moved} → ${moved}/index`),
          }),
        );
        resolveQueue = job.then(() => {}, () => {});
        file = await job;
      } catch (err) {
        results.failures.push({ url, error: err.message });
        continue;
      }
      if (!opts.force && (await exists(file))) {
        results.skipped++;
        continue;
      }
      const host = new URL(url).host;
      if ((strikes.get(host) ?? 0) >= HOST_STRIKE_LIMIT) {
        results.skippedHosts.push({ url, error: `${host} gave up after ${HOST_STRIKE_LIMIT} strikes` });
        continue;
      }
      let outcome;
      try {
        outcome = await download(url, file);
      } catch (err) {
        if (err instanceof AbortRun) {
          stopped = true;
          results.aborted = err.message;
          return;
        }
        // Anything else (a write that lost a race with a directory relocation,
        // a permissions problem) is this URL's failure, not the run's — losing
        // the whole run would also lose the report of what did succeed.
        outcome = { ok: false, kind: 'error', error: err.message };
      }
      if (outcome.ok) {
        results.downloaded++;
        if (outcome.mirrored) results.mirrored++;
      } else if (outcome.kind === 'missing') {
        // Dead links are normal across thousands of scripts — record and move on.
        // They say nothing about the host's health, so they earn no strike.
        results.missing.push({ url, error: outcome.error });
      } else {
        results.failures.push({ url, error: outcome.error });
        console.info(`  FAIL ${outcome.error}: ${url}`);
        const count = (strikes.get(host) ?? 0) + 1;
        strikes.set(host, count);
        if (count === HOST_STRIKE_LIMIT) {
          results.brokenHosts.push({ host, error: outcome.error });
          console.info(`  GIVING UP on ${host} (${outcome.error}) — skipping its remaining URLs`);
          // Many hosts failing at once means the problem is on our side, not
          // theirs; that's the one non-429 reason to stop the whole run.
          if (results.brokenHosts.length > opts.maxBrokenHosts) {
            stopped = true;
            results.aborted = `${results.brokenHosts.length} hosts unreachable — the network looks broken`;
            return;
          }
        }
      }
      const done =
        results.downloaded + results.skipped + results.missing.length + results.skippedHosts.length + results.failures.length;
      if (done % 25 === 0) {
        console.info(`  ${label}: ${done}/${urls.length} (${results.downloaded} new, ${results.skipped} cached)`);
      }
      if (opts.delay > 0) await sleep(opts.delay);
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  return results;
}

/**
 * Collect dependency URLs of one tag (`require` or `resource`) from the
 * userscripts we have on disk. Relative and `//host/path` forms are resolved
 * against the script's own URL, which is exactly what the file's location under
 * <root> encodes.
 */
async function collectDependencies(scriptUrls, opts, tag) {
  const urls = new Map(); // absolute URL → first script that asked for it
  const unresolved = [];
  for (const scriptUrl of scriptUrls) {
    // Not downloaded (skipped, failed, or cut off by --count) → nothing to scan.
    const downloaded = await readDownloaded(opts.root, scriptUrl);
    if (!downloaded) continue;

    const header = parseHeader(downloaded.text);
    if (!header) continue;
    for (const value of getValues(header, tag)) {
      if (!value.trim()) continue;
      // Shared with build-db.mjs so both agree on which URL a line names.
      const resolved = dependencyUrlFor(tag, value, scriptUrl);
      if (resolved === null) {
        unresolved.push({ [tag]: value.trim(), script: scriptUrl });
        continue;
      }
      if (!urls.has(resolved)) urls.set(resolved, scriptUrl);
    }
  }
  return { urls, unresolved };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const maxFilename = await detectMaxFilename(opts.root);
  if (maxFilename < 255) console.info(`Filesystem caps filenames at ${maxFilename} bytes; longer names get hashed`);
  const rows = listingRows(await readCorpus(opts.corpus));
  const scriptUrls = rows
    .map((row) => row.script_url)
    .filter((url) => url)
    .slice(0, opts.count === Infinity ? undefined : opts.count);
  console.info(`${scriptUrls.length} script URLs from ${path.relative(REPO_ROOT, opts.corpus)}`);

  const report = { root: opts.root, scripts: null, requires: null, resources: null };
  const aborted = () => Object.values(report).some((phase) => phase?.aborted);

  const summarize = (results) => {
    console.info(
      `  done: ${results.downloaded} downloaded (${results.mirrored} via mirror), ` +
        `${results.skipped} already present, ${results.missing.length} dead links, ` +
        `${results.failures.length} failed on ${results.brokenHosts.length} unreachable hosts ` +
        `(${results.skippedHosts.length} URLs skipped)`,
    );
    if (results.aborted) console.info(`  ABORTED: ${results.aborted}`);
  };

  if (opts.scripts) {
    console.info('Phase 1: userscripts');
    report.scripts = await downloadAll(scriptUrls, opts, 'scripts');
    summarize(report.scripts);
  }

  // @require libraries, then @resource assets — same collect-and-fetch shape.
  const phases = [
    ['requires', 'require', opts.requires, 'Phase 2: @require libraries'],
    ['resources', 'resource', opts.resources, 'Phase 3: @resource assets'],
  ];
  for (const [key, tag, enabled, banner] of phases) {
    // An abort in ANY earlier phase stops the rest: a 429 in phase 2 means the
    // server wants us to back off, and phase 3 hits the same hosts.
    if (!enabled || aborted()) continue;
    console.info(banner);
    const { urls, unresolved } = await collectDependencies(scriptUrls, opts, tag);
    console.info(`  ${urls.size} unique @${tag} URLs`);
    for (const item of unresolved) console.info(`  UNPARSEABLE @${tag} ${item[tag]} (${item.script})`);
    report[key] = await downloadAll([...urls.keys()], opts, key);
    report[key].unresolved = unresolved;
    report[key].unique = urls.size;
    summarize(report[key]);
  }

  await writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
  console.info(`Report written to ${path.relative(REPO_ROOT, opts.report)}`);
  if (aborted()) process.exitCode = 1;
}

await main();
