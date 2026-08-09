#!/usr/bin/env node
//
// Offline userscript validator — the install-time checks as a CLI.
//
// SourceMonkey validates a script at the moment it is installed or
// refreshed: split the metadata block, check the header has the fields
// we require, fetch every `@require` / `@resource`, and compile the
// composed program to see whether V8 would accept it. This runs the
// same pipeline over files on disk so a corpus of scripts can be
// checked in bulk without a browser.
//
// It is the production code, not a reimplementation: `buildScriptFromText`
// and `applyFiles` are imported from `dist/`, so the statuses and the
// error strings are the ones a user would see in the extension. Two
// pieces necessarily differ, and both are documented where they live:
//
//   - the compile happens in Node's V8 rather than Chrome's sandboxed
//     page (`scripts/parse-check-node.mjs`);
//   - `--offline-root` swaps the global `fetch` for one that serves
//     `@require` / `@resource` URLs out of a downloaded tree.
//
// Usage:
//   node scripts/validate-userscripts.mjs [options] <path>...
//
//   <path>   a `*.user.js` file, or a directory scanned recursively
//            for them.
//
// Options:
//   --offline-root DIR   Serve every http(s) dependency from DIR (the
//                        tree `tests/greasyfork-examples/download-scripts.mjs`
//                        writes). No network requests are made at all;
//                        a URL that isn't in the tree reads as a dead
//                        link. Scripts found *under* DIR also get their
//                        original https:// URL reconstructed from their
//                        path, so relative refs resolve the way they
//                        would on the real host.
//   --json FILE          Write one JSON record per script to FILE.
//   --limit N            Stop after N scripts (in scan order).
//   --concurrency N      Scripts checked in parallel (default 8).
//   --examples N         Example script names to print per failure
//                        group (default 3; use --examples 0 for none).
//   --quiet              Summary only — no per-group examples.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyFiles,
  buildScriptFromText,
  setParseChecker,
  NO_MATCH_OR_INCLUDE,
  NO_NAME,
  SYNTAX_ERROR_PREFIX,
} from '../dist/script-store.js';
import { buildParseCheckSource } from '../dist/injector.js';
import { attachParseLocation } from '../dist/parse-location.js';
import { describeDiagnostic } from '../dist/diagnostic-location.js';
import { resolveScriptResource } from '../dist/file-loader.js';
import {
  distillRequires,
  distillResources,
  isFetchFailureMessage,
  MAX_FILE_BYTES,
} from '../dist/external-files.js';
import {
  NO_METADATA_BLOCK,
  UNTERMINATED_METADATA_BLOCK,
} from '../dist/userscript-header.js';
import { unusableMatchGroupKey } from '../dist/url-match.js';
import { checkParseNode } from './parse-check-node.mjs';
// The offline tree's layout (percent-encoded segments, truncated long
// names, `<path>/index` for a path that is also a directory prefix) is
// defined by the corpus downloader, so the lookup comes from there
// rather than being guessed at here.
import { detectMaxFilename, findExisting } from '../tests/greasyfork-examples/corpus.mjs';

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    paths: [],
    offlineRoot: null,
    json: null,
    limit: Infinity,
    concurrency: 8,
    examples: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    // A non-numeric count has to be rejected, not coerced: `Number('x')`
    // is NaN, every comparison against it is false, and the run would
    // quietly check nothing (or, for --concurrency, spawn no workers and
    // report an empty corpus as clean).
    const nextCount = (min) => {
      const v = Number(next());
      if (!Number.isInteger(v) || v < min) throw new Error(`${arg} needs a whole number >= ${min}`);
      return v;
    };
    switch (arg) {
      case '--offline-root': opts.offlineRoot = path.resolve(next()); break;
      case '--json': opts.json = path.resolve(next()); break;
      case '--limit': opts.limit = nextCount(1); break;
      case '--concurrency': opts.concurrency = nextCount(1); break;
      case '--examples': opts.examples = nextCount(0); break;
      case '--quiet': opts.examples = 0; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        opts.paths.push(path.resolve(arg));
    }
  }
  return opts;
}

const USAGE = `Usage: node scripts/validate-userscripts.mjs [options] <path>...

  --offline-root DIR   serve @require/@resource from a downloaded tree
  --json FILE          write per-script results as JSON
  --limit N            stop after N scripts
  --concurrency N      scripts in parallel (default 8)
  --examples N         example names per failure group (default 3)
  --quiet              summary only
`;

