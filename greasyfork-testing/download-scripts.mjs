#!/usr/bin/env node
// Download the userscripts listed in corpus.json, then the unique
// `@require` libraries, `@resource` assets and `@icon` images they pull in,
// into a URL-shaped tree on disk.
//
// Layout: every file lands at <root>/<host>/<path>, keeping the URL's
// percent-encoding verbatim in the filename, e.g.
//   https://update.greasyfork.org/scripts/25253/ZOOM%20HACK%20for%20Blobleio%21.user.js
//   → greasyfork-testing/files/update.greasyfork.org/scripts/25253/ZOOM%20HACK%20for%20Blobleio%21.user.js
//
// The raw `.user.js` URLs aren't behind GreasyFork's Cloudflare bot check
// (see README.md), so a plain fetch works.
//
// Usage:
//   node greasyfork-testing/download-scripts.mjs [options]
//
//   --corpus PATH      script list (default greasyfork-testing/corpus.json)
//   --root PATH        download root (default greasyfork-testing/files)
//   --count N          only the first N scripts, in listing order (default: all)
//   --delay MS         pause between requests (default 200)
//   --concurrency N    parallel requests (default 1 — be polite)
//   --force            re-download files that already exist on disk
//   --update           ask GreasyFork which scripts changed, and re-download only
//                      those, with all their @require, @resource and @icon files,
//                      refreshing their `listing` blocks but for `name` and
//                      `script_url`. It lists what changed, marks scripts
//                      GreasyFork no longer has with `gone_as_of`, and takes
//                      neither --force nor --include. Run
//                      `record-results.mjs validate` afterwards
//   --api-origin URL   the GreasyFork API server --update reads each script's
//                      current version and listing data from (default
//                      https://api.greasyfork.org; the tests point it at a
//                      local server)
//   --include PARTS    a comma-separated list of what to download: `scripts`,
//                      `requires`, `resources`, `icons`, or `all` (default all).
//                      `requires`, `resources` and `icons` are found in the
//                      headers of scripts already on disk, so they need the
//                      scripts downloaded first, in this run or an earlier one
//   --report PATH      where to write the run report (default download-report.json here)
//   --max-broken-hosts N  abort once more than N hosts have gone unreachable (default 5)
//
// Failure handling, in short:
//   - 429 aborts the run outright — that's the one status that means "slow down"
//   - a host that 403s or won't connect is dropped after 3 strikes; its
//     remaining URLs are skipped and the rest of the corpus continues
//   - 404/410 dead links are recorded and otherwise ignored
// Re-running resumes, since files already on disk are skipped. An --update run
// resumes too: a script keeps its old `listing` until its files are saved, so
// the next run still sees it as changed (unless it had a same-day upload, which
// looks current by then).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValue, parseHeader, getValues } from '../dist/userscript-header.js';
import { iconRefFromHeader } from '../dist/script-icon.js';
import {
  API_ORIGIN, CORPUS_JSON, dependencyUrlFor, checkRoot, exists, listingBlock, listingRows, mirrorUrl, readCorpus, readDownloaded,
  resolveTarget, today, updateCorpus, urlToPath, printHelp,
} from './corpus.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'greasyfork-testing/files');
const REPORT_PATH = path.join(REPO_ROOT, 'greasyfork-testing/download-report.json');

// Sent first on every request: some hosts serving @require libraries reject the
// default Node UA outright.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// What `--include` can name, each a phase of the download.
const PARTS = ['scripts', 'requires', 'resources', 'icons'];

