// `sm-dev validate` over the example suites, as a subprocess: its
// verdicts, and the warnings it prints beside them.
//
// The expectations for `tests/bad-examples/` come from the same module
// `tests/e2e/bad-scripts.spec.ts` uses, so this test and the browser one
// assert the same table. That is the claim being made: validating under
// Node reproduces what the extension does at install time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BAD_CASES,
  badScriptFilesOnDisk,
  locationPattern,
} from '../../fixtures/bad-script-cases.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI = path.join(REPO_ROOT, 'lib', 'harness', 'cli.js');

/**
 * Run `sm-dev validate` and read its output back per script:
 * `{ status, lines }` keyed by basename, `lines` being the indented
 * ones under it (the diagnostic, then warnings).
 */
function validate(...args) {
  const r = spawnSync(process.execPath, [CLI, 'validate', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const scripts = new Map();
  let current = null;
  for (const line of r.stdout.split('\n')) {
    const head = /^(ok|INVALID|UNCHECKED) +(\S.*)$/.exec(line);
    if (head) {
      current = { status: head[1].toLowerCase(), lines: [] };
      scripts.set(path.basename(head[2]), current);
    } else if (line.startsWith('    ') && current) {
      current.lines.push(line.trim());
    } else {
      current = null;
    }
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, scripts };
}

test('every script in tests/examples validates clean', () => {
  const { code, stdout, scripts } = validate('tests/examples');
  const bad = [...scripts].filter(([, s]) => s.status !== 'ok');
  // Except one flagged on purpose: an @match naming a #hash never runs
  // here, while Violentmonkey runs it.
  assert.deepEqual(bad.map(([name, s]) => `${name}: ${s.lines[0]}`), [
    'match-hash.user.js: @match *://*/*headers-match-hash/headers-match-hash.html#part names a #hash that @match can\'t see, so this script would never run on any page; use @include to match on the hash (in tests/examples/headers-match-hash/match-hash.user.js, line 6)',
  ]);
  assert.equal(code, 1);
  // Guard against the walker silently matching nothing.
  assert.ok(scripts.size >= 20, `expected the examples suite, got ${scripts.size} scripts`);
  assert.match(stdout, new RegExp(`\\n${scripts.size - 1} ok, 1 invalid\\n$`));
});

test('tests/bad-examples produces the same verdicts the browser records', () => {
  const { scripts } = validate('tests/bad-examples');
  for (const c of BAD_CASES) {
    const s = scripts.get(c.file);
    assert.ok(s, `missing result for ${c.file}`);
    assert.equal(s.status, c.expectedStatus, `wrong status for ${c.file}`);
    if (c.expectedStatus !== 'invalid') continue;
    // The diagnostic, rendered through `describeDiagnostic` as the
    // extension's own surfaces render it, so one pattern checks both.
    const diagnostic = s.lines[0] ?? '';
    if (c.errorMatcher) assert.match(diagnostic, c.errorMatcher, `wrong message for ${c.file}`);
    if (c.errorIn) assert.match(diagnostic, locationPattern(c), `wrong location for ${c.file}`);
  }
  // Every file on disk was seen: catches a new bad example that the
  // walker skips or that nobody added expectations for.
  assert.deepEqual([...scripts.keys()].sort(), badScriptFilesOnDisk());
});

test('validate shows every warning, with the line it is about', () => {
  const { scripts } = validate('tests/bad-examples');
  assert.deepEqual(scripts.get('unknown-grant.user.js')?.lines, [
    'warn: Ignoring unsupported @grant GM_notARealApi, GM_alsoNotReal (in tests/bad-examples/unknown-grant.user.js, line 8)',
  ]);
});

test('validate notes GM_xmlhttpRequest with no @connect, warns about an unsupported @run-at, and still passes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'warns.user.js');
  fs.writeFileSync(file, [
    '// ==UserScript==',
    '// @name  Warns',
    '// @match https://example.com/*',
    '// @grant GM_xmlhttpRequest',
    '// @run-at document-ready',
    '// ==/UserScript==',
    'GM_xmlhttpRequest({ url: "https://example.com/" });',
  ].join('\n'));
  const { code, scripts } = validate(file);
  assert.equal(code, 0);
  const s = scripts.get('warns.user.js');
  assert.equal(s?.status, 'ok');
  assert.equal(s.lines.length, 2);
  assert.match(s.lines[0], /^info: This script has no @connect lines, so SourceMonkey asks before its GM_xmlhttpRequest requests reach another site\. .*, line 4\)$/);
  assert.match(s.lines[1], /^warn: @run-at document-ready is not supported\. The script runs at document-idle instead\. .*, line 5\)$/);
});

test('validate accepts @run-at context-menu, with no warning', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'menu.user.js');
  fs.writeFileSync(file, [
    '// ==UserScript==',
    '// @name  Menu',
    '// @match https://example.com/*',
    '// @run-at context-menu',
    '// ==/UserScript==',
  ].join('\n'));
  const { code, scripts } = validate(file);
  assert.equal(code, 0);
  const s = scripts.get('menu.user.js');
  assert.equal(s?.status, 'ok');
  assert.deepEqual(s.lines, []);
});

test('validate calls a script unchecked when the syntax check could not decide', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Nesting deep enough to overflow V8's parser: not a SyntaxError, so
  // the check fails open. The script still loads, so it doesn't fail
  // the command, but it isn't called ok either.
  const file = path.join(dir, 'deep.user.js');
  fs.writeFileSync(file, [
    '// ==UserScript==',
    '// @name  Deep',
    '// @match https://example.com/*',
    '// ==/UserScript==',
    `x = ${'['.repeat(200000)}${']'.repeat(200000)};`,
  ].join('\n'));
  const { code, stdout, scripts } = validate(file);
  assert.equal(code, 0);
  assert.deepEqual(scripts.get('deep.user.js'), {
    status: 'unchecked',
    lines: ['The syntax check could not finish (Maximum call stack size exceeded), so syntax errors were not checked. The script still loads.'],
  });
  assert.match(stdout, /\n0 ok, 0 invalid, 1 unchecked\n$/);
});
