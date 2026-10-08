#!/usr/bin/env node
//
// Validates the downloaded corpus offline: SourceMonkey's install-time
// checks over every script in `files/`, with `@require` / `@resource`
// served out of the same tree, and the failures grouped into a survey.
//
// The checking itself is `sm-dev validate`'s: each script goes through
// `prepareScript` (lib/harness/prepare.ts), the extension's own install
// pipeline under Node. What this adds is corpus-only:
//
//   - `--offline-root`: every dependency fetch is answered from the
//     downloaded tree, and a script under it gets its original https://
//     URL back, so relative refs resolve as they did on the real host.
//   - A report grouping failures by category and message.
//   - `--json`, one record per script, which `record-results.mjs
//     validate` imports into corpus.json.
//
// Usage:
//   node tests/greasyfork-examples/validate-corpus.mjs [options] <path>...
//
//   <path>   a `*.user.js` file, or a directory scanned recursively
//            for them.
//
// Options:
//   --offline-root DIR   Serve every dependency from DIR (the tree
//                        `download-scripts.mjs` writes). No network
//                        requests are made at all; a URL that isn't in
//                        the tree reads as a dead link.
//   --json FILE          Write one JSON record per script to FILE.
//   --limit N            Stop after N scripts (in scan order).
//   --examples N         Example script names to print per failure
//                        group (default 3; use --examples 0 for none).
//   --quiet              Summary only, no per-group examples.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NO_MATCH_OR_INCLUDE, NO_NAME, SYNTAX_ERROR_PREFIX } from '../../lib/script-build.js';
import { resolveScriptResource } from '../../lib/file-loader.js';
import { distillRequires, distillResources, isFetchFailureMessage } from '../../lib/external-files.js';
import { getValue, NO_METADATA_BLOCK, UNTERMINATED_METADATA_BLOCK } from '../../lib/userscript-header.js';
import { unusableMatchGroupKey } from '../../lib/url-match.js';
import { prepareScript } from '../../lib/harness/prepare.js';
// The offline tree's layout (percent-encoded segments, truncated long
// names, `<path>/index` for a path that is also a directory prefix) is
// defined by the downloader, so the lookup comes from there rather
// than being guessed at here.
import { checkRoot, findExisting, helpText } from './corpus.mjs';

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    paths: [],
    offlineRoot: null,
    json: null,
    limit: Infinity,
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
    // quietly check nothing.
    const nextCount = (min) => {
      const v = Number(next());
      if (!Number.isInteger(v) || v < min) throw new Error(`${arg} needs a whole number >= ${min}`);
      return v;
    };
    switch (arg) {
      case '--offline-root': opts.offlineRoot = path.resolve(next()); break;
      case '--json': opts.json = path.resolve(next()); break;
      case '--limit': opts.limit = nextCount(1); break;
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

// Symlinks are not followed: the tree is generated, not curated, and
// following links risks walking a cycle.
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
// Passed to `prepareScript` as its `fetch`, which answers every
// dependency fetch in the pipeline, `file://` included.

/** url → why the offline tree couldn't satisfy it, for the report. */
const fetchLog = new Map();

function offlineFetch(offlineRoot) {
  return async (url) => {
    if (url.startsWith('file:')) return serveLocalFile(fileURLToPath(url), url, 'not-found');
    const file = await findExisting(offlineRoot, url);
    if (!file) {
      fetchLog.set(url, 'not-downloaded');
      return new Response(null, { status: 404 });
    }
    return serveLocalFile(file, url, 'not-downloaded');
  };
}

async function serveLocalFile(file, url, missingReason) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    fetchLog.set(url, missingReason);
    return new Response(null, { status: 404 });
  }
  // No Content-Type, like the harness's own `file://` reads: a
  // downloaded file has no record of the header its server sent. The
  // loader's markup sniff still rejects an HTML page served in place of
  // a library, just with its own wording.
  return new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

// ---------- Checking one script ----------

async function checkScript(file, offlineRoot) {
  return prepareScript({
    file,
    sourceUrl: scriptUrlFor(file, offlineRoot),
    // A corpus script has no repo of local copies to find.
    localFiles: false,
    ...(offlineRoot && { fetch: offlineFetch(offlineRoot) }),
  });
}

// The URL a script would have been fetched from. Inside the offline
// tree that's reconstructible: the tree is `<root>/<host>/<url-path>`
// with the URL's own percent-encoding preserved. A `file://` base would
// get these wrong:
//
//   - the directory a relative `@require` / `@resource` resolves
//     against;
//   - whether a relative ref may climb out of that directory, which
//     `resolveScriptResource` only forbids for a `file://` base;
//   - the URL `findExisting` looks up, and the one the report prints.
//
// Not exact in two shapes the downloader produces (a truncated
// over-long segment, and `<path>/index`), but both affect only the
// filename, so the directory relative refs resolve against is right.
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
// Every failure arrives as `status: 'invalid'` plus the extension's own
// `errorMessage`, which already says which fetch failure it was. The
// fetch log is consulted for one case only: the offline tree answers a
// URL it doesn't hold with a 404, and "not in the offline tree" is a
// different fact from a server that really replied 404.
//
// Strings shared with the pipeline are imported, never copied or
// pattern-matched: a copy goes stale the next time the wording changes.

const OFFLINE_REASON_TEXT = {
  'not-downloaded': 'not in the offline tree (dead link or never downloaded)',
  'not-found': 'file not found',
};

