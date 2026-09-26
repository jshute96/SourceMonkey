// The offline validator CLI (`scripts/validate-userscripts.mjs`), driven
// the way a user drives it: as a subprocess, over real directories, with
// its own `--json` output read back.
//
// Not an in-process import, deliberately. The CLI's arg parsing, script
// discovery, `fetch` replacement and reporting are as much of the tool
// as the checking is, and each of them has a failure mode that returns
// *zero problems found* — a mistyped flag, a walker that matches
// nothing, a fetch shim that isn't installed. A test that reached past
// them into the internals would pass while the tool reported an empty
// corpus as clean.
//
// The expectations for `tests/bad-examples/` come from the same module
// `tests/e2e/bad-scripts.spec.ts` uses, so this test and the browser one
// are asserting the same table. That is the whole claim being made: the
// CLI reproduces what the extension does at install time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  BAD_CASES,
  expectedErrorLine,
  expectedFilePattern,
  badScriptFilesOnDisk,
  locationPattern,
} from '../fixtures/bad-script-cases.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'validate-userscripts.mjs');

/**
 * Run the CLI and return its parsed `--json` records. Paths in the
 * result are relative to the repo root, since that's the CLI's cwd.
 * @param {string[]} args
 */
async function runValidator(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validate-'));
  const jsonPath = path.join(dir, 'out.json');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI, '--json', jsonPath, '--quiet', ...args],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
    return { records: JSON.parse(fs.readFileSync(jsonPath, 'utf8')), stdout };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {{name: string}[]} records */
function byBasename(records) {
  return new Map(records.map((r) => [path.basename(r.name), r]));
}

test('every script in tests/examples validates clean', async () => {
  const { records, stdout } = await runValidator(['tests/examples']);
  // The suite is the reference for well-formed scripts, so anything
  // other than a clean sweep is either a broken example or a validator
  // that has started rejecting valid input.
  // Except one that is flagged on purpose: it shows that an @match
  // naming a #hash never runs here, while Violentmonkey runs it.
  const bad = records.filter((r) => r.category !== 'ok');
  assert.deepEqual(bad.map((r) => `${r.name}: ${r.detail ?? r.message}`), [
    'tests/examples/headers-match-hash/match-hash.user.js: @match … names a #hash that @match can\'t see, so this script would never run on any page; use @include to match on the hash',
  ]);
  // Guard against the walker silently matching nothing — an empty run
  // reports zero failures too.
  assert.ok(records.length >= 20, `expected the examples suite, got ${records.length} scripts`);
  // The printed summary is the product for a CLI, and it is derived
  // separately from the JSON — a reporter that lost its counts (or its
  // output) would otherwise pass every assertion above.
  assert.match(stdout, new RegExp(`Scripts checked: ${records.length}\\b`));
  assert.match(stdout, new RegExp(`ok:\\s+${records.length - bad.length} \\(`));
  assert.match(stdout, new RegExp(`invalid:\\s+${bad.length} \\(`));
});

test('tests/bad-examples produces the same verdicts the browser records', async () => {
  const { records } = await runValidator(['tests/bad-examples']);
  const got = byBasename(records);

  for (const c of BAD_CASES) {
    const r = got.get(c.file);
    assert.ok(r, `missing result for ${c.file}`);
    assert.equal(r.status, c.expectedStatus, `wrong status for ${c.file}`);
    if (c.errorMatcher) {
      assert.match(r.message ?? '', c.errorMatcher, `wrong message for ${c.file}`);
    } else {
      assert.equal(r.message ?? '', '', `expected no message for ${c.file}`);
    }
    if (c.errorIn) {
      // The same location assertion the e2e spec makes, read off the
      // example's own `>>> the error` marker rather than written down.
      // The CLI renders it through `describeDiagnostic`, exactly as the
      // extension's own surfaces do, so one pattern checks both.
      assert.match(r.message ?? '', locationPattern(c), `wrong location for ${c.file}`);
      assert.match(r.location?.file ?? '', expectedFilePattern(c), `wrong file for ${c.file}`);
      assert.equal(r.location?.line, expectedErrorLine(c), `wrong line for ${c.file}`);
    }
  }

  // Every file on disk was seen — catches a new bad example that the
  // walker skips or that nobody added expectations for.
  assert.deepEqual([...got.keys()].sort(), badScriptFilesOnDisk());
});

// ---------- Offline mode ----------
//
// The flag that makes a corpus run reproducible: dependencies resolve
// out of a downloaded tree and nothing touches the network. The tree
// here is built by hand rather than borrowed from
// `tests/greasyfork-examples/files/` — that directory is gitignored and
// 270 MB, so a test that needed it would be skipped on every fresh
// checkout, which is the same as not having one.