// ---------- Finding scripts ----------

async function collectScripts(inputs, limit) {
  const found = [];
  for (const input of inputs) {
    // A mistyped path has to be an error, not zero scripts silently
    // reported as a clean run.
    const info = await stat(input).catch(() => {
      throw new Error(`No such file or directory: ${input}`);
    });
    if (info.isDirectory()) await walk(input, found, limit);
    else found.push(input);
    if (found.length >= limit) break;
  }
  return found.slice(0, limit);
}

// Symlinks are not followed: `isDirectory()` is false for a link to a
// directory, and a link to a file fails the name test too. That's the
// conservative reading — a corpus tree is generated, not curated, and
// following links risks walking a cycle or the whole filesystem. Worth
// knowing if you ever point this at a hand-built tree of symlinks,
// because those files are skipped silently.
async function walk(dir, out, limit) {
  const entries = await readdir(dir, { withFileTypes: true });
  // Sorted so a --limit run is reproducible.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out, limit);
    else if (entry.name.endsWith('.user.js')) out.push(full);
  }
}

// ---------- Offline fetch ----------
//
// `file-loader.ts` reaches the network through the global `fetch` for
// both http(s) and file:// URLs (in a Node/service-worker context,
// where there is no XHR). Replacing that global is therefore enough to
// redirect every dependency fetch in the pipeline — `attachFiles`, and
// anything it calls, is untouched.
//
// `file://` is handled in both modes because Node's built-in fetch
// doesn't implement it at all, and a script sitting in a local
// directory can legitimately `@require` a sibling.

/** url → why the offline tree couldn't satisfy it, for the report. */
const fetchLog = new Map();

function installFetch(offlineRoot) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    // Every caller in the pipeline passes a string, but `fetch` also
    // takes a URL or a Request, and a shim that only half-implements
    // its own signature fails confusingly later rather than here.
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input.url;
    if (url.startsWith('file:')) return serveLocalFile(fileURLToPath(url), url, 'not-found');
    if (offlineRoot) {
      const file = await findExisting(offlineRoot, url);
      if (!file) {
        fetchLog.set(url, { reason: 'not-downloaded' });
        return new Response(null, { status: 404 });
      }
      return serveLocalFile(file, url, 'not-downloaded');
    }
    return realFetch(input, init);
  };
}

async function serveLocalFile(file, url, missingReason) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    fetchLog.set(url, { reason: missingReason });
    return new Response(null, { status: 404 });
  }
  if (bytes.byteLength === 0) fetchLog.set(url, { reason: 'empty', size: 0 });
  else if (bytes.byteLength > MAX_FILE_BYTES) {
    fetchLog.set(url, { reason: 'oversize', size: bytes.byteLength });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': guessContentType(file, bytes),
      'content-length': String(bytes.byteLength),
    },
  });
}

// A downloaded file carries no record of the Content-Type its server
// sent, and the `@require` loader gates on exactly that header: an
// HTML response is rejected as the classic soft-failure signature (a
// login or error page served in place of the library). Sniffing the
// bytes reproduces that decision better than trusting the extension
// would — a `.js` URL whose content is a `<!DOCTYPE html>` page is
// precisely the case the gate exists for. Everything else is typed off
// the extension, and falls back to `application/octet-stream`, which
// the loader accepts (see `requireAcceptContentType`).
//
// The sniff is deliberately only the two unambiguous openings. A page
// starting with `<?xml`, a BOM, or a comment is left to its extension —
// which under-reports the HTML gate rather than over-reporting it, and
// a false accusation about someone's dependency is the worse error of
// the two. Such a file still fails, one step later, as a syntax error.
const CONTENT_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