// `--include`'s list, as `{ scripts, requires, resources, icons }` flags.
function includedParts(given) {
  const words = given.split(',').map((p) => p.trim()).filter(Boolean);
  const unknown = words.find((p) => p !== 'all' && !PARTS.includes(p));
  if (unknown !== undefined || words.length === 0) {
    const takes = [...PARTS, 'all'].map((p) => `\`${p}\``).join(', ');
    throw new Error(`The \`--include\` flag takes ${takes}, comma-separated${unknown !== undefined ? `, and not \`${unknown}\`` : ''}`);
  }
  return Object.fromEntries(PARTS.map((p) => [p, words.includes('all') || words.includes(p)]));
}

function parseArgs(argv) {
  const opts = {
    corpus: CORPUS_JSON,
    root: DEFAULT_ROOT,
    count: Infinity,
    delay: 200,
    concurrency: 1,
    force: false,
    update: false,
    apiOrigin: API_ORIGIN,
    ...includedParts('all'),
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
      case '--update': opts.update = true; break;
      case '--api-origin': opts.apiOrigin = next(); break;
      case '--include': opts.includeGiven = true; Object.assign(opts, includedParts(next())); break;
      case '--report': opts.report = path.resolve(next()); break;
      case '--max-broken-hosts': opts.maxBrokenHosts = Number(next()); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (opts.update && (opts.force || opts.includeGiven)) {
    throw new Error('The `--update` flag picks what to download itself, so it takes neither `--force` nor `--include`');
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

/** A failed fetch's message. Node's own is `fetch failed`, with the reason in `cause`. */
const networkError = (err) => `Network error: ${err.cause?.message ?? err.message}`;

/** Thrown when the server signals we should stop entirely, not just skip one file. */
class AbortRun extends Error {}

// How a failed request is classified, which decides whether the run keeps going:
//   'missing' — 404/410/other 4xx: a dead link, expected in a corpus this size
//   'blocked' — 403: this host is bot-checking us
//   'error'   — 5xx or network trouble: might mean we're being throttled
async function download(url, file, { attempts = 3 } = {}) {
  const fetchUrl = mirrorUrl(url) ?? url;
  let lastError;
  let headers = { 'User-Agent': USER_AGENT };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetch(fetchUrl, { headers, redirect: 'follow' });
    } catch (err) {
      lastError = networkError(err);
      await sleep(500 * attempt);
      continue;
    }
    // Only an explicit 429 means "you are going too fast" — stop everything.
    if (response.status === 429) throw new AbortRun(`HTTP 429 (rate limited) for ${fetchUrl}`);
    if (response.status === 403) {
      // Some hosts (Codeberg) turn away a browser user agent that doesn't act
      // like a browser, and accept Node's own, so try that once.
      if (!headers['User-Agent'] || attempt === attempts) return { ok: false, kind: 'blocked', error: 'HTTP 403' };
      headers = {};
      continue;
    }
    if (!response.ok) {
      lastError = `HTTP ${response.status}`;
      // 4xx won't fix itself on a retry.
      if (response.status < 500) return { ok: false, kind: 'missing', error: lastError };
      await sleep(500 * attempt);
      continue;
    }
    const body = Buffer.from(await response.arrayBuffer());
    const previous = await readFile(file).catch(() => null);
    const change = previous === null ? 'added' : previous.equals(body) ? 'unchanged' : 'changed';
    if (change !== 'unchanged') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
    }
    return { ok: true, bytes: body.length, mirrored: fetchUrl !== url, change };
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
    // The downloaded URLs, by how the bytes compare with the copy on disk.
    added: [], changed: [], unchanged: [],
    missing: [], skippedHosts: [], failures: [], brokenHosts: [], aborted: null,
  };
  // Per-host circuit breaker. Across a corpus this size some hosts are simply
  // unusable — bot-checked (403) or unreachable from this network (Chinese CDNs
  // resolve but never connect). Those are host problems, not "we're being
  // throttled", so after a few strikes we stop asking that host and carry on.
  const HOST_STRIKE_LIMIT = 3;
  const strikes = new Map(); // host → failed attempts
  const blockedHosts = new Set(); // hosts that answered 403
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
        results.skippedHosts.push({
          url, error: `${host} gave up after ${HOST_STRIKE_LIMIT} strikes`, mayPass: !blockedHosts.has(host),
        });
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
        results[outcome.change].push(url);
        if (outcome.mirrored) results.mirrored++;
      } else if (outcome.kind === 'missing') {
        // Dead links are normal across thousands of scripts — record and move on.
        // They say nothing about the host's health, so they earn no strike.
        results.missing.push({ url, error: outcome.error });
      } else {
        // `mayPass`: a later run could get this file. A 403 will likely repeat.
        results.failures.push({ url, error: outcome.error, mayPass: outcome.kind !== 'blocked' });
        if (outcome.kind === 'blocked') blockedHosts.add(host);
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
 * Collect dependency URLs of one tag (`require`, `resource` or `icon`) from
 * the userscripts we have on disk. For `icon`, only the one icon SourceMonkey
 * would show, picked from `@icon` and its aliases as it picks it. Relative and `//host/path` forms are resolved
 * against the script's own URL, which is exactly what the file's location under
 * <root> encodes.
 */
// The icon SourceMonkey would show, unless it's inline (`data:`), which has
// nothing to download.
function iconValues(header) {
  const ref = iconRefFromHeader(header);
  return ref && !ref.startsWith('data:') ? [ref] : [];
}

async function collectDependencies(scriptUrls, opts, tag) {
  const urls = new Map(); // absolute URL → the scripts that ask for it
  const unresolved = [];
  for (const scriptUrl of scriptUrls) {
    // Not downloaded (skipped, failed, or cut off by --count) → nothing to scan.
    const downloaded = await readDownloaded(opts.root, scriptUrl);
    if (!downloaded) continue;

    const header = parseHeader(downloaded.text);
    if (!header) continue;
    const values = tag === 'icon' ? iconValues(header) : getValues(header, tag);
    for (const value of values) {
      if (!value.trim()) continue;
      // Shared with build-db.mjs so both agree on which URL a line names.
      const resolved = dependencyUrlFor(tag, value, scriptUrl);
      if (resolved === null) {
        unresolved.push({ [tag]: value.trim(), script: scriptUrl });
        continue;
      }
      if (!urls.has(resolved)) urls.set(resolved, new Set());
      urls.get(resolved).add(scriptUrl);
    }
  }
  return { urls, unresolved };
}

const aborted = (report) => Object.values(report).some((phase) => phase?.aborted);

function summarize(results) {
  console.info(
    `  done: ${results.downloaded} downloaded (${results.mirrored} via mirror), ` +
      `${results.skipped} already present, ${results.missing.length} dead links, ` +
      `${results.failures.length} failed on ${results.brokenHosts.length} unreachable hosts ` +
      `(${results.skippedHosts.length} URLs skipped)`,
  );
  if (results.aborted) console.info(`  ABORTED: ${results.aborted}`);
}

/**
 * The @require, @resource and @icon phases, for the given scripts on disk.
 * Returns the scripts naming a file that failed and may pass on a later run.
 */
async function downloadDependencies(scriptUrls, opts, report) {
  const phases = [
    ['requires', 'require', opts.requires, 'Phase 2: @require libraries'],
    ['resources', 'resource', opts.resources, 'Phase 3: @resource assets'],
    ['icons', 'icon', opts.icons, 'Phase 4: @icon images'],
  ];
  const retry = new Set();
  for (const [key, tag, enabled, banner] of phases) {
    // An abort in ANY earlier phase stops the rest: a 429 in phase 2 means the
    // server wants us to back off, and phase 3 hits the same hosts.
    if (!enabled || aborted(report)) continue;
    console.info(banner);
    const { urls, unresolved } = await collectDependencies(scriptUrls, opts, tag);
    console.info(`  ${urls.size} unique @${tag} URLs`);
    for (const item of unresolved) console.info(`  UNPARSEABLE @${tag} ${item[tag]} (${item.script})`);
    report[key] = await downloadAll([...urls.keys()], opts, key);
    report[key].unresolved = unresolved;
    report[key].unique = urls.size;
    summarize(report[key]);
    for (const { url, mayPass } of [...report[key].failures, ...report[key].skippedHosts]) {
      if (mayPass) for (const script of urls.get(url)) retry.add(script);
    }
  }
  return retry;
}

// ---------- --update ----------

// Stop asking after this many API failures in a row: that's the API or our
// network, not one script.
const API_FAILURE_LIMIT = 10;

/**
 * Ask the API about one script. Returns its row, `{ gone: true }` when
 * GreasyFork no longer has it, or `{ error }`. Throws AbortRun on a 429.
 */
async function fetchScriptRow(id, opts, { attempts = 3 } = {}) {
  const url = new URL(`/en/scripts/${id}.json`, opts.apiOrigin);
  let error;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      // Node's own user agent, as add-scripts.mjs sends to this API.
      response = await fetch(url);
    } catch (err) {
      error = networkError(err);
      await sleep(500 * attempt);
      continue;
    }
    if (response.status === 429) throw new AbortRun(`HTTP 429 (rate limited) for ${url}`);
    if (response.status === 404 || response.status === 410) return { gone: true };
    if (response.ok) {
      try {
        const row = await response.json();
        // A redirect could lead to a script that replaced this one, whose data
        // doesn't belong in this record.
        return row.deleted || row.id !== id ? { gone: true } : { row };
      } catch {
        return { error: 'The API answer is not JSON' };
      }
    }
    error = `HTTP ${response.status}`;
    if (response.status < 500) break;
    await sleep(500 * attempt);
  }
  return { error };
}