/** Write `<root>/<host>/<url-path>` the way the corpus downloader does. */
function writeOfflineTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const OFFLINE_SCRIPT_HEADER = [
  '// ==UserScript==',
  '// @name        Offline fixture',
  '// @match       https://example.com/*',
].join('\n');

test('offline mode resolves @require URLs out of the tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeOfflineTree(root, {
    // An absolute URL — the form the corpus scripts overwhelmingly use.
    'example.com/lib/thing.js': 'const OFFLINE_THING = 1;\n',
    // A sibling reached by a relative ref.
    'example.com/scripts/helper.js': 'const OFFLINE_HELPER = 2;\n',
    'example.com/scripts/good.user.js': [
      OFFLINE_SCRIPT_HEADER,
      '// @require     https://example.com/lib/thing.js',
      '// @require     ./helper.js',
      '// ==/UserScript==',
      'console.log(OFFLINE_THING, OFFLINE_HELPER);',
    ].join('\n'),
    // Same shape, but the library was never downloaded.
    'example.com/scripts/dead.user.js': [
      OFFLINE_SCRIPT_HEADER,
      '// @require     https://example.com/lib/absent.js',
      '// ==/UserScript==',
      'console.log(1);',
    ].join('\n'),
    // A RELATIVE ref that resolves to nothing, which is what makes the
    // reported URL observable. A successful relative ref proves little:
    // the tree mirrors URL paths onto the filesystem, so `./helper.js`
    // finds the same bytes whether the base was the reconstructed
    // https:// URL or the file:// path it sits at. The failure names
    // the URL it resolved against, and only one of those two is right.
    'example.com/scripts/dead-relative.user.js': [
      OFFLINE_SCRIPT_HEADER,
      '// @require     ./absent-helper.js',
      '// ==/UserScript==',
      'console.log(1);',
    ].join('\n'),
    // A `@resource`, whose failure message names both the resource name
    // and its ref — a different subject shape from `@require`, which
    // `depUrl` has to take apart to find the URL. Without this the
    // resource branch reports `url: ''` and falls back to a generic
    // reason, and nothing fails.
    'example.com/scripts/dead-resource.user.js': [
      OFFLINE_SCRIPT_HEADER,
      '// @resource    theme https://example.com/style/absent.css',
      '// ==/UserScript==',
      'console.log(1);',
    ].join('\n'),
  });

  const { records } = await runValidator(['--offline-root', root, root]);
  const got = byBasename(records);

  assert.equal(got.get('good.user.js')?.status, 'ok', got.get('good.user.js')?.message);
  assert.equal(got.get('dead.user.js')?.status, 'invalid');
  assert.equal(got.get('dead.user.js')?.category, '@require');
  // This detail is also the proof that nothing reached the network:
  // it can only come from the shim's own log. A real fetch of
  // `example.com` — a domain that resolves — would have failed some
  // other way and reported the pipeline's generic "fetch failed".
  assert.match(got.get('dead.user.js')?.detail ?? '', /not in the offline tree/);
  assert.equal(got.get('dead.user.js')?.url, 'https://example.com/lib/absent.js');

  // The `scriptUrlFor` assertion: a relative ref resolved against the
  // reconstructed https:// URL, not against the file:// path the script
  // physically sits at. Break that reconstruction and this is the one
  // assertion that notices.
  assert.equal(
    got.get('dead-relative.user.js')?.url,
    'https://example.com/scripts/absent-helper.js',
  );

  // The `@resource` subject is `<name> (<ref>)`, so recovering the URL
  // means taking that apart rather than reading the ref directly. A
  // mis-parse doesn't throw — it yields no URL and a generic reason —
  // so both halves are pinned.
  assert.equal(got.get('dead-resource.user.js')?.category, '@resource');
  assert.match(got.get('dead-resource.user.js')?.detail ?? '', /not in the offline tree/);
  assert.equal(
    got.get('dead-resource.user.js')?.url,
    'https://example.com/style/absent.css',
  );
});

test('offline mode rejects a root that does not exist', async () => {
  await assert.rejects(
    runValidator(['--offline-root', path.join(os.tmpdir(), 'sm-no-such-root'), 'tests/bad-examples']),
    // A silently-empty run is the failure mode worth pinning: a typo in
    // the root must not read as a corpus with nothing wrong in it.
    (err) => /Download root does not exist/.test(err.stderr ?? ''),
  );
});