function guessContentType(file, bytes) {
  const head = bytes.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html';
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// ---------- The parse checker ----------
//
// Same two steps every in-browser checker performs (`background.ts`
// for the service worker, `parse-check-client.ts` for extension
// pages): compose the exact text the injected entry compiles, then
// resolve the reported position back to the file it was written in.
// Only the compile itself is Node's.

// Verdicts the pipeline deliberately swallows, kept so the report can
// show them. The check fails open by design: `unknown` (V8 threw
// something that wasn't a SyntaxError) and a checker that throws both
// leave the script `ok`, logged and otherwise invisible. Over a corpus
// that silence is the thing most worth measuring, so it's recorded
// here — without changing what the pipeline does with it.
const parseNotes = new Map();

function installParseChecker() {
  setParseChecker(async (script) => {
    let checked;
    try {
      checked = await buildParseCheckSource(script, EXTENSION_VERSION);
    } catch (err) {
      parseNotes.set(script.id, { kind: 'errored', message: String(err?.message ?? err) });
      throw err;
    }
    const verdict = attachParseLocation(checkParseNode(checked.text), checked);
    if (verdict?.status === 'unknown') {
      parseNotes.set(script.id, { kind: 'inconclusive', message: verdict.message ?? '' });
    }
    return verdict;
  });
}

// `chrome.runtime.getManifest().version` in the extension. Only used as
// one leg of the parse-check cache key, which this tool never reads,
// but keeping it honest costs nothing.
let EXTENSION_VERSION = '';

// ---------- Checking one script ----------

async function checkScript(file, offlineRoot, now) {
  const source = await readFile(file, 'utf8');
  const fileUrl = scriptUrlFor(file, offlineRoot);
  const built = await buildScriptFromText({
    id: `offline-${file}`,
    collectionId: 'offline',
    relativePath: path.basename(file),
    fileUrl,
    text: source,
    now,
  });
  // A fresh install: no prior row, and `recheck: 'all'` refetches every
  // declared dependency. The fetch cache is per script rather than
  // shared across the run — sharing is purely a network optimization,
  // and holding every dependency body of a 2000-script corpus in memory
  // at once is not worth it when the "network" is the local disk.
  return applyFiles(built, undefined, 'all', new Map(), now);
}

// The URL a script would have been fetched from. Inside the offline
// tree that's reconstructible: the tree is `<root>/<host>/<url-path>`
// with the URL's own percent-encoding preserved.
//
// It matters for three things, all of which a `file://` base would get
// wrong:
//
//   - the directory a relative `@require` / `@resource` resolves
//     against;
//   - the canonical URL used as the fetch + dedup key, which is what
//     `findExisting` looks up in the tree;
//   - the URL the report prints, which should name the dependency the
//     way the script's author wrote it.
//
// (The containment rule in `resolveScriptResource` is NOT one of them —
// it applies to every relative ref regardless of scheme.)
//
// Not exact in two shapes the downloader produces: `clampSegment`
// truncates an over-long segment with a hash spliced in, and a path
// that is also a directory prefix is stored as `<path>/index`. Neither
// round-trips. Both affect only the last segment (the filename), so the
// directory a relative ref resolves against is still right.
function scriptUrlFor(file, offlineRoot) {
  if (offlineRoot) {
    const rel = path.relative(offlineRoot, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const [host, ...rest] = rel.split(path.sep);
      return `https://${host}/${rest.join('/')}`;
    }
  }
  return pathToFileURL(file).toString();
}

// ---------- Classifying the outcome ----------
//
// Every failure arrives as `status: 'invalid'` plus a human-readable
// `errorMessage`, which is all the extension itself has. That message
// now says which fetch failure it was, so the report mostly just passes
// it through.
//
// One thing the harness still knows better than the pipeline: the
// offline mirror answers a URL it doesn't hold with a 404, which is a
// different fact from a server that really replied 404. So the fetch
// log is consulted for that case alone — the size and empty-file
// outcomes it used to supply are reported by the pipeline itself now.
//
// Strings that ARE shared with the pipeline get imported, never copied:
// they are user-facing wording, and a copy here would go stale the next
// time somebody improves one.

const OFFLINE_REASON_TEXT = {
  'not-downloaded': 'not in the offline tree (dead link or never downloaded)',
  'not-found': 'file not found',
};

function classify(script) {
  if (script.status !== 'invalid') {
    const note = parseNotes.get(script.id);
    // Still `ok` — the check failed open, which is the design. Called
    // out separately because "we couldn't tell" is not "it parses".
    if (note) return { category: `parse check ${note.kind}`, detail: note.message || '(no message)' };
    return { category: 'ok' };
  }
  const message = script.errorMessage ?? '(no message)';

  if (message.startsWith(SYNTAX_ERROR_PREFIX)) {
    // No position to strip: `errorMessage` carries the message alone and
    // the location travels beside it in `errorLocation` (see
    // docs/diagnostics.md). That is what we want here anyway — the
    // position is per script, the message is what groups.
    return { category: 'syntax error', detail: message.slice(SYNTAX_ERROR_PREFIX.length) };
  }

  const dep = /^@(require|resource) (.*?): ([\s\S]*)$/.exec(message);
  if (dep) {
    const [, kind, subject, reason] = dep;
    // Resolved for every dependency failure, not just the fetch ones:
    // it is the only source of the record's `url` field, and an
    // oversize or empty dependency is exactly as worth locating as an
    // unreachable one.
    const url = depUrl(script, kind, subject);
    // "We tried to read it and got nothing usable", asked of the
    // pipeline via `isFetchFailureMessage` rather than pattern-matched
    // here. This was a regex over the wording (`/^could not be
    // (fetched|read)/`) and went stale silently the first time those
    // messages were reworded — the whole point of the import rule above.
    //
    // A loose gate on purpose. It also admits failures the log can say
    // nothing about (a timeout, a rejected content type), which is
    // harmless: those never coincide with a `not-downloaded` /
    // `not-found` entry, so the lookup simply misses and the pipeline's
    // own message stands.
    if (isFetchFailureMessage(reason)) {
      const offline = OFFLINE_REASON_TEXT[fetchLog.get(url)?.reason];
      // No log entry, or one we have no better wording for: the
      // pipeline's own message is already specific.
      return { category: `@${kind}`, detail: offline ?? reason, url };
    }
    // Everything else is already a specific message; strip embedded
    // content-type values so near-identical failures group together.
    return { category: `@${kind}`, detail: reason.replace(/"[^"]*"/g, '"…"'), url };
  }

  // A header failure too, but one that names the offending `@match`, so
  // it can't be a member of the set below. The pattern is elided by the
  // module that writes the message, so a hundred scripts each botching
  // a different URL the same way land in ONE row.
  const unusableMatch = unusableMatchGroupKey(message);
  if (unusableMatch) return { category: 'header', detail: unusableMatch };

  if (HEADER_MESSAGES.has(message)) return { category: 'header', detail: message };
  // A message no step here recognizes. Bucketing it as `header` (the
  // only other producer today) would let a new failure shape hide
  // inside a familiar count, which is the opposite of what a survey is
  // for.
  return { category: 'other', detail: message };
}

// The fixed messages `buildScriptFromText` can produce: the `SplitError`
// union from `userscript-header.ts`, then `validateHeader`'s returns.
// Its one variable message — the unusable `@match` — is recognized just
// above instead, since it carries the pattern that caused it.
const HEADER_MESSAGES = new Set([
  NO_METADATA_BLOCK,
  UNTERMINATED_METADATA_BLOCK,
  NO_NAME,
  NO_MATCH_OR_INCLUDE,
]);

// The URL behind a failing dependency line. `@require` names its ref
// directly; `@resource` names both, as `<name> (<ref>)`.
//
// Either way the ref is checked against the header before being
// resolved, so a message we mis-parsed yields '' rather than a
// confidently wrong URL.
//
// The name is matched lazily so a ref containing `)` — `(./icon
// (copy).png)` — splits at the FIRST gap rather than the last. A
// resource name can never contain a space (`splitResourceValue` ends it
// at the first whitespace), so the first gap is always the right one.
const RESOURCE_SUBJECT = /^(.*?) \((.*)\)$/;

function depUrl(script, kind, subject) {
  let ref = subject;
  if (kind === 'resource') {
    const m = RESOURCE_SUBJECT.exec(subject);
    if (!m) return '';
    const [, name, declRef] = m;
    if (!distillResources(script.header).some((d) => d.name === name && d.ref === declRef)) {
      return '';
    }
    ref = declRef;
  } else if (!distillRequires(script.header).includes(subject)) {
    return '';
  }
  return resolveScriptResource(ref, script.fileUrl)?.url ?? '';
}

// ---------- Reporting ----------

function report(results, opts) {
  const total = results.length;
  const okCount = results.filter((r) => r.status === 'ok').length;
  const byCategory = new Map();
  for (const r of results) {
    if (r.category === 'ok') continue;
    // Groups are keyed by category + message, so a script that stayed
    // `ok` with an inconclusive check appears under its own heading
    // rather than inflating the invalid count.
    if (!byCategory.has(r.category)) byCategory.set(r.category, new Map());
    const groups = byCategory.get(r.category);
    if (!groups.has(r.detail)) groups.set(r.detail, []);
    groups.get(r.detail).push(r.name);
  }

  // Counted per bucket rather than as "everything that isn't ok",
  // because a script the tool failed to check is not a script the tool
  // judged invalid — the whole point of keeping `tool error` separate.
  const invalidCount = results.filter((r) => r.status === 'invalid').length;
  const toolErrors = results.filter((r) => r.status === 'tool error').length;

  const lines = [];
  lines.push('');
  lines.push(`Scripts checked: ${total}`);
  lines.push(`  ok:      ${okCount} (${pct(okCount, total)})`);
  lines.push(`  invalid: ${invalidCount} (${pct(invalidCount, total)})`);
  if (toolErrors > 0) lines.push(`  NOT CHECKED (tool error): ${toolErrors}`);
  lines.push('');
  lines.push('Failure groups (a script appears once, under its first failing step):');
  lines.push('');

  const categories = [...byCategory.entries()].sort((a, b) => size(b[1]) - size(a[1]));
  for (const [category, groups] of categories) {
    lines.push(`${category}: ${size(groups)}`);
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [detail, names] of sorted) {
      lines.push(`  ${String(names.length).padStart(5)}  ${detail}`);
      for (const name of names.slice(0, opts.examples)) lines.push(`         · ${name}`);
      if (opts.examples && names.length > opts.examples) {
        lines.push(`         · … ${names.length - opts.examples} more`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

const size = (groups) => [...groups.values()].reduce((n, list) => n + list.length, 0);
const pct = (n, total) => (total === 0 ? '0%' : `${((100 * n) / total).toFixed(1)}%`);

// ---------- Main ----------

// Every exit here sets `process.exitCode` and returns rather than
// calling `process.exit`. Node's stdio is asynchronous for pipes on
// macOS, so exiting immediately after a write can truncate it — and the
// writes below are usage text someone is reading.
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    // A usage mistake is not a crash — print what's wrong and how to
    // spell it, not a stack trace through the arg parser.
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help || opts.paths.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  EXTENSION_VERSION = JSON.parse(
    await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'),
  ).version;

  if (opts.offlineRoot) {
    // The downloader probes the filesystem's per-filename limit and
    // truncates over-long names to fit; every reader has to probe the
    // same way or it computes different paths than the writer did.
    await detectMaxFilename(opts.offlineRoot, { create: false });
  }
  installFetch(opts.offlineRoot);
  installParseChecker();

  const files = await collectScripts(opts.paths, opts.limit);
  process.stderr.write(`Checking ${files.length} scripts${opts.offlineRoot ? ' (offline)' : ''}…\n`);

  const now = Date.now();
  const results = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const name = path.relative(process.cwd(), files[i]);
      let record;
      try {
        const script = await checkScript(files[i], opts.offlineRoot, now);
        record = { name, status: script.status, ...classify(script) };
        // Rendered the way every in-browser surface renders it, so the
        // report reads as `<message> (in <file>, line N, column N)`
        // rather than losing the position that `errorLocation` now
        // carries separately. `classify` above deliberately works off
        // the bare message, which is what groups.
        if (script.errorMessage) {
          record.message = describeDiagnostic(script.errorMessage, script.errorLocation);
          if (script.errorLocation) record.location = script.errorLocation;
        }
      } catch (err) {
        // The pipeline itself threw — a read error, or a bug. Reported
        // as its own category so it can never be mistaken for a
        // verdict about the script.
        record = { name, status: 'tool error', category: 'tool error', detail: String(err?.message ?? err) };
      }
      results[i] = record;
      if (++done % 100 === 0) process.stderr.write(`  ${done}/${files.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  process.stdout.write(report(results, opts));
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify(results, null, 2));
    process.stderr.write(`Wrote ${opts.json}\n`);
  }
  // Invalid scripts are the *finding*, not a failure of the run, so
  // they don't set an exit code. Only the tool failing does.
  process.exitCode = results.some((r) => r.category === 'tool error') ? 1 : 0;
}

await main().catch((err) => {
  // A bad path or an unreadable offline root — report it as a sentence
  // rather than a stack through the walker.
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exitCode = 1;
});