/** `{ version }` of the script copy on disk (`''` when it has none), or null when there's no copy. */
async function diskVersion(root, scriptUrl) {
  const downloaded = await readDownloaded(root, scriptUrl);
  if (!downloaded) return null;
  const header = parseHeader(downloaded.text);
  return { version: (header && getValue(header, 'version')?.trim()) || '' };
}

/**
 * Ask the API about each script, and sort them into `current` (nothing new),
 * `outdated` (needs downloading), `gone` and `failures`.
 *
 * The date catches a new upload that kept its `@version`. The version catches a
 * same-day upload, since the listing's date only has the day.
 */
async function checkScripts(rows, opts) {
  const check = { current: [], outdated: [], gone: [], failures: [], aborted: null };
  let index = 0;
  let failuresInARow = 0;
  const worker = async () => {
    while (!check.aborted && index < rows.length) {
      const old = rows[index++];
      let answer;
      try {
        answer = await fetchScriptRow(old.id, opts);
      } catch (err) {
        if (!(err instanceof AbortRun)) throw err;
        check.aborted = err.message;
        return;
      }
      if (answer.error) {
        check.failures.push({ id: old.id, name: old.name, error: answer.error });
        console.info(`  FAIL ${answer.error}: script ${old.id}`);
        if (++failuresInARow >= API_FAILURE_LIMIT) {
          check.aborted = `${API_FAILURE_LIMIT} API failures in a row, the last: ${answer.error}`;
          return;
        }
      } else {
        failuresInARow = 0;
        if (answer.gone) {
          check.gone.push({ id: old.id, name: old.name });
        } else {
          // `script_url` stays as it was: GreasyFork finds a script's code by
          // ID whatever name the URL has, so a renamed script keeps its path
          // in files/, and `file` in corpus.json. `name` stays too: for one
          // script, the API gives the author's language even under /en/, where
          // the listings that added it gave the English name.
          const listing = { ...listingBlock(answer.row), name: old.name, script_url: old.script_url };
          const onDisk = await diskVersion(opts.root, old.script_url);
          const entry = { id: old.id, listing, from: onDisk?.version ?? null, to: answer.row.version ?? '' };
          // A copy with no version to compare (no `@version`, or a user style
          // our parser reads no header from) goes by the date alone.
          const newVersion = onDisk?.version && onDisk.version !== entry.to;
          const isOutdated = !onDisk || newVersion || old.updated_date !== listing.updated_date;
          (isOutdated ? check.outdated : check.current).push(entry);
        }
      }
      const done = check.current.length + check.outdated.length + check.gone.length + check.failures.length;
      if (done % 100 === 0) console.info(`  checked ${done}/${rows.length} (${check.outdated.length} to download)`);
      if (opts.delay > 0) await sleep(opts.delay);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  return check;
}

/** Print the report's lists, the ones worth reading after the run. */
function printChanges(changes, report) {
  for (const { id, listing, from, to } of changes.changed) {
    const versions = from === to ? `v${to}, the same version` : `v${from ?? '?'} → v${to}`;
    console.info(`  changed ${id} ${listing.name}: ${versions}`);
  }
  for (const { id, name } of changes.gone) console.info(`  gone    ${id} ${name}: kept the copy on disk`);
  for (const { id, name, error } of changes.failures) console.info(`  failed  ${id} ${name}: ${error}`);
  for (const { id, listing } of changes.heldBack) console.info(`  retry   ${id} ${listing.name}: the next run tries it and its files again`);
  for (const key of ['requires', 'resources', 'icons']) {
    for (const url of report[key]?.changed ?? []) console.info(`  changed ${url}: for all scripts that name this URL`);
    for (const { url, error } of ['missing', 'failures', 'skippedHosts'].flatMap((list) => report[key]?.[list] ?? [])) {
      console.info(`  failed  ${url}: ${error}, kept any copy on disk`);
    }
  }
}

async function update(opts) {
  const rows = listingRows(await readCorpus(opts.corpus))
    .filter((row) => row.script_url)
    .slice(0, opts.count === Infinity ? undefined : opts.count);
  // Every download overwrites its file, but only after a successful fetch, so a
  // failed one keeps the old copy.
  const fetchOpts = { ...opts, force: true };
  const report = { root: opts.root, check: null, scripts: null, requires: null, resources: null, icons: null };

  console.info(`Checking ${rows.length} scripts with ${opts.apiOrigin}`);
  const check = await checkScripts(rows, opts);
  report.check = {
    current: check.current.length, outdated: check.outdated.length, gone: check.gone, failures: check.failures,
    aborted: check.aborted,
  };
  console.info(`  ${check.current.length} current, ${check.outdated.length} to download, ` +
    `${check.gone.length} gone, ${check.failures.length} failed`);
  if (check.aborted) console.info(`  ABORTED: ${check.aborted}`);

  const changes = { changed: [], gone: check.gone, failures: [...check.failures], heldBack: [] };
  let saved = [];
  if (!check.aborted && check.outdated.length > 0) {
    console.info('Phase 1: userscripts');
    const byUrl = new Map(check.outdated.map((entry) => [entry.listing.script_url, entry]));
    report.scripts = await downloadAll([...byUrl.keys()], fetchOpts, 'scripts');
    summarize(report.scripts);
    const { added, changed, unchanged } = report.scripts;
    saved = [...added, ...changed, ...unchanged].map((url) => byUrl.get(url));
    changes.changed = [...added, ...changed].map((url) => byUrl.get(url));
    for (const { url, error } of [...report.scripts.missing, ...report.scripts.failures, ...report.scripts.skippedHosts]) {
      const { id, listing } = byUrl.get(url);
      changes.failures.push({ id, name: listing.name, error });
    }
    if (!aborted(report)) {
      const retry = await downloadDependencies(saved.map((entry) => entry.listing.script_url), fetchOpts, report);
      changes.heldBack = saved.filter((entry) => retry.has(entry.listing.script_url));
    }
  }

  // A listing's API data changes only with its download, so its counters and
  // `as_of` date describe the copy on disk, and a run's diff shows only the
  // scripts it updated, apart from `gone_as_of` marks.
  //
  // A script keeps its old listing when the run aborted, or when a file it names
  // failed in a way that may pass. The next run then sees it as changed, and
  // downloads it and its files again. A same-day upload is the exception: the
  // version on disk is new by then and the date matches, so it reads as current.
  //
  // A file that a 4xx or 403 refused doesn't hold back the listing, since that
  // would likely repeat on every run.
  const refreshed = aborted(report) ? [] : saved.filter((entry) => !changes.heldBack.includes(entry));
  await updateCorpus(opts.corpus, (live) => {
    // These marks come from the API's answers, so they stand even if the run
    // aborted. `gone_as_of` keeps the date a script was first found gone, and a
    // script that's back loses it, even when its listing is held back.
    for (const { id } of check.gone) {
      if (live.scripts[id]?.listing) live.scripts[id].listing.gone_as_of ??= today();
    }
    for (const { id } of [...check.current, ...check.outdated]) {
      if (live.scripts[id]?.listing) delete live.scripts[id].listing.gone_as_of;
    }
    for (const { id, listing } of refreshed) {
      if (live.scripts[id]) live.scripts[id].listing = listing;
    }
  });

  report.update = {
    changed: changes.changed.map(({ id, listing, from, to }) => ({ id, name: listing.name, from, to })),
    sameVersion: changes.changed.filter(({ from, to }) => from === to).map(({ id }) => id),
    gone: changes.gone,
    failures: changes.failures,
    heldBack: changes.heldBack.map(({ id }) => id),
  };
  printChanges(changes, report);
  await writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
  console.info(`Report written to ${path.relative(REPO_ROOT, opts.report)}`);
  if (aborted(report)) {
    console.info('The run stopped early. Run `--update` again to continue.');
    process.exitCode = 1;
  }
  // On saved scripts, not just changed ones: a rerun after an abort finds the
  // scripts it saved earlier unchanged, and they may still need validating.
  if (saved.length > 0) {
    const count = changes.changed.length;
    console.info(`${count} ${count === 1 ? 'script' : 'scripts'} changed, ${saved.length} downloaded. ` +
      'Next: `record-results.mjs validate`, then `record-results.mjs list --stale` for the tests to repeat');
  }
}

async function main() {
  if (printHelp(process.argv.slice(2), import.meta.url)) return;
  const opts = parseArgs(process.argv.slice(2));
  await checkRoot(opts.root, { create: true });
  if (opts.update) return update(opts);
  const rows = listingRows(await readCorpus(opts.corpus));
  const scriptUrls = rows
    .map((row) => row.script_url)
    .filter((url) => url)
    .slice(0, opts.count === Infinity ? undefined : opts.count);
  console.info(`${scriptUrls.length} script URLs from ${path.relative(REPO_ROOT, opts.corpus)}`);

  const report = { root: opts.root, scripts: null, requires: null, resources: null, icons: null };

  if (opts.scripts) {
    console.info('Phase 1: userscripts');
    report.scripts = await downloadAll(scriptUrls, opts, 'scripts');
    summarize(report.scripts);
  }

  if (!aborted(report)) await downloadDependencies(scriptUrls, opts, report);

  await writeFile(opts.report, JSON.stringify(report, null, 2) + '\n');
  console.info(`Report written to ${path.relative(REPO_ROOT, opts.report)}`);
  if (aborted(report)) process.exitCode = 1;
}

await main();