function classify(prepared) {
  const script = prepared.script;
  if (prepared.status !== 'ok') return classifyInvalid(script);
  const note = prepared.parseCheckNote;
  // Still `ok`: the check failed open, which is the design. Called out
  // separately because "we couldn't tell" is not "it parses".
  if (note) return { category: `parse check ${note.kind}`, detail: note.message || '(no message)' };
  return { category: 'ok' };
}

function classifyInvalid(script) {
  const message = script.errorMessage ?? '(no message)';

  if (message.startsWith(SYNTAX_ERROR_PREFIX)) {
    // The location travels in `errorLocation`, so the bare message is
    // what groups.
    return { category: 'syntax error', detail: message.slice(SYNTAX_ERROR_PREFIX.length) };
  }

  const dep = /^@(require|resource) (.*?): ([\s\S]*)$/.exec(message);
  if (dep) {
    const [, kind, subject, reason] = dep;
    // The record's `url` field, for every dependency failure: an
    // oversize one is as worth locating as an unreachable one.
    const url = depUrl(script, kind, subject);
    if (isFetchFailureMessage(reason)) {
      // No log entry: the pipeline's own message is already specific.
      return { category: `@${kind}`, detail: OFFLINE_REASON_TEXT[fetchLog.get(url)] ?? reason, url };
    }
    // Strip embedded content-type values so near-identical failures
    // group together.
    return { category: `@${kind}`, detail: reason.replace(/"[^"]*"/g, '"…"'), url };
  }

  // A header failure naming the offending `@match`; its module elides
  // the pattern so every script making that mistake lands in one row.
  const unusableMatch = unusableMatchGroupKey(message);
  if (unusableMatch) return { category: 'header', detail: unusableMatch };

  if (HEADER_MESSAGES.has(message)) return { category: 'header', detail: message };
  // A message nothing here recognizes. Folding it into `header` would
  // hide a new failure shape inside a familiar count.
  return { category: 'other', detail: message };
}

// The fixed messages `buildScriptFromText` can produce.
const HEADER_MESSAGES = new Set([
  NO_METADATA_BLOCK,
  UNTERMINATED_METADATA_BLOCK,
  NO_NAME,
  NO_MATCH_OR_INCLUDE,
]);

// The URL behind a failing dependency line. `@require` names its ref
// directly; `@resource` names both, as `<name> (<ref>)`. The ref is
// checked against the header before being resolved, so a mis-parsed
// message yields '' rather than a confidently wrong URL.
//
// The name is matched lazily: a resource name never contains a space,
// so the first gap is the right split even when the ref has `)` in it.
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
    // Keyed by category + message, so a script that stayed `ok` with an
    // inconclusive check gets its own heading rather than inflating the
    // invalid count.
    if (!byCategory.has(r.category)) byCategory.set(r.category, new Map());
    const groups = byCategory.get(r.category);
    if (!groups.has(r.detail)) groups.set(r.detail, []);
    groups.get(r.detail).push(r.name);
  }

  // A script the tool failed to check is not one it judged invalid.
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

// One script's JSON record.
function record(name, prepared) {
  const script = prepared.script;
  const out = { name, status: prepared.status, ...classify(prepared) };
  if (prepared.diagnostic) {
    out.message = prepared.diagnostic;
    // The two halves as well, for a consumer that renders the location
    // its own way (record-results.mjs shortens the file name).
    out.errorMessage = prepared.errorMessage;
    if (prepared.errorLocation) out.location = prepared.errorLocation;
  }
  const version = script.header ? getValue(script.header, 'version') : undefined;
  if (version) out.version = version.trim();
  // The load-time diagnostics the Log tab shows. They don't change the
  // verdict, so they only reach the JSON, not the report.
  if (prepared.startupLogs.length) {
    out.warnings = prepared.startupLogs.map((log) => ({
      level: log.level,
      message: log.message,
      ...(log.location && { location: log.location }),
    }));
  }
  return out;
}

// ---------- Main ----------

// Every exit sets `process.exitCode` rather than calling `process.exit`,
// which can truncate piped output.
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}. Run with --help for usage.\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.help || opts.paths.length === 0) {
    process.stdout.write(helpText(import.meta.url));
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  if (opts.offlineRoot) {
    await checkRoot(opts.offlineRoot);
  }

  const files = await collectScripts(opts.paths, opts.limit);
  process.stderr.write(`Checking ${files.length} scripts${opts.offlineRoot ? ' (offline)' : ''}…\n`);

  // One at a time: `prepareScript` serializes calls anyway.
  const results = [];
  for (const file of files) {
    const name = path.relative(process.cwd(), file);
    try {
      results.push(record(name, await checkScript(file, opts.offlineRoot)));
    } catch (err) {
      // The pipeline itself threw (a read error, or a bug). Its own
      // category, so it's never mistaken for a verdict on the script.
      results.push({ name, status: 'tool error', category: 'tool error', detail: String(err?.message ?? err) });
    }
    if (results.length % 100 === 0) process.stderr.write(`  ${results.length}/${files.length}\n`);
  }

  process.stdout.write(report(results, opts));
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify(results, null, 2));
    process.stderr.write(`Wrote ${opts.json}\n`);
  }
  // Invalid scripts are the finding, not a failure of the run.
  process.exitCode = results.some((r) => r.category === 'tool error') ? 1 : 0;
}

await main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exitCode = 1;
});
